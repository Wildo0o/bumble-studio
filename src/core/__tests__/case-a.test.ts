// 用例 A：只读工具自动执行 + 重启后可查询
//
// 验收条件（来自 SPEC）：
//   1. read_file 自动执行，不需要审批
//   2. 模型收束，Run = completed
//   3. 重启后 Run / Step / Trace / 最终结果仍可查询
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

describe('用例 A：只读工具自动执行', () => {
  let dir: string
  let dbPath: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-case-a-'))
    dbPath = join(dir, 'test.db')
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'hello.txt'), '你好，工作站', 'utf8')
    store = new Store(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider): { executor: RunExecutor; script: ScriptedProvider } {
    const adapter: ProviderAdapter = {
      stream: (req, handlers) => script.stream(req, handlers),
    }
    const executor = new RunExecutor(
      store,
      new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100_000, outputReserve: 8_000, maxToolRounds: 8 },
      () => adapter,
    )
    return { executor, script }
  }

  it('模型调用 read_file → 自动放行 → 收束 → Run completed', async () => {
    const session = store.createSession('测试会话')
    const task = store.createTask({ sessionId: session.id, goal: '读一下 hello.txt' })
    const run = store.createRun({
      taskId: task.id,
      role: 'producer',
      budget: { maxSteps: 10, maxToolCalls: 5 },
    })

    const script = new ScriptedProvider([
      { text: '我先看看这个文件。', toolCalls: [{ name: 'read_file', args: { path: join(workspace, 'hello.txt') } }] },
      { text: '文件内容是：你好，工作站。' },
    ])

    const { executor } = makeExecutor(script)
    const controller = new AbortController()

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test-model' },
      system: '你是测试助手',
      messages: [userMessage('读一下 hello.txt')],
      signal: controller.signal,
    })

    expect(outcome.status).toBe('completed')
    if (outcome.status === 'completed') {
      expect(outcome.text).toContain('你好，工作站')
    }

    // ── 验证 Step 序列 ────────────────────────────────────
    const steps = store.listSteps(run.id)
    expect(steps.map((s) => s.kind)).toEqual(['llm', 'tool', 'llm'])
    expect(steps.every((s) => s.status === 'completed')).toBe(true)

    // ── 验证工具真的被调用了（第二轮请求里应包含 tool 结果） ──
    expect(script.turnCount).toBe(2)
    const secondCallMessages = script.calls[1]!.messages
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toContain('你好，工作站')

    // ── 验证 Trace ────────────────────────────────────────
    const toolStep = steps.find((s) => s.kind === 'tool')!
    expect(toolStep.trace.toolName).toBe('read_file')
    expect(toolStep.trace.toolLatencyMs).toBeGreaterThanOrEqual(0)

    const llmSteps = steps.filter((s) => s.kind === 'llm')
    expect(llmSteps[0]!.trace.inputTokens).toBe(100)
    expect(llmSteps[0]!.trace.outputTokens).toBe(50)

    // ── 验证用量累计 ──────────────────────────────────────
    const finalRun = store.getRun(run.id)!
    expect(finalRun.usage.steps).toBe(3)
    expect(finalRun.usage.toolCalls).toBe(1)
    expect(finalRun.usage.inputTokens).toBe(200)
    expect(finalRun.usage.outputTokens).toBe(100)

    // ── 验证事件流 ────────────────────────────────────────
    const events = store.listEvents(run.id)
    expect(events.map((e) => e.kind)).toContain('run.started')
    expect(events.map((e) => e.kind)).toContain('tool.done')
    expect(events.map((e) => e.kind)).toContain('run.completed')
  })

  it('重启后 Run / Step / Trace / 结果仍可查询', async () => {
    const session = store.createSession('持久化测试')
    const task = store.createTask({ sessionId: session.id, goal: '读文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { text: '', toolCalls: [{ name: 'read_file', args: { path: join(workspace, 'hello.txt') } }] },
      { text: '完成', inputTokens: 120, outputTokens: 30 },
    ])
    const { executor } = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test-model' },
      messages: [userMessage('读文件')],
      signal: new AbortController().signal,
    })

    // ── 模拟重启：关掉连接，重新打开同一个数据库 ──────────
    store.close()
    store = new Store(dbPath)

    const reloadedRun = store.getRun(run.id)
    expect(reloadedRun).toBeDefined()
    expect(reloadedRun!.status).toBe('completed')
    expect(reloadedRun!.usage.toolCalls).toBe(1)

    const reloadedSteps = store.listSteps(run.id)
    expect(reloadedSteps).toHaveLength(3)
    expect(reloadedSteps[0]!.trace.inputTokens).toBe(100)
    expect(reloadedSteps[1]!.trace.toolName).toBe('read_file')
    expect(reloadedSteps[2]!.trace.inputTokens).toBe(120)

    // 最终结果能从最后一条 llm step 里读出来
    const lastLlm = reloadedSteps.filter((s) => s.kind === 'llm').pop()!
    expect((lastLlm.output as { text: string }).text).toBe('完成')

    const events = store.listEvents(run.id)
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]!.kind).toBe('run.completed')
  })
})
