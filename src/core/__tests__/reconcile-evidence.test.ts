// reconcile 的证据校验。
//
// 一个 unknown 状态的含义是「我们不知道外部发生了什么」。
// 解除它需要**证据**，不能是「用户点了确认」。
//
// 否则 reconcile 就退化成「把不确定改成确定」的按钮——
// 而它本来是系统诚实性的最后一道防线。
//
// 这个文件验证：
//   · 空证据 / 纯文字搪塞 / 类型不对 → 拒绝
//   · 结构化证据 → 接受，并绑定到 Intent
//   · 没有 Intent 的 Step 也能对账（历史上没有 Intent 的记录）
//   · 重复 reconcile 不重新执行
//   · 错误 stepId 不能对账别的 Intent
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

describe('reconcile 证据校验', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-rec-ev-'))
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

  /** 跑出一个停在 unknown 的 Run，返回它的 unknown step。 */
  async function makeUnknown(): Promise<{
    runId: string
    stepId: string
    counter: { calls: number }
    target: string
  }> {
    const target = join(workspace, 'x.txt')
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
      toolCallId: 'call_ev', arguments: { path: target }, timeoutMs: 60_000,
    })
    store.setRunStatus(run.id, 'waiting_approval')
    store.appendRunMessage(run.id, userMessage('go'))
    store.appendRunMessage(run.id, {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'call_ev', name: 'fa', arguments: JSON.stringify({ path: target }) }],
    })

    const ex = makeExecutor(tools, new ScriptedProvider([{ text: '好' }]))
    ex.approve(approval.id, { scope: 'run' })
    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [], signal: new AbortController().signal,
    })

    const unknownStep = store.listSteps(run.id).find((x) => x.status === 'unknown')
    if (!unknownStep) throw new Error('没有产生 unknown Step')

    return { runId: run.id, stepId: unknownStep.id, counter, target }
  }

  it('空 evidence 被拒绝', async () => {
    const { runId, stepId } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: '', decidedBy: 'user',
    })).toThrow(/证据/)

    // Step 仍是 unknown
    expect(store.getStep(stepId)!.status).toBe('unknown')
  })

  it('纯文字搪塞被拒绝（没有结构化字段）', async () => {
    const { runId, stepId } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: '我确认过了，没问题',
      decidedBy: 'user',
    })).toThrow(/证据/)
  })

  it('自相矛盾的证据被拒绝（confirmed_success 但 source 说没生效）', async () => {
    const { runId, stepId } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: JSON.stringify({
        type: 'manual_inspection',
        source: 'manual_review',
        observed: 'not_found',
        actor: 'user',
      }),
      decidedBy: 'user',
    })).toThrow(/证据/)
  })

  it('结构化证据被接受，且绑定到 Intent', async () => {
    const { runId, stepId, target } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    const record = ex.reconcile({
      runId, stepId, resolution: 'confirmed_success',
      evidence: JSON.stringify({
        type: 'manual_inspection',
        source: 'manual_review',
        observed: 'exists',
        observedAt: Date.now(),
        contentHash: 'abc123',
        actor: 'user',
        note: `cat ${target} 确认内容已写入`,
      }),
      decidedBy: 'user',
    })

    expect(record.evidence).toBeTruthy()

    // Step 变成 completed
    expect(store.getStep(stepId)!.status).toBe('completed')
    // Intent 变成 reconciled
    const intent = store.listIntents(runId)[0]!
    expect(intent.status).toBe('reconciled')
    // v0.14：不可验证的来源走人工复核路径，type 记为 manual_inspection
    expect(intent.resolution).toContain('manual_inspection')
  })

  it('confirmed_failure 且证据说没找到 → 接受', async () => {
    const { runId, stepId } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    ex.reconcile({
      runId, stepId, resolution: 'confirmed_failure',
      evidence: JSON.stringify({
        type: 'manual_inspection',
        source: 'manual_review',
        observed: 'not_found',
        actor: 'user',
      }),
      decidedBy: 'user',
    })

    expect(store.getStep(stepId)!.status).toBe('failed')
  })

  it('重复 reconcile 被拒绝，且不会重新执行工具', async () => {
    const { runId, stepId, counter } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    const ev = JSON.stringify({
      type: 'manual_inspection', source: 'manual_review',
      observed: 'exists', actor: 'user',
    })

    ex.reconcile({ runId, stepId, resolution: 'confirmed_success', evidence: ev, decidedBy: 'user' })
    const callsAfterFirst = counter.calls

    // 第二次：Step 已经不是 unknown，应抛错
    expect(() => ex.reconcile({
      runId, stepId, resolution: 'confirmed_success', evidence: ev, decidedBy: 'user',
    })).toThrow()

    expect(counter.calls).toBe(callsAfterFirst)
  })

  it('错误的 stepId 不能对账别的 Run 的 Step', async () => {
    const { runId, stepId } = await makeUnknown()
    const ex = makeExecutor(new ToolRegistry(), new ScriptedProvider([]))

    // 造另一个 Run
    const s2 = store.createSession('t2')
    const t2 = store.createTask({ sessionId: s2.id, goal: 'g2' })
    const r2 = store.createRun({ taskId: t2.id, role: 'producer', budget: {} })

    expect(() => ex.reconcile({
      runId: r2.id,                     // 用 B 的 Run
      stepId,                           // 对账 A 的 Step
      resolution: 'confirmed_success',
      evidence: JSON.stringify({
        type: 'external_query', source: 'x', observed: 'exists', actor: 'user',
      }),
      decidedBy: 'user',
    })).toThrow(/属于 Run/)

    expect(store.getStep(stepId)!.status).toBe('unknown')
  })

  it('普通路径（无审批）产生的 unknown 也能对账并绑定 Intent', async () => {
    const target = join(workspace, 'p.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([failingAfterEffect(counter, target)])

    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    // 先给 Grant，让普通路径直接执行
    store.createGrant({
      id: 'g1', runId: run.id, toolId: 'fa',
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

    const unknownStep = store.listSteps(run.id).find((x) => x.status === 'unknown')!
    expect(unknownStep).toBeDefined()
    expect(store.listIntents(run.id)).toHaveLength(1)

    ex.reconcile({
      runId: run.id, stepId: unknownStep.id,
      resolution: 'confirmed_success',
      evidence: JSON.stringify({
        type: 'manual_inspection', source: 'manual_review',
        observed: 'exists', actor: 'user',
      }),
      decidedBy: 'user',
    })

    expect(store.listIntents(run.id)[0]!.status).toBe('reconciled')
    expect(counter.calls).toBe(1)   // 没有重放
  })
})
