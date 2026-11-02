// 无人值守运行器的编排循环。
//
// 每个 tick 做四件事：
//   1. 清理过期租约外的残留状态（崩溃接管）
//   2. 选一个可执行的任务
//   3. 抢租约
//   4. 评估暂停条件 → 执行或暂停
//
// 崩溃接管（crash takeover）放在这里而不是启动时：
//   无人值守运行器可能长时间运行，一次抢占发生在一小时前，
//   启动时清理只能处理「进程启动时已经在跑」的残局。
//   每个 tick 检查一次才能覆盖运行期间的崩溃。
import type { RunStatus } from '../shared/types.js'
import type { Store } from './store.js'
import {
  DEFAULT_LEASE_TTL_MS,
  evaluatePause,
  pickNextTask,
  type Lease,
  type LeaseStore,
  type PauseDecision,
  type SchedulableTask,
  type UnattendedPolicy,
} from './runner.js'
import { DomainError } from './errors.js'

/** 调度器需要的最小 Store 能力。 */
export interface RunnerStore {
  listRunsByStatus(status: RunStatus): Array<{
    id: string
    taskId: string
    status: RunStatus
    startedAt?: number
    endedAt?: number
  }>
  getTask(id: string): { id: string; status: string } | undefined
  setRunStatus(id: string, status: RunStatus): void
  /**
   * 把 Run 的 lease_epoch 换成新的一代（接管时用）。
   * 条件写：只有当前 epoch 与期望值不符时才会更新。
   */
  /** 读一个 Run（任意状态）。取消需要判断它当前在哪个状态。 */
  getRun(runId: string): { id: string; taskId: string; status: RunStatus; startedAt?: number; endedAt?: number } | undefined
  adoptRunEpoch(runId: string, newEpoch: number, replacingEpoch?: number): boolean
  /** CAS 状态迁移。返回 false 表示当前状态不在期望集合里。 */
  transitionRunStatus(id: string, from: RunStatus | RunStatus[], to: RunStatus): boolean
  appendEvent(
    runId: string,
    kind: string,
    payload: unknown,
    options?: { actor?: 'system' | 'user' | 'role' | 'coordinator' | 'provider'; correlationId?: string },
  ): unknown
  hasUnresolvedUnknown(runId: string): boolean
  /**
   * 把**指定 Run**停在 running 的 Step 标成 unknown。
   *
   * 必须按 Run 限定：全局清扫会把其他健康执行者正在进行的 Step
   * 一起标成 unknown，让它们看起来像崩过。
   */
  sweepStepsForRun(runId: string): Array<{ stepId: string; runId: string }>
  /** 把**指定 Run**停在 started 的 ToolIntent 标成 unknown。 */
  sweepIntentsForRun(runId: string): number
  /** 写入持久化取消意图。 */
  requestCancel(runId: string, requestedBy?: string, reason?: string): void
  /** 是否被请求取消（读持久化状态）。 */
  hasCancelIntent(runId: string): boolean
}

/**
 * 暂停原因 → 应该落到哪个 Run 状态。
 *
 * 返回 undefined 表示「不改状态」——那两种情形下 Run 本来就已经在
 * 正确的等待状态上（审批 / 对账），重复写只会制造噪音。
 *
 * 关键是**预算 / 期限 / 取消**这三类：它们原本只写一条事件，
 * 于是 Run 仍是 running，租约过期后会被重新排队执行——
 * 用户的策略被静默绕过。
 */
function pauseTargetStatus(reason: PauseDecision['reason']): RunStatus | undefined {
  switch (reason) {
    case 'waiting_approval':
    case 'needs_reconciliation':
      // 已经处在对应状态，不需要改
      return undefined
    case 'user_cancelled':
      return 'cancelled'
    case 'budget_exhausted':
    case 'deadline_exceeded':
      // **预算与期限是可恢复的暂停**，用 paused。
      //
      // 语义上它们不同于「失败太多」：
      //   · 用户给 Run 追加预算 / 延长期限之后，它应该能继续
      //   · paused 不在标准执行入口里，所以**不会**被自动重跑——
      //     这正是我们要的：必须有人明确 resume
      // 换句话说，paused 同时满足「不会被偷偷重跑」和「可以恢复」。
      return 'paused'
    case 'too_many_failures':
    case 'policy_blocked':
      // **失败过多 / 策略拦截是不可恢复的暂停**，用 failed。
      //
      // 为什么不用 paused：连续失败达上限说明这条路走不通，
      // 标成 paused 会让它看起来「只是暂时停下」，而 resume 之后
      // 大概率立刻再次失败——那只是把死循环拉长。
      // failed 是诚实的：需要人改点什么（换模型 / 改任务）才能重来。
      return 'failed'
    default:
      return undefined
  }
}

export interface TickResult {
  /** 这一轮选中的任务；没有可执行的为 undefined */
  selected?: string
  /** 是否抢到租约 */
  leased: boolean
  /** 暂停判定结果（未选中任务时 undefined） */
  decision?: PauseDecision
}

/**
 * 无人值守调度器。
 *
 * 刻意**不**自己执行 Run：执行需要 provider、工具、工作区……
 * 那些在服务层。这里只负责「什么时候该谁执行」。
 * 分开的好处是调度逻辑可以被完整测试，而不需要起一个真实模型。
 */
/**
 * 连续失败计数器。
 *
 * 为什么抽成接口（审计二轮 P1-4）：
 *   HTTP 的 /runner/tick 每次请求都新建一个 runner 实例，
 *   内存里的 Map 每次归零——「连续失败 3 次就停」这条策略
 *   在生产上永远不会触发。
 *
 *   可以用内存实现（单进程 / 测试），也可以换成持久化实现
 *   （跨请求、跨重启）。runner 只依赖这个接口。
 */
export interface FailureCounter {
  get(runId: string): number
  set(runId: string, count: number): void
  clear(runId: string): void
}

/** 默认实现：进程内 Map。 */
export class InMemoryFailureCounter implements FailureCounter {
  private map = new Map<string, number>()
  get(runId: string): number { return this.map.get(runId) ?? 0 }
  set(runId: string, count: number): void { this.map.set(runId, count) }
  clear(runId: string): void { this.map.delete(runId) }
}

/** 基于 Store 的持久化实现：重启后仍然记得。 */
export class StoreFailureCounter implements FailureCounter {
  constructor(private readonly store: FailureFailureStore) {}
  get(runId: string): number { return this.store.getFailureCount(runId) }
  set(runId: string, count: number): void { this.store.setFailureCount(runId, count) }
  clear(runId: string): void { this.store.setFailureCount(runId, 0) }
}

/** 持久化计数器需要的最小存储能力。 */
export interface FailureFailureStore {
  getFailureCount(runId: string): number
  setFailureCount(runId: number | string, count: number): void
}

export class UnattendedRunner {
  /** 连续失败计数。优先用注入实现（持久化），否则进程内 Map。 */
  private failures: FailureCounter = new InMemoryFailureCounter()

  /** 被请求取消的 Run。取消是**意图**，由下一次 tick 的暂停判定生效。 */
  private cancelling = new Set<string>()

  constructor(
    private readonly store: RunnerStore,
    private readonly leases: LeaseStore,
    private readonly owner: string,
    private readonly policy: UnattendedPolicy,
    private readonly options: {
      leaseTtlMs?: number
      /**
       * 失败计数器。省略时用进程内 Map。
       * HTTP tick 这类短生命周期调用必须传入持久化实现，
       * 否则「连续失败就停」永远不会触发。
       */
      failures?: FailureCounter
    } = {},
  ) {
    if (options.failures) this.failures = options.failures
  }

  private get ttl(): number {
    return this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  }

  /**
   * 崩溃接管：把停在 running 但没有活租约的 Run 降级。
   *
   * 为什么这里会「降级」而不是「继续跑」：
   *   没有活租约说明原来的执行者已经不在了。它的内部状态（走到第几步、
   *   正在做哪个工具调用）已经不可知。继续跑等于在一个未知状态上叠加。
   *   正确做法是标记出来，让人或对账流程处理。
   *
   * 与 recovery.ts 的 recoverOnStartup 的区别：
   *   那个在**启动时**跑一次，处理「上个进程崩了」；
   *   这个在**每次 tick**跑，处理「运行期间持有者崩了」。
   */
  takeOverStaleRuns(
    now = Date.now(),
    opts: { skipRunIds?: string[] } = {},
  ): Array<{ runId: string; reason: string }> {
    const taken: Array<{ runId: string; reason: string }> = []
    const skip = new Set(opts.skipRunIds ?? [])

    for (const run of this.store.listRunsByStatus('running')) {
      // 本次 tick 准备执行的 Run 不参与接管：
      // 它要么马上会被执行，要么由下面单独处理它的暂停条件。
      if (skip.has(run.id)) continue

      const key = `run:${run.id}`

      // 读一次只为「快速跳过明显活着的情况」，不作为判定依据。
      //
      // 为什么不能靠这次读做决定：`inspect` 与后面的清扫 / 改状态
      // 之间没有原子性。两个 runner 同时读到这里「已过期」，
      // 都会去清扫——而其中一个可能刚抢到租约正在执行。
      const peek = this.leases.inspect(key)
      if (peek && peek.expiresAt > now) continue

      // ── 关键：先抢到 takeover 权，再动任何状态 ──────────────
      //
      // tryAcquire 是原子 CAS：只有真正拿到租约的那个 runner 能继续。
      // 抢到之后，这个 Run 的清扫与状态修正就归本 owner 独占，
      // 另一个 runner 会在这里拿到 undefined 并直接跳过。
      //
      // 租约 TTL 用接管专用的短值：这是「我正在处理这个失联的 Run」，
      // 不是「我要执行它」，所以不需要长时间持有。
      const takeover = this.leases.tryAcquire(key, this.owner, this.ttl, now)
      if (!takeover) continue

      // ── 接管必须同时转移 epoch（审计二轮 P0）──────────────
      //
      // 只拿到租约是不够的：run.lease_epoch 仍是旧值，
      // 于是旧 owner 用「自己的 epoch」写入仍然匹配，fencing 失效；
      // 而新 owner 用新 epoch 反而写不进去。
      //
      // 所以接管的第一步就是把新 epoch 打到 Run 上。
      // 这一步用 fenced 写（要求当前 epoch 仍是旧的），
      // 保证两个 runner 同时接管时只有一个真正完成转移。
      // 为什么这里不传 replacingEpoch（无条件写）：
      //
      // 互斥性由**租约**保证，不由 epoch 比较保证。
      // 两个 runner 同时接管时，只有抢到租约的那个能走到这里；
      // 另一个在 tryAcquire 就返回 undefined 并跳过。
      // 所以走到这一步时，「当前 epoch 一定是我要替换的那个」——
      // 再加一层比较是冗余的，反而会让「同 owner 重复接管」失败。
      const transferred = this.store.adoptRunEpoch(run.id, takeover.epoch)
      if (!transferred) {
        // 别人先完成了转移：放弃本次接管，归还租约。
        this.leases.release(key, this.owner)
        continue
      }

      // 只有拿到了 takeover 权，才清扫与改状态。
      // sweepStepsForRun / sweepIntentsForRun 按 Run 限定，
      // 不会碰到其他 Run 的活跃 Step。
      this.store.sweepStepsForRun(run.id)
      this.store.sweepIntentsForRun(run.id)

      // 取消意图优先于「能不能重跑」。
      //
      // 先查取消：如果用户已经取消，即使这个 Run 没有任何 unknown 残留，
      // 也不能把它重新排队——那等于无视用户的决定。
      if (this.store.hasCancelIntent(run.id)) {
        const cancelWon = this.store.transitionRunStatus(run.id, 'running', 'cancelled')
        if (cancelWon) {
          this.store.appendEvent(
            run.id,
            'run.cancelled',
            { reason: '用户已请求取消；接管时不再重新排队', viaRunner: true },
            { actor: 'user', correlationId: run.id },
          )
          taken.push({ runId: run.id, reason: 'cancelled' })
        } else {
          this.leases.release(key, this.owner)
        }
        continue
      }

      const hasUnknown = this.store.hasUnresolvedUnknown(run.id)
      const target: RunStatus = hasUnknown ? 'needs_reconciliation' : 'queued'

      // 状态写入也必须是 CAS：如果期间有人（例如 cancel）把 Run
      // 改成了终态，这里就不能覆盖它。
      const moved = this.store.transitionRunStatus(run.id, 'running', target)
      if (!moved) {
        // 状态已被别人改动：放弃本次接管，把租约还回去，
        // 让下一个 tick 重新评估。
        this.leases.release(key, this.owner)
        continue
      }

      this.store.appendEvent(
        run.id,
        'run.status_recovered',
        {
          from: 'running',
          to: target,
          reason: hasUnknown
            ? '执行者已失联且存在未确认操作，需要人工对账'
            : '执行者已失联，没有未确认残留，重新排队',
          takenOverBy: this.owner,
          takeover: true,
        },
        { actor: 'system', correlationId: run.id },
      )
      taken.push({ runId: run.id, reason: target })

      // ── 成功接管后必须释放 takeover 租约（审计二轮 P1-2）──
      //
      // 不释放的后果：这个 Run 在剩余 TTL 内仍然显示「有人持有」。
      //   · 真正要执行它的 runner 抢不到租约，只能白等
      //   · 用户 resume 之后调度因为「租约被占」而跳过
      //
      // 此时状态已经稳定落定（queued / needs_reconciliation / cancelled），
      // 释放是安全的——下一次接管看到的是正确状态。
      this.leases.release(key, this.owner)
    }
    return taken
  }

  /**
   * 执行一次调度。
   *
   * @param execute 真正执行的回调。返回 'ok' / 'failed'。
   *                runner 不关心它内部做什么，只关心成败。
   */
  async tick(
    /**
     * 执行回调。
     *
     * 收到**已抢到的租约**：调用方必须复用它，不能再抢一次。
     * 同一个 owner 重复抢会得到假冲突（「已被其他执行者持有」），
     * 把正常执行挡掉——这是审计二轮 P1-3 的核心问题。
     */
    execute: (taskId: string, runId: string, lease: Lease) => Promise<'ok' | 'failed'>,
    candidates: SchedulableTask[],
    opts: {
      now?: number
      usage?: (runId: string) => { totalTokens: number; costUsd: number; steps: number }
      cancelRequested?: (runId: string) => boolean
    } = {},
  ): Promise<TickResult> {
    const now = opts.now ?? Date.now()

    const next = pickNextTask(candidates)

    // ── 接管顺序很重要 ────────────────────────────────────
    //
    // 不能先全局接管再选任务：那不是错，只是浪费——
    // 但更重要的是**必须排除本次要执行的 Run**：
    // 如果它此刻正处于 running（例如上一次执行者刚挂），
    // 先接管会把它降级成 queued，而下面又按 running 去找它，
    // 结果就是「选了它却找不到」，这一轮被静默跳过。
    //
    // 所以这里先确定要执行的 Run，再接管其余失联的。
    this.takeOverStaleRuns(now, { skipRunIds: next?.runId ? [next.runId] : [] })

    if (!next || !next.runId) return { selected: next?.taskId, leased: false }

    // ── 取消意图：先把状态落定，再决定要不要执行 ───────────
    //
    // 审计二轮 P1-1：queued 的 Run 有取消意图时，旧实现只是
    // 「拒绝执行」——它永远停在 queued，既不执行也不取消。
    // 用户看到的是一个「永远不会动」的任务，而且每次 tick 都会
    // 重新检查它一遍。
    //
    // 正确行为：取消意图一旦登记，就在下一次调度时**落实**成
    // cancelled（从 queued 或 running 都可以）。
    // 这个动作不需要租约：它是幂等的状态迁移，且 CAS 只从
    // 非终态出发，不会覆盖别人的终态。
    if (this.isCancelRequested(next.runId)) {
      const current = this.store.getRun?.(next.runId)
        ?? this.findRun(next.runId, next.taskId)
      const from = current?.status === 'running' ? 'running' : 'queued'
      const applied = this.store.transitionRunStatus(next.runId, from, 'cancelled')
      if (applied && current) {
        this.store.appendEvent(
          next.runId,
          'run.cancelled',
          { reason: '用户已请求取消', viaRunner: true },
          { actor: 'user', correlationId: next.runId },
        )
      }
      return { selected: next.taskId, leased: false }
    }

    // ── 取消意图的兜底检查 ────────────────────────────────
    //
    // 候选集合构造时已经过滤过一遍，但那是**调用方**的职责。
    // runner 自己也必须查一遍：
    //   · 候选可能是外部传入的（HTTP body / 脚本）
    //   · 从构造候选到真正执行之间，用户可能刚点了取消
    //
    // 关键：**不是直接 return**，而是走 pause 分支。
    //   直接 return 会让 Run 停在原状态，取消这个动作就没有落点；
    //   走 pause 分支才能把状态改成 cancelled（见 pauseTargetStatus）。

    const run = this.store.listRunsByStatus('running').find((r) => r.id === next.runId)
      ?? this.findRun(next.runId, next.taskId)
    if (!run) {
      return { selected: next.taskId, leased: false }
    }

    // 抢租约。抢不到说明别的 runner 正在处理它。
    const lease: Lease | undefined = this.leases.tryAcquire(
      `run:${run.id}`,
      this.owner,
      this.ttl,
      now,
    )
    if (!lease) {
      return { selected: next.taskId, leased: false }
    }

    const decision = evaluatePause({
      run: { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt },
      now,
      policy: this.policy,
      consecutiveFailures: this.failures.get(run.id),
      usage: opts.usage?.(run.id) ?? { totalTokens: 0, costUsd: 0, steps: 0 },
      // 取消意图在上面已经落实成 cancelled；到这里还没有的话，
      // 就尊重调用方注入的值（测试用）。
      cancelRequested: opts.cancelRequested?.(run.id) ?? false,
    })

    if (decision.shouldPause) {
      // ── 暂停必须持久化到 Run 状态，不能只写一条事件 ─────────
      //
      // 只写事件时，「暂停」只是一个历史事实——租约到期后下一个
      // runner 会看到 Run 仍是 running，把它接管成 queued 并重新执行。
      // 用户的暂停 / 预算耗尽 / 连续失败上限全都被绕过。
      //
      // 所以这里把状态也改掉（CAS，只从 running 出发），
      // 让「暂停」成为一个后续调度必须尊重的状态：
      //   · 等待审批 / 对账  → 用对应的专门状态（它们本来就不会被自动重跑）
      //   · 其它（预算 / 期限 / 取消）→ paused
      const target = pauseTargetStatus(decision.reason)
      if (target) {
        this.store.transitionRunStatus(run.id, 'running', target)
      }

      this.store.appendEvent(
        run.id,
        'run.paused',
        {
          reason: decision.reason,
          detail: decision.detail,
          unattended: true,
          statusApplied: target ?? null,
        },
        { actor: 'system', correlationId: run.id },
      )

      // ── 暂停分支必须释放租约 ──────────────────────────
      //
      // 审计 C-7：暂停后不释放会让这个 Run 在剩余 TTL 内看起来
      // 「有人在处理」，于是：
      //   · 用户 resume 之后，调度会因为「租约被占」而跳过它
      //   · 真正的崩溃接管要白等一个 TTL
      //
      // 释放是安全的：状态已经落到终态或 paused，
      // 后续无论是 resume 还是接管，读到的都是正确的状态。
      this.leases.release(`run:${run.id}`, this.owner)
      return { selected: next.taskId, leased: true, decision }
    }

    let threw = false
    try {
      const outcome = await execute(next.taskId, run.id, lease)
      if (outcome === 'ok') {
        this.failures.clear(run.id)
      } else {
        this.failures.set(run.id, (this.failures.get(run.id)) + 1)
      }
      return { selected: next.taskId, leased: true, decision }
    } catch (err) {
      // 执行抛错也算一次失败：不确定性比「明确失败」更该被计入，
      // 否则一个每次都抛错的 Run 永远不会触发「连续失败」暂停。
      this.failures.set(run.id, (this.failures.get(run.id)) + 1)
      threw = true
      // ── 执行前失败必须立即释放租约（L2 Task 1）──────────
      //
      // 区分两种抛错：
      //   · **执行前**失败（provider 解析 / 能力门 / 参数校验）：
      //     Run 状态没被动过，持有租约只会让它白等一个 TTL 才能重试。
      //     这正是「执行前校验错误后 lease 能立即重试」的要求。
      //   · **执行中**抛错：可能已有外部副作用，不能立刻释放让别人
      //     接管并重复执行。让租约自然过期更安全。
      //
      // 判据：Run 是否真的进入了 running。执行前失败时它仍是 queued。
      const currentStatus = this.store.getRun(run.id)?.status
      if (currentStatus !== undefined && currentStatus !== 'running') {
        this.leases.release(`run:${run.id}`, this.owner)
      }
      throw err
    } finally {
      // 正常返回（成功或明确失败）才释放租约。
      // 抛错时不释放——让租约自然过期。理由：
      //   抛错意味着执行过程中断了，Run 的实际状态可能不一致。
      //   立即释放会让下一个 tick 马上接管并重复执行。
      //   宁可多等一个 TTL，也不要重复执行。
      if (!threw) this.leases.release(`run:${run.id}`, this.owner)
    }
  }

  /**
   * 主动请求取消。
   *
   * 写入**持久化**的取消意图，而不是只记在内存 Set 里。
   *
   * 为什么这一点很关键：取消意图如果只存在进程内存里，
   * 那么「用户点了取消 → runner 重启 / 租约过期 → 另一个 runner 接管」
   * 这条路径上，取消就消失了，Run 被重新排队并再次执行——
   * 用户的决定被技术细节吞掉。
   *
   * 引擎侧（UnattendedRunner.tick）与执行侧（executor.cancel）
   * 都会读这张表。
   */
  requestCancel(runId: string, requestedBy = 'user', reason = '用户请求取消'): void {
    this.store.requestCancel(runId, requestedBy, reason)
    this.cancelling.add(runId)
  }

  /** 是否被请求取消。读持久化状态，内存 Set 只作快速路径。 */
  isCancelRequested(runId: string): boolean {
    return this.cancelling.has(runId) || this.store.hasCancelIntent(runId)
  }

  private findRun(runId: string, taskId: string): {
    id: string
    taskId: string
    status: RunStatus
    startedAt?: number
    endedAt?: number
  } | undefined {
    const task = this.store.getTask(taskId)
    if (!task) return undefined
    // 通过状态查询覆盖不到 queued 的 Run（那是「待执行」），
    // 这里按 id 在 queued 列表里再找一次。
    return this.store
      .listRunsByStatus('queued')
      .find((r) => r.id === runId && r.taskId === taskId)
  }
}

/** 从 Store 构造 runner（生产路径用）。 */
export function createRunner(
  store: Store,
  owner: string,
  policy: UnattendedPolicy,
  leases: LeaseStore,
): UnattendedRunner {
  if (!owner.trim()) throw new DomainError('INVALID_INPUT', 'runner 的 owner 标识不能为空')
  return new UnattendedRunner(store, leases, owner, policy)
}
