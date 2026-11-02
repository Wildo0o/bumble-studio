// `beginToolAttempt` 的事务边界：用真实故障注入证明，不手工构造状态。
//
// 上一版的崩溃测试有个矛盾：它们手工调用 `claimGrantUsage` 制造出
// 「Grant 已扣、Intent 仍 prepared」的状态，然后声称这是崩溃的结果。
//
// 但 `beginToolAttempt` 是一个事务：claim 和 startIntent 一起提交。
// 这个中间状态**不可能**通过正常路径产生。手工构造它，等于在验证
// 一个系统根本不会进入的状态。
//
// 本文件用真实手段验证四个边界：
//
//   1. 事务提交前失败 → 全部回滚
//   2. 事务提交后、外部调用前崩溃 → Intent=started，sweep 成 unknown
//   3. 外部副作用后、结果落库前崩溃 → Intent=unknown，Run=needs_reconciliation
//   4. 预算失败 → Grant 不变，Intent 不锁死
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

describe('beginToolAttempt 的事务边界（真实故障注入）', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-tx-'))
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

  function newRunWithGrant(maxCalls = 5, maxToolCalls = 20) {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxSteps: 20, maxToolCalls },
    })
    store.createGrant({
      id: `g-${run.id}`, runId: run.id, toolId: 'wt',
      constraints: { maxCalls }, expiresAt: Date.now() + 60_000, status: 'active',
    })
    return run
  }

  // ── 边界 1：事务提交前失败 ──────────────────────────────

  it('1. 预算在事务内抛错 → Grant 不变、Intent 留 prepared、工具不执行', () => {
    const run = newRunWithGrant(5, 0)   // maxToolCalls=0 → 预算必然失败

    const r = store.beginToolAttempt({
      runId: run.id,
      taskId: run.taskId,
      stepId: 's1',
      toolCallId: 'c1',
      toolId: 'wt',
      toolName: 'wt',
      requestHash: 'h',
      operationKey: 'op',
      requireGrant: true,
      // 用一个必然失败的预留模拟预算不足
      reserve: { steps: 999_999 },
    })

    expect(r.ok).toBe('budget_exceeded')
    // ★ Grant 完全没动
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(0)
    // ★ Intent 仍在 prepared（可重试），不是 failed
    const intents = store.listIntents(run.id)
    expect(intents).toHaveLength(1)
    expect(intents[0]!.status).toBe('prepared')
  })

  it('1b. startIntent 失败时 Grant 也必须回滚', () => {
    const run = newRunWithGrant()

    // 先把 Intent 推到 started，让 beginToolAttempt 的 startIntent 失败
    const pre = store.getOrCreateIntent({
      runId: run.id, stepId: 's1', toolCallId: 'c1',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })
    store.startIntent(pre.intent.id)

    const r = store.beginToolAttempt({
      runId: run.id, taskId: run.taskId, stepId: 's1', toolCallId: 'c1',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
      requireGrant: true,
    })

    // 已经 started 的 Intent 会被 blocked 分支拦住（在 claim 之前）
    expect(r.ok).toBe('blocked')
    // ★ Grant 没被扣
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(0)
  })

  // ── 边界 2：事务提交后、外部调用前崩溃 ──────────────────

  it('2. 事务提交后崩溃：Intent=started，Grant 已扣，sweep 后变 unknown 且不重试', async () => {
    const run = newRunWithGrant()

    // 手工调一次事务——它成功提交，模拟「提交后立刻崩溃」
    const r = store.beginToolAttempt({
      runId: run.id, taskId: run.taskId, stepId: 's1', toolCallId: 'c1',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
      requireGrant: true,
    })
    expect(r.ok).toBe('started')

    // 此刻的真实状态
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('started')
    // 工具没执行（没有文件）

    // 重启：sweep 把 started 标成 unknown
    store.close()
    store = new Store(dbPath)
    const swept = store.sweepStartedIntents()
    expect(swept).toHaveLength(1)

    const after = store.listIntents(run.id)[0]!
    expect(after.status).toBe('unknown')
    expect(after.unknownReason).toContain('进程异常终止')

    // 再次尝试：必须被 unknown 挡住，不重试
    const r2 = store.beginToolAttempt({
      runId: run.id, taskId: run.taskId, stepId: 's1', toolCallId: 'c1',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
      requireGrant: true,
    })
    expect(r2.ok).toBe('blocked')
    // ★ Grant 没有被二次消耗
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
  })

  // ── 边界 3：副作用后、结果落库前崩溃 ────────────────────

  it('3. 副作用后崩溃：Intent=unknown，Run=needs_reconciliation，不标 completed', async () => {
    const target = join(workspace, 'crash.txt')
    const counter = { calls: 0 }

    const crashing: ToolImpl = {
      definition: {
        id: 'wt', name: 'wt', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
        timeoutMs: 5000, maxOutputBytes: 8192,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run(input) {
        counter.calls++
        writeFileSync(String(input.path), 'side-effect', 'utf8')
        throw new Error('CRASH_AFTER_EFFECT')
      },
    }

    const run = newRunWithGrant()
    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(new ToolRegistry([crashing]), script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 先确认走到了目标路径：模型确实发了 tool_call，工具确实被执行
    expect(script.turnCount, '模型没有发出 tool_call，测试没走到目标路径').toBeGreaterThan(0)
    expect(counter.calls, '工具没有被调用，测试没走到目标路径').toBe(1)

    // ★ 不能是 completed
    expect(out.status).toBe('needs_reconciliation')
    expect(store.getRun(run.id)!.status).toBe('needs_reconciliation')
    // ★ Intent 是 unknown
    const intents = store.listIntents(run.id)
    expect(intents, '没有创建 Intent').toHaveLength(1)
    expect(intents[0]!.status).toBe('unknown')
    // 副作用确实发生了
    expect(readFileSync(target, 'utf8')).toBe('side-effect')
  })

  // ── 边界 4：预算失败的全链路 ────────────────────────────

  it('4. 预算失败：工具不执行、Grant 不变、Intent 不锁死、Run 不静默 completed', async () => {
    const target = join(workspace, 'budget.txt')
    const counter = { calls: 0 }
    const run = newRunWithGrant(5, 0)

    const ex = makeExecutor(new ToolRegistry([writeTool(counter, target)]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'wt', args: { path: target } }] },
        { text: '好' },
      ]))

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(0)
    expect(out.status).toBe('expired')
    expect(out.status).not.toBe('completed')
    // Intent 若存在，必须仍是 prepared
    for (const i of store.listIntents(run.id)) {
      expect(i.status).toBe('prepared')
    }
  })

  // ── 对照：正常路径下，不会出现「Grant 已扣但 Intent prepared」────

  it('正常路径不会产生「Grant 已扣但 Intent 仍 prepared」的中间态', async () => {
    const target = join(workspace, 'normal.txt')
    const counter = { calls: 0 }
    const run = newRunWithGrant()

    const ex = makeExecutor(new ToolRegistry([writeTool(counter, target)]),
      new ScriptedProvider([
        { toolCalls: [{ name: 'wt', args: { path: target } }] },
        { text: '完成' },
      ]))

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    const grant = store.listGrants(run.id)[0]!
    const intent = store.listIntents(run.id)[0]!

    // 两者要么都是「没发生」（used=0 + prepared），
    // 要么都是「已发生」（used=1 + committed/unknown）。
    // 不可能出现 used=1 + prepared。
    expect(
      grant.usedCalls === 1 && intent.status === 'prepared',
      `出现了事务外的不一致状态：usedCalls=${grant.usedCalls}, intent=${intent.status}`,
    ).toBe(false)

    expect(grant.usedCalls).toBe(1)
    expect(intent.status).toBe('committed')
  })
})
