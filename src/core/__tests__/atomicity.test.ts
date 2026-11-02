// 审批与授权原子性测试（第四批 C 项）。
//
// 核心不变量：状态转换只能成功一次。
// 非原子的「读 → 判断 → 写」会让并发请求都通过。
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

describe('审批与授权原子性', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-atomic-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider, tools?: ToolRegistry): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    return new RunExecutor(
      store, tools ?? new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  function setupRunWithApproval() {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const step = store.createStep({
      runId: run.id, index: 0, kind: 'approval', status: 'waiting_approval',
      input: { tool: 'write_file' },
    })
    const approval = store.createApproval({
      runId: run.id, stepId: step.id, toolId: 'write_file',
      toolCallId: 'call_1', arguments: { path: 'x.txt', content: 'y' },
    })
    store.setRunStatus(run.id, 'waiting_approval')
    return { run, step, approval, task }
  }

  // ── Approval 状态转换 ─────────────────────────────────

  it('transitionApproval 只能成功一次', () => {
    const { approval } = setupRunWithApproval()

    const first = store.transitionApproval(approval.id, 'approved', 'user')
    expect(first).toBe(true)

    const second = store.transitionApproval(approval.id, 'rejected', 'user')
    expect(second).toBe(false)

    expect(store.getApproval(approval.id)!.status).toBe('approved')
  })

  it('approve 与 reject 竞争时只有一个生效', () => {
    const { approval } = setupRunWithApproval()
    const executor = makeExecutor(new ScriptedProvider([]))

    // 同时发起
    const results = [
      () => { try { executor.approve(approval.id); return 'approved' } catch { return 'lost' } },
      () => { try { executor.reject(approval.id, '拒绝'); return 'rejected' } catch { return 'lost' } },
    ].map((fn) => fn())

    const winners = results.filter((r) => r !== 'lost')
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => r === 'lost')).toHaveLength(1)
  })

  it('重复 approve 会抛错而不是静默成功', () => {
    const { approval } = setupRunWithApproval()
    const executor = makeExecutor(new ScriptedProvider([]))

    executor.approve(approval.id)
    expect(() => executor.approve(approval.id)).toThrow(/已被处理/)
  })

  it('approve 与 expiry 竞争：只有一个能赢', () => {
    const { approval } = setupRunWithApproval()

    // 模拟「超时处理」先抢到
    const expired = store.transitionApproval(approval.id, 'rejected', '超时')
    expect(expired).toBe(true)

    // 此时 approve 必须失败
    const executor = makeExecutor(new ScriptedProvider([]))
    expect(() => executor.approve(approval.id)).toThrow(/已被处理/)
  })

  // ── Grant 原子认领 ────────────────────────────────────

  it('claimGrantUsage 在额度用尽后返回 false', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const grant = store.createGrant({
      id: 'g1', runId: run.id, toolId: 'write_file',
      constraints: { maxCalls: 1 },   // ← 只允许一次
      expiresAt: Date.now() + 60000,
      status: 'active',
    })

    expect(store.claimGrantUsage(grant.id)).toBe(true)
    expect(store.claimGrantUsage(grant.id)).toBe(false)   // 额度用尽
  })

  it('scope=once 的 Grant 两次执行只能成功一次', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const grant = store.createGrant({
      id: 'g2', runId: run.id, toolId: 'write_file',
      constraints: { maxCalls: 1 },
      expiresAt: Date.now() + 60000,
      status: 'active',
    })

    // 模拟两次并发执行都试图用这个 Grant
    const claims = [store.claimGrantUsage(grant.id), store.claimGrantUsage(grant.id)]
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('过期 Grant 无法认领', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const grant = store.createGrant({
      id: 'g3', runId: run.id, toolId: 'write_file',
      constraints: { maxCalls: 5 },
      expiresAt: Date.now() - 1000,   // ← 已过期
      status: 'active',
    })

    expect(store.claimGrantUsage(grant.id)).toBe(false)
  })

  it('已撤销的 Grant 无法认领', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const grant = store.createGrant({
      id: 'g4', runId: run.id, toolId: 'write_file',
      constraints: { maxCalls: 5 },
      expiresAt: Date.now() + 60000,
      status: 'active',
    })
    store.revokeGrant(grant.id)

    expect(store.claimGrantUsage(grant.id)).toBe(false)
  })

  it('maxCalls 为空的 Grant 可以无限认领', () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const grant = store.createGrant({
      id: 'g5', runId: run.id, toolId: 'write_file',
      constraints: {},   // 不限次数
      expiresAt: Date.now() + 60000,
      status: 'active',
    })

    expect(store.claimGrantUsage(grant.id)).toBe(true)
    expect(store.claimGrantUsage(grant.id)).toBe(true)
    expect(store.claimGrantUsage(grant.id)).toBe(true)
  })
})
