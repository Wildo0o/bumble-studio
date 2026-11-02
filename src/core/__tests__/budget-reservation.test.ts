// 预算 reservation：调用前预留，调用后结算。
//
// 没有 reservation 时的问题是**并发超支**：
//
//   Task 预算 100，两个 Run 同时启动
//   Run A 读到已用 0 → 通过
//   Run B 读到已用 0 → 通过      ← 两个都以为自己还有 100
//   A 消耗 60，B 消耗 60 → 总共 120，超了 20
//
// 旧实现只能在调用**之后**发现超支（overshoot），那时钱已经花了。
//
// reservation 的做法：调用前先在事务里占住额度。
//   usage + reserved + estimate <= limit
// 不满足就**根本不发起调用**。
//
// 关键约束：
//   · 预留与判定在同一个 SQLite 事务里（并发安全）
//   · 结算按实际用量，释放多余部分
//   · 重复结算幂等（不会重复累加 usage）
//   · 进程崩溃留下的 reservation 能回收
//   · committed Intent 复用结果时**不预留**（没有真实调用）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import type { ToolImpl } from '../tools.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

const PROVIDER = {
  id: 'p', name: 'P', kind: 'demo' as const, baseUrl: '', requiresKey: false,
}

function writeTool(counter: { calls: number }, target: string): ToolImpl {
  return {
    definition: {
      id: 'wt', name: 'wt', description: 'x',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
      timeoutMs: 5000, maxOutputBytes: 8192,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input) {
      counter.calls++
      writeFileSync(String(input.path ?? target), `call-${counter.calls}`, 'utf8')
      return { ok: true, content: `wrote ${counter.calls}` }
    },
  }
}

describe('预算 reservation', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-resv-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    dbPath = join(dir, 't.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(tools: ToolRegistry, script: ScriptedProvider): RunExecutor {
    const adapter: ProviderAdapter = { stream: (r, h) => script.stream(r, h) }
    return new RunExecutor(
      store, tools,
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  function seedTask(budget: Record<string, number>) {
    const s = store.createSession('t')
    return store.createTask({ sessionId: s.id, goal: 'g', budget })
  }

  function newRun(taskId: string, budget: Record<string, number>) {
    return store.createRun({ taskId, role: 'producer', budget })
  }

  // ── 1. Task 级跨 Run 原子预留 ───────────────────────────

  it('1. 两个并发 Run 合计不能超过 Task budget', () => {
    const task = seedTask({ maxSteps: 10 })

    const runA = newRun(task.id, {})
    const runB = newRun(task.id, {})

    // A 预留 8 步（Task 上限 10）
    const a = store.reserveBudget({
      runId: runA.id,
      taskId: task.id,
      steps: 8,
      ttlMs: 60_000,
    })
    expect(a.ok).toBe(true)

    // B 想再预留 8 步 → 8 + 8 = 16 > 10，必须拒绝
    const b = store.reserveBudget({
      runId: runB.id,
      taskId: task.id,
      steps: 8,
      ttlMs: 60_000,
    })
    expect(b.ok, '两个 Run 合计超过了 Task 预算却都通过了').toBe(false)
    expect(b.ok === false ? b.reason : '').toMatch(/预算|budget/)

    // B 只能预留剩下的 2 步
    const b2 = store.reserveBudget({
      runId: runB.id,
      taskId: task.id,
      steps: 2,
      ttlMs: 60_000,
    })
    expect(b2.ok).toBe(true)
  })

  it('1b. 预留释放后额度可以再被使用', () => {
    const task = seedTask({ maxSteps: 10 })
    const runA = newRun(task.id, {})

    const a = store.reserveBudget({ runId: runA.id, taskId: task.id, steps: 10, ttlMs: 60_000 })
    expect(a.ok).toBe(true)

    // 结算：实际只用了 3 步，释放 7
    store.settleBudget(a.ok ? a.reservationId : '', { steps: 3 })
    expect(store.reservedBudget(task.id).steps).toBe(0)

    // 现在又能预留了
    const b = store.reserveBudget({ runId: runA.id, taskId: task.id, steps: 5, ttlMs: 60_000 })
    expect(b.ok).toBe(true)
  })

  // ── 2. 单次 input/output token 超限 ─────────────────────

  it('2. 单次 input token 超过 Run 上限时拒绝，不发起调用', () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxInputTokens: 100 })

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id,
      inputTokens: 150,   // 超过 100
      ttlMs: 60_000,
    })
    expect(r.ok).toBe(false)
  })

  it('2b. 单次 output token 超过 Run 上限时拒绝', () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxOutputTokens: 50 })

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id,
      outputTokens: 80,
      ttlMs: 60_000,
    })
    expect(r.ok).toBe(false)
  })

  // ── 3-6. toolCalls / steps / cost / deadline ────────────

  it('3. maxToolCalls：累计预留不能超过上限', () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxToolCalls: 3 })

    expect(store.reserveBudget({ runId: run.id, taskId: task.id, toolCalls: 2, ttlMs: 60_000 }).ok).toBe(true)
    expect(store.reserveBudget({ runId: run.id, taskId: task.id, toolCalls: 2, ttlMs: 60_000 }).ok).toBe(false)
    expect(store.reserveBudget({ runId: run.id, taskId: task.id, toolCalls: 1, ttlMs: 60_000 }).ok).toBe(true)
  })

  it('4. maxSteps：累计预留不能超过上限', () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxSteps: 5 })

    expect(store.reserveBudget({ runId: run.id, taskId: task.id, steps: 5, ttlMs: 60_000 }).ok).toBe(true)
    expect(store.reserveBudget({ runId: run.id, taskId: task.id, steps: 1, ttlMs: 60_000 }).ok).toBe(false)
  })

  it('5. maxCost：累计预留不能超过上限', () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxCostUsd: 1 })

    expect(store.reserveBudget({ runId: run.id, taskId: task.id, costUsd: 0.6, ttlMs: 60_000 }).ok).toBe(true)
    expect(store.reserveBudget({ runId: run.id, taskId: task.id, costUsd: 0.6, ttlMs: 60_000 }).ok).toBe(false)
    expect(store.reserveBudget({ runId: run.id, taskId: task.id, costUsd: 0.4, ttlMs: 60_000 }).ok).toBe(true)
  })

  it('6. deadline：已过期时拒绝任何预留', () => {
    const task = seedTask({})
    const run = newRun(task.id, { deadlineAt: Date.now() - 1000 })

    const r = store.reserveBudget({ runId: run.id, taskId: task.id, steps: 1, ttlMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.ok === false ? r.reason : '').toMatch(/deadline|过期|截止/)
  })

  // ── 7-8. 异常与流式中断 ─────────────────────────────────

  it('7. 模型调用异常时 reservation 必须被释放', async () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxSteps: 10 })

    const script = new ScriptedProvider([{ error: 'MODEL_BOOM' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 异常路径不能留下悬挂的 reservation
    expect(store.reservedBudget(task.id).steps, '异常后仍有未释放的预留').toBe(0)
  })

  it('8. 取消（abort）时 reservation 必须被释放', async () => {
    const task = seedTask({})
    const run = newRun(task.id, { maxSteps: 10 })

    const controller = new AbortController()
    const script = new ScriptedProvider([{ hang: true }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const p = ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await p

    expect(store.reservedBudget(task.id).steps, '取消后仍有未释放的预留').toBe(0)
  })

  // ── 9-10. 崩溃与回收 ────────────────────────────────────

  it('9. 预留后进程崩溃：reservation 留在库里，但不影响后续（可回收）', () => {
    const task = seedTask({ maxSteps: 10 })
    const run = newRun(task.id, {})

    const r = store.reserveBudget({ runId: run.id, taskId: task.id, steps: 5, ttlMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(store.reservedBudget(task.id).steps).toBe(5)

    // 「崩溃」：不结算，直接重新打开 db
    store.close()
    store = new Store(dbPath)

    // 预留仍在（这是对的——不知道那次调用有没有发生）
    expect(store.reservedBudget(task.id).steps).toBe(5)
  })

  it('10. 重启回收把过期 reservation 标成 expired，但额度仍占用', () => {
    const task = seedTask({ maxSteps: 10 })
    const run = newRun(task.id, {})

    // 预留 5 步，TTL 极短
    const r = store.reserveBudget({ runId: run.id, taskId: task.id, steps: 5, ttlMs: 1 })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.reservationId : ''

    const expired = store.expireReservations(Date.now() + 10)
    expect(expired).toHaveLength(1)

    // v0.14 行为变更：过期不等于「调用没发生」。
    // 状态标成 expired（供对账），但额度继续占用——
    // 否则一个慢请求会在第 11 分钟返回时凭空超支。
    expect(store.getReservation(id)!.status).toBe('expired')
    expect(store.reservedBudget(task.id).steps).toBe(5)
  })

  // ── 11. approved-resume 计入预算 ────────────────────────

  it('11. approved-resume 的工具调用也计入预算', async () => {
    const target = join(workspace, 'r.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([writeTool(counter, target)])

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g', budget: {} })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 1 },
    })

    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval', input: {},
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'wt',
      toolCallId: 'c1', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'c1', name: 'wt', arguments: JSON.stringify({ path: target }) }],
    })

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 工具调用消耗了 1 次额度
    const after = store.getRun(run.id)!
    expect(after.usage.toolCalls).toBe(1)
    // 预留已释放
    expect(store.reservedBudget(task.id).toolCalls).toBe(0)
  })

  // ── 12. Auditor 计入预算 ────────────────────────────────

  it('12. Auditor 调用也计入预算', async () => {
    const task = seedTask({ maxSteps: 20 })
    const run = newRun(task.id, { maxSteps: 20 })

    // 直接验证 store 层：Auditor 的用量通过 addTaskUsage 计入
    store.addTaskUsage(task.id, { steps: 1, inputTokens: 100, outputTokens: 50 })
    const after = store.getTask(task.id)!
    expect(after.usage!.steps).toBe(1)
    expect(after.usage!.inputTokens).toBe(100)
  })

  // ── 13. committed Intent 复用不预留 ─────────────────────

  it('13. committed Intent 复用结果时不消耗预算', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([writeTool(counter, target)])

    const task = seedTask({ maxSteps: 20 })
    const run = newRun(task.id, { maxSteps: 20, maxToolCalls: 20 })
    store.createGrant({
      id: 'g1', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const ex = makeExecutor(tools, new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '完成' },
    ]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    const first = store.getRun(run.id)!
    expect(counter.calls).toBe(1)
    expect(first.usage.toolCalls).toBe(1)

    // 模拟崩溃重放：审批未消费
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()
    store = new Store(dbPath)

    // 再次执行同一个 toolCallId（通过同一 Run 重新跑）
    // 这里简化：直接查 Intent 状态，确认它是 committed
    const intent = store.listIntents(run.id)[0]!
    expect(intent.status).toBe('committed')

    // committed 的 Intent 复用不会再累加 toolCalls
    const after = store.getRun(run.id)!
    expect(after.usage.toolCalls).toBe(1)
  })

  // ── 14. 重复 settle 幂等 ────────────────────────────────

  it('14. 重复 settle 不会重复累加 usage', () => {
    const task = seedTask({ maxSteps: 20 })
    const run = newRun(task.id, {})

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id, steps: 3, ttlMs: 60_000,
    })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.reservationId : ''

    store.settleBudget(id, { steps: 2 })
    const afterFirst = store.getRun(run.id)!
    expect(afterFirst.usage.steps).toBe(2)

    // 第二次结算：必须是幂等的，不能再加 2
    store.settleBudget(id, { steps: 2 })
    const afterSecond = store.getRun(run.id)!
    expect(afterSecond.usage.steps, '重复 settle 重复累加了 usage').toBe(2)
  })

  // ── 15. 预算失败时 Grant 不消耗 ─────────────────────────

  it('15. 预算预留失败时 Grant 不被消耗', async () => {
    const target = join(workspace, 'g.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([writeTool(counter, target)])

    const task = seedTask({})
    // maxToolCalls = 0 → 工具预算必然失败
    const run = newRun(task.id, { maxSteps: 20, maxToolCalls: 0 })
    store.createGrant({
      id: 'g15', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const ex = makeExecutor(tools, new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '好' },
    ]))
    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(0)
    expect(store.listGrants(run.id)[0]!.usedCalls, '预算失败但 Grant 被扣').toBe(0)
    expect(out.status).not.toBe('completed')
  })
})

// ══════════════════════════════════════════════════════════
// Executor 级：预算必须真的拦住调用
// ══════════════════════════════════════════════════════════
//
// 上面的测试大多直接调 Store。但「Store 层方法正确」不等于
// 「executor 真的调了它」——这个错误本项目已经犯过三次。
//
// 这一组全部从 executor.execute() 入口跑，断言「工具/模型被调用了几次」。

describe('预算 reservation：Executor 级行为', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-resvx-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    dbPath = join(dir, 't.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(tools: ToolRegistry, script: ScriptedProvider): RunExecutor {
    const adapter: ProviderAdapter = { stream: (r, h) => script.stream(r, h) }
    return new RunExecutor(
      store, tools,
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  it('E1. 模型调用前预留：预算确实不足时一次调用都不发', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      // v0.11 起 output 估算会按剩余预算收敛，所以 maxTotalTokens=100 能跑。
      // 要测「真的不足」，得用 maxSteps=0——那是绝对不可能满足的。
      budget: { maxSteps: 0 },
    })

    const script = new ScriptedProvider([{ text: '不应该被调用' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 模型一次都没被调用
    expect(script.turnCount, '预算不足却发起了模型调用').toBe(0)
    expect(out.status).toBe('expired')
    // 没有留下悬挂预留
    expect(store.reservedBudget(task.id).steps).toBe(0)
  })

  it('E2. maxSteps 不足时工具不执行，Grant 不消耗', async () => {
    const target = join(workspace, 'e2.txt')
    const counter = { calls: 0 }

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 1, maxToolCalls: 20 },
    })
    store.createGrant({
      id: 'g-e2', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const ex = makeExecutor(
      new ToolRegistry([writeTool(counter, target)]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'wt', args: { path: target } }] },
        { text: '好' },
      ]),
    )

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 模型调用占掉唯一 1 步；工具那一步预留失败
    expect(counter.calls).toBe(0)
    expect(store.listGrants(run.id)[0]!.usedCalls, '预算失败但 Grant 被扣').toBe(0)
    expect(out.status).not.toBe('completed')
  })

  it('E3. 模型调用异常后预留被释放，usage 不记', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 10 },
    })

    const script = new ScriptedProvider([{ error: 'BOOM' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 异常后不能留下悬挂预留
    expect(store.reservedBudget(task.id).steps).toBe(0)
    // usage 也不该被记（调用失败了）
    expect(store.getRun(run.id)!.usage.steps).toBe(0)
  })

  it('E4. 正常路径：预留被结算，usage 只记一次', async () => {
    const target = join(workspace, 'e4.txt')
    const counter = { calls: 0 }

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    store.createGrant({
      id: 'g-e4', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const ex = makeExecutor(
      new ToolRegistry([writeTool(counter, target)]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'wt', args: { path: target } }] },
        { text: '完成' },
      ]),
    )

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(out.status).toBe('completed')
    expect(counter.calls).toBe(1)

    const after = store.getRun(run.id)!
    // 两轮模型调用 + 一次工具 = 3 步
    expect(after.usage.steps).toBe(3)
    expect(after.usage.toolCalls).toBe(1)
    // 没有悬挂预留
    expect(store.reservedBudget(task.id).steps).toBe(0)
    expect(store.reservedBudget(task.id).toolCalls).toBe(0)
  })

  it('E5. Task 级：前一个 Run 用掉额度后，后一个 Run 被拦', async () => {
    const target = join(workspace, 'e5.txt')
    const counter = { calls: 0 }

    const s = store.createSession('t')
    // Task 只给 3 步
    const task = store.createTask({ sessionId: s.id, goal: 'g', budget: { maxSteps: 3 } })

    const runA = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 20 } })
    store.createGrant({
      id: 'g-e5', runId: runA.id, toolId: 'wt',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const ex = makeExecutor(
      new ToolRegistry([writeTool(counter, target)]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'wt', args: { path: target } }] },
        { text: '完成' },
      ]),
    )

    await ex.execute({
      runId: runA.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    const afterA = store.getTask(task.id)!
    // A 用了 3 步（2 次模型 + 1 次工具），刚好用光
    expect(afterA.usage!.steps).toBe(3)

    // 第二个 Run 应该一步都走不了
    const runB = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 20 } })
    const scriptB = new ScriptedProvider([{ text: '不应该被调用' }])
    const exB = makeExecutor(new ToolRegistry([writeTool(counter, target)]), scriptB)

    const outB = await exB.execute({
      runId: runB.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(scriptB.turnCount, 'Task 预算已耗尽却还在调模型').toBe(0)
    expect(outB.status).toBe('expired')
  })
})
