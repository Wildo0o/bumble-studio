// 迟到写入被拒绝：fencing 必须是**条件写**（审计二轮 P0）。
//
// 关键认识：只判 status 不够。
//   A 持有 epoch 1 执行中 → 租约过期 → B 接管 epoch 2，
//   但 Run 状态可能仍是 running。此时 A 用 CAS「从 running 到 completed」
//   会**成功**——状态一致性无法区分它是不是已经过期的那一代。
//
// 真正的判据是 lease_epoch：认领时写入，之后每次写入都要求相符。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { guardFor } from '../lease-fencing.js'

describe('迟到写入被拒绝（真实 Store + epoch 条件写）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-fence2-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function newRun(): string {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    return run.id
  }

  it('接管后旧 owner 的 epoch 条件写必然失败', () => {
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const now = Date.now()

    // A 认领 epoch 1
    const lA = leases.tryAcquire(leaseKey, 'A', 60_000, now)!
    expect(store.claimRunForEpoch(runId, 'queued', lA.epoch)).toBe(true)
    expect(store.getRun(runId)!.status).toBe('running')

    // 租约过期，B 接管（epoch 递增）
    const lB = leases.tryAcquire(leaseKey, 'B', 60_000, now + 100_000)!
    expect(lB.epoch).toBeGreaterThan(lA.epoch)
    // 接管必须同时转移 run 的 epoch —— 这是 fencing 真正生效的一步。
    expect(store.adoptRunEpoch(runId, lB.epoch)).toBe(true)

    // A 尝试用**自己的** epoch 写终态 → 必须失败
    const stale = store.transitionRunStatusFenced(
      runId,
      'running',
      'completed',
      lA.epoch,
    )
    expect(stale, '旧 epoch 的写入必须被拒绝').toBe(false)
    expect(store.getRun(runId)!.status).toBe('running')

    // B 用自己的 epoch 写 → 成功
    expect(store.transitionRunStatusFenced(runId, 'running', 'failed', lB.epoch)).toBe(true)
    expect(store.getRun(runId)!.status).toBe('failed')
  })

  it('旧 owner 无法用 epoch 0（无租约约束）绕过', () => {
    // 认领后 lease_epoch 是具体数字，epoch=0 不匹配
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const lA = leases.tryAcquire(leaseKey, 'A', 60_000, Date.now())!
    store.claimRunForEpoch(runId, 'queued', lA.epoch)

    expect(store.transitionRunStatusFenced(runId, 'running', 'completed', 0)).toBe(false)
    expect(store.getRun(runId)!.status).toBe('running')
  })

  it('Step 写入同样受 epoch 约束', () => {
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const now = Date.now()
    const lA = leases.tryAcquire(leaseKey, 'A', 60_000, now)!
    store.claimRunForEpoch(runId, 'queued', lA.epoch)

    const step = store.createStep({ runId, index: 0, kind: 'tool', status: 'running' })
    // 先把 epoch 打到这个 step 上
    store.updateStepStatusFenced(step.id, 'running', lA.epoch)

    // B 接管
    const lB = leases.tryAcquire(leaseKey, 'B', 60_000, now + 100_000)!
    expect(lB.epoch).toBeGreaterThan(lA.epoch)
    // 接管必须同时转移 run 的 epoch —— 这是 fencing 真正生效的一步。
    expect(store.adoptRunEpoch(runId, lB.epoch)).toBe(true)

    // A 的 step 写入被拒绝
    expect(store.updateStepStatusFenced(step.id, 'completed', lA.epoch)).toBe(false)
    // 当前仍是 running，没有变成 completed
    expect(store.getStep(step.id)!.status).toBe('running')
  })

  it('Run 历史消息写入受 epoch 约束', () => {
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const now = Date.now()
    const lA = leases.tryAcquire(leaseKey, 'A', 60_000, now)!
    store.claimRunForEpoch(runId, 'queued', lA.epoch)

    expect(store.appendRunMessageFenced(runId, { role: 'assistant', content: 'a' }, lA.epoch)).toBe(true)

    const lB = leases.tryAcquire(leaseKey, 'B', 60_000, now + 100_000)!
    expect(lB.epoch).toBeGreaterThan(lA.epoch)
    // 接管必须同时转移 run 的 epoch —— 这是 fencing 真正生效的一步。
    expect(store.adoptRunEpoch(runId, lB.epoch)).toBe(true)

    // A 的迟到消息被拒绝
    expect(store.appendRunMessageFenced(runId, { role: 'assistant', content: 'late' }, lA.epoch)).toBe(false)
    // 只有一条消息
    expect(store.listRunMessagesWithMeta(runId)).toHaveLength(1)
  })

  it('没有被接管时，epoch 条件写正常进行', () => {
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const l = leases.tryAcquire(leaseKey, 'A', 60_000, Date.now())!
    expect(store.claimRunForEpoch(runId, 'queued', l.epoch)).toBe(true)

    const guard = guardFor(leases, leaseKey, l, 60_000)
    expect(guard.check()).toBe(true)

    expect(store.transitionRunStatusFenced(runId, 'running', 'completed', l.epoch)).toBe(true)
    expect(store.getRun(runId)!.status).toBe('completed')
  })

  it('取消不会覆盖新 owner 的状态（stale cancel）', () => {
    const runId = newRun()
    const leaseKey = `run:${runId}`
    const now = Date.now()
    const lA = leases.tryAcquire(leaseKey, 'A', 60_000, now)!
    store.claimRunForEpoch(runId, 'queued', lA.epoch)

    // B 接管并把它推进到 completed
    const lB = leases.tryAcquire(leaseKey, 'B', 60_000, now + 100_000)!
    expect(store.adoptRunEpoch(runId, lB.epoch)).toBe(true)
    store.transitionRunStatusFenced(runId, 'running', 'completed', lB.epoch)
    expect(store.getRun(runId)!.status).toBe('completed')

    // A（旧 epoch）尝试取消 → 被拒
    expect(store.transitionRunStatusFenced(runId, 'running', 'cancelled', lA.epoch)).toBe(false)
    expect(store.getRun(runId)!.status).toBe('completed')
  })
})
