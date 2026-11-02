// 租约 fencing 与长执行竞态（审计 C 项）。
//
// 核心场景：一次执行**超过 TTL**，第二个 runner 合法接管。
// 没有 fencing 时，旧执行者的迟到写入会覆盖新 owner 的状态。
//
// 这些测试直接断言「旧写入被拒绝」，而不是「看起来状态对了」——
// 后者在竞态下可能是巧合。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { LeaseGuard, LeaseLostError, guardFor } from '../lease-fencing.js'
import { InMemoryLeaseStore } from '../runner.js'
import { ScriptedProvider, userMessage } from './helpers.js'
import { providerFromPreset } from '../../providers/registry.js'

describe('LeaseGuard（内存实现）', () => {
  it('持有期间 assertValid 通过', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', lease, 1000)
    // 用与建租约一致的时间点：这些用例的时钟从 0 开始，
    // 默认 Date.now() 会让租约「看起来已过期」。
    expect(() => guard.assertValid(100)).not.toThrow()
  })

  it('被接管后 assertValid 抛 LeaseLostError', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', lease, 1000)

    // B 接管（租约过期后）
    leases.tryAcquire('k', 'B', 1000, 2000)

    expect(() => guard.assertValid()).toThrow(LeaseLostError)
    expect(guard.check()).toBe(false)
  })

  it('被接管的消息说明「结果不会被采纳」', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', lease, 1000)
    leases.tryAcquire('k', 'B', 1000, 2000)

    let msg = ''
    try { guard.assertValid() } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('不会被采纳')
    expect(msg).toContain('epoch 1')
  })

  it('自己续期不改变 epoch，仍有效', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', lease, 1000)

    leases.heartbeat('k', 'A', lease.epoch, 1000, 500)
    expect(guard.check(600)).toBe(true)
  })

  it('心跳失败即标记失效（owner 不匹配）', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    expect(leases.heartbeat('k', 'C', lease.epoch, 1000, 100)).toBe(false)
    expect(leases.heartbeat('k', 'A', lease.epoch + 1, 1000, 100)).toBe(false)
  })

  it('租约被删除后 currentEpoch 为 0，守卫失败', () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 1000, 0)!
    const guard = guardFor(leases, 'k', lease, 1000)
    leases.release('k', 'A')
    expect(guard.check()).toBe(false)
  })
})

describe('LeaseGuard（数据库实现）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-fence-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('epoch 在接管时递增，续期时不变', () => {
    const l1 = leases.tryAcquire('k', 'A', 1000, 0)!
    expect(l1.epoch).toBe(1)

    leases.heartbeat('k', 'A', 1, 1000, 500)
    expect(leases.currentEpoch('k')).toBe(1)

    const l2 = leases.tryAcquire('k', 'B', 1000, 2000)!
    expect(l2.epoch).toBe(2)
    expect(leases.currentEpoch('k')).toBe(2)
  })

  it('heartbeat 是条件更新：epoch 不符则失败', () => {
    leases.tryAcquire('k', 'A', 1000, 0)
    expect(leases.heartbeat('k', 'A', 1, 1000, 100)).toBe(true)
    // 用错误的 epoch
    expect(leases.heartbeat('k', 'A', 99, 1000, 200)).toBe(false)
    // 用错误的 owner
    expect(leases.heartbeat('k', 'B', 1, 1000, 200)).toBe(false)
  })

  it('长执行超过 TTL 后，健康持有者靠心跳保住租约', () => {
    // 这正是 fencing 要解决的场景：
    // 执行 90s，TTL 60s，但每 20s 心跳一次 → 租约一直有效。
    const l = leases.tryAcquire('k', 'A', 60_000, 0)!
    for (let t = 20_000; t <= 100_000; t += 20_000) {
      expect(leases.heartbeat('k', 'A', l.epoch, 60_000, t)).toBe(true)
    }
    // B 在这期间任何时刻都抢不到
    expect(leases.tryAcquire('k', 'B', 60_000, 90_000)).toBeUndefined()
    expect(leases.currentEpoch('k')).toBe(1)
  })

  it('心跳停止后租约过期，B 可接管，A 的守卫失效', () => {
    const l = leases.tryAcquire('k', 'A', 60_000, 0)!
    const guard = guardFor(leases, 'k', l, 60_000)

    // 不再心跳，120s 后 B 接管
    const l2 = leases.tryAcquire('k', 'B', 60_000, 120_000)
    expect(l2?.epoch).toBe(2)

    // A 的迟到写入必须被拒绝
    expect(guard.check()).toBe(false)
    expect(() => guard.assertValid()).toThrow(LeaseLostError)
  })
})

describe('心跳定时器行为', () => {
  it('start 后可以被 stop，且不阻止进程退出', async () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 300, 0)!
    let now = 0
    const guard = new LeaseGuard(leases, { key: 'k', owner: 'A', epoch: lease.epoch }, 300, 50)
    guard.start(() => now)

    // 让心跳跑几轮
    now = 100
    await new Promise((r) => setTimeout(r, 120))
    expect(guard.isValid).toBe(true)

    guard.stop()
    expect(guard.isValid).toBe(true)
  })

  it('心跳发现被接管后自动失效', async () => {
    const leases = new InMemoryLeaseStore()
    const lease = leases.tryAcquire('k', 'A', 300, 0)!
    const guard = new LeaseGuard(leases, { key: 'k', owner: 'A', epoch: lease.epoch }, 300, 30)
    guard.start(() => 0)

    // 模拟接管
    leases.tryAcquire('k', 'B', 300, 10_000)

    await new Promise((r) => setTimeout(r, 90))
    expect(guard.isValid).toBe(false)
    expect(guard.invalidReason).toContain('接管')
    guard.stop()
  })
})
