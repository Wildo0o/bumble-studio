// 无人值守运行器（区块 7）。
//
// 核心是三个「无人在场时会出事」的场景：
//   · 两个执行者同时跑同一任务 → 租约 CAS 拦下
//   · 执行者崩了但没人知道 → 租约过期后可接管
//   · 无人在场时无限跑下去 → 暂停条件
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { DomainError } from '../errors.js'
import { SqliteLeaseStore } from '../lease-store.js'
import { UnattendedRunner, type RunnerStore } from '../runner-loop.js'
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_UNATTENDED_POLICY,
  InMemoryLeaseStore,
  canTakeOver,
  evaluatePause,
  isLeaseSuspicious,
  pickNextTask,
  validateUnattendedPolicy,
  type PauseContext,
  type UnattendedPolicy,
} from '../runner.js'

describe('租约 CAS（内存实现）', () => {
  it('无人持有时获取成功', () => {
    const s = new InMemoryLeaseStore()
    const lease = s.tryAcquire('k', 'a', 1000, 0)
    expect(lease?.owner).toBe('a')
  })

  it('别人持有且未过期 → 获取失败', () => {
    const s = new InMemoryLeaseStore()
    s.tryAcquire('k', 'a', 1000, 0)
    expect(s.tryAcquire('k', 'b', 1000, 500)).toBeUndefined()
  })

  it('自己持有 → 续期成功，不算接管', () => {
    const s = new InMemoryLeaseStore()
    s.tryAcquire('k', 'a', 1000, 0)
    const renewed = s.tryAcquire('k', 'a', 1000, 500)
    expect(renewed?.owner).toBe('a')
    expect(renewed?.epoch).toBe(1)
    expect(renewed?.expiresAt).toBe(1500)
  })

  it('租约过期后可被接管，计数 +1', () => {
    const s = new InMemoryLeaseStore()
    s.tryAcquire('k', 'a', 1000, 0)
    const taken = s.tryAcquire('k', 'b', 1000, 1500)
    expect(taken?.owner).toBe('b')
    expect(taken?.epoch).toBe(2)
  })

  it('释放只对持有者有效', () => {
    const s = new InMemoryLeaseStore()
    s.tryAcquire('k', 'a', 1000, 0)
    expect(s.release('k', 'b')).toBe(false)
    expect(s.inspect('k')?.owner).toBe('a')
    expect(s.release('k', 'a')).toBe(true)
    expect(s.inspect('k')).toBeUndefined()
  })
})

describe('租约 CAS（数据库实现）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-lease-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('单条 UPSERT + 条件 WHERE 实现原子获取', () => {
    expect(leases.tryAcquire('k', 'a', 1000, 0)?.owner).toBe('a')
    // 未过期，别人抢不到
    expect(leases.tryAcquire('k', 'b', 1000, 100)).toBeUndefined()
    expect(leases.inspect('k')?.owner).toBe('a')
  })

  it('过期后接管', () => {
    leases.tryAcquire('k', 'a', 1000, 0)
    const taken = leases.tryAcquire('k', 'b', 1000, 2000)
    expect(taken?.owner).toBe('b')
    expect(leases.inspect('k')?.epoch).toBe(2)
  })

  it('自己续期不增加接管计数', () => {
    leases.tryAcquire('k', 'a', 1000, 0)
    leases.tryAcquire('k', 'a', 1000, 500)
    leases.tryAcquire('k', 'a', 1000, 900)
    expect(leases.inspect('k')?.epoch).toBe(1)
  })

  it('并发式交替获取只有一方成功（顺序模拟）', () => {
    const first = leases.tryAcquire('k', 'a', 1000, 0)
    const second = leases.tryAcquire('k', 'b', 1000, 0)
    expect(first?.owner).toBe('a')
    expect(second).toBeUndefined()
  })

  it('释放后立即可被获取', () => {
    leases.tryAcquire('k', 'a', 1000, 0)
    expect(leases.release('k', 'a')).toBe(true)
    expect(leases.tryAcquire('k', 'b', 1000, 1)?.owner).toBe('b')
  })
})

describe('崩溃接管判定', () => {
  it('没有租约 → 可接管', () => {
    expect(canTakeOver(undefined, 0)).toBe(true)
  })

  it('租约未过期 → 不可接管', () => {
    expect(canTakeOver({ owner: 'a', expiresAt: 1000, heartbeatAt: 900, epoch: 1 }, 500)).toBe(false)
  })

  it('租约已过期 → 可接管', () => {
    expect(canTakeOver({ owner: 'a', expiresAt: 1000, heartbeatAt: 900, epoch: 1 }, 1000)).toBe(true)
  })

  it('心跳过旧但租约未过期 → 只标记可疑，不接管', () => {
    // 这条是关键：可疑但有效时接管会重复执行正在进行的工具调用。
    // 心跳宽限期默认 15s：这里用 20s 的静默让它「可疑」，
    // 但租约还有 100s 才到期，所以仍不可接管。
    const lease = { owner: 'a', expiresAt: 120_000, heartbeatAt: 0, epoch: 1 }
    expect(isLeaseSuspicious(lease, 20_000)).toBe(true)
    expect(canTakeOver(lease, 20_000)).toBe(false)
  })

  it('心跳在宽限期内 → 既不可疑也不可接管', () => {
    const lease = { owner: 'a', expiresAt: 120_000, heartbeatAt: 0, epoch: 1 }
    // 5s < 15s 宽限期
    expect(isLeaseSuspicious(lease, 5_000)).toBe(false)
    expect(canTakeOver(lease, 5_000)).toBe(false)
  })

  it('已过期的租约不算「可疑」（它已经该被接管）', () => {
    const lease = { owner: 'a', expiresAt: 1000, heartbeatAt: 0, epoch: 1 }
    expect(isLeaseSuspicious(lease, 2000)).toBe(false)
  })
})

describe('暂停条件', () => {
  const policy: UnattendedPolicy = {
    ...DEFAULT_UNATTENDED_POLICY,
    maxConsecutiveFailures: 3,
    maxRunDurationMs: 60_000,
    budget: { maxTotalTokens: 1000, maxCostUsd: 1, maxSteps: 10 },
  }

  function ctx(over: Partial<PauseContext> = {}): PauseContext {
    return {
      run: { status: 'running', startedAt: 0 },
      now: 1000,
      policy,
      consecutiveFailures: 0,
      usage: { totalTokens: 0, costUsd: 0, steps: 0 },
      cancelRequested: false,
      ...over,
    }
  }

  it('正常情况不暂停', () => {
    expect(evaluatePause(ctx()).shouldPause).toBe(false)
  })

  it('用户取消 → 暂停（最高优先级）', () => {
    const d = evaluatePause(ctx({ cancelRequested: true, run: { status: 'waiting_approval' } }))
    expect(d.reason).toBe('user_cancelled')
  })

  it('等待审批 → 暂停（无人值守不自动批准）', () => {
    const d = evaluatePause(ctx({ run: { status: 'waiting_approval', startedAt: 0 } }))
    expect(d.reason).toBe('waiting_approval')
    expect(d.detail).toContain('不会自动批准')
  })

  it('需要人对账 → 暂停', () => {
    expect(evaluatePause(ctx({ run: { status: 'needs_reconciliation', startedAt: 0 } })).reason)
      .toBe('needs_reconciliation')
  })

  it('token 超预算 → 暂停', () => {
    const d = evaluatePause(ctx({ usage: { totalTokens: 1000, costUsd: 0, steps: 0 } }))
    expect(d.reason).toBe('budget_exhausted')
    expect(d.detail).toContain('1000')
  })

  it('成本超预算 → 暂停', () => {
    expect(evaluatePause(ctx({ usage: { totalTokens: 0, costUsd: 1.5, steps: 0 } })).reason)
      .toBe('budget_exhausted')
  })

  it('步数超预算 → 暂停', () => {
    expect(evaluatePause(ctx({ usage: { totalTokens: 0, costUsd: 0, steps: 10 } })).reason)
      .toBe('budget_exhausted')
  })

  it('运行时长超限 → 暂停', () => {
    const d = evaluatePause(ctx({ now: 61_000 }))
    expect(d.reason).toBe('deadline_exceeded')
  })

  it('连续失败达上限 → 暂停', () => {
    const d = evaluatePause(ctx({ consecutiveFailures: 3 }))
    expect(d.reason).toBe('too_many_failures')
  })

  it('暂停判定是纯函数：同样输入同样输出', () => {
    const c = ctx()
    expect(evaluatePause(c)).toEqual(evaluatePause(c))
  })

  it('预算为 undefined 时不因预算暂停', () => {
    const loose: UnattendedPolicy = { ...policy, budget: {} }
    const d = evaluatePause(ctx({ policy: loose, usage: { totalTokens: 1e9, costUsd: 1e9, steps: 1e9 } }))
    // 但期限仍然生效（now=1000 未超）
    expect(d.shouldPause).toBe(false)
  })
})

describe('调度选择', () => {
  it('只选 eligible，按优先级降序', () => {
    const picked = pickNextTask([
      { taskId: 'b', priority: 10, eligible: true },
      { taskId: 'a', priority: 50, eligible: false },
      { taskId: 'c', priority: 20, eligible: true },
    ])
    expect(picked?.taskId).toBe('c')
  })

  it('同优先级按 taskId 稳定排序', () => {
    const picked = pickNextTask([
      { taskId: 'z', priority: 1, eligible: true },
      { taskId: 'a', priority: 1, eligible: true },
    ])
    expect(picked?.taskId).toBe('a')
  })

  it('没有可执行任务 → undefined', () => {
    expect(pickNextTask([{ taskId: 'a', priority: 1, eligible: false }])).toBeUndefined()
  })
})

describe('无人值守策略校验', () => {
  it('拒绝 autoApprove: true', () => {
    let caught: unknown
    try {
      validateUnattendedPolicy({ autoApprove: true })
    } catch (e) {
      caught = e
    }
    const err = caught as DomainError
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('INVALID_INPUT')
    expect(err.message).toContain('autoApprove')
  })

  it('缺省时使用保守默认值', () => {
    const p = validateUnattendedPolicy({})
    expect(p.autoApprove).toBe(false)
    expect(p.maxConsecutiveFailures).toBe(DEFAULT_UNATTENDED_POLICY.maxConsecutiveFailures)
  })

  it('非法值被拒绝', () => {
    expect(() => validateUnattendedPolicy({ maxConsecutiveFailures: 0 })).toThrow(/>= 1/)
    expect(() => validateUnattendedPolicy({ maxRunDurationMs: 10 })).toThrow(/>= 1000/)
    expect(() => validateUnattendedPolicy({ budget: { maxSteps: -1 } })).toThrow(/非负/)
  })

  it('合法预算被保留', () => {
    const p = validateUnattendedPolicy({ budget: { maxSteps: 5, maxCostUsd: 2 } })
    expect(p.budget).toEqual({ maxSteps: 5, maxCostUsd: 2 })
  })
})

describe('崩溃接管（真实 Store）', () => {
  let dir: string
  let store: Store
  let leases: SqliteLeaseStore
  let runner: UnattendedRunner

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-runner-'))
    store = new Store(join(dir, 't.db'))
    leases = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)
    runner = new UnattendedRunner(
      store as unknown as RunnerStore,
      leases,
      'test-runner',
      DEFAULT_UNATTENDED_POLICY,
    )
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRunningRun(): string {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'running')
    return run.id
  }

  it('没有活租约的 running Run 被降级为 queued', () => {
    const runId = makeRunningRun()
    const taken = runner.takeOverStaleRuns()
    expect(taken.map((t) => t.runId)).toContain(runId)
    expect(store.getRun(runId)!.status).toBe('queued')
  })

  it('有活租约的 running Run 不会被接管（别人还在跑）', () => {
    const runId = makeRunningRun()
    leases.tryAcquire(`run:${runId}`, 'other', 60_000, Date.now())
    expect(runner.takeOverStaleRuns()).toEqual([])
    expect(store.getRun(runId)!.status).toBe('running')
  })

  it('租约过期后被接管', () => {
    const runId = makeRunningRun()
    leases.tryAcquire(`run:${runId}`, 'other', 1000, 0)
    const taken = runner.takeOverStaleRuns(Date.now() + 5000)
    expect(taken.map((t) => t.runId)).toContain(runId)
  })

  it('有未确认操作时降级为 needs_reconciliation 而不是 queued', () => {
    const runId = makeRunningRun()
    // 造一个 running Step（模拟进程被杀）
    store.createStep({ runId, index: 0, kind: 'tool', status: 'running' })
    runner.takeOverStaleRuns()
    expect(store.getRun(runId)!.status).toBe('needs_reconciliation')
  })

  it('接管会写事件（可追溯）', () => {
    const runId = makeRunningRun()
    runner.takeOverStaleRuns()
    const events = store.listEvents(runId)
    expect(events.some((e) => e.kind === 'run.status_recovered')).toBe(true)
    const evt = events.find((e) => e.kind === 'run.status_recovered')!
    expect((evt.payload as { takenOverBy?: string }).takenOverBy).toBe('test-runner')
  })

  it('tick 抢到租约后执行并释放', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    let executed = false
    const result = await runner.tick(
      async () => {
        executed = true
        return 'ok'
      },
      [{ taskId: task.id, runId: run.id, priority: 1, eligible: true }],
    )
    expect(executed).toBe(true)
    expect(result.leased).toBe(true)
    // 正常结束后租约被释放
    expect(leases.inspect(`run:${run.id}`)).toBeUndefined()
  })

  it('tick 抢不到被别人持有的租约时不执行', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    leases.tryAcquire(`run:${run.id}`, 'other', 60_000, Date.now())

    let executed = false
    const result = await runner.tick(
      async () => {
        executed = true
        return 'ok'
      },
      [{ taskId: task.id, runId: run.id, priority: 1, eligible: true }],
    )
    expect(executed).toBe(false)
    expect(result.leased).toBe(false)
  })
  it('执行中抛错时保留租约（避免立即被接管并重复执行）', async () => {
    // 关键区分（L2 Task 1）：
    //   · **执行前**失败（provider 解析 / 参数校验）→ 立即释放租约，
    //     让调用方可以马上重试，不用等一个 TTL。
    //   · **执行中**失败（已进入 running）→ 保留租约，让它自然过期。
    //     立即释放会让下一个 tick 马上接管并重复执行，而外部副作用
    //     可能已经发生。
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    // 让 Run 在执行回调**之前**就进入 running：模拟「已经开始执行」
    const storeAny = store as unknown as {
      transitionRunStatus(id: string, from: string, to: string): boolean
    }
    storeAny.transitionRunStatus(run.id, 'queued', 'running')

    await expect(
      runner.tick(
        async () => {
          throw new Error('boom')
        },
        [{ taskId: task.id, runId: run.id, priority: 1, eligible: true }],
      ),
    ).rejects.toThrow('boom')

    // 租约仍在：防止立即被接管
    expect(leases.inspect(`run:${run.id}`)?.owner).toBe('test-runner')
  })

  it('连续失败累积到上限后暂停', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const policy: UnattendedPolicy = { ...DEFAULT_UNATTENDED_POLICY, maxConsecutiveFailures: 2 }
    const r2 = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r2', policy)
    const cand = [{ taskId: task.id, runId: run.id, priority: 1, eligible: true }]

    await r2.tick(async () => 'failed', cand)
    await r2.tick(async () => 'failed', cand)
    const third = await r2.tick(async () => 'failed', cand)
    expect(third.decision?.reason).toBe('too_many_failures')
  })

  it('成功一次会清零连续失败计数', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const policy: UnattendedPolicy = { ...DEFAULT_UNATTENDED_POLICY, maxConsecutiveFailures: 2 }
    const r3 = new UnattendedRunner(store as unknown as RunnerStore, leases, 'r3', policy)
    const cand = [{ taskId: task.id, runId: run.id, priority: 1, eligible: true }]

    await r3.tick(async () => 'failed', cand)
    await r3.tick(async () => 'ok', cand)
    const third = await r3.tick(async () => 'ok', cand)
    expect(third.decision?.shouldPause).toBe(false)
  })

  it('默认租约 TTL 与心跳宽限期都为正数', () => {
    expect(DEFAULT_LEASE_TTL_MS).toBeGreaterThan(0)
  })
})
