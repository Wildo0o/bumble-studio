// invokeTool 的执行顺序。
//
// 顺序错了会怎样，这个文件要证明两件事：
//
//   1. **Intent 检查必须早于 Grant 认领。**
//      已 committed 的调用重放时，Grant 可能已经用完。
//      如果先 claim，就会因为「没有授权」而拒绝一个**根本不该再执行**的调用，
//      而且报错是「工具未授权」——完全误导。
//
//   2. **Grant 认领必须早于 prepared → started。**
//      如果先转 started 再 claim，claim 失败时 Intent 已离开 prepared，
//      只能记 failed 或 unknown——这两种状态都不允许重试。
//      工具根本没执行过，却永久不可用，这是设计缺陷。
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

function countingWrite(counter: { calls: number }, target: string): ToolImpl {
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

describe('invokeTool 执行顺序', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-order-'))
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

  /** 造「停在 waiting_approval」的 Run。 */
  function awaiting(target: string, callId = 'call_1') {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval', input: {},
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'wt',
      toolCallId: callId, arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: callId, name: 'wt', arguments: JSON.stringify({ path: target }) }],
    })
    return { run, task, approval, step }
  }

  async function resetConsumption(runId: string, approvalId: string): Promise<void> {
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approvalId)
    raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(runId)
    raw.close()
    store = new Store(dbPath)
  }

  // ── 任务书第一条要求的回归测试 ──────────────────────────

  it('已 committed + Grant 额度耗尽 + 重放：必须复用结果，不能报「未授权」', async () => {
    const target = join(workspace, 'a.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingWrite(counter, target)])

    const { run, approval } = awaiting(target)
    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))

    // scope=once → maxCalls=1
    ex.approve(approval.id, { scope: 'once' })
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    const grant = store.listGrants(run.id)[0]!
    expect(grant.usedCalls).toBe(1)          // 额度已耗尽
    expect(store.listIntents(run.id)[0]!.status).toBe('committed')

    // 模拟「markApprovalConsumed 之前崩溃」
    await resetConsumption(run.id, approval.id)

    // 篡改文件：如果工具被重放，内容会变成 call-2
    writeFileSync(target, 'tampered', 'utf8')

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    const out = await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 三条一起断言
    expect(out.status).toBe('completed')
    expect(counter.calls, '工具被重放了').toBe(1)
    expect(readFileSync(target, 'utf8'), '文件被重写了').toBe('tampered')

    // Grant 不能被二次消耗
    expect(store.listGrants(run.id)[0]!.usedCalls).toBe(1)

    // ★ 不能报「未授权」——这是顺序错误的典型症状
    const steps = store.listSteps(run.id)
    const badStep = steps.find((s) =>
      JSON.stringify(s.output ?? {}).includes('没有可用授权'))
    expect(badStep, '出现了「没有可用授权」的步骤').toBeUndefined()
  })

  // ── Grant 认领失败后的 Intent 状态 ──────────────────────

  it('Grant 认领失败时 Intent 必须仍可重试（不能永久锁死）', async () => {
    // 造一个「没有 Grant」的场景：不 approve，直接手工把 Run 推到 queued
    // 并伪造一条已批准但没 Grant 的审批。
    const target = join(workspace, 'b.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingWrite(counter, target)])

    const { run, approval } = awaiting(target)

    // 直接把审批标成 approved，但**不创建 Grant**
    store.transitionApproval(approval.id, 'approved', 'test')
    // Run 必须回到 queued，否则状态门会先把它拦下，根本走不到 Grant 那一步
    store.setRunStatus(run.id, 'queued')

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 没有执行
    expect(counter.calls).toBe(0)
    expect(existsSync(target)).toBe(false)

    const intent = store.listIntents(run.id)[0]
    expect(intent).toBeDefined()

    // ★ 核心：Intent 不能停在 failed 或 unknown
    //
    // 工具根本没被调用，副作用一定没发生。
    // 记成 failed/unknown 会让这次调用永久不可用——
    // 但用户重新批准之后，它本应是可执行的。
    expect(
      intent!.status,
      `Intent 停在 ${intent!.status}，工具从未执行却被永久锁死`,
    ).toBe('prepared')
  })

  it('Grant 认领失败后，用户重新批准可以正常执行', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingWrite(counter, target)])

    const { run, approval } = awaiting(target)
    store.transitionApproval(approval.id, 'approved', 'test')   // 无 Grant
    store.setRunStatus(run.id, 'queued')

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(0)

    // 用户重新批准：新建一条 pending 审批 → approve → 产生 Grant
    // 简化处理：直接给这个 Run 加一个可用 Grant
    store.createGrant({
      id: 'g-retry', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 1 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    // 审批结果已被消费（上一次 execute 里 markApprovalConsumed 了），
    // 所以这里重新把它标成未消费来模拟「用户再走一次」
    await resetConsumption(run.id, approval.id)

    const ex2 = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // ★ 有 Grant 之后必须能执行
    expect(counter.calls, '重新批准后仍然无法执行').toBe(1)
    expect(existsSync(target)).toBe(true)
  })
})

describe('Grant 耗尽后的行为', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-regrant-'))
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

  it('Grant 已耗尽时重新进入审批，不静默完成、也不执行工具', async () => {
    const target = join(workspace, 'z.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([countingWrite(counter, target)])

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    // 额度为 1 的 Grant，先手工耗尽
    const grant = store.createGrant({
      id: 'g-x', runId: run.id, toolId: 'wt',
      constraints: { maxCalls: 1 }, expiresAt: Date.now() + 60_000, status: 'active',
    })
    store.claimGrantUsage(grant.id)

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '算了，不做了' },
    ])
    const ex = makeExecutor(tools, script)
    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 工具没有执行
    expect(counter.calls, 'Grant 已耗尽却执行了工具').toBe(0)
    expect(existsSync(target)).toBe(false)

    // ★ 不能静默完成：一个被请求过的写操作从未执行
    expect(out.status, `Run 状态是 ${out.status}，但工具从未执行`).not.toBe('completed')

    // ★ 真实行为：重新回到等待审批。
    // 这是对的——用户需要重新批准，而不是被告知「完成了」。
    expect(out.status).toBe('paused')
    expect(store.getRun(run.id)!.status).toBe('waiting_approval')

    // 有一条新的 pending 审批
    const pending = store.listApprovals('pending')
    expect(pending.length).toBe(1)
    expect(pending[0]!.toolId).toBe('wt')

    // 没有产生 Intent（还没走到执行阶段）
    expect(store.listIntents(run.id)).toHaveLength(0)
  })

  // ── 关于「Grant 已扣但工具未执行」 ────────────────────────
  //
  // 上一版这里有一条测试，手工调用 `claimGrantUsage` 制造出
  // 「额度已扣、工具未执行」，并把它当作崩溃的结果。
  //
  // **那个状态在 `beginToolAttempt` 事务下不可能产生。**
  // 事务内 claim 与 startIntent 一起提交：
  //   · 提交成功 → Grant 扣 + Intent started（工具随后会执行）
  //   · 提交失败 → Grant 不扣 + Intent prepared
  //
  // 真实的事务边界（含故障注入）见 `tx-boundary.test.ts`。
})
