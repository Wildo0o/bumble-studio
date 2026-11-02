// 预算策略的四个缺口。
//
// v0.10 的 reservation 机制本身是对的，但有四处策略问题：
//
//   1. outputReserve 固定 8000 → maxTotalTokens=100 这类合法小预算被误杀
//   2. pricing 未知时 estimateCost 返回 undefined → 被当成 0 → maxCostUsd 形同虚设
//   3. 只读工具走 executeWithoutIntent，直接 addRunUsage，绕过 reservation
//   4. reservation 表没有 status / actual_* / settled_at，无法说明
//      「预留了多少、实际用了多少、是结算还是释放」
//
// 这个文件只测策略，机制本身在 budget-reservation.test.ts。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
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

describe('预算策略', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-pol-'))
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

  // ── 缺口 1：小预算被误杀 ────────────────────────────────

  it('1. maxTotalTokens=100 + maxOutputTokens=50：小预算必须能正常执行', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxTotalTokens: 100, maxOutputTokens: 50 },
    })

    // 模型实际只用 10 + 5
    const script = new ScriptedProvider([
      { text: '好', inputTokens: 10, outputTokens: 5 },
    ])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 必须能执行，不能因为固定 8000 被误杀
    expect(script.turnCount, '合法小预算被误杀：模型一次都没被调用').toBe(1)
    expect(out.status).toBe('completed')
  })

  it('1b. maxTotalTokens=100 + maxOutputTokens=200：调用前拒绝', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      // 输出上限 200 > 总量上限 100，本身矛盾
      budget: { maxTotalTokens: 100, maxOutputTokens: 200 },
    })

    const script = new ScriptedProvider([{ text: '不应该被调用' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 预算自相矛盾，调用前就要拒绝
    expect(script.turnCount, '预算矛盾却发起了调用').toBe(0)
    expect(out.status).toBe('expired')
  })

  it('1c. 没有 maxOutputTokens 时用保守默认，且不会超支', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      // 只有总量上限，没有 output 上限
      budget: { maxTotalTokens: 200 },
    })

    const script = new ScriptedProvider([
      { text: '好', inputTokens: 10, outputTokens: 5 },
    ])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 保守默认（不超过剩余预算）→ 能执行
    expect(script.turnCount).toBe(1)
    expect(out.status).toBe('completed')
    // 实际用量没超
    expect(store.getRun(run.id)!.usage.inputTokens + store.getRun(run.id)!.usage.outputTokens)
      .toBeLessThanOrEqual(200)
  })

  // ── 缺口 2：pricing 未知时 fail-closed ──────────────────

  it('2. maxCostUsd 已设置但价格未知 → 拒绝调用（不能当 0）', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxCostUsd: 1 },
    })

    // demo provider 没有 pricing
    const script = new ScriptedProvider([{ text: '不应该被调用' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id,
      provider: { ...PROVIDER, pricing: undefined },
      model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 价格未知 → 无法保证不超支 → fail-closed
    expect(script.turnCount, '价格未知却放行，maxCostUsd 形同虚设').toBe(0)
    expect(out.status).toBe('expired')
    expect(String((out as { reason?: string }).reason ?? '')).toMatch(/价格|pricing|成本/)
  })

  it('2b. 没设 maxCostUsd 时价格未知不影响执行', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 10 },   // 没有 maxCostUsd
    })

    const script = new ScriptedProvider([{ text: '好' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: { ...PROVIDER, pricing: undefined },
      model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 用户没要求成本上限，价格未知不该阻断
    expect(script.turnCount).toBe(1)
    expect(out.status).toBe('completed')
  })

  // ── 缺口 3：只读工具也走预算 ────────────────────────────

  it('3. 只读工具消耗 toolCalls/steps 预算', async () => {
    const readme = join(workspace, 'a.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(readme, 'content', 'utf8')

    const readTool: ToolImpl = {
      definition: {
        id: 'rt', name: 'rt', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'read', sideEffect: 'none', enabled: true,
        timeoutMs: 5000, maxOutputBytes: 8192,
        reconcile: { idempotent: true, unsafeToRetry: false },
      },
      async run(input) {
        return { ok: true, content: readFileSync(String(input.path), 'utf8') }
      },
    }

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 20, maxToolCalls: 20 },
    })

    const ex = makeExecutor(
      new ToolRegistry([readTool]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'rt', args: { path: readme } }] },
        { text: '完成' },
      ]),
    )

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    const after = store.getRun(run.id)!
    // ★ 只读工具也要算 1 次 toolCalls
    expect(after.usage.toolCalls, '只读工具没有计入 toolCalls').toBe(1)
    // 2 轮模型 + 1 次工具 = 3 步
    expect(after.usage.steps).toBe(3)
  })

  it('3b. 只读工具的 toolCalls 预算耗尽时也不能执行', async () => {
    const readme = join(workspace, 'b.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(readme, 'content', 'utf8')

    let called = 0
    const readTool: ToolImpl = {
      definition: {
        id: 'rt', name: 'rt', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'read', sideEffect: 'none', enabled: true,
        timeoutMs: 5000, maxOutputBytes: 8192,
        reconcile: { idempotent: true, unsafeToRetry: false },
      },
      async run() {
        called++
        return { ok: true, content: 'x' }
      },
    }

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      // 工具调用预算为 0
      budget: { maxSteps: 20, maxToolCalls: 0 },
    })

    const ex = makeExecutor(
      new ToolRegistry([readTool]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'rt', args: { path: readme } }] },
        { text: '好' },
      ]),
    )

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 只读工具也要受 toolCalls 预算约束
    expect(called, 'toolCalls 预算为 0 却执行了只读工具').toBe(0)
    expect(out.status).not.toBe('completed')
  })

  // ── 缺口 4：reservation 审计字段 ────────────────────────

  it('4. reservation 记录 status 与 actual usage', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id,
      purpose: 'model', inputTokens: 100, outputTokens: 50,
      ttlMs: 60_000,
    })
    expect(r.ok).toBe(true)
    const id = r.ok ? r.reservationId : ''

    // 刚预留：status = 'reserved'
    const before = store.getReservation(id)!
    expect(before.status).toBe('reserved')
    expect(before.inputTokens).toBe(100)
    expect(before.actualInputTokens).toBe(0)

    // 结算后：status = 'settled'，actual 有值
    store.settleBudget(id, { inputTokens: 80, outputTokens: 30 })
    const after = store.getReservation(id)!
    expect(after.status).toBe('settled')
    expect(after.actualInputTokens).toBe(80)
    expect(after.actualOutputTokens).toBe(30)
    expect(after.settledAt).toBeTruthy()
  })

  it('4b. release 与 expire 有各自的 status', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const a = store.reserveBudget({
      runId: run.id, taskId: task.id, purpose: 'model', steps: 1, ttlMs: 60_000,
    })
    store.releaseBudget(a.ok ? a.reservationId : '')
    expect(store.getReservation(a.ok ? a.reservationId : '')!.status).toBe('released')

    const b = store.reserveBudget({
      runId: run.id, taskId: task.id, purpose: 'model', steps: 1, ttlMs: 1,
    })
    store.expireReservations(Date.now() + 10)
    expect(store.getReservation(b.ok ? b.reservationId : '')!.status).toBe('expired')
  })

  it('4c. release 两次不会让额度变成负数', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id, purpose: 'model', steps: 5, ttlMs: 60_000,
    })
    const id = r.ok ? r.reservationId : ''

    store.releaseBudget(id)
    store.releaseBudget(id)
    store.releaseBudget(id)

    // 已释放的不再占用额度
    expect(store.reservedBudget(task.id).steps).toBe(0)
    // usage 没有被写成负数
    expect(store.getRun(run.id)!.usage.steps).toBe(0)
  })

  it('4d. settle 两次只累计一次', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const r = store.reserveBudget({
      runId: run.id, taskId: task.id, purpose: 'model', steps: 2, ttlMs: 60_000,
    })
    const id = r.ok ? r.reservationId : ''

    store.settleBudget(id, { steps: 2 })
    store.settleBudget(id, { steps: 2 })

    expect(store.getRun(run.id)!.usage.steps).toBe(2)
  })

  // ── 缺口 5：不得伪造精确 cost ───────────────────────────
  //
  // 旧实现：`costUsd: cost ?? 0`。
  // 价格未知时 cost 是 undefined，被写成 0。
  // 事后看 usage.costUsd === 0，读起来就是「这次调用花了 0 元」。
  // 那不是保守，是伪造——比不记更糟，因为它看起来是精确的。

  it('5. 价格未知时 usage 必须标记 costUnknown，不能假装是 0', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 10 },   // 没设 maxCostUsd，所以调用可以发生
    })

    const script = new ScriptedProvider([{ text: '好', inputTokens: 100, outputTokens: 50 }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: { ...PROVIDER, pricing: undefined },
      model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(out.status).toBe('completed')
    expect(script.turnCount).toBe(1)

    const after = store.getRun(run.id)!
    // 数字仍然是 0（我们确实不知道），但必须同时带上「未知」标记
    expect(after.usage.costUsd).toBe(0)
    expect(after.usage.costUnknown, '价格未知却把成本当成精确的 0').toBe(true)

    // reservation 上也要能看出这一点
    const reservations = store.listReservationsForRun(run.id)
    const modelResv = reservations.find((r) => r.purpose === 'model')!
    expect(modelResv.status).toBe('settled')
    expect(modelResv.actualCostKnown).toBe(false)

    // Task 级同样标记
    expect(store.getTask(task.id)!.usage!.costUnknown).toBe(true)
  })

  it('5b. 价格已知时 costKnown 为 true，不误标未知', async () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 10, maxCostUsd: 10 },
    })

    const script = new ScriptedProvider([{ text: '好', inputTokens: 100, outputTokens: 50 }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id,
      provider: { ...PROVIDER, pricing: { input: 1, output: 2 } },
      model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(out.status).toBe('completed')
    const after = store.getRun(run.id)!
    expect(after.usage.costUnknown).toBeUndefined()
    expect(after.usage.costUsd).toBeGreaterThan(0)

    const modelResv = store.listReservationsForRun(run.id).find((r) => r.purpose === 'model')!
    expect(modelResv.actualCostKnown).toBe(true)
  })

  // ── 缺口 6：Task 级 maxCostUsd 也必须触发价格 fail-closed ──
  //
  // 旧实现只检查 `run.budget.maxCostUsd`。
  // 用户设了 Task 成本上限、Run 没设 → 价格未知时照样调用，
  // Task 成本上限从头到尾没有任何效果。

  it('6. 只设了 Task 级 maxCostUsd、价格未知 → 同样拒绝调用', async () => {
    const s = store.createSession('t')
    const task = store.createTask({
      sessionId: s.id, goal: 'g',
      budget: { maxCostUsd: 5 },     // ← Task 级，不是 Run 级
    })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 10 },      // Run 级没有 maxCostUsd
    })

    const script = new ScriptedProvider([{ text: '不应该被调用' }])
    const ex = makeExecutor(new ToolRegistry(), script)

    const out = await ex.execute({
      runId: run.id, provider: { ...PROVIDER, pricing: undefined },
      model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(script.turnCount, 'Task 成本上限存在却放行了价格未知的调用').toBe(0)
    expect(out.status).toBe('expired')
  })
})
