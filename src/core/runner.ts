// 无人值守运行器。
//
// 问题：没人在看着的时候，谁来决定「下一个做什么、什么时候放弃」？
//
// 三个必须解决的风险：
//
// 1. **两个执行者同时跑同一个任务。**
//    两个进程（或一个进程的两次调度）都以为自己在跑，会重复执行工具调用。
//    解：lease（租约）。抢租约是原子的 CAS，拿到才执行，且有有效期。
//
// 2. **执行者死了但没人知道。**
//    进程崩溃后租约不会自动释放，任务会永远「有人在跑」。
//    解：heartbeat（心跳）。超过宽限期没心跳 = 租约失效，可以被接管。
//
// 3. **无人在场时它无限跑下去。**
//    预算、期限、连续失败次数、需要审批——任何一条都该让它停下来等人。
//    解：暂停条件（pause conditions）是一组**声明式**规则，
//    由检查函数统一评估，而不是散落在各处的 if。
//
// 设计取舍：调度**不排队、不重试**。
// 每次 tick 只做「找出可执行的任务 → 抢租约 → 执行」。
// 失败就是失败，由暂停条件决定要不要继续。
// 自动重试在无人值守场景下是危险的：它会把一个必然失败的循环
// 变成一个持续消耗预算的循环。
import type { RunStatus } from '../shared/types.js'
import { DomainError } from './errors.js'

/** 租约。 */
export interface Lease {
  /** 租约的持有者。必须是稳定标识（进程 id + 实例 id），不是请求 id。 */
  owner: string
  /** 什么时候过期。到期后可被其他 owner 接管。 */
  expiresAt: number
  /** 最近一次心跳 */
  heartbeatAt: number
  /**
   * Epoch / fencing token。
   *
   * 每次**换主人**（含过期后接管）时 +1，同一 owner 续期时不变。
   *
   * 它是「这次执行属于哪一代」的唯一凭据：
   *   持有 epoch=3 的执行者写状态时带上 3；数据库只接受
   *   「当前 epoch 仍是 3」的写入。接管发生后 epoch 变成 4，
   *   旧执行者的所有写入都会被拒绝——**即使它的租约看起来还没过期**。
   *
   * 为什么必须有它（而不是只靠 TTL）：
   *   TTL 到期不等于执行者死了。一次长时间模型调用 / 工具执行
   *   可能超过 TTL，而它仍然是健康的。只靠 TTL 会出现
   *   「第二个 runner 合法接管 → 旧执行者写完 → 两份状态打架」。
   *   epoch 让「谁有权写」变成可判定的事，而不是时间竞赛。
   */
  epoch: number
}

/**
 * LeaseStore：租约的持久化接口。
 *
 * 只有 `tryAcquire` 一个写操作，且必须是原子 CAS：
 *   · 没有租约 → 获取
 *   · 租约已过期 → 抢过来（acquisitionCount + 1）
 *   · 租约被自己持有 → 续期
 *   · 租约被别人持有且未过期 → 失败
 */
export interface LeaseStore {
  /**
   * 尝试获取 / 续期租约。
   * @returns 成功时返回租约；失败（被别人持有）返回 undefined
   */
  tryAcquire(key: string, owner: string, ttlMs: number, now: number): Lease | undefined
  /** 读当前租约（不修改） */
  inspect(key: string): Lease | undefined
  /** 主动释放（正常结束）。只释放自己持有的。 */
  release(key: string, owner: string): boolean
  /**
   * 心跳续期。只有 owner 与 epoch 都匹配时才成功。
   *
   * @returns false 表示「我已经不是这一代的持有者」——必须立即停止写入
   */
  heartbeat(key: string, owner: string, epoch: number, ttlMs: number, now: number): boolean
  /** 当前 epoch（没有租约时为 0）。 */
  currentEpoch(key: string): number
}

export const DEFAULT_LEASE_TTL_MS = 60_000

/**
 * 心跳宽限期。
 *
 * 为什么心跳与租约到期分开：
 *   · 租约到期 = 「可以被接管」
 *   · 心跳宽限 = 「多久没动静算真死了」
 * 如果两者相同，一次网络抖动就会让健康执行者被接管，
 * 而接管者会**重复执行**正在进行的工具调用。
 * 宽限期内租约仍有效，只是标记「可疑」。
 */
export const DEFAULT_HEARTBEAT_GRACE_MS = 15_000

/** 无人值守策略。 */
export interface UnattendedPolicy {
  /** 最多连续几次失败后自动暂停 */
  maxConsecutiveFailures: number
  /** 单次运行最长时长 */
  maxRunDurationMs: number
  /**
   * 是否允许自动批准审批。
   *
   * 默认 false，而且**不提供「全自动批准」选项**——
   * 那等于把审批门禁关掉。允许的自动化只有「拒绝」：
   * 无人值守时超时审批按 fail-closed 拒绝（这一点已由内核保证）。
   */
  autoApprove: false
  /** 预算上限（与 Run 预算合并取严） */
  budget: {
    maxTotalTokens?: number
    maxCostUsd?: number
    maxSteps?: number
  }
}

export const DEFAULT_UNATTENDED_POLICY: UnattendedPolicy = {
  maxConsecutiveFailures: 3,
  maxRunDurationMs: 30 * 60 * 1000,
  autoApprove: false,
  budget: {},
}

/** 暂停原因。 */
export type PauseReason =
  | 'waiting_approval'
  | 'needs_reconciliation'
  | 'budget_exhausted'
  | 'deadline_exceeded'
  | 'too_many_failures'
  | 'user_cancelled'
  | 'policy_blocked'

export interface PauseDecision {
  shouldPause: boolean
  reason?: PauseReason
  detail?: string
}

/** 评估暂停条件所需的上下文。 */
export interface PauseContext {
  run: { status: RunStatus; startedAt?: number; endedAt?: number }
  now: number
  policy: UnattendedPolicy
  /** 连续失败次数（调度器维护） */
  consecutiveFailures: number
  usage: { totalTokens: number; costUsd: number; steps: number }
  /** 用户是否请求了取消 */
  cancelRequested: boolean
}

/**
 * 评估是否应该暂停。
 *
 * **纯函数**：输入全部显式给出，不读全局状态、不看时钟。
 * 这样每个条件都能单独测试，也能在离线 replay 里重新评估
 * 「当时为什么停下」。
 *
 * 顺序有意义：越「硬」的条件越先判定。
 * 用户取消 > 需要审批 > 需要对账 > 预算 > 期限 > 失败次数。
 */
export function evaluatePause(ctx: PauseContext): PauseDecision {
  if (ctx.cancelRequested) {
    return { shouldPause: true, reason: 'user_cancelled', detail: '用户请求取消' }
  }
  if (ctx.run.status === 'waiting_approval') {
    return {
      shouldPause: true,
      reason: 'waiting_approval',
      detail: '等待用户审批；无人值守模式下不会自动批准',
    }
  }
  if (ctx.run.status === 'needs_reconciliation') {
    return {
      shouldPause: true,
      reason: 'needs_reconciliation',
      detail: '存在未确认的外部操作，必须人工对账',
    }
  }

  const b = ctx.policy.budget
  if (b.maxTotalTokens !== undefined && ctx.usage.totalTokens >= b.maxTotalTokens) {
    return {
      shouldPause: true,
      reason: 'budget_exhausted',
      detail: `已用 ${ctx.usage.totalTokens} tokens，达到上限 ${b.maxTotalTokens}`,
    }
  }
  if (b.maxCostUsd !== undefined && ctx.usage.costUsd >= b.maxCostUsd) {
    return {
      shouldPause: true,
      reason: 'budget_exhausted',
      detail: `已花费 $${ctx.usage.costUsd.toFixed(4)}，达到上限 $${b.maxCostUsd}`,
    }
  }
  if (b.maxSteps !== undefined && ctx.usage.steps >= b.maxSteps) {
    return {
      shouldPause: true,
      reason: 'budget_exhausted',
      detail: `已执行 ${ctx.usage.steps} 步，达到上限 ${b.maxSteps}`,
    }
  }

  if (ctx.run.startedAt !== undefined) {
    const elapsed = ctx.now - ctx.run.startedAt
    if (elapsed >= ctx.policy.maxRunDurationMs) {
      return {
        shouldPause: true,
        reason: 'deadline_exceeded',
        detail: `已运行 ${Math.round(elapsed / 1000)} 秒，超过上限 ${Math.round(ctx.policy.maxRunDurationMs / 1000)} 秒`,
      }
    }
  }

  if (ctx.consecutiveFailures >= ctx.policy.maxConsecutiveFailures) {
    return {
      shouldPause: true,
      reason: 'too_many_failures',
      detail: `连续失败 ${ctx.consecutiveFailures} 次，达到上限 ${ctx.policy.maxConsecutiveFailures}`,
    }
  }

  return { shouldPause: false }
}

/** 租约是否「可疑」（仍有效但已超过心跳宽限期）。 */
export function isLeaseSuspicious(lease: Lease, now: number, graceMs = DEFAULT_HEARTBEAT_GRACE_MS): boolean {
  if (lease.expiresAt <= now) return false   // 已过期，不是「可疑」而是「可接管」
  return now - lease.heartbeatAt > graceMs
}

/**
 * 判断一个租约能否被接管。
 *
 * 只有**已过期**才能接管。可疑但未过期时不能——那是活着的执行者，
 * 接管会导致重复执行同一批工具调用。
 */
export function canTakeOver(lease: Lease | undefined, now: number): boolean {
  if (!lease) return true
  return lease.expiresAt <= now
}

// ── 内存租约存储（默认实现，也用于测试）────────────────────

/**
 * 内存租约存储。
 *
 * 注意：这是**单进程**实现。多进程场景需要换成数据库实现
 * （同样的 CAS 语义，只是原子性由数据库行锁保证）。
 * 接口刻意设计成可在两种实现间切换。
 */
/**
 * 租约 owner 标识。
 *
 * **必须唯一**：只用 `http:${pid}` 时，同一进程里两个 server 实例
 * （集成测试常见，生产也可能）会得到相同 owner，于是：
 *   · 实例 A 的租约被实例 B 误认为是「自己的」
 *   · B 续期成功、A 的 fencing 校验也通过
 * 两个执行者共享同一代租约，fencing 形同虚设。
 *
 * 所以 owner = `<kind>:<pid>:<nonce>`，nonce 每次创建实例都不同。
 */
export function newLeaseOwner(kind: string): string {
  // 不用 crypto 的完整 UUID：这里只需要「同进程内唯一」，
  // 而 randomUUID 在部分运行时上较慢（每次调用都走系统熵源）。
  const nonce =
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(-4)
  return `${kind}:${process.pid}:${nonce}`
}

export class InMemoryLeaseStore implements LeaseStore {
  private leases = new Map<string, Lease>()
  /**
   * 全局单调 epoch 计数器。
   *
   * 与 DB 实现同理：epoch 不能从「行是否存在」推导，
   * 否则 release 后重新 acquire 会回到 1。
   */
  private epochCounter = 0

  tryAcquire(key: string, owner: string, ttlMs: number, now: number): Lease | undefined {
    const existing = this.leases.get(key)
    const expired = existing === undefined || existing.expiresAt <= now

    if (!expired && existing.owner !== owner) {
      // 别人持有且未过期
      return undefined
    }

    const expiresAt = now + ttlMs

    if (!expired && existing.owner === owner) {
      // 自己持有且未过期 → 续期，epoch 不变
      const renewed: Lease = {
        owner,
        expiresAt,
        heartbeatAt: now,
        epoch: existing.epoch,
      }
      this.leases.set(key, renewed)
      return renewed
    }

    // 无租约 / 已过期 → 换手，分配新 epoch
    this.epochCounter += 1
    const lease: Lease = { owner, expiresAt, heartbeatAt: now, epoch: this.epochCounter }
    this.leases.set(key, lease)
    return lease
  }

  heartbeat(key: string, owner: string, epoch: number, ttlMs: number, now: number): boolean {
    const existing = this.leases.get(key)
    if (!existing) return false
    if (existing.owner !== owner) return false
    if (existing.epoch !== epoch) return false
    // 过期租约不能续活
    if (existing.expiresAt <= now) return false
    this.leases.set(key, { ...existing, expiresAt: now + ttlMs, heartbeatAt: now })
    return true
  }

  currentEpoch(key: string): number {
    return this.leases.get(key)?.epoch ?? 0
  }

  inspect(key: string): Lease | undefined {
    return this.leases.get(key)
  }

  release(key: string, owner: string): boolean {
    const existing = this.leases.get(key)
    if (!existing || existing.owner !== owner) return false
    this.leases.delete(key)
    return true
  }
}

// ── 调度计划 ───────────────────────────────────────────────

/** 一个可执行的候选（调度器的输入）。 */
export interface SchedulableTask {
  taskId: string
  runId?: string
  /** 优先级：数字越大越先执行。 */
  priority: number
  /** 是否满足前置条件（例如工作包已就绪）。 */
  eligible: boolean
}

/**
 * 选择这一轮要执行的任务。
 *
 * 规则：
 *   · 只考虑 eligible
 *   · 按 priority 降序，相同优先级按 taskId 稳定排序
 *   · 一次只取一个 —— 并发由多个 runner 抢租约实现，
 *     而不是由单个 runner 同时跑多个（那会让暂停条件难以判断）
 *
 * 为什么「一次一个」：无人值守场景下，同时跑多个任务时
 * 「连续失败次数」和「预算」的归属会变得模糊。
 * 一个任务一个任务推进，状态是清晰的。
 */
export function pickNextTask(candidates: SchedulableTask[]): SchedulableTask | undefined {
  const sorted = candidates
    .filter((c) => c.eligible)
    .sort((a, b) => b.priority - a.priority || a.taskId.localeCompare(b.taskId))
  return sorted[0]
}

// ── 策略校验 ───────────────────────────────────────────────

/**
 * 校验无人值守策略。
 *
 * 关键：**拒绝 autoApprove: true**。
 * 允许它等于把「用户审批」这道门禁在无人值守时关掉，
 * 而这正是最需要它的时候。
 */
export function validateUnattendedPolicy(input: Record<string, unknown>): UnattendedPolicy {
  if (input.autoApprove === true) {
    throw new DomainError(
      'INVALID_INPUT',
      '无人值守模式下不允许 autoApprove：' +
      '那会在没有人在场时关掉审批门禁。允许的自动化只有超时按 fail-closed 拒绝。',
    )
  }

  const policy: UnattendedPolicy = { ...DEFAULT_UNATTENDED_POLICY, budget: {} }

  if (input.maxConsecutiveFailures !== undefined) {
    const v = Number(input.maxConsecutiveFailures)
    if (!Number.isInteger(v) || v < 1) {
      throw new DomainError('INVALID_INPUT', 'maxConsecutiveFailures 必须是 >= 1 的整数')
    }
    policy.maxConsecutiveFailures = v
  }

  if (input.maxRunDurationMs !== undefined) {
    const v = Number(input.maxRunDurationMs)
    if (!Number.isFinite(v) || v < 1000) {
      throw new DomainError('INVALID_INPUT', 'maxRunDurationMs 必须 >= 1000')
    }
    policy.maxRunDurationMs = v
  }

  const rawBudget = input.budget
  if (rawBudget !== undefined) {
    if (typeof rawBudget !== 'object' || rawBudget === null) {
      throw new DomainError('INVALID_INPUT', 'budget 必须是对象')
    }
    const rb = rawBudget as Record<string, unknown>
    for (const key of ['maxTotalTokens', 'maxCostUsd', 'maxSteps'] as const) {
      if (rb[key] === undefined) continue
      const v = Number(rb[key])
      if (!Number.isFinite(v) || v < 0) {
        throw new DomainError('INVALID_INPUT', `budget.${key} 必须是非负有限数`)
      }
      policy.budget[key] = v
    }
  }

  return policy
}
