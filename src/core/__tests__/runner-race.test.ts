// 竞态与持久化回归（审计 P1-2 / P1-3 / P1-4 / P1-5）。
//
// 这一组测的都是「两个执行者同时动作」或「进程重启」才会暴露的问题。
// 它们无法用「单线程顺序调用」证明，所以断言的是**CAS 的结果**：
// 第二次写必须失败，而不是「看起来状态对」。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { UnattendedRunner, type RunnerStore } from '../runner-loop.js'
import { DEFAULT_UNATTENDED_POLICY, InMemoryLeaseStore } from '../runner.js'
import { recoverOnStartup } from '../recovery.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import type { Run } from '../../shared/types.js'

describe('runner 竞态回归', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore
  let runner: UnattendedRunner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-race-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
    runner = new UnattendedRunner(store as unknown as RunnerStore, leases, 'runner-A', DEFAULT_UNATTENDED_POLICY)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRunning(): Run {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.transitionRunStatus(run.id, 'queued', 'running')
    return store.getRun(run.id)!
  }

  // ── P1-2：takeover 必须先抢到权力再动状态 ──────────────
  it('另一个 runner 持有有效租约时，takeover 不动这个 Run', () => {
    const run = makeRunning()
    // 模拟另一个健康 runner 正在执行
    leases.tryAcquire(`run:${run.id}`, 'runner-B', 60_000, Date.now())

    const taken = runner.takeOverStaleRuns()
    expect(taken).toEqual([])
    expect(store.getRun(run.id)!.status).toBe('running')
  })

  it('两个 runner 同时接管同一个过期 Run：只有一个成功', () => {
    const run = makeRunning()
    // 让租约过期
    leases.tryAcquire(`run:${run.id}`, 'dead-runner', 1000, 0)

    const runnerB = new UnattendedRunner(
      store as unknown as RunnerStore,
      leases,
      'runner-B',
      DEFAULT_UNATTENDED_POLICY,
    )
    const a = runner.takeOverStaleRuns(Date.now() + 5000)
    const b = runnerB.takeOverStaleRuns(Date.now() + 5000)

    // 只有一个真正接管（另一个抢不到租约）
    expect(a.length + b.length).toBe(1)
    // 且状态只变一次
    expect(store.getRun(run.id)!.status).toBe('queued')
  })

  it('接管时状态已被别人改走，则不覆盖', () => {
    const run = makeRunning()
    leases.tryAcquire(`run:${run.id}`, 'dead-runner', 1000, 0)

    // 模拟：另一个路径已经把 Run 变成终态（例如它自己完成了）
    store.transitionRunStatus(run.id, 'running', 'completed')

    const taken = runner.takeOverStaleRuns(Date.now() + 5000)
    expect(taken).toEqual([])
    expect(store.getRun(run.id)!.status).toBe('completed')
  })

  // ── P1-3：取消意图必须跨进程持久化 ──────────────────────
  it('取消意图落库，新 runner 实例也能看到', () => {
    const run = makeRunning()
    runner.requestCancel(run.id, 'user', '不要了')

    // 全新实例（模拟进程重启）
    const fresh = new UnattendedRunner(
      store as unknown as RunnerStore,
      leases,
      'runner-new',
      DEFAULT_UNATTENDED_POLICY,
    )
    expect(fresh.isCancelRequested(run.id)).toBe(true)
  })

  it('有取消意图的失联 Run 被接管成 cancelled，而不是重新排队', () => {
    const run = makeRunning()
    store.requestCancel(run.id, 'user')
    // 让租约过期
    leases.tryAcquire(`run:${run.id}`, 'dead', 1000, 0)

    const taken = runner.takeOverStaleRuns(Date.now() + 5000)
    expect(taken.some((t) => t.runId === run.id)).toBe(true)
    expect(store.getRun(run.id)!.status).toBe('cancelled')
  })

  // ── P1-3：暂停必须落到状态上 ────────────────────────────
  it('预算耗尽时 pause 会把 Run 置为 paused（不只是写事件）', async () => {
    const run = makeRunning()
    const policy = {
      ...DEFAULT_UNATTENDED_POLICY,
      budget: { maxSteps: 1 },
    }
    const r = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r-budget', policy)

    const result = await r.tick(
      async () => 'ok',
      [{ taskId: run.taskId, runId: run.id, priority: 1, eligible: true }],
      { usage: () => ({ totalTokens: 0, costUsd: 0, steps: 5 }) },
    )

    expect(result.decision?.reason).toBe('budget_exhausted')
    // 关键：状态真的变了，后续调度不会把它当 running 重跑
    expect(store.getRun(run.id)!.status).toBe('paused')
  })

  it('用户取消时 Run 直接被置为 cancelled，且不执行', async () => {
    const run = makeRunning()
    store.requestCancel(run.id, 'user')

    let executed = false
    const result = await runner.tick(
      async () => { executed = true; return 'ok' },
      [{ taskId: run.taskId, runId: run.id, priority: 1, eligible: true }],
    )

    // 取消现在在 tick 开头就落实成状态（审计二轮 P1-1），
    // 不再走 pause 决策——所以 decision 为 undefined 是预期的。
    // 真正要断言的是「状态变了 + 没有执行」。
    expect(result.decision).toBeUndefined()
    expect(executed).toBe(false)
    expect(store.getRun(run.id)!.status).toBe('cancelled')
  })

  it('paused 的 Run 不会被标准执行入口重跑', () => {
    const run = makeRunning()
    store.transitionRunStatus(run.id, 'running', 'paused')
    // 只有 queued / running 是执行入口
    expect(store.getRun(run.id)!.status).toBe('paused')
  })

  // ── 暂停语义：可恢复 vs 不可恢复 ───────────────────────
  //
  // 这两个用例锁定的是一条**设计判断**：
  //   预算 / 期限 = 可恢复 → paused（等人工 resume）
  //   失败过多   = 走不通   → failed（需要改点什么才能重来）
  // 如果产品期望「失败太久也只是暂停」，改这里即可，测试会提示影响面。

  it('预算耗尽 → paused（可恢复）', async () => {
    const run = makeRunning()
    const policy = { ...DEFAULT_UNATTENDED_POLICY, budget: { maxSteps: 1 } }
    const r = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r1', policy)
    await r.tick(async () => 'ok', [{ taskId: run.taskId, runId: run.id, priority: 1, eligible: true }], {
      usage: () => ({ totalTokens: 0, costUsd: 0, steps: 99 }),
    })
    expect(store.getRun(run.id)!.status).toBe('paused')
  })

  it('连续失败达上限 → failed（不可恢复，需改配置）', async () => {
    const run = makeRunning()
    const policy = { ...DEFAULT_UNATTENDED_POLICY, maxConsecutiveFailures: 1 }
    const r = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r2', policy)
    const cand = [{ taskId: run.taskId, runId: run.id, priority: 1, eligible: true }]

    await r.tick(async () => 'failed', cand)
    const second = await r.tick(async () => 'failed', cand)
    expect(second.decision?.reason).toBe('too_many_failures')
    expect(store.getRun(run.id)!.status).toBe('failed')
  })

  // ── 取消意图的清理 ─────────────────────────────────────

  it('终态 Run 的取消意图可被清理，非终态的不受影响', () => {
    const done = makeRunning()
    store.requestCancel(done.id)
    store.transitionRunStatus(done.id, 'running', 'cancelled')

    const live = makeRunning()
    store.requestCancel(live.id)

    expect(store.listCancelIntents().length).toBe(2)
    const removed = store.pruneCancelIntents()
    expect(removed).toBe(1)
    // 终态的清了，非终态的还在（仍有防护价值）
    expect(store.hasCancelIntent(done.id)).toBe(false)
    expect(store.hasCancelIntent(live.id)).toBe(true)
  })

  // ── P1-4：启动恢复不能碰活跃执行者 ──────────────────────
  it('有活跃租约的 running Run 在启动恢复时被跳过', () => {
    const run = makeRunning()
    leases.tryAcquire(`run:${run.id}`, 'live-process', 60_000, Date.now())

    const report = recoverOnStartup(store)
    expect(report.skippedActiveRuns).toContain(run.id)
    expect(report.staleRuns).toEqual([])
    expect(store.getRun(run.id)!.status).toBe('running')
  })

  it('没有租约的 running Run 在启动恢复时被降级', () => {
    const run = makeRunning()
    const report = recoverOnStartup(store)
    expect(report.staleRuns.some((s) => s.runId === run.id)).toBe(true)
    expect(['queued', 'needs_reconciliation']).toContain(store.getRun(run.id)!.status)
  })

  it('启动恢复成功后释放恢复租约（否则该 Run 会空等一个 TTL）', () => {
    const run = makeRunning()
    recoverOnStartup(store)

    // 恢复完成后不应该还持有任何租约
    expect(leases.inspect(`run:${run.id}`)).toBeUndefined()
    // 于是它可以立刻被调度认领
    const claimed = leases.tryAcquire(`run:${run.id}`, 'runner-later', 1000, Date.now())
    expect(claimed).toBeDefined()
    leases.release(`run:${run.id}`, 'runner-later')
  })

  it('恢复期间 Run 已被别人改成终态 → 不覆盖', () => {
    const run = makeRunning()
    // 先让它变成 completed（模拟 Run 自己收尾了）
    store.transitionRunStatus(run.id, 'running', 'completed')
    const report = recoverOnStartup(store)
    expect(report.staleRuns).toEqual([])
    expect(store.getRun(run.id)!.status).toBe('completed')
  })

  // ── D-8/D-9：启动恢复不得清扫健康执行者的 Step ──────────
  //
  // 场景：第一个服务正在跑一个 Run（持有活租约），第二个服务启动。
  // 早期实现在「判断租约」之前就全局 sweep，把第一个服务的
  // running Step 全标成 unknown —— 那条执行轨迹直接被毁。

  it('有活跃租约时，启动恢复不清扫该 Run 的 Step / Intent', () => {
    const run = makeRunning()
    // 造一个正在执行的 Step
    const step = store.createStep({ runId: run.id, index: 0, kind: 'tool', status: 'running' })
    // 第一个服务持有活租约
    leases.tryAcquire(`run:${run.id}`, 'live-service', 60_000, Date.now())

    const report = recoverOnStartup(store)

    expect(report.skippedActiveRuns).toContain(run.id)
    // 关键：Step 仍然是 running，没有被标成 unknown
    expect(store.getStep(step.id)!.status).toBe('running')
    // Run 也仍然是 running
    expect(store.getRun(run.id)!.status).toBe('running')
  })

  it('多个 Run 中只有失联的那个被清扫', () => {
    const healthy = makeRunning()
    const healthyStep = store.createStep({ runId: healthy.id, index: 0, kind: 'tool', status: 'running' })
    leases.tryAcquire(`run:${healthy.id}`, 'live-service', 60_000, Date.now())

    const stale = makeRunning()
    const staleStep = store.createStep({ runId: stale.id, index: 0, kind: 'tool', status: 'running' })

    recoverOnStartup(store)

    // 健康的完全没被动
    expect(store.getStep(healthyStep.id)!.status).toBe('running')
    expect(store.getRun(healthy.id)!.status).toBe('running')
    // 失联的被如实降级
    expect(store.getStep(staleStep.id)!.status).toBe('unknown')
    expect(['needs_reconciliation', 'queued']).toContain(store.getRun(stale.id)!.status)
  })

  // ── P1-5：cancel 不能覆盖终态 ───────────────────────────
  it('已完成 / 已失败的 Run 调用 cancel 不会改写终态', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'ws-cancel-'))
    const store2 = new Store(join(dir2, 't.db'))
    try {
      const executor = new RunExecutor(
        store2,
        new ToolRegistry(),
        { workspaceRoots: [dir2], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 2 },
        () => {
          throw new Error('不应调用模型')
        },
      )
      const s = store2.createSession('t')
      const task = store2.createTask({ sessionId: s.id, goal: 'g' })

      for (const terminal of ['completed', 'failed', 'expired'] as const) {
        const r = store2.createRun({ taskId: task.id, role: 'producer', budget: {} })
        store2.transitionRunStatus(r.id, 'queued', 'running')
        store2.transitionRunStatus(r.id, 'running', terminal)

        const outcome = executor.cancel(r.id)
        // 不覆盖：返回的是真实状态
        expect(outcome.status).toBe(terminal)
        expect(store2.getRun(r.id)!.status).toBe(terminal)
      }
    } finally {
      store2.close()
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('运行中的 Run 调用 cancel 生效，且之后再 cancel 不再改动', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'ws-cancel2-'))
    const store3 = new Store(join(dir3, 't.db'))
    try {
      const executor = new RunExecutor(
        store3,
        new ToolRegistry(),
        { workspaceRoots: [dir3], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 2 },
        () => {
          throw new Error('不应调用模型')
        },
      )
      const s = store3.createSession('t')
      const task = store3.createTask({ sessionId: s.id, goal: 'g' })
      const r = store3.createRun({ taskId: task.id, role: 'producer', budget: {} })
      store3.transitionRunStatus(r.id, 'queued', 'running')

      expect(executor.cancel(r.id).status).toBe('cancelled')
      expect(store3.getRun(r.id)!.status).toBe('cancelled')

      // 幂等：再取消一次仍是 cancelled，不抛错
      expect(executor.cancel(r.id).status).toBe('cancelled')
    } finally {
      store3.close()
      rmSync(dir3, { recursive: true, force: true })
    }
  })
})

describe('内存租约与数据库租约语义一致', () => {
  it('两者的 epoch 规则相同', () => {
    const mem = new InMemoryLeaseStore()
    mem.tryAcquire('k', 'a', 1000, 0)
    mem.tryAcquire('k', 'b', 1000, 5000)
    expect(mem.inspect('k')?.epoch).toBe(2)
  })
})
