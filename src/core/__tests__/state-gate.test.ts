// 状态门测试（第四批 A 项）。
//
// 核心不变量：每种 Run 状态只有一条合法入口，
// 混用会绕过安全检查。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'
import type { RunStatus } from '../../shared/types.js'

describe('状态门', () => {
  let dir: string
  let workspace: string
  let store: Store
  let script: ScriptedProvider
  let executor: RunExecutor

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-gate-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))

    script = new ScriptedProvider([
      { text: '第一次调用' },
      { text: '第二次调用' },
      { text: '第三次调用' },
    ])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRun(status: RunStatus) {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    if (status !== 'queued') {
      store.setRunStatus(run.id, status)
    }
    return { run, task }
  }

  async function tryExecute(runId: string) {
    return executor.execute({
      runId,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })
  }

  // ── 允许执行的状态 ────────────────────────────────────

  it('queued 可以执行', async () => {
    const { run } = makeRun('queued')
    const outcome = await tryExecute(run.id)
    expect(outcome.status).toBe('completed')
    expect(script.turnCount).toBe(1)
  })

  // ── 被状态门拦截的情形 ────────────────────────────────

  it('paused 不能直接 execute，必须走 resume', async () => {
    const { run } = makeRun('paused')
    const outcome = await tryExecute(run.id)

    expect(outcome.status).toBe('paused')
    expect('reason' in outcome ? outcome.reason : '').toContain('resume')
    // 关键：模型一次都没被调用
    expect(script.turnCount).toBe(0)
    // 状态没变
    expect(store.getRun(run.id)!.status).toBe('paused')
  })

  it('waiting_approval 不能 execute，必须走审批', async () => {
    const { run } = makeRun('waiting_approval')
    const outcome = await tryExecute(run.id)

    expect(outcome.status).toBe('paused')
    expect('reason' in outcome ? outcome.reason : '').toContain('审批')
    expect(script.turnCount).toBe(0)
    expect(store.getRun(run.id)!.status).toBe('waiting_approval')
  })

  it('needs_reconciliation 不能 execute，必须走 reconcile', async () => {
    const { run } = makeRun('needs_reconciliation')
    const outcome = await tryExecute(run.id)

    expect(outcome.status).toBe('needs_reconciliation')
    expect(script.turnCount).toBe(0)
  })

  it('completed 不能重复执行', async () => {
    const { run } = makeRun('completed')
    const outcome = await tryExecute(run.id)

    expect(outcome.status).toBe('completed')
    // 关键：模型没被再次调用
    expect(script.turnCount).toBe(0)
  })

  it('failed 不能重复执行', async () => {
    const { run } = makeRun('failed')
    const outcome = await tryExecute(run.id)
    expect(outcome.status).toBe('failed')
    expect(script.turnCount).toBe(0)
  })

  it('cancelled 不能重复执行', async () => {
    const { run } = makeRun('cancelled')
    const outcome = await tryExecute(run.id)
    expect(outcome.status).toBe('cancelled')
    expect(script.turnCount).toBe(0)
  })

  it('expired 不能重复执行', async () => {
    const { run } = makeRun('expired')
    const outcome = await tryExecute(run.id)
    expect(outcome.status).toBe('expired')
    expect(script.turnCount).toBe(0)
  })

  // ── CAS：并发抢占 ─────────────────────────────────────

  it('状态迁移是 CAS 的：从错误状态迁移会失败', () => {
    const { run } = makeRun('completed')

    // 尝试把 completed 迁回 running
    const ok = store.transitionRunStatus(run.id, 'completed', 'running')
    expect(ok).toBe(true)   // completed → running 是允许的（CAS 本身不判断业务规则）

    // 但如果期望状态不匹配，就会失败
    const again = store.transitionRunStatus(run.id, 'completed', 'running')
    expect(again).toBe(false)   // 现在已经是 running 了，不再是 completed
  })

  it('两个并发 execute 只有一个能真正执行', async () => {
    const { run } = makeRun('queued')

    // 同时发起两次
    const [a, b] = await Promise.all([tryExecute(run.id), tryExecute(run.id)])

    // 一次成功，一次被拒
    const successes = [a, b].filter((o) => o.status === 'completed').length
    const failures = [a, b].filter((o) => o.status !== 'completed').length

    expect(successes).toBe(1)
    expect(failures).toBe(1)

    // 关键：模型只被调用一次（不是两次）
    expect(script.turnCount).toBe(1)
  })

  it('transitionRunStatus 支持多起始状态', () => {
    const { run } = makeRun('running')

    const ok = store.transitionRunStatus(run.id, ['queued', 'running'], 'completed')
    expect(ok).toBe(true)
    expect(store.getRun(run.id)!.status).toBe('completed')
  })

  it('transitionRunStatus 在状态不匹配时返回 false 且不改状态', () => {
    const { run } = makeRun('failed')

    const ok = store.transitionRunStatus(run.id, ['queued', 'running'], 'completed')
    expect(ok).toBe(false)
    // 状态没被改动
    expect(store.getRun(run.id)!.status).toBe('failed')
  })
})
