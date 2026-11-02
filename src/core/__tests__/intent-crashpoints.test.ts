// 六个崩溃点，逐个验证「重启后会发生什么」。
//
// 任务书列的 A-F：
//
//   A. Intent 创建后、Grant claim 前崩溃
//   B. Grant claim 后、Intent started 前崩溃
//   C. Intent started 后、工具执行前崩溃
//   D. 外部副作用已发生、结果写回前崩溃
//   E. committed 已写入、Approval.resultConsumed 尚未写入时崩溃
//   F. timeout 返回 unknown、底层 Promise 之后才完成
//
// 每个点都要回答四个问题：
//   1. 重启后会不会重复执行？
//   2. 会不会把 unknown 伪装成 failed/completed？
//   3. 会不会无证据自动重试？
//   4. 会不会永久留下无法解释的 prepared/started？
//
// 做法：直接操作数据库制造中间状态，然后新建 Store（模拟重启），
// 再从 executor 入口跑一次——只看最终行为和副作用次数。
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
import { hashArguments } from '../paths.js'

const PROVIDER = {
  id: 'p', name: 'P', kind: 'demo' as const, baseUrl: '', requiresKey: false,
}

function countingTool(counter: { calls: number }, target: string): ToolImpl {
  return {
    definition: {
      id: 'ct', name: 'ct', description: 'x',
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

describe('六个崩溃点', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-cp-'))
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

  /** 造一个 Run + 一条已批准的审批 + Grant，停在任何执行之前的状态。 */
  function setupApproved(opts: {
    target: string
    grantMaxCalls?: number
    callId?: string
  }) {
    const callId = opts.callId ?? 'call_cp'
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval', input: {},
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'ct',
      toolCallId: callId, arguments: { path: opts.target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: callId, name: 'ct', arguments: JSON.stringify({ path: opts.target }) }],
    })
    store.transitionApproval(approval.id, 'approved', 'test')
    const grant = store.createGrant({
      id: `g-${approval.id}`, runId: run.id, toolId: 'ct',
      constraints: { maxCalls: opts.grantMaxCalls ?? 5 },
      expiresAt: Date.now() + 60_000, status: 'active',
    })
    store.setRunStatus(run.id, 'queued')
    return { run, approval, grant, step, callId }
  }

  async function restart(): Promise<void> {
    store.close()
    store = new Store(dbPath)
    // 模拟服务启动清理：sweepStartedIntents 会把 started 标成 unknown
    store.sweepStartedIntents()
    store.sweepDanglingSteps()
  }

  async function rawDb(): Promise<import('better-sqlite3').Database> {
    const { default: Database } = await import('better-sqlite3')
    return new Database(dbPath)
  }

  // ── A. Intent 创建后、Grant claim 前崩溃 ────────────────
  it('A. Intent 已建但未 claim Grant：重启后正常执行一次', async () => {
    const target = join(workspace, 'a.txt')
    const counter = { calls: 0 }
    const { run, step, callId } = setupApproved({ target })

    // 手工造出「Intent 已创建（prepared），但没走任何后续」。
    //
    // requestHash 必须用**真实参数**算出来：现在 getOrCreateIntent 会校验
    // 「同一个 toolCallId 必须是同一个请求」，随便填 'h' 会被拒绝——
    // 那正是新加的防护在起作用。
    const realHash = hashArguments({ path: target })
    store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: callId,
      toolId: 'ct', toolName: 'ct',
      requestHash: realHash, operationKey: `op-${callId}`,
    })
    expect(store.listIntents(run.id)[0]!.status).toBe('prepared')

    await restart()

    const ex = makeExecutor(new ToolRegistry([countingTool(counter, target)]),
      new ScriptedProvider([{ text: '好' }]))
    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // prepared 是可以执行的——之前什么都没发生
    expect(counter.calls).toBe(1)
    expect(out.status).toBe('completed')
    expect(store.listIntents(run.id)[0]!.status).toBe('committed')
  })

  // ── B. Grant claim 与 Intent started 的原子性 ──────────
  //
  // **上一版这条测试是错的。**
  //
  // 它手工调用 `claimGrantUsage` 制造「Grant 已扣、Intent 仍 prepared」，
  // 然后把这个状态当作崩溃结果。但 `beginToolAttempt` 是一个事务：
  // claim 和 startIntent 一起提交，这个中间态**不可能**产生。
  //
  // 现在改成用真实事务验证：要么全做（Grant 扣 + Intent started），
  // 要么全不做（Grant 不扣 + Intent prepared）。
  it('B. 事务提交后崩溃：Grant 已扣且 Intent=started，sweep 后变 unknown', async () => {
    const target = join(workspace, 'b.txt')
    const counter = { calls: 0 }
    const { run, grant, step, callId } = setupApproved({ target, grantMaxCalls: 1 })

    // 真实地走一次事务——它会提交，模拟「提交后立刻崩溃」
    const r = store.beginToolAttempt({
      runId: run.id, taskId: run.taskId, stepId: step.id, toolCallId: callId,
      toolId: 'ct', toolName: 'ct',
      requestHash: 'h', operationKey: `op-${callId}`,
      requireGrant: true,
    })
    expect(r.ok).toBe('started')

    // ★ 事务的一致性：两个变化一起发生
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('started')

    await restart()

    // sweep 之后是 unknown，不是 prepared
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')

    const ex = makeExecutor(new ToolRegistry([countingTool(counter, target)]),
      new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 工具不执行（unknown 挡住）
    expect(counter.calls).toBe(0)
    expect(existsSync(target)).toBe(false)
    // Grant 不会被二次消耗
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
  })

  // ── C. Intent started 后、工具执行前崩溃 ────────────────
  it('C. Intent 停在 started：重启后 sweep 成 unknown，不重试', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const { run, step, callId } = setupApproved({ target })

    const created = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: callId,
      toolId: 'ct', toolName: 'ct',
      requestHash: 'h', operationKey: `op-${callId}`,
    })
    store.startIntent(created.intent.id)
    expect(store.listIntents(run.id)[0]!.status).toBe('started')

    await restart()

    // sweep 之后必须是 unknown，不能留在 started
    const afterSweep = store.listIntents(run.id)[0]!
    expect(afterSweep.status).toBe('unknown')
    expect(afterSweep.unknownReason).toContain('进程异常终止')

    const ex = makeExecutor(new ToolRegistry([countingTool(counter, target)]),
      new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 不重试
    expect(counter.calls).toBe(0)
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
  })

  // ── D. 副作用已发生、结果写回前崩溃 ────────────────────
  it('D. 副作用已发生但 Intent 仍 started：重启后记 unknown，文件保持原样', async () => {
    const target = join(workspace, 'd.txt')
    const counter = { calls: 0 }
    const { run, step, callId } = setupApproved({ target })

    // 先真的执行一次副作用（绕过 executor，直接写文件）
    writeFileSync(target, 'side-effect-happened', 'utf8')

    // 再造出「Intent 已 started 但没 committed」
    const created = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: callId,
      toolId: 'ct', toolName: 'ct',
      requestHash: 'h', operationKey: `op-${callId}`,
    })
    store.startIntent(created.intent.id)

    await restart()

    const ex = makeExecutor(new ToolRegistry([countingTool(counter, target)]),
      new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 不重放，文件内容不变
    expect(counter.calls).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('side-effect-happened')
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
  })

  // ── E. committed 已写、Approval.resultConsumed 未写 ────
  it('E. committed + resultConsumed=0：重启后复用结果，不重放', async () => {
    const target = join(workspace, 'e.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool(counter, target)])
    const { run, approval } = setupApproved({ target })

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('committed')

    // 模拟「committed 已写，resultConsumed 还没写就崩了」
    store.close()
    const db = await rawDb()
    db.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    db.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    db.close()
    store = new Store(dbPath)

    writeFileSync(target, 'tampered', 'utf8')

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    const out = await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(out.status).toBe('completed')
    expect(counter.calls, '重放了已 committed 的调用').toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('tampered')
  })

  // ── F. timeout unknown + 晚到完成 ──────────────────────
  it('F. 超时后底层完成：Intent 保持 unknown，文件被晚到写入，不产生第二次执行', async () => {
    const target = join(workspace, 'f.txt')
    const counter = { calls: 0 }

    const slow: ToolImpl = {
      definition: {
        id: 'ct', name: 'ct', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
        timeoutMs: 30, maxOutputBytes: 8192,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run(input) {
        counter.calls++
        await new Promise((r) => setTimeout(r, 150))
        writeFileSync(String(input.path), `late-${counter.calls}`, 'utf8')
        return { ok: true, content: 'late done' }
      },
    }

    const { run } = setupApproved({ target })
    const ex = makeExecutor(new ToolRegistry([slow]), new ScriptedProvider([{ text: '好' }]))
    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(out.status).toBe('needs_reconciliation')
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')

    // 等晚到写入落地
    await new Promise((r) => setTimeout(r, 300))

    // ★ 文件确实被晚到的调用写了
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('late-1')
    // ★ 但 Intent 仍是 unknown——晚到结果不能把它改成 committed
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
    // ★ 也没有第二次执行
    expect(counter.calls).toBe(1)

    // 重启后：sweep 不会动 unknown，仍然不重试
    await restart()
    expect(store.listIntents(run.id)[0]!.status).toBe('unknown')
  })

  // ── 汇总：不能留下无法解释的中间态 ────────────────────
  it('重启 sweep 之后不存在遗留的 started Intent', async () => {
    const target = join(workspace, 'g.txt')
    const { run, step, callId } = setupApproved({ target })
    const created = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: callId,
      toolId: 'ct', toolName: 'ct',
      requestHash: 'h', operationKey: `op-${callId}`,
    })
    store.startIntent(created.intent.id)

    await restart()

    const leftover = store.listIntents(run.id).filter((i) => i.status === 'started')
    expect(leftover, 'sweep 后仍有 started Intent——重启后会永久卡住')
      .toHaveLength(0)
  })
})
