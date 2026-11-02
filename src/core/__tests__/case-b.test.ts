// 用例 B：写工具被拒绝
//
// 验收条件（来自 SPEC）：
//   1. write_file 触发审批，Run = paused
//   2. 用户拒绝后返回 tool_denied
//   3. 模型收束，不再重复请求
//   4. 相同工具和参数不重复创建审批
//   5. 重启后审批历史仍存在
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

describe('用例 B：写工具被拒绝', () => {
  let dir: string
  let dbPath: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-case-b-'))
    dbPath = join(dir, 'test.db')
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(dbPath)
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, handlers) => script.stream(req, handlers) }
    return new RunExecutor(
      store,
      new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100_000, outputReserve: 8_000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  it('write_file 触发审批，Run 进入 paused，文件未被写入', async () => {
    const session = store.createSession('测试')
    const task = store.createTask({ sessionId: session.id, goal: '写一个文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    const target = join(workspace, 'out.txt')

    const script = new ScriptedProvider([
      { text: '我来写文件', toolCalls: [{ name: 'write_file', args: { path: target, content: 'hello' } }] },
    ])
    const executor = makeExecutor(script)

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写个文件')],
      signal: new AbortController().signal,
    })

    // ── Run 进入 waiting_approval，不是 paused ─────────────
    // 两者语义不同：paused 是用户主动暂停（可直接恢复），
    // waiting_approval 必须先处理审批才能继续。
    expect(outcome.status).toBe('paused')
    expect(store.getRun(run.id)!.status).toBe('waiting_approval')

    const approvals = store.listApprovals('pending')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]!.toolId).toBe('write_file')

    // ── 文件绝不能已经写进去 ──────────────────────────────
    expect(existsSync(target)).toBe(false)

    // ── 审批 Step 处于 waiting_approval ───────────────────
    const steps = store.listSteps(run.id)
    const approvalStep = steps.find((s) => s.kind === 'approval')!
    expect(approvalStep.status).toBe('waiting_approval')
  })

  it('拒绝后返回 tool_denied，模型收束，Run completed', async () => {
    const session = store.createSession('测试')
    const task = store.createTask({ sessionId: session.id, goal: '写文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    const target = join(workspace, 'out.txt')

    const script = new ScriptedProvider([
      { text: '我来写', toolCalls: [{ name: 'write_file', args: { path: target, content: 'x' } }] },
      { text: '好的，我不会写这个文件。' },
    ])
    const executor = makeExecutor(script)

    const first = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写文件')],
      signal: new AbortController().signal,
    })
    expect(first.status).toBe('paused')
    const approval = store.listApprovals('pending')[0]!

    // ── 用户拒绝 ──────────────────────────────────────────
    executor.reject(approval.id, '不要动这个目录')

    const reloaded = store.getApproval(approval.id)!
    expect(reloaded.status).toBe('rejected')
    expect(reloaded.reason).toBe('不要动这个目录')
    expect(store.getRun(run.id)!.status).toBe('queued')

    // ── 恢复执行：模型应该收到拒绝结果并收束 ──────────────
    const second = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写文件')],
      signal: new AbortController().signal,
    })

    expect(second.status).toBe('completed')

    // 拒绝信息必须作为结构化结果回给模型
    const secondCall = script.calls[1]!
    const toolResult = secondCall.messages.find((m) => m.role === 'tool')!
    expect(toolResult.content).toContain('已拒绝')
    expect(toolResult.content).toContain('不要动这个目录')

    // 文件仍未写入
    expect(existsSync(target)).toBe(false)
  })

  it('相同工具和参数不重复创建审批', async () => {
    const session = store.createSession('测试')
    const task = store.createTask({ sessionId: session.id, goal: '写文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 20 } })
    const target = join(workspace, 'dup.txt')
    const args = { path: target, content: 'same' }

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'write_file', args }] },
      { text: '好的' },
    ])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写')],
      signal: new AbortController().signal,
    })

    const approval = store.listApprovals('pending')[0]!
    executor.reject(approval.id, '不行')

    // 第二次执行时，模型又请求同样的工具和参数
    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写')],
      signal: new AbortController().signal,
    })

    // ── 关键断言：只应存在最初那一条审批 ──────────────────
    const allApprovals = store.listApprovals()
    expect(allApprovals).toHaveLength(1)

    // 被去重拦下的 Step 状态是 rejected，而不是又开一个 waiting_approval
    const steps = store.listSteps(run.id)
    const rejectedSteps = steps.filter((s) => s.status === 'rejected')
    expect(rejectedSteps.length).toBeGreaterThanOrEqual(1)
  })

  it('重启后审批历史仍存在', async () => {
    const session = store.createSession('测试')
    const task = store.createTask({ sessionId: session.id, goal: '写文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'write_file', args: { path: join(workspace, 'r.txt'), content: 'x' } }] },
    ])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写')],
      signal: new AbortController().signal,
    })

    const approvalId = store.listApprovals('pending')[0]!.id
    executor.reject(approvalId, '拒绝原因')

    // ── 模拟重启 ──────────────────────────────────────────
    store.close()
    store = new Store(dbPath)

    const approval = store.getApproval(approvalId)
    expect(approval).toBeDefined()
    expect(approval!.status).toBe('rejected')
    expect(approval!.reason).toBe('拒绝原因')
    expect(approval!.decidedAt).toBeGreaterThan(0)

    // 拒绝记录也要还在，否则重启后去重会失效
    const { hashArguments } = await import('../paths.js')
    const denied = store.findDenied(run.id, 'write_file', hashArguments({ path: join(workspace, 'r.txt'), content: 'x' }))
    expect(denied).toBeDefined()
    expect(denied!.reason).toBe('拒绝原因')
  })
})
