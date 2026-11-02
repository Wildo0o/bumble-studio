// 崩溃场景：副作用已发生，但结果没落库。
//
// 前一个测试文件（tool-intent.test.ts）验证的是「进程还活着」时的行为，
// 那些保护（状态门、unknown 立即停止）本来就有。
//
// 本文件验证的是**进程死亡后重新启动**的场景——这是 ToolIntent 存在的唯一理由：
//
//   同一个 Store 实例可以模拟重启：关掉再打开同一个数据库文件。
//   executor 是新建的，内存里什么都没留下。
//   ——如果系统仍然知道「这次调用执行过」，那才是真的持久化；否则就只能靠猜。
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
  id: 'test-provider',
  name: 'Test',
  kind: 'demo' as const,
  baseUrl: '',
  requiresKey: false,
}

function makeCrashingTool(opts: {
  /** 副作用发生的那一刻调用它——用来「杀死进程」 */
  onSideEffect: () => void
  counter: { calls: number }
  target: string
}): ToolImpl {
  return {
    definition: {
      id: 'crashy_write',
      name: 'crashy_write',
      description: '写完就崩',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'builtin',
      riskLevel: 'write',
      sideEffect: 'filesystem',
      enabled: true,
      timeoutMs: 5000,
      maxOutputBytes: 8 * 1024,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input) {
      opts.counter.calls++
      // 副作用先落地……
      writeFileSync(opts.target, `side-effect-${opts.counter.calls}`, 'utf8')
      // ……然后「进程崩溃」：让调用方在这个点中断，模拟落库前死亡
      opts.onSideEffect()
      return { ok: true, content: 'done' }
    },
  }
}

describe('崩溃恢复：副作用已发生但结果未落库', () => {
  let dir: string
  let workspace: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-crash-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    dbPath = join(dir, 't.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider, tools: ToolRegistry): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    return new RunExecutor(
      store, tools,
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  /** 模拟进程重启：关掉 store，用同一个 db 文件新建一个。 */
  function restart(): Store {
    store.close()
    store = new Store(dbPath)
    return store
  }

  it('审批恢复执行中崩溃后，重启不得再执行一次（side effect 只能发生一次）', async () => {
    const target = join(workspace, 'crashed.txt')
    const counter = { calls: 0 }

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'crashy_write', args: { path: target } },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'crashy_write',
      toolCallId: 'call_crash', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_crash', name: 'crashy_write', arguments: JSON.stringify({ path: target }) }],
    })

    const ex1 = makeExecutor(new ScriptedProvider([{ text: '好' }]),
      new ToolRegistry([makeCrashingTool({ counter, target, onSideEffect: () => { /* 下面通过 throw 模拟 */ } })]))
    ex1.approve(approval.id, { scope: 'once' })

    // ── 第一次执行：副作用落地后立刻抛错，模拟崩溃 ──
    const crashingTool = makeCrashingTool({
      counter, target,
      onSideEffect: () => { throw new Error('SIMULATED_CRASH_AFTER_SIDE_EFFECT') },
    })
    const ex2 = makeExecutor(new ScriptedProvider([{ text: '好' }]), new ToolRegistry([crashingTool]))

    await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 副作用发生了
    expect(counter.calls).toBe(1)
    expect(existsSync(target)).toBe(true)

    // ── 模拟进程重启 ──
    restart()

    // 重启后：如果有 Intent，系统应知道这次调用「开始过但没完成」
    // 或者至少 Run 停在需要人工处理的状态，而不是 queued
    const runAfter = store.getRun(run.id)!

    // 关键断言：Run 不能是 queued ——那意味着重启后会自动再跑一遍
    expect(runAfter.status).not.toBe('queued')

    // 而且不能被静默标成 completed
    expect(runAfter.status).not.toBe('completed')
  })

  it('「副作用已发生但结果未落库」的窗口后重启，不得重复执行', async () => {
    // 这个测试复现了 ToolIntent 要解决的**唯一**核心问题：
    //
    //   工具已经写完文件 → markApprovalConsumed 之前进程崩溃
    //   → 重启后 approval 仍是 approved + unconsumed
    //   → 系统没有「这次调用执行过」的持久记录
    //   → 只能再执行一遍
    //
    // 修复目标：toolCallId 对应的 Intent 已经 committed 时，
    // 直接返回保存的结果，不再调用工具。
    const target = join(workspace, 'twice.txt')
    const counter = { calls: 0 }

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'crashy_write', args: { path: target } },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'crashy_write',
      toolCallId: 'call_twice', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_twice', name: 'crashy_write', arguments: JSON.stringify({ path: target }) }],
    })

    // 第一次：正常执行成功
    const okTool: ToolImpl = {
      definition: {
        id: 'crashy_write', name: 'crashy_write', description: 'x',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
        timeoutMs: 5000, maxOutputBytes: 8192,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run(input) {
        counter.calls++
        writeFileSync(String(input.path), `run-${counter.calls}`, 'utf8')
        return { ok: true, content: 'done' }
      },
    }

    const ex = makeExecutor(new ScriptedProvider([{ text: '好' }]), new ToolRegistry([okTool]))
    // 用 scope='run'（maxCalls=50），这样第二次恢复时 Grant 仍然可用。
    // 如果用 'once'，Grant 消耗会挡住重放——那是另一个保护，
    // 会掩盖掉「没有 Intent 就分不清执行过没有」这个真正的问题。
    ex.approve(approval.id, { scope: 'run' })
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(counter.calls).toBe(1)
    expect(store.pendingResolutions(run.id)).toHaveLength(0)

    // 现在把 approval 的 result_consumed 强行改回 0，模拟
    // 「副作用已发生，但 markApprovalConsumed 之前崩溃」的窗口。
    //
    // 必须先关掉 store，否则两个连接同时写同一个 SQLite 文件会互相干扰。
    store.close()
    const { default: Database } = await import('better-sqlite3')
    const raw = new Database(dbPath)
    const r1 = raw.prepare('UPDATE approval SET result_consumed = 0 WHERE id = ?').run(approval.id)
    const r2 = raw.prepare("UPDATE run SET status = 'queued' WHERE id = ?").run(run.id)
    raw.close()

    // 确认改动真的生效了——否则下面的测试是在验证一个不存在的场景
    expect(r1.changes, '重置 result_consumed 失败').toBe(1)
    expect(r2.changes, '重置 run 状态失败').toBe(1)

    store = new Store(dbPath)
    expect(store.pendingResolutions(run.id), '重置后应能重新找到这条审批').toHaveLength(1)

    // 重启后再次执行
    const ex2 = makeExecutor(new ScriptedProvider([{ text: '好' }]), new ToolRegistry([okTool]))
    const outcome = await ex2.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('completed')

    // ★ 核心断言：副作用只能发生一次。
    //
    // 无论靠什么机制（Intent 查表 / 结果缓存 / operationKey），
    // 只要这个数字是 2，就说明系统在崩溃窗口里重复执行了外部操作。
    expect(counter.calls, `崩溃窗口内的重复执行次数：${counter.calls}`).toBe(1)
  })
})
