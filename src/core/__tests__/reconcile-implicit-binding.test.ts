// 隐式绑定 Intent 的边界。
//
// reconcile 允许不传 intentId：Run 里只有一条 unknown Intent 时直接用它。
// 但「只有一条」不等于「就是这一条」——
// 那条 Intent 可能属于 Run 里的**另一个 Step**。
//
// 旧实现只看数量，不看归属：
//
//   Step A（纯本地 unknown，没有 Intent）
//   Step B（unknown，有 unknown Intent）
//   → reconcile(A) 把 B 的 Intent 标成 reconciled
//
// 结果是一条声称「A 的裁决」的记录，实际裁决的是 B 的外部调用，
// 而 B 的 Step 仍然是 unknown。这正是代码注释里禁止的
// 「把 A 的确认结果记到 B 头上」。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'

const EVIDENCE = JSON.stringify({
  type: 'manual_inspection', source: 'manual_review',
  observed: 'exists', actor: 'tester',
})

describe('reconcile 隐式绑定 Intent 的归属', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-recimplicit-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(): RunExecutor {
    return new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => { throw new Error('不应调用模型') },
    )
  }

  function makeRun() {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    return store.createRun({ taskId: task.id, role: 'producer', budget: {} })
  }

  /** 造一个 unknown Step + 它自己的 unknown Intent。 */
  function makeUnknownWithIntent(runId: string, index: number, suffix: string) {
    const step = store.createStep({
      runId, index, kind: 'tool', status: 'unknown',
      input: { toolName: 'write_file' }, output: { error: `步骤 ${suffix} 结果未知` },
    })
    const intent = store.getOrCreateIntent({
      runId, stepId: step.id, toolCallId: `call-${suffix}`,
      toolId: 'write_file', toolName: 'write_file',
      requestHash: `hash-${suffix}`, operationKey: `op-${suffix}`,
    }).intent
    store.startIntent(intent.id)
    store.markIntentUnknown(intent.id, '崩溃')
    return { step, intent }
  }

  /** 造一个纯本地 unknown Step（没有外部副作用，因此没有 Intent）。 */
  function makeLocalUnknown(runId: string, index: number) {
    return store.createStep({
      runId, index, kind: 'tool', status: 'unknown',
      input: { toolName: 'local_only' }, output: { error: '本地步骤结果未知' },
    })
  }

  it('对账纯本地 Step 时，不能把别的 Step 的 unknown Intent 结算掉', () => {
    const run = makeRun()
    const local = makeLocalUnknown(run.id, 0)
    const other = makeUnknownWithIntent(run.id, 1, 'b')

    const record = makeExecutor().reconcile({
      runId: run.id, stepId: local.id,
      resolution: 'confirmed_success', evidence: EVIDENCE,
    })

    // 这条裁决没有对应的外部调用，记录里不该凭空出现一个 Intent
    expect(record.intentId, '把别的 Step 的 Intent 绑到了本地 Step 上').toBeUndefined()
    expect(record.toolCallId).toBeUndefined()

    // 另一个 Step 的 Intent 必须原封不动
    expect(
      store.getIntent(run.id, other.step.id, 'call-b')!.status,
      '别的 Step 的 unknown Intent 被这条裁决结算了',
    ).toBe('unknown')

    // 它仍然是未解决的 unknown，Run 仍然被阻塞
    expect(store.hasUnresolvedUnknown(run.id)).toBe(true)
  })

  it('唯一 unknown Intent 属于本 Step 时，仍然隐式绑定（不能因为修归属就不绑）', () => {
    const run = makeRun()
    const own = makeUnknownWithIntent(run.id, 0, 'own')

    const record = makeExecutor().reconcile({
      runId: run.id, stepId: own.step.id,
      resolution: 'confirmed_success', evidence: EVIDENCE,
    })

    expect(record.intentId).toBe(own.intent.id)
    expect(record.toolCallId).toBe('call-own')
    expect(store.getIntent(run.id, own.step.id, 'call-own')!.status).toBe('reconciled')
  })

  it('先解决本地 Step，再解决另一个 Step 时，Intent 仍然能被隐式绑定', () => {
    const run = makeRun()
    const local = makeLocalUnknown(run.id, 0)
    const other = makeUnknownWithIntent(run.id, 1, 'b')

    makeExecutor().reconcile({
      runId: run.id, stepId: local.id,
      resolution: 'confirmed_success', evidence: EVIDENCE,
    })

    // 此时 Run 里只剩一条 unknown Intent，且属于这个 Step
    const record = makeExecutor().reconcile({
      runId: run.id, stepId: other.step.id,
      resolution: 'confirmed_success', evidence: EVIDENCE,
    })

    expect(record.intentId).toBe(other.intent.id)
    expect(store.hasUnresolvedUnknown(run.id)).toBe(false)
  })
})
