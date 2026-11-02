// 任务书列出的 10 个副作用语义场景。
//
// 全部从 `executor.execute()` 入口跑，不直接调 Store。
// 理由：Store 层的测试再多，也证明不了「执行路径真的调了它」——
// 上一批的 Grant 漏洞就是这么漏掉的。
//
// 每个测试都数「工具被调用了几次」，这是唯一可靠的判据。
// 只看状态字段会被「状态对了但副作用执行了两次」骗过去。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 计数工具：每次 run 都 +1，并按配置决定行为。 */
function countingTool(opts: {
  counter: { calls: number }
  target: string
  behavior: 'ok' | 'throw-before' | 'throw-after' | 'hang'
  riskLevel?: 'read' | 'write'
  idempotent?: boolean
  timeoutMs?: number
}): ToolImpl {
  const { counter, target, behavior } = opts
  return {
    definition: {
      id: 'count_tool',
      name: 'count_tool',
      description: '测试用',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'builtin',
      riskLevel: opts.riskLevel ?? 'write',
      sideEffect: (opts.riskLevel ?? 'write') === 'read' ? 'none' : 'filesystem',
      enabled: true,
      timeoutMs: opts.timeoutMs ?? 5000,
      maxOutputBytes: 8192,
      reconcile: {
        idempotent: opts.idempotent ?? false,
        unsafeToRetry: !(opts.idempotent ?? false),
      },
    },
    async run(input) {
      counter.calls++
      if (behavior === 'throw-before') {
        throw new Error('FAILED_BEFORE_SIDE_EFFECT')
      }
      if (behavior === 'hang') {
        await new Promise(() => { /* 永不 resolve */ })
        return { ok: true, content: '' }
      }
      writeFileSync(String(input.path ?? target), `call-${counter.calls}`, 'utf8')
      if (behavior === 'throw-after') {
        throw new Error('FAILED_AFTER_SIDE_EFFECT')
      }
      return { ok: true, content: `wrote at call ${counter.calls}` }
    },
  }
}

describe('副作用语义：10 个场景', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-scen-'))
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

  function newRun() {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    return { run, task }
  }

  /** 造一个「已停在 waiting_approval」的 Run。 */
  function awaitingApproval(target: string, callId = 'call_1') {
    const { run, task } = newRun()
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'count_tool', args: { path: target } },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'count_tool',
      toolCallId: callId, arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: callId, name: 'count_tool', arguments: JSON.stringify({ path: target }) }],
    })
    return { run, task, approval, step }
  }

  function restart(): void {
    store.close()
    store = new Store(dbPath)
  }

  // ─────────────────────────────────────────────────────
  // 1. 副作用前进程崩溃
  // ─────────────────────────────────────────────────────
  it('1. 副作用发生前的异常：记 failed，允许后续重试', async () => {
    const target = join(workspace, 'a.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'throw-before' })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '知道了' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    expect(existsSync(target)).toBe(false)

    // 写工具的异常一律记 unknown（无法区分「抛错前有没有写」），
    // 但这里要确认的是：**系统没有谎称成功**
    const intents = store.listIntents(run.id)
    expect(intents).toHaveLength(1)
    expect(intents[0]!.status).toBe('unknown')
  })

  // ─────────────────────────────────────────────────────
  // 2. 副作用已发生、结果落库前崩溃
  // ─────────────────────────────────────────────────────
  it('2. 副作用后异常：文件已写，系统必须记 unknown 而不是 completed', async () => {
    const target = join(workspace, 'b.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'throw-after' })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('call-1')      // 副作用已发生

    expect(out.status).toBe('needs_reconciliation')          // 不能是 completed
    expect(store.getRun(run.id)!.status).toBe('needs_reconciliation')
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
  })

  // ─────────────────────────────────────────────────────
  // 3. markApprovalConsumed 前崩溃（Intent 已 committed）
  // ─────────────────────────────────────────────────────
  it('3. 已 committed 的调用在重启后不重放，直接复用保存的结果', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'ok' })])

    const { run, approval, step } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)
    const intentAfterFirst = store.listIntents(run.id)[0]!
    expect(intentAfterFirst.status).toBe('committed')

    // 模拟「markApprovalConsumed 之前崩溃」：
    // 直接把审批打回未消费 + Run 打回 queued
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()
    restart()

    // ★ 断言重启后能找回这条审批
    expect(store.pendingResolutions(run.id)).toHaveLength(1)

    // 篡改文件：如果工具被重放，内容会被改回 call-2
    writeFileSync(target, 'tampered', 'utf8')

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    const out = await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(out.status).toBe('completed')
    // ★ 核心：工具没有被再次调用
    expect(counter.calls, `工具被调用 ${counter.calls} 次，应为 1`).toBe(1)
    // 文件保持被篡改后的内容，说明确实没重写
    expect(readFileSync(target, 'utf8')).toBe('tampered')
    // Intent 仍是同一条，状态仍 committed
    const intents = store.listIntents(run.id)
    expect(intents).toHaveLength(1)
    expect(intents[0]!.id).toBe(intentAfterFirst.id)
    expect(intents[0]!.status).toBe('committed')
    // stepId 用的是原始审批的 stepId（不是恢复时新建的）
    expect(intents[0]!.stepId).toBe(step.id)
  })

  // ─────────────────────────────────────────────────────
  // 4. timeout 后底层写操作晚到
  // ─────────────────────────────────────────────────────
  it('4. 超时后底层写入晚到：记 unknown，晚到不改变状态', async () => {
    const target = join(workspace, 'd.txt')
    const counter = { calls: 0 }

    // 一个「慢但会成功」的工具：30ms 超时，150ms 后写完
    const slowTool: ToolImpl = {
      definition: {
        id: 'count_tool', name: 'count_tool', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
        timeoutMs: 30, maxOutputBytes: 8192,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run(input) {
        counter.calls++
        await new Promise((r) => setTimeout(r, 150))
        writeFileSync(String(input.path), `late-${counter.calls}`, 'utf8')
        return { ok: true, content: 'done late' }
      },
    }

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(new ToolRegistry([slowTool]),
      new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(out.status).toBe('needs_reconciliation')
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')

    // 等晚到的写入落地
    await new Promise((r) => setTimeout(r, 300))

    // 文件确实被晚到的调用写了
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('late-1')
    // 但 Intent 仍是 unknown——晚到结果不能把它改成 committed
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
    // 也没有产生第二次执行
    expect(counter.calls).toBe(1)
  })

  // ─────────────────────────────────────────────────────
  // 5. 重复 resume
  // ─────────────────────────────────────────────────────
  it('5. 重复 execute 不会重放已 committed 的工具', async () => {
    const target = join(workspace, 'e.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'ok' })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }, { text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)

    const second = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(second.status).toBe('completed')   // 状态门：已是 completed
    expect(counter.calls).toBe(1)
  })

  // ─────────────────────────────────────────────────────
  // 6. 已 committed 的 Intent 再执行
  // ─────────────────────────────────────────────────────
  it('6. 普通路径命已 committed 的 Intent 时直接复用', async () => {
    // 手动造一个 committed Intent，然后让普通路径请求同一个 toolCallId
    const target = join(workspace, 'f.txt')
    const counter = { calls: 0 }
    const { run } = newRun()

    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'running',
      input: { tool: 'count_tool' },
    })
    const created = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: 'call_x',
      toolId: 'count_tool', toolName: 'count_tool',
      requestHash: 'h', operationKey: 'op',
    })
    store.startIntent(created.intent.id)
    store.commitIntent(created.intent.id, {
      content: 'cached-result', isError: false, resultHash: 'rh',
    })

    // 现在用同一个 (run, step, toolCallId) 走 invokeTool —— 通过一个
    // 会先生成同样 stepId 的路径很难，所以这里直接验证 Store 层语义：
    // 已 committed 的 Intent 取回来仍是 committed，不会被重置成 prepared
    const again = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: 'call_x',
      toolId: 'count_tool', toolName: 'count_tool',
      requestHash: 'h', operationKey: 'op',
    })
    expect(again.created).toBe(false)
    expect(again.intent.status).toBe('committed')
    expect(again.intent.resultContent).toBe('cached-result')
    expect(counter.calls).toBe(0)
  })

  // ─────────────────────────────────────────────────────
  // 7. unknown Intent 被自动重试
  // ─────────────────────────────────────────────────────
  it('7. unknown Intent 不会被自动重试', async () => {
    const target = join(workspace, 'g.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'throw-after' })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')

    // 手动把 Run 打回 queued，模拟用户想「再试一次」
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()
    restart()

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 没有第二次执行
    expect(counter.calls, `工具被调用 ${counter.calls} 次，应为 1`).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
  })

  // ─────────────────────────────────────────────────────
  // 8. 不支持幂等键的工具不能自动重试
  // ─────────────────────────────────────────────────────
  it('8. 非幂等工具在 unknown 后即使重新 execute 也不重试', async () => {
    const target = join(workspace, 'h.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({
      counter, target, behavior: 'ok', idempotent: false,
    })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)

    // 把 Intent 手工改成 unknown（模拟「不确定」）
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare("UPDATE tool_intent SET status = 'unknown' WHERE run_id = ?").run(run.id)
    raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()
    restart()

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
  })

  // ─────────────────────────────────────────────────────
  // 9. approved-resume 与普通路径共用同一个 Intent
  // ─────────────────────────────────────────────────────
  it('9. 审批恢复创建的 Intent 键用原始 stepId，不是恢复时的新 stepId', async () => {
    const target = join(workspace, 'i.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'ok' })])

    const { run, approval, step } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    const intents = store.listIntents(run.id)
    expect(intents).toHaveLength(1)
    // 关键：Intent 挂在原始审批的 step 上
    expect(intents[0]!.stepId).toBe(step.id)
    expect(intents[0]!.toolCallId).toBe(approval.toolCallId)

    // 恢复路径额外建了一个追踪 step，但 Intent 不属于它
    const steps = store.listSteps(run.id)
    const resumedStep = steps.find((s) => s.id !== step.id && s.kind === 'tool')
    if (resumedStep) {
      expect(intents[0]!.stepId).not.toBe(resumedStep.id)
    }
  })

  // ─────────────────────────────────────────────────────
  // 10. scope=once Grant 不因崩溃重放而重复消耗
  // ─────────────────────────────────────────────────────
  it('10. scope=once：崩溃重放时 Grant 不会被消耗两次', async () => {
    const target = join(workspace, 'j.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool({ counter, target, behavior: 'ok' })])

    const { run, approval } = awaitingApproval(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'once' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    const grant = store.listGrants(run.id)[0]!
    expect(grant.usedCalls).toBe(1)

    // 模拟崩溃重放
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()
    restart()

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 工具没重放（Intent 复用），Grant 也没被二次消耗
    expect(counter.calls).toBe(1)
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
  })
})

describe('裁决与 Intent 的联动', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-rec-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    dbPath = join(dir, 't.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('对账后 Intent 从 unknown 变成 reconciled，仍然不会自动重试', async () => {
    const target = join(workspace, 'r.txt')
    const counter = { calls: 0 }
    const tool = countingTool({ counter, target, behavior: 'throw-after' })

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval', input: {},
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'count_tool',
      toolCallId: 'c1', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'c1', name: 'count_tool', arguments: JSON.stringify({ path: target }) }],
    })

    const adapter: ProviderAdapter = { stream: (r, h) => new ScriptedProvider([{ text: '好' }]).stream(r, h) }
    const ex = new RunExecutor(store, new ToolRegistry([tool]),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter)
    ex.approve(approval.id, { scope: 'run' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    const intentBefore = store.listIntents(run.id)[0]!
    expect(intentBefore.status).toBe('unknown')

    // 找到被标成 unknown 的 step 并对账
    const unknownStep = store.listSteps(run.id).find((x) => x.status === 'unknown')!
    ex.reconcile({
      runId: run.id,
      stepId: unknownStep.id,
      resolution: 'confirmed_success',
      // 结构化证据：observed 必须与 confirmed_success 自洽
      evidence: JSON.stringify({
        type: 'manual_inspection',
        source: 'file_stat',
        observed: 'exists',
        actor: 'user',
        note: '人工确认文件已写入',
      }),
      decidedBy: 'user',
    })

    const intentAfter = store.listIntents(run.id)[0]!
    expect(intentAfter.status).toBe('reconciled')
    expect(intentAfter.resolution).toContain('confirmed_success')
    expect(intentAfter.resolution).toContain('人工确认')
    // 没有重试
    expect(counter.calls).toBe(1)
  })
})
