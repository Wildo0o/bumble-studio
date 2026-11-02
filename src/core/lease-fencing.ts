// 租约 fencing：把「谁有权写」变成可判定的事。
//
// 问题：TTL 到期不等于执行者死了。
//
//   一次长时间模型调用 / 工具执行可能超过 TTL，但它仍然是健康的。
//   如果只靠 TTL 判定，会出现这条时间线：
//     t=0    A 抢到租约（epoch=1），开始一次 90s 的模型调用
//     t=60   租约到期（TTL=60s）
//     t=61   B 接管，epoch=2，把 Run 重新排队并开始执行
//     t=90   A 的调用返回，A 写入 completed 和事件
//     t=91   B 也在写 —— 两份状态打架，工具可能被执行两遍
//
// 解法：epoch（fencing token）。
//
//   写的语句带上「我以为的 epoch」。数据库只在 epoch 未变时接受：
//     UPDATE run SET status=? WHERE id=? AND ... AND lease_epoch=?
//   A 的 epoch=1 已经被 B 改成 2，所以 A 的写入**必然失败**。
//   A 拿到失败就知道「我不是这一代了」，停止一切写入。
//
// 为什么不用「更长的 TTL」：那只是把窗口推远，跑得够久仍然会撞上。
// 而且长 TTL 会让真正的崩溃恢复等待更久。

import type { Lease, LeaseStore } from './runner.js'

/** 一次执行持有的 fencing 凭据。 */
export interface FencingToken {
  key: string
  owner: string
  epoch: number
}

/**
 * 执行期租约守卫。
 *
 * 职责：
 *   1. 定期心跳续期（避免健康的长调用被误判为死亡）
 *   2. 提供 `assertValid()` 给写操作前调用
 *   3. 心跳失败时立即标记失效，后续写入全部拒绝
 */
export class LeaseGuard {
  private timer: ReturnType<typeof setInterval> | undefined
  private lost = false
  private lostReason: string | undefined

  constructor(
    private readonly leases: LeaseStore,
    readonly token: FencingToken,
    private readonly ttlMs: number,
    private readonly heartbeatIntervalMs: number = Math.max(1000, Math.floor(ttlMs / 3)),
  ) {}

  /** 开始心跳。 */
  start(now: () => number = Date.now): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const ok = this.leases.heartbeat(
        this.token.key,
        this.token.owner,
        this.token.epoch,
        this.ttlMs,
        now(),
      )
      if (!ok) {
        // 续期失败 = 有人接管了（epoch 变了）或租约被删除。
        // 无论哪种，我都已经不是这一代，必须停止写入。
        this.lost = true
        this.lostReason ??= '租约续期失败：已被其他执行者接管'
        this.stop()
      }
    }, this.heartbeatIntervalMs)
    // 不要让心跳阻止进程退出
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 是否仍然持有这一代租约。 */
  get isValid(): boolean {
    return !this.lost
  }

  get invalidReason(): string | undefined {
    return this.lostReason
  }

  /**
   * 写操作前的校验。
   *
   * 这是**权威判断**，同时检查三件事（审计二轮 P0）：
   *   1. 本地是否已被标记失效（心跳失败 / 上一次校验失败）
   *   2. 数据库里的 epoch 是否仍是我们的
   *   3. 数据库里的 owner 是否仍是我们
   *   4. **租约是否尚未过期**
   *
   * 为什么必须查过期：只比 epoch 会漏掉「租约到期但还没人接管」
   * 的窗口。那段时间里旧持有者看起来仍然合法，但另一个执行者
   * 随时可以接管——写入可能落在接管之后，污染新 owner 的状态。
   *
   * @param at 时间点。默认 Date.now()；测试可注入。
   */
  assertValid(at: number = Date.now()): void {
    if (this.lost) {
      throw new LeaseLostError(this.token, this.lostReason ?? '租约已失效')
    }

    const current = this.leases.inspect(this.token.key)
    if (!current) {
      this.lost = true
      this.lostReason = '租约已被释放或删除'
      throw new LeaseLostError(this.token, this.lostReason)
    }
    if (current.owner !== this.token.owner) {
      this.lost = true
      this.lostReason = `owner 已从 ${this.token.owner} 变为 ${current.owner}：被其他执行者接管`
      throw new LeaseLostError(this.token, this.lostReason)
    }
    if (current.epoch !== this.token.epoch) {
      this.lost = true
      this.lostReason = `epoch 已从 ${this.token.epoch} 变为 ${current.epoch}：被其他执行者接管`
      throw new LeaseLostError(this.token, this.lostReason)
    }
    if (current.expiresAt <= at) {
      this.lost = true
      this.lostReason = '租约已过期且未续期：随时可能被接管'
      throw new LeaseLostError(this.token, this.lostReason)
    }
  }

  /** 不抛错的版本，供「可以安全跳过写入」的场景使用。 */
  check(at: number = Date.now()): boolean {
    try {
      this.assertValid(at)
      return true
    } catch {
      return false
    }
  }
}

/** 租约已被接管。调用方必须停止写入并如实报告。 */
export class LeaseLostError extends Error {
  readonly token: FencingToken

  constructor(token: FencingToken, message: string) {
    super(
      `租约已失效（${token.key} / epoch ${token.epoch}）：${message}。` +
      '另一个执行者已经接管这个 Run，本次执行的结果不会被采纳。',
    )
    this.name = 'LeaseLostError'
    this.token = token
  }
}

/** 从租约构造守卫。 */
export function guardFor(
  leases: LeaseStore,
  key: string,
  lease: Lease,
  ttlMs: number,
): LeaseGuard {
  return new LeaseGuard(leases, { key, owner: lease.owner, epoch: lease.epoch }, ttlMs)
}
