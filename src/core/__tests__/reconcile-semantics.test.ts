// reconcile 的终态语义。
//
// 四种 resolution 各自意味着什么，必须严格区分：
//
//   confirmed_success  → 查证过，外部操作生效了
//   confirmed_failure  → 查证过，外部操作没生效
//   retried            → 打算重做（**不自动重试原 Intent**）
//   abandoned          → 放弃（**不能伪装成 completed**）
//
// 关键约束：
//   · 任何 resolution 都不能让原 Intent 自动重放
//   · abandoned 不能把 Step 标成 completed
//   · 重复 reconcile 不会重新执行工具
//   · 必须同时更新 Step 和 Intent，不能只改一个
//   · 必须绑定到正确的 Intent / toolCallId
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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

function failingAfterEffect(counter: { calls: number }, target: string): ToolImpl {
  return {
    definition: {
      id: 'fa', name: 'fa', description: 'x',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
      timeoutMs: 5000, maxOutputBytes: 8192,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input) {
      counter.calls++
      writeFileSync(String(input.path ?? target), `w-${counter.calls}`, 'utf8')
      throw new Error('FAILED_AFTER_WRITE')
    },
  }
}

const EVIDENCE = (observed: string) => JSON.stringify({
  type: 'manual_inspection', source: 'manual_review',
  observed, actor: 'tester',
})

describe('reconcile 终态语义', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-recsem-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
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

  /** 普通路径跑出一个 unknown。 */
  async function makeUnknownOrdinary(): Promise<{
    runId: string
    stepId: string
    intentId: string
    counter: { calls: number }
  }> {
    const target = join(workspace, 'o.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([failingAfterEffect(counter, target)])

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    store.createGrant({
      id: 'g-o', runId: run.id, toolId: 'fa',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'fa', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    const step = store.listSteps(run.id).find((x) => x.status === 'unknown')!
    const intent = store.listIntents(run.id)[0]!
    expect(step, '没有产生 unknown Step').toBeDefined()
    expect(intent, '没有产生 Intent').toBeDefined()
    expect(intent.status).toBe('unknown')

    return { runId: run.id, stepId: step.id, intentId: intent.id, counter }
  }

  // ── confirmed_success ───────────────────────────────────

  it('confirmed_success：Step→completed，Intent→reconciled，不重放', async () => {
    const { runId, stepId, intentId, counter } = await makeUnknownOrdinary()
    const before = counter.calls
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: EVIDENCE('exists'), decidedBy: 'user',
    })

    expect(store.getStep(stepId)!.status).toBe('completed')
    const intent = store.listIntents(runId).find((i) => i.id === intentId)!
    expect(intent.status).toBe('reconciled')
    expect(counter.calls).toBe(before)   // 没有重放
  })

  // ── confirmed_failure ───────────────────────────────────

  it('confirmed_failure：Step→failed，Intent→reconciled', async () => {
    const { runId, stepId, intentId, counter } = await makeUnknownOrdinary()
    const before = counter.calls
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'confirmed_failure',
      evidence: EVIDENCE('not_found'), decidedBy: 'user',
    })

    expect(store.getStep(stepId)!.status).toBe('failed')
    expect(store.listIntents(runId).find((i) => i.id === intentId)!.status).toBe('reconciled')
    expect(counter.calls).toBe(before)
  })

  // ── retried ─────────────────────────────────────────────

  it('retried：Step→skipped，Intent→reconciled，**不自动重试**', async () => {
    const { runId, stepId, intentId, counter } = await makeUnknownOrdinary()
    const before = counter.calls
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'retried',
      evidence: JSON.stringify({
        type: 'manual_inspection', source: 'file_stat',
        observed: 'not_found', actor: 'tester',
      }),
      decidedBy: 'user',
    })

    // Step 标 skipped —— 不是 completed
    expect(store.getStep(stepId)!.status).toBe('skipped')
    expect(store.getStep(stepId)!.status).not.toBe('completed')
    // Intent 变 reconciled
    expect(store.listIntents(runId).find((i) => i.id === intentId)!.status).toBe('reconciled')
    // ★ 关键：reconcile 本身不执行工具
    expect(counter.calls).toBe(before)
  })

  it('retried 之后再次 execute：原 Intent 已 reconciled，不会被重放', async () => {
    const { runId, stepId, intentId, counter } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))
    ex.reconcile({
      runId, stepId, resolution: 'retried',
      evidence: JSON.stringify({
        type: 'manual_inspection', source: 'file_stat',
        observed: 'not_found', actor: 'tester',
      }),
      decidedBy: 'user',
    })
    const before = counter.calls

    // Run 已解阻塞（queued），再跑一次——这次**真的让模型再调一次同一工具**。
    //
    // 注意：ScriptedProvider 每次新建实例都会从 cursor=0 开始，
    // 生成的 toolCallId 会和上一次相同（call_1_0）。
    // 真实模型每次 tool_call 的 id 都是唯一的，所以这里先用一次
    // 空跑把 cursor 推到 1，模拟「新的一次调用」。
    const warmup = new ScriptedProvider([{ text: 'warmup' }])
    await warmup.stream({} as never, { onText: () => {} } as never).catch(() => { /* 忽略 */ })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'fa', args: { path: join(workspace, 'o.txt') } }] },
      { text: '好' },
    ])
    // 手动推进 cursor，让这次的 toolCallId 与首次不同
    await script.stream({} as never, { onText: () => {} } as never).catch(() => { /* 忽略 */ })

    const ex2 = makeExecutor(
      new ToolRegistry([failingAfterEffect(counter, join(workspace, 'o.txt'))]),
      script,
    )
    await ex2.execute({
      runId, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    // 模型确实发了新的 tool_call
    expect(script.turnCount, '模型没有发出新的 tool_call，测试没走到目标路径').toBeGreaterThan(0)

    // ★ 关键：原 Intent 仍是 reconciled，**没有被重置成可执行**
    //
    // 注意这里**不**断言「工具不能再执行」。
    // `retried` 的语义是「用户决定重做」，模型发一个新的 tool_call
    // 会得到一个新的 toolCallId → 新的 Intent → 允许执行。
    // 那是用户明确要求的行为，不是缺陷。
    //
    // 要防的是「原 Intent 被重放」——同一个 toolCallId 再执行一次。
    const intents = store.listIntents(runId)
    const original = intents.find((i) => i.id === intentId)!
    expect(original.status).toBe('reconciled')
    // 原 Intent 的结果没有被改写
    expect(original.resolution).toContain('retried')

    // 如果模型真的重做，会是一条**新的** Intent（不同 toolCallId）
    if (counter.calls > before) {
      expect(intents.length, '重做应该产生新的 Intent').toBeGreaterThan(1)
      const newOnes = intents.filter((i) => i.id !== intentId)
      expect(newOnes.every((i) => i.toolCallId !== original.toolCallId)).toBe(true)
    }
  })

  // ── abandoned ───────────────────────────────────────────

  it('abandoned：Step→cancelled，**不能伪装成 completed**', async () => {
    const { runId, stepId, intentId, counter } = await makeUnknownOrdinary()
    const before = counter.calls
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'abandoned',
      evidence: JSON.stringify({
        type: 'manual_inspection', source: 'file_stat',
        observed: 'indeterminate', actor: 'tester',
      }),
      decidedBy: 'user',
    })

    expect(store.getStep(stepId)!.status).toBe('cancelled')
    // ★ 绝不能是 completed —— 放弃不等于完成
    expect(store.getStep(stepId)!.status).not.toBe('completed')
    expect(store.listIntents(runId).find((i) => i.id === intentId)!.status).toBe('reconciled')
    expect(counter.calls).toBe(before)
  })

  // ── 一致性 ──────────────────────────────────────────────

  it('reconcile 必须同时更新 Step 和 Intent，不能只改一个', async () => {
    const { runId, stepId, intentId } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: EVIDENCE('exists'), decidedBy: 'user',
    })

    const step = store.getStep(stepId)!
    const intent = store.listIntents(runId).find((i) => i.id === intentId)!

    // 两者必须都离开 unknown
    expect(step.status).not.toBe('unknown')
    expect(intent.status).toBe('reconciled')
    // 且都记录了结论
    expect(intent.resolution).toContain('confirmed_success')
  })

  it('重复 reconcile 被拒绝，Intent 不会被改第二次', async () => {
    const { runId, stepId, intentId } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: EVIDENCE('exists'), decidedBy: 'user',
    })
    const first = store.listIntents(runId).find((i) => i.id === intentId)!

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_failure',
      evidence: EVIDENCE('not_found'), decidedBy: 'user',
    })).toThrow()

    const after = store.listIntents(runId).find((i) => i.id === intentId)!
    expect(after.resolution).toBe(first.resolution)
  })

  // ── 证据与 resolution 的自洽 ────────────────────────────

  it('confirmed_success 配 observed=not_found 被拒绝', async () => {
    const { runId, stepId } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: EVIDENCE('not_found'), decidedBy: 'user',
    })).toThrow(/自相矛盾/)

    // Step 仍是 unknown
    expect(store.getStep(stepId)!.status).toBe('unknown')
  })

  it('confirmed_failure 配 observed=exists 被拒绝', async () => {
    const { runId, stepId } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_failure',
      evidence: EVIDENCE('exists'), decidedBy: 'user',
    })).toThrow(/自相矛盾/)
  })

  it('observed=indeterminate 不能清除 unknown（确认类裁决）', async () => {
    const { runId, stepId } = await makeUnknownOrdinary()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: EVIDENCE('indeterminate'), decidedBy: 'user',
    })).toThrow(/indeterminate/)
  })

  // ── approved-resume 路径的真实 reconcile ────────────────

  it('approved-resume 产生的 unknown 也能正确 reconcile 并绑定 Intent', async () => {
    const target = join(workspace, 'r.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([failingAfterEffect(counter, target)])

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'waiting_approval', input: {},
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'fa',
      toolCallId: 'call_ap', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_ap', name: 'fa', arguments: JSON.stringify({ path: target }) }],
    })

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    const unknownStep = store.listSteps(run.id).find((x) => x.status === 'unknown')!
    expect(unknownStep, '审批路径没有产生 unknown Step').toBeDefined()
    const intentBefore = store.listIntents(run.id)[0]!
    expect(intentBefore.status).toBe('unknown')

    ex.reconcile({
      runId: run.id, stepId: unknownStep.id,
      resolution: 'confirmed_success',
      evidence: EVIDENCE('exists'), decidedBy: 'user',
    })

    // Intent 被正确绑定并转成 reconciled
    const intentAfter = store.listIntents(run.id)[0]!
    expect(intentAfter.id).toBe(intentBefore.id)
    expect(intentAfter.status).toBe('reconciled')
    // 没有重放
    expect(counter.calls).toBe(1)
  })
})

// ── toolCallId 重复时的行为 ──────────────────────────────
//
// 真实模型每次 tool_call 的 id 都是唯一的。但系统不能假设这一点：
// 如果模型重复发同一个 id，必须按「同一次调用」处理，
// 不能产生两条 Intent（否则会出现两次副作用）。

describe('toolCallId 重复', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-dupid-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一 stepId + 同一 toolCallId 只会有一条 Intent', async () => {
    const target = join(workspace, 'dup.txt')
    const counter = { calls: 0 }

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    store.createGrant({
      id: 'g-dup2', runId: run.id, toolId: 'fa',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    // 手工在同一 step 上建两次 Intent（模拟模型重复发同一 id）
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'running', input: {},
    })
    const a = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: 'same-id',
      toolId: 'fa', toolName: 'fa', requestHash: 'h', operationKey: 'op',
    })
    const b = store.getOrCreateIntent({
      runId: run.id, stepId: step.id, toolCallId: 'same-id',
      toolId: 'fa', toolName: 'fa', requestHash: 'h', operationKey: 'op',
    })

    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.intent.id).toBe(a.intent.id)
    expect(store.listIntents(run.id)).toHaveLength(1)
    expect(counter.calls).toBe(0)
  })
})
