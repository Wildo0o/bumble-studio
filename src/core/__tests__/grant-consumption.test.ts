// Grant 消耗在「审批恢复」路径上的正确性。
//
// 背景：`atomicity.test.ts` 只测了 Store 层的 claimGrantUsage 本身，
// 从没测过 executor 的两条执行路径是否都真的调用它。
//
// 这正是漏洞藏身的地方：
//   普通路径  → claimGrantUsage() ✅
//   审批恢复   → executeApprovedTool() ❌ 从未认领
//
// 后果：scope=once 的授权在审批恢复时执行一次，usedCalls 仍是 0，
// 同一个 Run 里模型可以再次调用同一工具而完全绕过审批。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

describe('审批恢复路径的 Grant 消耗', () => {
  let dir: string
  let workspace: string
  let store: Store
  let executor: RunExecutor
  let script: ScriptedProvider

  /** 测试用的最小 ProviderConfig。adapter 由 executor 的工厂注入。 */
  const PROVIDER = {
    id: 'test-provider',
    name: 'Test',
    kind: 'demo' as const,
    baseUrl: '',
    requiresKey: false,
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-grant-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    script = new ScriptedProvider([])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store,
      new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个「已经停在 waiting_approval」的 Run，和它对应的一条 pending 审批。 */
  function seedAwaitingApproval() {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    // 模型先调了一次 write_file → 系统建了审批
    const probeStep = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'write_file', args: { path: join(workspace, 'a.txt'), content: 'first' } },
    })
    const approval = store.createApproval({
      runId: run.id,
      stepId: probeStep.id,
      toolId: 'write_file',
      toolCallId: 'call_pending',
      arguments: { path: join(workspace, 'a.txt'), content: 'first' },
      timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')

    // 历史里必须有那条 assistant tool_call，否则恢复时序列不合法
    store.appendRunMessage(run.id, userMessage('写个文件'))
    store.appendRunMessage(run.id, {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call_pending',
        name: 'write_file',
        arguments: JSON.stringify({ path: join(workspace, 'a.txt'), content: 'first' }),
      }],
    })

    return { run, approval, task }
  }

  it('审批恢复执行后，once 授权必须被消耗（usedCalls=1）', async () => {
    const { run, approval } = seedAwaitingApproval()

    // 用户批准一次
    executor.approve(approval.id, { scope: 'once' })
    const grants = store.listGrants(run.id)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.constraints.maxCalls).toBe(1)
    expect(grants[0]!.usedCalls).toBe(0)     // 批准本身不消耗

    // 恢复执行：模型这一轮不再调工具，直接收束
    script = new ScriptedProvider([{ text: '已经写好了。' }])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: PROVIDER,
      model: { id: 'deepseek-chat' },
      messages: [],
      signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('completed')
    // 文件确实写了
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('first')

    // ★ 核心断言：审批恢复的执行必须消耗授权
    const after = store.listGrants(run.id)[0]!
    expect(after.usedCalls).toBe(1)
  })

  it('approve 之后的审批恢复只能发生一次（重复 execute 不会重复执行工具）', async () => {
    const { run, approval } = seedAwaitingApproval()
    executor.approve(approval.id, { scope: 'once' })

    script = new ScriptedProvider([{ text: '完成。' }, { text: '完成。' }])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    await executor.execute({
      runId: run.id,
      provider: PROVIDER,
      model: { id: 'deepseek-chat' },
      messages: [],
      signal: new AbortController().signal,
    })

    // 篡改文件，再执行一次：如果审批被重复消费，内容会被改回 first
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(workspace, 'a.txt'), 'tampered', 'utf8')

    const second = await executor.execute({
      runId: run.id,
      provider: PROVIDER,
      model: { id: 'deepseek-chat' },
      messages: [],
      signal: new AbortController().signal,
    })

    // 第二次 execute 被状态门拦下：返回的是「当前状态就是 completed」，
    // 不是「这次又执行完了一次」。判据看 Run 本身和文件内容。
    expect(second.status).toBe('completed')
    expect(store.getRun(run.id)!.status).toBe('completed')
    // ★ 真正的不变量：审批结果只被消费一次，工具没有被重放
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('tampered')
    expect(store.pendingResolutions(run.id)).toHaveLength(0)
  })

  it('批准后 Grant 被撤销时，审批恢复执行必须拒绝而不是静默执行', async () => {
    // 真实场景：用户批准了，随后在别处撤销了授权（或授权过期），
    // 之后才轮到恢复执行。此时绝不能再执行工具。
    const { run, approval } = seedAwaitingApproval()
    executor.approve(approval.id, { scope: 'once' })

    const grant = store.listGrants(run.id)[0]!
    store.revokeGrant(grant.id)

    script = new ScriptedProvider([{ text: '好，我不再重试。' }])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: PROVIDER,
      model: { id: 'deepseek-chat' },
      messages: [],
      signal: new AbortController().signal,
    })

    // 工具没有执行
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    // 但 Run 本身正常收束（模型收到了「授权不可用」的 tool 消息）
    expect(outcome.status).toBe('completed')
    // 授权没有被消耗
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(0)
  })

  it('审批恢复路径必须计入 Run 的 toolCalls 预算', async () => {
    // 预算在建 Run 时就固定，之后不能改。
    // 所以这条测试自己建 Run，把 maxToolCalls 设为 1。
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 10, maxToolCalls: 1 },
    })

    const probeStep = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'write_file', args: { path: join(workspace, 'b.txt'), content: 'x' } },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: probeStep.id, toolId: 'write_file',
      toolCallId: 'call_budget', arguments: { path: join(workspace, 'b.txt'), content: 'x' },
      timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('写'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_budget', name: 'write_file',
        arguments: JSON.stringify({ path: join(workspace, 'b.txt'), content: 'x' }) }],
    })

    executor.approve(approval.id, { scope: 'once' })

    script = new ScriptedProvider([{ text: '完成。' }])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    await executor.execute({
      runId: run.id,
      provider: PROVIDER,
      model: { id: 'deepseek-chat' },
      messages: [],
      signal: new AbortController().signal,
    })

    const after = store.getRun(run.id)!
    expect(after.usage.toolCalls).toBe(1)
  })
})
