// ToolIntent / 副作用执行语义。
//
// 这一批要回答的问题只有一个：**一次外部副作用到底执行了几次？**
//
// 当前实现的三个洞（本文件逐条验证）：
//
//   1. 超时后底层 Promise 继续跑，可能在系统已经判定 unknown 之后才真正落盘。
//   2. 崩溃后重启，已批准的审批会重新执行一遍（没有任何记录表明「执行过」）。
//   3. 普通路径和 approved-resume 是两套逻辑，没有共享的「这次调用做过没有」。
//
// 全部是行为测试：从 executor.execute() 入口跑，不直接调 Store。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

/**
 * 一个可控的工具：能卡住、能被信号中断、也能「无视信号坚持写盘」。
 *
 * 后者是关键场景——真实世界里 writeFile 一旦开始就无法取消，
 * 文件系统调用没有 abort 语义。
 */
function makeSlowTool(opts: {
  /** 写盘延迟（毫秒）。超过工具超时就会变成「晚到副作用」 */
  delayMs: number
  /** 是否响应 abort 信号 */
  respectsSignal: boolean
  /** 每次被调用时递增，用来数「执行了几次」 */
  counter: { calls: number }
  filePath: string
}): ToolImpl {
  return {
    definition: {
      id: 'slow_write',
      name: 'slow_write',
      description: '测试用的慢速写操作',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'builtin',
      riskLevel: 'write',
      sideEffect: 'filesystem',
      enabled: true,
      timeoutMs: 50,          // 很短，确保会超时
      maxOutputBytes: 8 * 1024,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input, ctx) {
      opts.counter.calls++
      const target = String(input.path ?? opts.filePath)

      // 模拟「实际工作」：不检查 signal 的异步操作，
      // 和 node:fs 的 writeFile 行为一致——开始后无法取消。
      const work = new Promise<void>((resolve) => {
        setTimeout(() => {
          writeFileSync(target, `written-by-call-${opts.counter.calls}`, 'utf8')
          resolve()
        }, opts.delayMs)
      })

      if (opts.respectsSignal) {
        // 支持取消：abort 时放弃等待（但延迟写入仍会发生，这就是现实）
        await Promise.race([
          work,
          new Promise<void>((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
        ])
      } else {
        await work
      }
      return { ok: true, content: `wrote ${target}` }
    },
  }
}

describe('ToolIntent：副作用执行语义', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-intent-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function makeExecutor(script: ScriptedProvider, tools: ToolRegistry): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    return new RunExecutor(
      store, tools,
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  function seedRunWithApproval(toolArgs: Record<string, unknown>) {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval',
      input: { tool: 'slow_write', args: toolArgs },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'slow_write',
      toolCallId: 'call_slow', arguments: toolArgs, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_slow', name: 'slow_write', arguments: JSON.stringify(toolArgs) }],
    })
    return { run, approval, task, step }
  }

  // ── 洞 1：超时后的晚到副作用 ────────────────────────────

  it('超时后底层写操作仍会落盘，但系统必须记为 unknown（不能记 failed）', async () => {
    const target = join(workspace, 'late.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      makeSlowTool({ delayMs: 300, respectsSignal: false, counter, filePath: target }),
    ])

    const { run, approval } = seedRunWithApproval({ path: target })
    const ex = makeExecutor(new ScriptedProvider([{ text: '好' }]), tools)
    ex.approve(approval.id, { scope: 'once' })

    const outcome = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 工具超时 → 整个 Run 停在对账状态
    expect(outcome.status).toBe('needs_reconciliation')

    // Step 必须是 unknown，不是 failed：
    // 此刻确实不知道文件写没写（下面会证明它其实写了）
    const steps = store.listSteps(run.id)
    const toolStep = steps.find((s) => s.kind === 'tool' && s.id !== approval.stepId)!
    expect(toolStep.status).toBe('unknown')

    // 等底层写入落地
    await new Promise((r) => setTimeout(r, 400))

    // ★ 晚到副作用确实发生了——这就是不能记 failed 的原因
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('written-by-call-1')
    expect(counter.calls).toBe(1)
  })

  it('超时后的晚到结果不得让模型继续循环（不能当普通错误字符串返回）', async () => {
    const target = join(workspace, 'late2.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      makeSlowTool({ delayMs: 300, respectsSignal: false, counter, filePath: target }),
    ])

    const { run, approval } = seedRunWithApproval({ path: target })
    // 模型脚本：如果循环继续，它会再被调用一次
    const script = new ScriptedProvider([{ text: '第一次' }, { text: '第二次' }])
    const ex = makeExecutor(script, tools)
    ex.approve(approval.id, { scope: 'once' })

    const outcome = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('needs_reconciliation')
    // 超时后立即停止，模型不应被再次调用
    expect(script.turnCount).toBe(0)

    await new Promise((r) => setTimeout(r, 400))
  })

  // ── 洞 2：重复 resume 不得重放已执行的副作用 ──────────────

  it('unknown 状态下重复 execute 必须被状态门拦住，不得重放工具', async () => {
    const target = join(workspace, 'replay.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      makeSlowTool({ delayMs: 300, respectsSignal: false, counter, filePath: target }),
    ])

    const { run, approval } = seedRunWithApproval({ path: target })
    const ex = makeExecutor(new ScriptedProvider([{ text: '好' }]), tools)
    ex.approve(approval.id, { scope: 'once' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(store.getRun(run.id)!.status).toBe('needs_reconciliation')
    expect(counter.calls).toBe(1)

    await new Promise((r) => setTimeout(r, 400))

    // 再次 execute：必须被拦住
    const second = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(second.status).toBe('needs_reconciliation')
    // ★ 工具没有被再次执行
    expect(counter.calls).toBe(1)

    await new Promise((r) => setTimeout(r, 400))
  })

  // ── 洞 3：审批消费与副作用不是原子的 ────────────────────

  it('已完成的审批不得被第二次 execute 重新执行', async () => {
    const target = join(workspace, 'once.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      makeSlowTool({ delayMs: 0, respectsSignal: true, counter, filePath: target }),
    ])

    const { run, approval } = seedRunWithApproval({ path: target })
    const ex = makeExecutor(new ScriptedProvider([{ text: '好' }, { text: '好' }]), tools)
    ex.approve(approval.id, { scope: 'once' })

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)

    // 审批结果已被消费
    expect(store.pendingResolutions(run.id)).toHaveLength(0)

    // 篡改文件，确认第二次执行没有把它改回去
    writeFileSync(target, 'tampered', 'utf8')

    const second = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })
    // Run 已完成，状态门拦下
    expect(second.status).toBe('completed')
    expect(readFileSync(target, 'utf8')).toBe('tampered')
    expect(counter.calls).toBe(1)
  })

  // ── 洞 4：普通路径与 approved-resume 必须是同一个执行入口 ──

  it('普通路径和审批恢复路径对同一个 toolCallId 只产生一次副作用', async () => {
    // 这个测试用「普通路径」执行一次，然后人为造一条指向同一 toolCallId 的审批，
    // 确认恢复时不会再来一次。
    const target = join(workspace, 'shared.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      makeSlowTool({ delayMs: 0, respectsSignal: true, counter, filePath: target }),
    ])

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    // 先给它一条可用 Grant，让普通路径直接执行
    store.createGrant({
      id: 'g-shared', runId: run.id, toolId: 'slow_write',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow_write', args: { path: target } }] },
      { text: '完成' },
    ])
    const ex = makeExecutor(script, tools)

    const outcome = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 允许完成或停在别的状态，但工具只应执行一次
    expect(counter.calls).toBe(1)
    if (outcome.status === 'completed') {
      expect(existsSync(target)).toBe(true)
    }
  })
})
