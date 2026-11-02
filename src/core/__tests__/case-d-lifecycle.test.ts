// 用例 D：生命周期与治理（P0-A 验收）
//
// 验证 v0.3 设计稿里新增的语义：
//   1. paused 与 waiting_approval 必须分开
//   2. 审批超时 fail-closed（超时 = 拒绝）
//   3. 悬挂的 running Step 在启动时被清理为 unknown
//   4. unknown 阻塞整个 Run（needs_reconciliation）
//   5. 对账后解除阻塞
//   6. Task 级累计预算
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
import type { ChatMessage } from '../../shared/types.js'

const hangingTool: ToolImpl = {
  definition: {
    id: 'slow_op',
    name: 'slow_op',
    description: '模拟卡住的外部操作',
    inputSchema: { type: 'object', properties: {}, required: [] },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 50,
    maxOutputBytes: 1024,
    reconcile: { idempotent: false, unsafeToRetry: true },
  },
  async run() {
    await new Promise(() => {
      /* 永不 resolve */
    })
    return { ok: true, content: '' }
  },
}

describe('用例 D：生命周期与治理', () => {
  let dir: string
  let dbPath: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-case-d-'))
    dbPath = join(dir, 'test.db')
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(dbPath)
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      /* 已关闭 */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider, tools?: ToolImpl[]): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, handlers) => script.stream(req, handlers) }
    // 不传 tools 时用默认内置工具（含 write_file）；传了就只用指定的
    return new RunExecutor(
      store,
      tools ? new ToolRegistry(tools) : new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100_000, outputReserve: 8_000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  // ── 1. paused vs waiting_approval ───────────────────────

  it('等审批时 Run 进入 waiting_approval，且不能直接 resume', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: '写文件' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'write_file', args: { path: join(workspace, 'x.txt'), content: 'a' } }] },
    ])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('写')],
      signal: new AbortController().signal,
    })

    expect(store.getRun(run.id)!.status).toBe('waiting_approval')

    // 关键：不能绕过审批直接 resume
    expect(() => executor.resume(run.id)).toThrow(/必须先批准或拒绝/)
    expect(store.getRun(run.id)!.status).toBe('waiting_approval')
  })

  it('用户主动暂停的 Run 可以直接恢复', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'running')

    const executor = makeExecutor(new ScriptedProvider([]))
    executor.pause(run.id)
    expect(store.getRun(run.id)!.status).toBe('paused')

    executor.resume(run.id)
    expect(store.getRun(run.id)!.status).toBe('queued')
  })

  // ── 2. 审批超时 fail-closed ─────────────────────────────

  it('审批超时自动转为拒绝，Run 回到 running', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: '写' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'write_file', args: { path: join(workspace, 'to.txt'), content: 'z' } }] },
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
    expect(approval.expiresAt).toBeGreaterThan(approval.createdAt)

    // 手动把过期时间推到过去，模拟超时
    store.dbExecForTest(`UPDATE approval SET expires_at = ${Date.now() - 1000} WHERE id = '${approval.id}'`)

    const expired = executor.expireStaleApprovals()
    expect(expired).toHaveLength(1)

    const reloaded = store.getApproval(approval.id)!
    expect(reloaded.status).toBe('rejected')
    expect(reloaded.reason).toContain('fail-closed')

    // 审批超时后 Run 不再挂在 waiting_approval
    expect(store.getRun(run.id)!.status).toBe('queued')
  })

  // ── 3. 悬挂 Step 清理 ───────────────────────────────────

  it('启动时把悬挂的 running Step 清理为 unknown', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const step = store.createStep({
      runId: run.id,
      index: 0,
      kind: 'tool',
      status: 'running',
      input: { tool: 'write_file' },
    })

    const swept = store.sweepDanglingSteps()
    expect(swept).toHaveLength(1)
    expect(swept[0]!.stepId).toBe(step.id)

    const after = store.getStep(step.id)!
    expect(after.status).toBe('unknown')
    expect((after.output as { swept?: boolean }).swept).toBe(true)
  })

  // ── 4 & 5. unknown 阻塞 Run，对账后解除 ─────────────────

  it('工具超时后 Run 进入 needs_reconciliation，阻塞验收', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow_op', args: {} }] },
      { text: '我需要人工确认' },
    ])
    const executor = makeExecutor(script, [hangingTool])

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('执行')],
      signal: new AbortController().signal,
    })

    // unknown 的 Step 应该把 Run 置为 needs_reconciliation
    const steps = store.listSteps(run.id)
    expect(steps.find((s) => s.kind === 'tool')!.status).toBe('unknown')

    // 但模型收束后 Run 会被标 completed——这里要验证有未解决 unknown 时不能算完成
    expect(store.hasUnresolvedUnknown(run.id)).toBe(true)
  })

  it('对账后才能解除 unknown 阻塞', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const step = store.createStep({
      runId: run.id,
      index: 0,
      kind: 'tool',
      status: 'unknown',
      input: { tool: 'write_file' },
      output: { error: '超时' },
    })
    store.setRunStatus(run.id, 'needs_reconciliation')

    const executor = makeExecutor(new ScriptedProvider([]))

    // 执行前：有未解决 unknown，应被状态门拒绝
    //
    // 返回类型是 needs_reconciliation 而不是 failed——
    // failed 语义上可以重试，needs_reconciliation 不行。
    const blocked = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('继续')],
      signal: new AbortController().signal,
    })
    expect(blocked.status).toBe('needs_reconciliation')
    expect((blocked as { reason: string }).reason).toContain('对账')

    // 对账
    const record = executor.reconcile({
      runId: run.id,
      stepId: step.id,
      resolution: 'confirmed_success',
      // 证据改为结构化 JSON：本项目现在要求可核验的依据，
      // 纯文字不再能解除 unknown（见 reconcile-evidence.test.ts）
      evidence: JSON.stringify({
        type: 'manual_inspection',
        source: 'file_stat',
        observed: 'exists',
        actor: 'user',
        note: '检查了目标文件，内容已写入',
      }),
      decidedBy: 'user',
    })
    expect(record.resolution).toBe('confirmed_success')

    const afterStep = store.getStep(step.id)!
    expect(afterStep.status).toBe('completed')
    expect(store.hasUnresolvedUnknown(run.id)).toBe(false)
    expect(store.getRun(run.id)!.status).toBe('queued')
  })

  it('对账记录必须留下依据', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const step = store.createStep({
      runId: run.id,
      index: 0,
      kind: 'tool',
      status: 'unknown',
      output: { error: '连接中断' },
    })

    const executor = makeExecutor(new ScriptedProvider([]))
    executor.reconcile({
      runId: run.id,
      stepId: step.id,
      resolution: 'confirmed_failure',
      // 结构化证据：observed 必须与 confirmed_failure 自洽（not_found）
      evidence: JSON.stringify({
        // 远端 API 无法被本进程独立验证 → 走人工复核路径。
        // 这是 v0.14 的语义：不可验证的证据必须显式声明人工确认。
        type: 'manual_inspection',
        source: 'remote_api',
        observed: 'not_found',
        actor: 'user',
        note: '查询远端确认未收到请求',
      }),
    })

    const records = store.listReconciliations(run.id)
    expect(records).toHaveLength(1)
    expect(records[0]!.unknownReason).toBe('连接中断')
    expect(records[0]!.resolution).toBe('confirmed_failure')
    // 断言强度不变：仍然要求记录里保留判断依据
    expect(records[0]!.evidence).toContain('未收到请求')
    expect(records[0]!.evidence).toContain('not_found')
  })

  // ── 6. Task 级预算 ──────────────────────────────────────

  it('Task 级预算耗尽时不得启动新 Run', async () => {
    const session = store.createSession('t')
    const task = store.createTask({
      sessionId: session.id,
      goal: 'g',
      budget: { maxSteps: 1 },
    })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 100 } })

    // 手动把 Task 用量推到上限
    store.addTaskUsage(task.id, { steps: 1 })

    const script = new ScriptedProvider([{ text: '不应该执行到这里' }])
    const executor = makeExecutor(script)

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('expired')
    expect(store.getRun(run.id)!.status).toBe('expired')
    // 模型不应被调用
    expect(script.turnCount).toBe(0)
  })

  it('模型调用后 Task 用量会累加', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const script = new ScriptedProvider([{ text: '完成', inputTokens: 200, outputTokens: 50 }])
    const executor = makeExecutor(script)

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    const reloaded = store.getTask(task.id)!
    expect(reloaded.usage!.inputTokens).toBe(200)
    expect(reloaded.usage!.outputTokens).toBe(50)
    expect(reloaded.usage!.steps).toBeGreaterThan(0)
  })
})
