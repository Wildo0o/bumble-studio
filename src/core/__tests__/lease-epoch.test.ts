// 租约 epoch 单调性与 fencing 守卫（审计二轮 P0）。
//
// 三条真实旧 bug：
//   1. release 是 DELETE，重新 acquire 时 INSERT VALUES 1 → epoch 回到 1
//   2. same owner 过期后重新 acquire，CASE 判 owner 相同 → 不加 epoch
//   3. 过期租约仍能 heartbeat 续活（旧实现只比 owner/epoch，不看 expires_at）
//
// epoch 不单调 = fencing 失效：旧持有者可能拿到「同一个 epoch」，
// 它的写入会被误认为合法。这是本轮最严重的一类问题。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { guardFor } from '../lease-fencing.js'
import { InMemoryLeaseStore, newLeaseOwner } from '../runner.js'

describe('epoch 单调性（DB 实现）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-epoch-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('release 后重新 acquire 必须得到更大的 epoch', () => {
    const l1 = leases.tryAcquire('k', 'A', 1000, 0)!
    expect(l1.epoch).toBe(1)
    expect(leases.release('k', 'A')).toBe(true)

    const l2 = leases.tryAcquire('k', 'B', 1000, 10)!
    expect(l2.epoch).toBeGreaterThan(1)
  })

  it('same owner 在租约过期后重新 acquire 必须产生新 epoch', () => {
    const l1 = leases.tryAcquire('k', 'A', 1000, 0)!
    expect(l1.epoch).toBe(1)
    // 不心跳，等到过期，同一个 owner 再抢
    const l2 = leases.tryAcquire('k', 'A', 1000, 5000)!
    expect(l2.epoch).toBeGreaterThan(l1.epoch)
  })

  it('same owner 未过期时续期不改变 epoch', () => {
    const l1 = leases.tryAcquire('k', 'A', 1000, 0)!
    const l2 = leases.tryAcquire('k', 'A', 1000, 500)!
    expect(l2.epoch).toBe(l1.epoch)
  })

  it('已过期的租约不能 heartbeat 续活', () => {
    const l = leases.tryAcquire('k', 'A', 1000, 0)!
    expect(leases.heartbeat('k', 'A', l.epoch, 1000, 500)).toBe(true)
    // 超过 expiresAt（= now + ttl）之后再心跳必须失败
    expect(leases.heartbeat('k', 'A', l.epoch, 1000, 999_999)).toBe(false)
  })

  it('反复 release / acquire，epoch 严格递增', () => {
    let last = 0
    for (let i = 0; i < 5; i++) {
      const l = leases.tryAcquire('k', `owner-${i}`, 100, i * 1000)!
      expect(l.epoch).toBeGreaterThan(last)
      last = l.epoch
      leases.release('k', `owner-${i}`)
    }
  })

  it('交接给第三方时 epoch 也递增（不会因为删行而从 1 开始）', () => {
    const a = leases.tryAcquire('k', 'A', 100, 0)!
    leases.tryAcquire('k', 'B', 100, 1000)!
    leases.release('k', 'B')
    const c = leases.tryAcquire('k', 'C', 100, 2000)!
    expect(c.epoch).toBeGreaterThan(a.epoch)
  })
})

describe('epoch 单调性（内存实现同样语义）', () => {
  it('release 后重新 acquire 得到更大 epoch', () => {
    const s = new InMemoryLeaseStore()
    const l1 = s.tryAcquire('k', 'A', 1000, 0)!
    s.release('k', 'A')
    const l2 = s.tryAcquire('k', 'B', 1000, 10)!
    expect(l2.epoch).toBeGreaterThan(l1.epoch)
  })

  it('same owner 过期后重新 acquire 产生新 epoch', () => {
    const s = new InMemoryLeaseStore()
    const l1 = s.tryAcquire('k', 'A', 1000, 0)!
    const l2 = s.tryAcquire('k', 'A', 1000, 5000)!
    expect(l2.epoch).toBeGreaterThan(l1.epoch)
  })

  it('过期租约不能 heartbeat', () => {
    const s = new InMemoryLeaseStore()
    const l = s.tryAcquire('k', 'A', 1000, 0)!
    expect(s.heartbeat('k', 'A', l.epoch, 1000, 5000)).toBe(false)
  })
})

describe('LeaseGuard 同时校验 owner / epoch / 未过期', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-guard3-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('租约过期后守卫失效（epoch 与 owner 都没变）', () => {
    const l = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', l, 1000)
    expect(guard.check(0)).toBe(true)
    // 时间推到过期之后，且没有心跳
    expect(guard.check(5000)).toBe(false)
  })

  it('owner 变了守卫失效', () => {
    const l = leases.tryAcquire('k', 'A', 60_000, 0)!
    const guard = guardFor(leases, 'k', l, 60_000)
    leases.tryAcquire('k', 'B', 60_000, 100_000)
    expect(guard.check(100_000)).toBe(false)
  })

  it('epoch 变了守卫失效（即使 owner 名字相同）', () => {
    const l = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', l, 1000)
    // 同 owner 过期重获 → epoch 增加
    leases.tryAcquire('k', 'A', 1000, 10_000)
    expect(guard.check(10_000)).toBe(false)
  })
})

describe('owner 标识必须唯一（不能用 http:${pid}）', () => {
  it('两次 newLeaseOwner 产生不同标识', () => {
    const a = newLeaseOwner('http')
    const b = newLeaseOwner('http')
    expect(a).not.toBe(b)
    expect(a.startsWith('http:')).toBe(true)
  })

  it('owner 包含 pid 与随机 nonce', () => {
    const o = newLeaseOwner('runner')
    expect(o).toContain(String(process.pid))
    // nonce 段长度足够区分
    const parts = o.split(':')
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts[parts.length - 1]!.length).toBeGreaterThanOrEqual(8)
  })
})
