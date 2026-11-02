// 用例 C：工具超时 → unknown
//
// 验收条件（来自 SPEC）：
//   1. 工具超时，Tool Step 状态是 unknown（不是 failed，也不是 completed）
//   2. Run 不得显示 completed
//   3. 模型收到结构化超时结果
//   4. 重启后仍能查询该状态
//
// unknown 的意义：请求中断，但无法确认外部操作是否已经发生。
// 这是本产品最需要诚实对待的状态。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry, type ToolImpl } from '../tools.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

/** 一个永远不返回的工具，用于制造超时。 */
const hangingTool: ToolImpl = {
  definition: {
    id: 'slow_write',
    name: 'slow_write',
    description: '模拟一个会卡住的外部操作',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    source: 'builtin',
    riskLevel: 'read', // 用 read 避免触发审批，专注测试超时逻辑
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 60,
    maxOutputBytes: 4096,
    reconcile: { idempotent: false, unsafeToRetry: true },
  },
  async run() {
    await new Promise(() => {
      /* 永不 resolve */
    })
    return { ok: true, content: '' }
  },
}

/** 一个安全的幂等工具，用于验证不同的对账建议。 */
const idempotentHangTool: ToolImpl = {
  definition: {
    id: 'slow_idempotent',
    name: 'slow_idempotent',
    description: '幂等的慢操作',
    inputSchema: { type: 'object', properties: {}, required: [] },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 60,
    maxOutputBytes: 4096,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run() {
    await new Promise(() => {
      /* 永不 resolve */
    })
    return { ok: true, content: '' }
  },
}

describe('用例 C：工具超时', () => {
  let dir: string
  let dbPath: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-case-c-'))
    dbPath = join(dir, 'test.db')
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider, tools: ToolImpl[] = [hangingTool]): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, handlers) => script.stream(req, handlers) }
    return new RunExecutor(
      store,
      new ToolRegistry(tools),
      { workspaceRoots: [workspace], contextBudget: 100_000, outputReserve: 8_000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  it('工具超时后 Step = unknown，Run 不显示 completed', async () => {
    const session = store.createSession('超时测试')
    const task = store.createTask({ sessionId: session.id, goal: '执行慢操作' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { text: '开始', toolCalls: [{ name: 'slow_write', args: { value: 'x' } }] },
      { text: '这个操作结果不确定，我需要人工确认。' },
    ])
    const executor = makeExecutor(script)

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('执行慢操作')],
      signal: new AbortController().signal,
    })

    // ── 工具 Step 必须是 unknown ──────────────────────────
    const steps = store.listSteps(run.id)
    const toolStep = steps.find((s) => s.kind === 'tool')!
    expect(toolStep.status).toBe('unknown')
    expect(toolStep.status).not.toBe('failed')
    expect(toolStep.status).not.toBe('completed')

    // ── 超时信息要记录在 Step 输出里 ──────────────────────
    const output = toolStep.output as { error: string; advice: string }
    expect(output.error).toContain('超时')
    expect(output.advice).toContain('人工确认')

    // ── 关键行为变更：超时后立即停止，不再调用模型 ────────
    //
    // 旧行为：超时结果回给模型，模型还能再收束一轮。
    // 新行为：不知道外部状态时，继续执行等于在不确定的地基上盖楼。
    //        所以只调用 1 次模型就停。
    expect(script.turnCount).toBe(1)

    // ── 结果类型必须是 needs_reconciliation，不是 failed ──
    // failed 可以被调用方当作「可以重试」，needs_reconciliation 不行
    expect(outcome.status).toBe('needs_reconciliation')

    // ── 但超时说明仍要落进历史，供对账后恢复 ──────────────
    const history = store.listRunMessages<{ role: string; content: string }>(run.id)
    const toolMsg = history.find((m) => m.role === 'tool')!
    expect(toolMsg.content).toContain('结果未知')
    expect(toolMsg.content).toContain('不要假设')
  })

  it('不安全重试的工具，建议必须升级人工', async () => {
    const session = store.createSession('对账策略')
    const task = store.createTask({ sessionId: session.id, goal: '测试' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow_write', args: { value: 'y' } }] },
      { text: '好的' },
    ])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('测试')],
      signal: new AbortController().signal,
    })

    // 超时后不再调用模型，改为检查落库的 tool 消息
    const history = store.listRunMessages<{ role: string; content: string }>(run.id)
    const toolMsg = history.find((m) => m.role === 'tool')!
    // unsafeToRetry: true → 必须说「必须由人工确认」
    expect(toolMsg.content).toContain('人工确认')
  })

  it('幂等工具，建议可以安全重试', async () => {
    const session = store.createSession('幂等')
    const task = store.createTask({ sessionId: session.id, goal: '测试' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow_idempotent', args: {} }] },
      { text: '好的' },
    ])
    const executor = makeExecutor(script, [idempotentHangTool])

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('测试')],
      signal: new AbortController().signal,
    })

    const history = store.listRunMessages<{ role: string; content: string }>(run.id)
    const toolMsg = history.find((m) => m.role === 'tool')!
    expect(toolMsg.content).toContain('幂等')
    expect(toolMsg.content).toContain('可以安全重试')
  })

  it('重启后 unknown 状态仍可查询', async () => {
    const session = store.createSession('持久化 unknown')
    const task = store.createTask({ sessionId: session.id, goal: '测试' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow_write', args: { value: 'z' } }] },
      { text: '完成' },
    ])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('测试')],
      signal: new AbortController().signal,
    })

    // ── 模拟重启 ──────────────────────────────────────────
    store.close()
    store = new Store(dbPath)

    const steps = store.listSteps(run.id)
    const toolStep = steps.find((s) => s.kind === 'tool')!
    expect(toolStep.status).toBe('unknown')

    const output = toolStep.output as { error: string }
    expect(output.error).toContain('超时')

    // 事件流里也应记录过这个 unknown
    const events = store.listEvents(run.id)
    expect(events.some((e) => e.kind === 'tool.unknown')).toBe(true)
  })
})
