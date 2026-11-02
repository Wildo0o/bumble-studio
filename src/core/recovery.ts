// 启动恢复。
//
// 进程可能在任意时刻被杀掉。重启后数据库里会留下几种「悬空」状态：
//
//   1. Step 停在 running          → 不知道那一步做完没有
//   2. ToolIntent 停在 started    → 不知道那个外部调用生效没有
//   3. Run 停在 running           → 没有进程在跑它，但状态说在跑
//   4. 审批停在 pending 且已过期  → 规则上应按 fail-closed 拒绝
//
// 为什么必须有这一步：
//   如果不处理，第 3 种状态会让 Run 永远「正在运行」——execute 的 CAS
//   只接受 queued（除非显式 resumeStale），UI 也只能显示一个假的执行中。
//   用户唯一的出路是删库。
//
// 关键约束：
//   · unknown **不能**被自动消解成 completed 或 failed。
//     那只会在事实层面撒谎。unknown 必须由对账（有证据）处理。
//   · 本模块只做「如实降级」：running → unknown / needs_reconciliation。
//   · 每一步都写事件，让「启动时修正了什么」可追溯。
//
// 安全顺序（审计 D-8/D-9）：
//   1. 逐个 Run 检查活跃租约
//   2. 只有确认失联**且**抢到恢复权之后，才清扫这个 Run 的 Step / Intent
//   3. 清扫完再判断 unknown 并 CAS 改状态
//
// 绝不能一开始就全局 sweep：启动第二个服务时，
// 第一个健康执行者正在跑的 Step 会被误标成 unknown。
import type { Store } from './store.js'
import type { Principal } from './permissions.js'
import { assertPermission, internalSystem } from './permissions.js'

export interface RecoveryReport {
  /** 被标成 unknown 的 Step */
  danglingSteps: Array<{ stepId: string; runId: string }>
  /** 被标成 unknown 的 ToolIntent */
  startedIntents: string[]
  /**
   * 从 running 降级的 Run。
   *
   * 有两种结局：
   *   needs_reconciliation —— 有未解决的 unknown（最保守）
   *   queued               —— 没有 unknown 残留，可以重新排队执行
   */
  staleRuns: Array<{ runId: string; to: 'needs_reconciliation' | 'queued' }>
  /**
   * 因仍有活跃持有者而跳过的 Run。
   *
   * 这不是失败：它说明另一个进程还活着，本进程不该去改它的状态。
   * 单独列出是为了让「启动时没有恢复任何东西」这件事可解释。
   */
  skippedActiveRuns: string[]
  /** 超时被自动拒绝的审批 */
  expiredApprovals: string[]
}

/**
 * 执行一次启动恢复。
 *
 * @param principal 必须是 internalSystem()。HTTP 层永远拿不到这个入口——
 *                  否则客户端可以声称「我重启了服务」来重置状态。
 */
export function recoverOnStartup(store: Store, principal: Principal = internalSystem()): RecoveryReport {
  assertPermission(principal, 'maintenance.recover')

  const report: RecoveryReport = {
    danglingSteps: [],
    startedIntents: [],
    staleRuns: [],
    skippedActiveRuns: [],
    expiredApprovals: [],
  }
  const correlationId = `startup-${Date.now()}`

  // ── 1+2+3. 失联的 Run：先确认无活跃 owner，再按 Run 清扫 ──
  //
  // **顺序是安全性的核心（审计 D-8/D-9）**：
  //
  //   错误做法：先全局 sweep 所有 running Step / started Intent，
  //   再看哪些 Run 停着。
  //   → 启动第二个服务时，第一个健康 Executor 正在跑的 Step
  //     会被标成 unknown，它随后的写入对不上，整个执行轨迹被毁。
  //
  //   正确做法：逐个 Run 判断「有没有活租约」，
  //   只有确认失联（且抢到恢复权）之后，才清扫**这个 Run** 的
  //   Step / Intent。
  for (const run of store.listRunsByStatus('running')) {
    const leaseKey = `run:${run.id}`

    // ① 有活跃租约 → 有人在跑，一点都不能动。
    const existing = store.inspectLease(leaseKey)
    if (existing && existing.expiresAt > Date.now()) {
      report.skippedActiveRuns.push(run.id)
      continue
    }

    // ② 抢恢复权。抢不到说明另一个恢复者 / runner 先动手了。
    const claim = store.tryClaimLease(leaseKey, `recovery:${correlationId}`, 30_000, Date.now())
    if (!claim) {
      report.skippedActiveRuns.push(run.id)
      continue
    }

    try {
      // ③ **抢到权之后**才清扫这个 Run 的悬挂状态。
      //    按 Run 限定，不会碰到别的 Run。
      const sweptSteps = store.sweepStepsForRun(run.id)
      for (const s of sweptSteps) {
        report.danglingSteps.push(s)
        store.appendEvent(
          run.id,
          'step.unknown',
          { stepId: s.stepId, reason: '执行者失联，启动恢复标记为未知' },
          { actor: 'system', correlationId },
        )
      }
      const sweptIntents = store.sweepIntentsForRun(run.id)
      if (sweptIntents > 0) {
        store.appendEvent(
          run.id,
          'intent.swept',
          { count: sweptIntents, reason: '执行者失联，启动恢复标记为未知' },
          { actor: 'system', correlationId },
        )
      }

      // ④ 清扫之后才有资格判断「有没有 unknown」。
      const hasUnknown = store.hasUnresolvedUnknown(run.id)
      const target: 'needs_reconciliation' | 'queued' = hasUnknown
        ? 'needs_reconciliation'
        : 'queued'

      // ⑤ 状态写入用 CAS：只从 running 出发。
      const moved = store.casRunStatus(run.id, 'running', target)
      if (!moved) {
        report.skippedActiveRuns.push(run.id)
        continue
      }

      report.staleRuns.push({ runId: run.id, to: target })
      store.appendEvent(
        run.id,
        hasUnknown ? 'run.status_recovered' : 'run.stale_running',
        {
          from: 'running',
          to: target,
          reason: hasUnknown
            ? '上次进程异常终止，存在未解决的外部操作，需对账'
            : '上次进程异常终止，没有未知残留，重新排队',
        },
        { actor: 'system', correlationId },
      )
    } finally {
      // 释放恢复租约：不释放会让这个 Run 白等一个 TTL。
      store.releaseLease(leaseKey, `recovery:${correlationId}`)
    }
  }

  // ── 4. 过期审批 ────────────────────────────────────────
  //
  // store.expireStaleApprovals 已经是 fail-closed（转 rejected）。
  // 这里只补事件，不改变语义。
  const expired = store.expireStaleApprovals()
  report.expiredApprovals = expired.map((a) => a.id)
  for (const approval of expired) {
    store.appendEvent(approval.runId, 'approval.expired', { approvalId: approval.id, atStartup: true }, {
      actor: 'system',
      correlationId,
    })
  }

  return report
}
