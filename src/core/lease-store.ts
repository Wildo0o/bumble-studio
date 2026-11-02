// 数据库租约存储。
//
// 与 InMemoryLeaseStore 同一个接口，原子性由数据库保证。
//
// 核心要求（审计二轮 P0）：**epoch 必须严格单调**。
//
// epoch 是 fencing token：旧持有者用「我以为的 epoch」写状态，
// 数据库只在 epoch 未变时接受。如果 epoch 会回退或被复用，
// 旧持有者就能「恰好对上」并写入——fencing 完全失效。
//
// 三种会导致 epoch 回退的旧实现：
//   1. release 用 DELETE，重新 acquire 时 INSERT VALUES 1 → 回到 1
//   2. same owner 过期后重新 acquire 时 CASE 判 owner 相同 → 不加 epoch
//   3. （无关但相关）过期租约仍能 heartbeat 续活
//
// 现在：epoch 由一个全局单调计数器（meta 表里的 lease_epoch_counter）分配，
// 每次**真正换手**（无租约 / 已过期 / 被释放）都 +1，永不复用。
import type Database from 'better-sqlite3'
import type { Lease, LeaseStore } from './runner.js'

interface LeaseRow {
  owner: string
  expiresAt: number
  heartbeatAt: number
  epoch: number
}

export class SqliteLeaseStore implements LeaseStore {
  constructor(private readonly db: Database.Database) {}

  /** 分配一个新的（严格递增的）epoch。必须在事务内调用。 */
  private nextEpoch(): number {
    this.db
      .prepare('UPDATE lease_epoch_counter SET value = value + 1 WHERE id = 1')
      .run()
    const row = this.db
      .prepare('SELECT value AS v FROM lease_epoch_counter WHERE id = 1')
      .get() as { v: number } | undefined
    return Number(row?.v ?? 1)
  }

  /**
   * 获取 / 续期租约。
   *
   * 三种情况：
   *   · 无租约 / 已过期（无论 owner 是谁）→ **换手**：分配新 epoch
   *   · 自己持有且未过期                  → 续期：epoch 不变
   *   · 别人持有且未过期                  → 失败
   *
   * 「已过期时 same owner 也要新 epoch」是刻意的：
   *   过期意味着「这一代已经结束」，同一个进程继续执行也应该算新的一代。
   * 否则一次长时间挂起后，旧代码路径与新代码路径会共享 epoch。
   */
  tryAcquire(key: string, owner: string, ttlMs: number, now: number): Lease | undefined {
    const expiresAt = now + ttlMs

    return this.db.transaction((): Lease | undefined => {
      const existing = this.db
        .prepare(
          'SELECT owner, expires_at as expiresAt, heartbeat_at as heartbeatAt, acquisition_count as epoch FROM lease WHERE lease_key = ?',
        )
        .get(key) as LeaseRow | undefined

      const stillValid = existing !== undefined && existing.expiresAt > now
      if (stillValid && existing.owner !== owner) {
        // 别人持有且未过期
        return undefined
      }

      if (stillValid && existing.owner === owner) {
        // 自己持有且未过期 → 续期，epoch 不变
        this.db
          .prepare('UPDATE lease SET expires_at = ?, heartbeat_at = ? WHERE lease_key = ?')
          .run(expiresAt, now, key)
        return { owner, expiresAt, heartbeatAt: now, epoch: existing.epoch }
      }

      // 无租约 / 已过期 → 换手，分配新 epoch
      const epoch = this.nextEpoch()
      this.db
        .prepare(
          `INSERT INTO lease(lease_key, owner, expires_at, heartbeat_at, acquisition_count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(lease_key) DO UPDATE SET
             owner = excluded.owner,
             expires_at = excluded.expires_at,
             heartbeat_at = excluded.heartbeat_at,
             acquisition_count = excluded.acquisition_count`,
        )
        .run(key, owner, expiresAt, now, epoch)
      return { owner, expiresAt, heartbeatAt: now, epoch }
    })()
  }

  inspect(key: string): Lease | undefined {
    const row = this.db
      .prepare(
        'SELECT owner, expires_at as expiresAt, heartbeat_at as heartbeatAt, acquisition_count as epoch FROM lease WHERE lease_key = ?',
      )
      .get(key) as LeaseRow | undefined
    if (!row) return undefined
    return {
      owner: row.owner,
      expiresAt: row.expiresAt,
      heartbeatAt: row.heartbeatAt,
      epoch: row.epoch,
    }
  }

  /**
   * 心跳续期：owner、epoch 都必须匹配，**且租约尚未过期**。
   *
   * 为什么要检查过期：过期意味着「这一代已经结束」。
   * 允许过期租约续活，就等于让一个迟到的执行者把已经失效的租约
   * 复活——而另一个 owner 可能正在接管它。
   *
   * 用单条条件 UPDATE 实现，避免「读 epoch → 判断 → 写」的竞态。
   */
  heartbeat(key: string, owner: string, epoch: number, ttlMs: number, now: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE lease SET expires_at = ?, heartbeat_at = ?
         WHERE lease_key = ? AND owner = ? AND acquisition_count = ? AND expires_at > ?`,
      )
      .run(now + ttlMs, now, key, owner, epoch, now)
    return res.changes > 0
  }

  /** 当前 epoch。没有租约时为 0。 */
  currentEpoch(key: string): number {
    const row = this.db
      .prepare('SELECT acquisition_count AS n FROM lease WHERE lease_key = ?')
      .get(key) as { n: number } | undefined
    return row?.n ?? 0
  }

  /**
   * 主动释放（正常结束）。只释放自己持有的。
   *
   * 删掉这一行是安全的**因为 epoch 已改由全局计数器分配**：
   * 下一次 acquire 会拿到一个全新的、更大的 epoch，
   * 不会回到 1，也不会与已释放的那一代重合。
   */
  release(key: string, owner: string): boolean {
    const res = this.db
      .prepare('DELETE FROM lease WHERE lease_key = ? AND owner = ?')
      .run(key, owner)
    return res.changes > 0
  }

  /** 清理已经过期很久的租约行（避免表无限增长）。epoch 计数器不受影响。 */
  pruneExpired(now: number): number {
    const res = this.db.prepare('DELETE FROM lease WHERE expires_at < ?').run(now)
    return res.changes
  }
}
