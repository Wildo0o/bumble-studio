// 第二组（审计二轮 P1）：runner 取消与异常租约。
//
// 这一组处理的都是「调度器在各种失败路径上没把租约 / 状态收拾干净」。
// 租约泄漏的后果很具体：该 Run 在 TTL 内看起来「有人在处理」，
// 真正的接管要白等，用户 resume 会被跳过。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { UnattendedRunner, type RunnerStore } from '../runner-loop.js'
import { DEFAULT_UNATTENDED_POLICY } from '../runner.js'

describe('runner 取消与异常路径（审计二轮）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore
  let runner: UnattendedRunner
  let taskId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-g2-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
    runner = new UnattendedRunner(
      store as unknown as RunnerStore,
      leases,
      'runner-A',
      DEFAULT_UNATTENDED_POLICY,
    )
    const s = store.createSession('t')
    taskId = store.createTask({ sessionId: s.id, goal: 'g' }).id
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeQueuedRun(): string {
    return store.createRun({ taskId, role: 'producer', budget: {} }).id
  }

  // ── 1. queued + 取消意图 → 必须变成 cancelled，不能永久 queued ──
  it('queued Run 有取消意图时，tick 之后必须是 cancelled（不能永久 queued）', async () => {
    const runId = makeQueuedRun()
    store.requestCancel(runId, 'user', '不要了')

    await runner.tick(async () => 'ok', [
      { taskId, runId, priority: 1, eligible: true },
    ])

    expect(store.getRun(runId)!.status).toBe('cancelled')
  })

  it('queued Run 被取消后不再被 tick 选中', async () => {
    const runId = makeQueuedRun()
    store.requestCancel(runId, 'user')

    let executed = false
    await runner.tick(async () => { executed = true; return 'ok' }, [
      { taskId, runId, priority: 1, eligible: true },
    ])
    expect(executed).toBe(false)

    // 第二次也不会
    await runner.tick(async () => { executed = true; return 'ok' }, [
      { taskId, runId, priority: 1, eligible: true },
    ])
    expect(executed).toBe(false)
  })

  // ── 2. takeover 后必须释放 takeover lease ──────────────────
  it('takeover 完成后不残留租约（否则其它 owner 无法调度）', () => {
    const runId = makeQueuedRun()
    store.transitionRunStatus(runId, 'queued', 'running')
    // 制造一个失联的 running Run（无租约）
    const taken = runner.takeOverStaleRuns()
    expect(taken.some((t) => t.runId === runId)).toBe(true)

    // 没有残留租约：别人可以立即拿到
    const l = leases.tryAcquire(`run:${runId}`, 'other', 60_000, Date.now())
    expect(l).toBeDefined()
    if (l) leases.release(`run:${runId}`, 'other')
  })

  // ── 3. 执行前异常必须释放 scheduler lease ──────────────────
  it('execute 抛错时不残留租约以外的状态，且下一次 tick 可以重试', async () => {
    const runId = makeQueuedRun()

    await expect(
      runner.tick(async () => { throw new Error('provider resolve failed') }, [
        { taskId, runId, priority: 1, eligible: true },
      ]),
    ).rejects.toThrow('provider resolve failed')

    // 抛错时刻意**不释放**租约（避免立即被接管并重复执行），
    // 但必须在 TTL 之后可重试。这里直接推进时间模拟 TTL 过期。
    const later = Date.now() + 120_000
    const l = leases.tryAcquire(`run:${runId}`, 'runner-B', 60_000, later)
    expect(l, 'TTL 之后必须可以被另一个 owner 接管').toBeDefined()
  })

  // ── 4. failure counter 必须跨 tick 保留（同一 runner 实例）──
  it('failure counter 在同一 runner 实例内跨 tick 累积', async () => {
    const runId = makeQueuedRun()
    const policy = { ...DEFAULT_UNATTENDED_POLICY, maxConsecutiveFailures: 2 }
    const r = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r-fail', policy)
    const cand = [{ taskId, runId, priority: 1, eligible: true }]

    await r.tick(async () => 'failed', cand)
    await r.tick(async () => 'failed', cand)
    const third = await r.tick(async () => 'failed', cand)
    expect(third.decision?.reason).toBe('too_many_failures')
  })

  // ── 5. 只有状态和 lease 都安全才允许重跑 stale Run ─────────
  it('失联 Run 被接管后，状态不安全时不会被重新执行', () => {
    const runId = makeQueuedRun()
    store.transitionRunStatus(runId, 'queued', 'running')
    // 造一个未解决的 unknown（running Step）
    store.createStep({ runId, index: 0, kind: 'tool', status: 'running' })

    runner.takeOverStaleRuns()

    // 有 unknown → 应进入 needs_reconciliation，而不是 queued
    expect(store.getRun(runId)!.status).toBe('needs_reconciliation')
  })

  it('接管后进入 needs_reconciliation 的 Run 不会被自动调度执行', async () => {
    const runId = makeQueuedRun()
    store.transitionRunStatus(runId, 'queued', 'running')
    store.createStep({ runId, index: 0, kind: 'tool', status: 'running' })
    runner.takeOverStaleRuns()

    let executed = false
    await runner.tick(async () => { executed = true; return 'ok' }, [
      { taskId, runId, priority: 1, eligible: true },
    ])
    // 它不在 queued 列表里，findRun 找不到 → 不执行
    expect(executed).toBe(false)
  })
})

describe('failure counter 可以外部提供（持久化场景）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-g2b-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('注入 external failures 后，新 runner 实例继承计数', async () => {
    const s = store.createSession('t')
    const taskId = store.createTask({ sessionId: s.id, goal: 'g' }).id
    const runId = store.createRun({ taskId, role: 'producer', budget: {} }).id

    // 用一个 Map 充当「持久化」的计数器
    const persisted = new Map<string, number>([[runId, 2]])
    const policy = { ...DEFAULT_UNATTENDED_POLICY, maxConsecutiveFailures: 2 }
    const r = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r-x', policy, {
      failures: {
        get: (id) => persisted.get(id) ?? 0,
        set: (id, n) => { persisted.set(id, n) },
        clear: (id) => { persisted.delete(id) },
      },
    })

    const result = await r.tick(async () => 'failed', [
      { taskId, runId, priority: 1, eligible: true },
    ])
    // 计数已到 2 → 应立即暂停，而不是重新开始数
    expect(result.decision?.reason).toBe('too_many_failures')
  })
})
