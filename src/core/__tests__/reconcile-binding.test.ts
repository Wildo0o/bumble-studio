// reconcile 的绑定与 actor 来源。
//
// 两个问题：
//
//   1. `decidedBy` 完全由请求体决定，调用方可以冒充 'system'。
//      「系统自动裁决」和「用户手动裁决」在审计上必须能区分——
//      如果谁都能声明自己是 system，这个字段就没有意义。
//
//   2. `ReconciliationRecord` 只绑定 stepId，没有 intentId / toolCallId。
//      而 Step 只是执行轨迹，Intent 才是「这次外部调用怎么样」的记录。
//      只绑 Step 会让「这条裁决对应哪次副作用」变得模糊。
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

function failingTool(counter: { calls: number }, target: string): ToolImpl {
  return {
    definition: {
      id: 'ft', name: 'ft', description: 'x',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      source: 'builtin', riskLevel: 'write', sideEffect: 'filesystem', enabled: true,
      timeoutMs: 5000, maxOutputBytes: 8192,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input) {
      counter.calls++
      writeFileSync(String(input.path ?? target), 'x', 'utf8')
      throw new Error('FAILED_AFTER_WRITE')
    },
  }
}

const EV = JSON.stringify({
  type: 'manual_inspection', source: 'manual_review',
  observed: 'exists', actor: 'tester',
})

describe('reconcile 的绑定与 actor', () => {
  let dir: string
  let workspace: string
  let store: Store
  let runId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-recbind-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))

    const target = join(workspace, 'f.txt')
    const counter = { calls: 0 }
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
    runId = run.id
    store.createGrant({
      id: 'g1', runId, toolId: 'ft',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'ft', args: { path: target } }] },
      { text: '好' },
    ])
    const adapter: ProviderAdapter = { stream: (r, h) => script.stream(r, h) }
    const ex = new RunExecutor(
      store, new ToolRegistry([failingTool(counter, target)]),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
    await ex.execute({
      runId, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(): RunExecutor {
    const adapter: ProviderAdapter = { stream: (r, h) => new ScriptedProvider([]).stream(r, h) }
    return new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  it('ReconciliationRecord 绑定 intentId 和 toolCallId', () => {
    const step = store.listSteps(runId).find((s) => s.status === 'unknown')!
    const intent = store.listIntents(runId)[0]!
    expect(intent, '没有 Intent').toBeDefined()

    const ex = makeExecutor()
    const record = ex.reconcile({
      runId, stepId: step.id,
      resolution: 'confirmed_success',
      evidence: EV,
      decidedBy: 'user',
    })

    // ★ 必须能从这个记录直接定位到那次外部调用
    expect(record.intentId, '记录没有绑定 intentId').toBe(intent.id)
    expect(record.toolCallId, '记录没有绑定 toolCallId').toBe(intent.toolCallId)
  })

  it('decidedBy=system 不能由调用方声称', () => {
    const step = store.listSteps(runId).find((s) => s.status === 'unknown')!
    const ex = makeExecutor()

    // 调用方传 'system'，但没有任何系统级证据支持
    const record = ex.reconcile({
      runId, stepId: step.id,
      resolution: 'confirmed_success',
      evidence: EV,
      decidedBy: 'system',
    })

    // ★ 通过公开入口的裁决一律记为 'user'（或 'reconciler'），
    // 不能因为请求体写了 'system' 就变成系统自动裁决
    expect(
      record.decidedBy,
      'decidedBy 被请求体伪造为 system',
    ).not.toBe('system')
  })

  it('系统内部调用可以显式标记为 system', () => {
    // 这条验证「system」不是被禁用了，而是**只能由内部代码路径**产生
    const step = store.listSteps(runId).find((s) => s.status === 'unknown')!
    const ex = makeExecutor()

    const record = ex.reconcile({
      runId, stepId: step.id,
      resolution: 'confirmed_success',
      evidence: EV,
      decidedBy: 'system',
      // 内部调用方显式声明这是系统行为
      trusted: true,
    })

    expect(record.decidedBy).toBe('system')
  })

  it('Intent / Step / Run 三者状态一致', () => {
    const step = store.listSteps(runId).find((s) => s.status === 'unknown')!
    const ex = makeExecutor()

    ex.reconcile({
      runId, stepId: step.id,
      resolution: 'confirmed_success',
      evidence: EV,
      decidedBy: 'user',
    })

    const s = store.getStep(step.id)!
    const i = store.listIntents(runId)[0]!
    const r = store.getRun(runId)!

    // Step 已离开 unknown
    expect(s.status).toBe('completed')
    // Intent 已 reconciled
    expect(i.status).toBe('reconciled')
    // Run 解除了阻塞（因为再没有未解决的 unknown）
    expect(r.status).not.toBe('needs_reconciliation')
  })

  it('abandoned 之后 Intent 是 reconciled，不是 committed', () => {
    const step = store.listSteps(runId).find((s) => s.status === 'unknown')!
    const ex = makeExecutor()

    ex.reconcile({
      runId, stepId: step.id,
      resolution: 'abandoned',
      evidence: JSON.stringify({
        type: 'manual_inspection', source: 'file_stat',
        observed: 'indeterminate', actor: 'tester',
      }),
      decidedBy: 'user',
    })

    const i = store.listIntents(runId)[0]!
    expect(i.status).toBe('reconciled')
    // ★ 不能是 committed——放弃不等于成功
    expect(i.status).not.toBe('committed')
    expect(store.getStep(step.id)!.status).toBe('cancelled')
  })
})
