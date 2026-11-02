// 跨对象不变式。
//
// 这些是**关系**层面的约束：单独一行数据看起来合法，
// 但它与另一行数据的关系不成立。数据库的外键只能保证「被引用的行存在」，
// 保证不了「这个 Artifact 真的属于这个 Task」，也保证不了
// 「Run 的 taskId 和它 Task 的 id 一致」。
//
// 为什么需要它：
//   · core 层的每层都自己判断一次归属，判断口径会漂移
//     （`review-loop` 查 artifact.taskId，`acceptance` 查 run.taskId……）。
//   · 一条跨越三个对象的要求（Run → Task → Session）散落在五处，
//     总有一处漏了。漏掉的那一处就是可以伪造归属的入口。
//   · 把它写成**单一函数**，测试可以穷举组合，业务代码可以复用。
//
// 本文件只做判定，不做 I/O 之外的副作用：
//   · 输入是已经从 Store 读出来的对象
//   · 输出是「成立」或一条带 code 的具体理由
// 这样调用方可以决定是抛错、记事件，还是返回 409。
import type { Store } from './store.js'
import type {
  AcceptanceRecord,
  Artifact,
  DeliveryRecord,
  ReviewCycle,
  Run,
  Task,
} from '../shared/types.js'
import { DomainError } from './errors.js'

/** 判定结果。ok 时不需要理由。 */
export type OwnershipCheck = { ok: true } | { ok: false; reason: string }

const ok: OwnershipCheck = { ok: true }
const bad = (reason: string): OwnershipCheck => ({ ok: false, reason })

/**
 * Artifact 是否真的属于这个 (task, run)。
 *
 * 三条都必须成立：
 *   1. artifact.taskId === task.id
 *   2. artifact.runId === run.id
 *   3. run.taskId === task.id
 *
 * 为什么第 3 条也要：只要 Run 和 Task 之间的连接断了，
 * 前两条可以同时成立但整体仍然是错的（例如把 artifact 的 taskId
 * 改成另一个 Task 的 id，同时那个 Task 恰好也有这个 Run 的引用）。
 * 这条是所有其他归属关系的根。
 */
export function artifactBelongsTo(artifact: Artifact, task: Task, run: Run): OwnershipCheck {
  if (artifact.taskId !== task.id) {
    return bad(`产物属于 Task ${artifact.taskId}，不是 ${task.id}`)
  }
  if (artifact.runId !== run.id) {
    return bad(`产物属于 Run ${artifact.runId}，不是 ${run.id}`)
  }
  if (run.taskId !== task.id) {
    return bad(`Run ${run.id} 属于 Task ${run.taskId}，不是 ${task.id}`)
  }
  return ok
}

/** AcceptanceRecord 与 (task, artifact, run) 的归属关系。 */
export function acceptanceBelongsTo(
  record: AcceptanceRecord,
  task: Task,
  artifact: Artifact,
  run: Run,
): OwnershipCheck {
  if (record.taskId !== task.id) return bad(`验收记录属于 Task ${record.taskId}，不是 ${task.id}`)
  if (record.artifactId !== artifact.id) {
    return bad(`验收记录指向产物 ${record.artifactId}，不是 ${artifact.id}`)
  }
  if (record.runId !== run.id) return bad(`验收记录属于 Run ${record.runId}，不是 ${run.id}`)
  return artifactBelongsTo(artifact, task, run)
}

/** DeliveryRecord 与验收记录的一致性。 */
export function deliveryMatchesAcceptance(
  delivery: DeliveryRecord,
  acceptance: AcceptanceRecord,
): OwnershipCheck {
  if (delivery.acceptanceId !== acceptance.id) {
    return bad(`交付记录绑定验收 ${delivery.acceptanceId}，不是 ${acceptance.id}`)
  }
  if (delivery.taskId !== acceptance.taskId) {
    return bad(`交付记录的 Task ${delivery.taskId} 与验收记录的 ${acceptance.taskId} 不一致`)
  }
  if (delivery.artifactId !== acceptance.artifactId) {
    return bad(`交付记录的产物 ${delivery.artifactId} 与验收记录的 ${acceptance.artifactId} 不一致`)
  }
  return ok
}

/** ReviewCycle 与 Task 的归属关系。 */
export function cycleBelongsTo(cycle: ReviewCycle, task: Task): OwnershipCheck {
  if (cycle.taskId !== task.id) return bad(`审核轮次属于 Task ${cycle.taskId}，不是 ${task.id}`)
  return ok
}

/**
 * 抛错版本的归属校验。
 *
 * 用 `OWNERSHIP_MISMATCH`（409）而不是 400：
 * 请求本身语法正确，是**对象之间的关系**不成立——
 * 这通常是并发或数据篡改的信号，不是「参数写错了」。
 */
export function assertOwnership(check: OwnershipCheck, what: string, correlationId?: string): void {
  if (check.ok) return
  throw new DomainError('OWNERSHIP_MISMATCH', `${what}：${check.reason}`, { correlationId })
}

/**
 * 对整个库做一次关系体检。
 *
 * 用途：
 *   · 测试里作为断言（"操作完之后没有断裂的关系"）
 *   · 启动时可选的自检（发现历史遗留的坏数据，而不是等它在验收时才爆）
 *
 * 只返回**事实**，不修复。修复必须有人做决定——自动改数据
 * 会把「数据坏了」这件事藏起来。
 */
export interface InvariantViolation {
  kind:
    | 'run_task_mismatch'
    | 'artifact_task_mismatch'
    | 'artifact_run_mismatch'
    | 'artifact_orphan_snapshot'
    | 'acceptance_task_mismatch'
    | 'acceptance_artifact_mismatch'
    | 'delivery_task_mismatch'
    | 'event_sequence_gap'
  detail: string
}

export function scanInvariants(store: Store): InvariantViolation[] {
  const out: InvariantViolation[] = []
  const tasks = new Map(store.listTasks().map((t) => [t.id, t]))
  const runsByTask = new Map<string, Run[]>()
  const allRuns = store.listAllRuns()
  const runsById = new Map(allRuns.map((r) => [r.id, r]))

  // ── 孤儿行：挂在不存在 / 不匹配的 Task 下的产物 ─────────
  //
  // 这类问题不会出现在「按 Task 遍历」里——正是因为它挂错了，
  // 正确的 Task 下看不到它。必须从**行本身**出发核对。
  for (const artifact of store.listAllArtifacts()) {
    const ownerTask = tasks.get(artifact.taskId)
    if (!ownerTask) {
      out.push({
        kind: 'artifact_task_mismatch',
        detail: `Artifact ${artifact.id} 的 taskId=${artifact.taskId} 指向不存在的 Task`,
      })
      continue
    }
    const ownerRun = runsById.get(artifact.runId)
    if (!ownerRun) {
      out.push({
        kind: 'artifact_run_mismatch',
        detail: `Artifact ${artifact.id} 的 runId=${artifact.runId} 指向不存在的 Run`,
      })
    } else if (ownerRun.taskId !== artifact.taskId) {
      out.push({
        kind: 'artifact_run_mismatch',
        detail:
          `Artifact ${artifact.id} 声称属于 Task ${artifact.taskId}，` +
          `但它的 Run ${ownerRun.id} 属于 Task ${ownerRun.taskId}`,
      })
    }
  }

  for (const task of tasks.values()) {
    const runs = store.listRuns(task.id)
    runsByTask.set(task.id, runs)

    // ── Run ↔ Task ────────────────────────────────────
    for (const run of runs) {
      if (run.taskId !== task.id) {
        out.push({
          kind: 'run_task_mismatch',
          detail: `Run ${run.id} 的 taskId=${run.taskId}，但在 Task ${task.id} 下列出`,
        })
      }
    }

    // ── Artifact（按 Task 视角：产物归属与快照存在性）──
    for (const artifact of store.listTaskArtifacts(task.id)) {
      if (artifact.sourceSnapshotId && !store.getSnapshot(artifact.sourceSnapshotId)) {
        out.push({
          kind: 'artifact_orphan_snapshot',
          detail: `Artifact ${artifact.id} 指向不存在的快照 ${artifact.sourceSnapshotId}`,
        })
      }
    }

    // ── Acceptance ───────────────────────────────────
    for (const record of store.listAcceptances(task.id)) {
      if (record.taskId !== task.id) {
        out.push({
          kind: 'acceptance_task_mismatch',
          detail: `Acceptance ${record.id} 的 taskId=${record.taskId}，但挂在 Task ${task.id} 下`,
        })
      }
      const artifact = store.getArtifact(record.artifactId)
      if (!artifact || artifact.taskId !== record.taskId) {
        out.push({
          kind: 'acceptance_artifact_mismatch',
          detail: `Acceptance ${record.id} 指向的产物 ${record.artifactId} 不属于 Task ${record.taskId}`,
        })
      }
    }

    // ── Delivery ─────────────────────────────────────
    for (const delivery of store.listDeliveries(task.id)) {
      if (delivery.taskId !== task.id) {
        out.push({
          kind: 'delivery_task_mismatch',
          detail: `Delivery ${delivery.id} 的 taskId=${delivery.taskId}，但挂在 Task ${task.id} 下`,
        })
      }
    }
  }

  // ── 事件序号连续性（全部聚合类型）──────────────────
  //
  // 序号必须从 1 开始、逐条 +1。出现空洞说明有事件被删除或
  // 有人绕过 EventStore 直接写 SQL——两种情况都意味着
  // 「事实记录」不再可信。
  //
  // **早期只扫 run 聚合**，于是 task / artifact / review / delivery
  // 上的空洞完全查不到。而那些正是验收与交付的证据所在。
  //
  // 做法：按 (aggregateType, aggregateId) 分组，逐组核对。
  // 不依赖「先知道有哪些聚合 id」——从事件表自身反推，
  // 这样即使某个聚合的对象已被删除，它的历史事件仍会被检查。
  const byAggregate = new Map<string, { type: string; id: string; seqs: Array<{ seq: number; id: number }> }>()
  for (const e of store.listAllEvents()) {
    const key = `${e.aggregateType}\u0000${e.aggregateId}`
    let entry = byAggregate.get(key)
    if (!entry) {
      entry = { type: e.aggregateType, id: e.aggregateId, seqs: [] }
      byAggregate.set(key, entry)
    }
    entry.seqs.push({ seq: e.sequence, id: e.id })
  }

  for (const entry of byAggregate.values()) {
    // 按 sequence 排序后核对连续性
    entry.seqs.sort((a, b) => a.seq - b.seq)
    let expected = 1
    for (const item of entry.seqs) {
      if (item.seq !== expected) {
        out.push({
          kind: 'event_sequence_gap',
          detail:
            `${entry.type} ${entry.id} 的事件序号不连续：期望 ${expected}，` +
            `实际 ${item.seq}（事件 ${item.id}）`,
        })
        break
      }
      expected++
    }
  }

  return out
}
