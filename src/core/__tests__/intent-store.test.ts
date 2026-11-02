// ToolIntent 状态机本身的约束。
//
// 只测 Store 层（快、确定性强），行为测试在 intent-crash / tool-intent 里。
// 这里要证明的是：**非法转换在数据库层面就转不过去**，
// 而不是靠调用方自觉。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'

describe('ToolIntent 状态机', () => {
  let dir: string
  let store: Store
  let runId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-intent-store-'))
    store = new Store(join(dir, 't.db'))
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    runId = store.createRun({ taskId: task.id, role: 'producer', budget: {} }).id
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function make(stepId = 'step-1', callId = 'call-1') {
    return store.getOrCreateIntent({
      runId, stepId, toolCallId: callId,
      toolId: 'write_file', toolName: 'write_file',
      requestHash: 'hash-abc', operationKey: `op-${callId}`,
    })
  }

  it('新 Intent 是 prepared，且 created=true', () => {
    const { intent, created } = make()
    expect(created).toBe(true)
    expect(intent.status).toBe('prepared')
    expect(intent.startedAt).toBeUndefined()
  })

  it('同一 (run, step, toolCallId) 第二次取返回同一条，created=false', () => {
    const first = make()
    const second = make()
    expect(second.created).toBe(false)
    expect(second.intent.id).toBe(first.intent.id)
    expect(second.intent.status).toBe('prepared')
  })

  it('不同 toolCallId 产生不同 Intent', () => {
    const a = make('step-1', 'call-a')
    const b = make('step-1', 'call-b')
    expect(a.intent.id).not.toBe(b.intent.id)
    expect(store.listIntents(runId)).toHaveLength(2)
  })

  // ── 合法路径 ────────────────────────────────────────

  it('prepared → started → committed', () => {
    const { intent } = make()
    expect(store.startIntent(intent.id)).toBe(true)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('started')

    expect(store.commitIntent(intent.id, {
      content: 'wrote file', isError: false, resultHash: 'rh-1',
    })).toBe(true)

    const done = store.getIntent(runId, 'step-1', 'call-1')!
    expect(done.status).toBe('committed')
    expect(done.resultContent).toBe('wrote file')
    expect(done.resultHash).toBe('rh-1')
    expect(done.completedAt).toBeTruthy()
  })

  it('prepared → started → failed', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    expect(store.failIntent(intent.id, '参数非法')).toBe(true)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('failed')
  })

  it('prepared → started → unknown → reconciled', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    expect(store.markIntentUnknown(intent.id, '超时')).toBe(true)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('unknown')

    expect(store.reconcileIntent(intent.id, '人工查证：文件已写入')).toBe(true)
    const rec = store.getIntent(runId, 'step-1', 'call-1')!
    expect(rec.status).toBe('reconciled')
    expect(rec.resolution).toContain('已写入')
  })

  // ── 非法路径：必须全部失败 ──────────────────────────

  it('committed 不能再转 started（禁止重放）', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    store.commitIntent(intent.id, { content: 'x', isError: false, resultHash: 'h' })

    expect(store.startIntent(intent.id)).toBe(false)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('committed')
  })

  it('unknown 不能自动转 started（禁止自动重试）', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    store.markIntentUnknown(intent.id, '超时')

    expect(store.startIntent(intent.id)).toBe(false)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('unknown')
  })

  it('failed 不能自动转 started', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    store.failIntent(intent.id, 'x')

    expect(store.startIntent(intent.id)).toBe(false)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('failed')
  })

  it('prepared 不能跳过 started 直接 committed', () => {
    const { intent } = make()
    expect(store.commitIntent(intent.id, {
      content: 'x', isError: false, resultHash: 'h',
    })).toBe(false)
    expect(store.getIntent(runId, 'step-1', 'call-1')!.status).toBe('prepared')
  })

  it('started 不能被重复 start', () => {
    const { intent } = make()
    expect(store.startIntent(intent.id)).toBe(true)
    expect(store.startIntent(intent.id)).toBe(false)
  })

  it('只有 unknown 能 reconcile', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    // started 状态下不能直接 reconcile
    expect(store.reconcileIntent(intent.id, 'x')).toBe(false)

    store.commitIntent(intent.id, { content: 'x', isError: false, resultHash: 'h' })
    // committed 也不能 reconcile
    expect(store.reconcileIntent(intent.id, 'x')).toBe(false)
  })

  // ── 唯一约束 ────────────────────────────────────────

  it('同一 (run, step, toolCallId) 无法插入第二条（数据库级唯一约束）', () => {
    make()
    // 绕过 getOrCreateIntent 直接插入，验证约束真的在数据库上
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    expect(() => {
      db.prepare(
        `INSERT INTO tool_intent(
           id, run_id, step_id, tool_call_id, tool_id, tool_name,
           request_hash, operation_key, status, created_at, updated_at
         ) VALUES ('dup', ?, 'step-1', 'call-1', 'write_file', 'write_file',
                   'h', 'op', 'prepared', 0, 0)`,
      ).run(runId)
    }).toThrow(/UNIQUE|constraint/i)
  })

  // ── 崩溃恢复 ────────────────────────────────────────

  it('sweepStartedIntents 把 started 标成 unknown，prepared 保持不变', () => {
    const a = make('step-a', 'call-a')
    const b = make('step-b', 'call-b')
    const c = make('step-c', 'call-c')

    store.startIntent(a.intent.id)
    store.startIntent(b.intent.id)
    store.commitIntent(b.intent.id, { content: 'ok', isError: false, resultHash: 'h' })
    // c 保持 prepared

    const swept = store.sweepStartedIntents()
    expect(swept.map((s) => s.id)).toEqual([a.intent.id])

    expect(store.getIntent(runId, 'step-a', 'call-a')!.status).toBe('unknown')
    expect(store.getIntent(runId, 'step-b', 'call-b')!.status).toBe('committed')  // 已完成的不动
    expect(store.getIntent(runId, 'step-c', 'call-c')!.status).toBe('prepared')  // 没开始的也不动
  })

  it('sweep 后 unknown Intent 不会因为「重新取一次」而变回 prepared', () => {
    const { intent } = make()
    store.startIntent(intent.id)
    store.markIntentUnknown(intent.id, '崩溃')

    const { intent: again, created } = make()
    expect(created).toBe(false)
    expect(again.id).toBe(intent.id)
    expect(again.status).toBe('unknown')
  })
})
