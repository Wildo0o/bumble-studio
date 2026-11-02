// Grant / Intent / Step 的事务边界。
//
// 这一批要闭合的确定性缺陷：
//
//   当前顺序是  claim Grant → checkBudget → startIntent → 执行
//
//   预算不足时 checkBudget 抛错，但 **Grant 已经被扣了**。
//   工具没执行、Intent 还在 prepared、额度却没了——
//   用户批准的权限被一次「预算不够」白白吃掉。
//
//   同理，进程在 claim 和 startIntent 之间崩溃，也会留下
//   「额度已扣、工具未执行」的状态。
//
// 目标：把「检查授权 + 扣减额度 + 标记开始」放进一个 SQLite 事务。
// 任一步失败 → 整个事务回滚 → Grant 不消耗、Intent 留 prepared。
//
// 注意：数据库事务**不能**和文件系统/网络调用组成原子事务。
// 本文件只保证「进入 started 之前的准备工作」是原子的；
// 进入 started 之后崩溃仍然只能记 unknown。这一点不夸大。
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

function countingTool(counter: { calls: number }, target: string): ToolImpl {
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

describe('Grant / Intent / Step 事务边界', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-attempt-'))
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

  /** 造一个普通路径可执行的 Run（有 Grant）。 */
  function runWithGrant(opts: {
    target: string
    maxToolCalls?: number
    maxCalls?: number
  }) {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: {
        maxSteps: 20,
        maxToolCalls: opts.maxToolCalls ?? 20,
      },
    })
    const grant = store.createGrant({
      id: `g-${run.id}`, runId: run.id, toolId: 'wt',
      constraints: { maxCalls: opts.maxCalls ?? 5 },
      expiresAt: Date.now() + 60_000, status: 'active',
    })
    return { run, task, grant }
  }

  // ── 核心：预算不足时 Grant 不能被消耗 ────────────────────

  it('预算不足：工具不执行、Grant 不消耗、Intent 不锁死、Run 不进 completed', async () => {
    const target = join(workspace, 'a.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool(counter, target)])

    // maxToolCalls = 0：任何工具调用都超预算
    const { run, grant } = runWithGrant({ target, maxToolCalls: 0 })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ① 工具调用次数
    expect(counter.calls, '预算不足却执行了工具').toBe(0)
    // ② 文件副作用
    expect(existsSync(target), '预算不足却产生了文件').toBe(false)
    // ③ Grant 消耗
    expect(
      store.listGrants(run.id)[0]!.usedCalls,
      '预算检查失败，但 Grant 已经被扣',
    ).toBe(0)
    // ④ Intent 状态：必须仍可重试
    const intents = store.listIntents(run.id)
    if (intents.length > 0) {
      expect(
        intents[0]!.status,
        `Intent 停在 ${intents[0]!.status}，工具没执行却被锁死`,
      ).toBe('prepared')
    }
    // ⑤ Run 状态：预算是 expired，不是 completed
    expect(out.status).toBe('expired')
    expect(store.getRun(run.id)!.status).toBe('expired')
  })

  it('预算充足：工具执行一次，Grant 扣一次，Intent committed', async () => {
    const target = join(workspace, 'b.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool(counter, target)])
    const { run } = runWithGrant({ target })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '完成' },
    ])
    const ex = makeExecutor(tools, script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('call-1')
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
    expect(store.listIntents(run.id)[0]!.status).toBe('committed')
    expect(out.status).toBe('completed')
  })

  // ── Grant 不足时不能执行，但也不能锁死 ──────────────────

  it('Grant 额度为 0：工具不执行，走审批而不是静默完成', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool(counter, target)])
    const { run, grant } = runWithGrant({ target, maxCalls: 1 })

    // 先耗尽
    store.claimGrantUsage(grant.id)
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)
    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(0)
    expect(existsSync(target)).toBe(false)
    // 额度没有被二次消耗
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)
    // 进入审批，不是 completed
    expect(out.status).toBe('paused')
    expect(store.getRun(run.id)!.status).toBe('waiting_approval')
  })

  // ── 事务失败时的一致性 ──────────────────────────────────

  it('预算不足时不创建 Intent（还没到执行阶段）', async () => {
    const target = join(workspace, 'd.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingTool(counter, target)])
    const { run } = runWithGrant({ target, maxToolCalls: 0 })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 预算在 Intent 创建之前就被拦下，不该留下半成品
    expect(store.listIntents(run.id)).toHaveLength(0)
  })

  // ── 崩溃边界 ────────────────────────────────────────────
  //
  // 上一版这里有一条「手工 claim 后崩溃」的测试，它构造出
  // 「Grant 已扣、Intent 仍 prepared」的状态。
  //
  // **那个状态在 beginToolAttempt 事务下不可能产生**——
  // claim 和 startIntent 一起提交。手工构造它等于在验证一个
  // 系统根本不会进入的状态。
  //
  // 真实的事务边界测试（含故障注入）见 `tx-boundary.test.ts`。
})
