// toolCallId 在同一个 Run 内必须全局唯一。
//
// 当前唯一约束是 `(run_id, step_id, tool_call_id)`。
// 它挡不住这种情况：
//
//   step A + toolCallId X  → Intent 1
//   step B + toolCallId X  → Intent 2   ← 同一逻辑调用产生了两条记录
//
// 后果：同一个 toolCallId 可能执行两次副作用，
// 而且恢复时按 toolCallId 反查会命中两条，行为不确定。
//
// **产品语义：同一个 Run 内，toolCallId 全局唯一。**
//
// 理由：toolCallId 来自模型的一次 tool_call，它标识「这一次调用」。
// 同一次调用不应该因为换了 step 就变成两次操作。
// 如果模型真的重复发同一个 id，那是模型的 bug，
// 系统必须拒绝而不是默默执行两次。
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

function writeTool(counter: { calls: number }, target: string): ToolImpl {
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

describe('toolCallId 在 Run 内全局唯一', () => {
  let dir: string
  let workspace: string
  let store: Store
  let runId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-tcuid-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    runId = store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    }).id
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

  // ── Store 层：不同 step、相同 toolCallId ────────────────

  it('不同 step + 相同 toolCallId：不能产生第二条 Intent', () => {
    const a = store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })
    expect(a.created).toBe(true)

    // 用不同 stepId、同一个 toolCallId 再取一次
    const b = store.getOrCreateIntent({
      runId, stepId: 'step-B', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })

    // ★ 必须复用同一条 Intent，不能新建
    expect(b.created, '产生了第二条 Intent').toBe(false)
    expect(b.intent.id).toBe(a.intent.id)
    expect(store.listIntents(runId)).toHaveLength(1)
  })

  it('数据库层有 UNIQUE(run_id, tool_call_id) 约束', () => {
    store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })

    // 绕过 getOrCreateIntent 直接插入，验证约束真的在数据库上
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    expect(() => {
      db.prepare(
        `INSERT INTO tool_intent(
           id, run_id, step_id, tool_call_id, tool_id, tool_name,
           request_hash, operation_key, status, created_at, updated_at
         ) VALUES ('dup', ?, 'step-B', 'X', 'wt', 'wt', 'h', 'op', 'prepared', 0, 0)`,
      ).run(runId)
    }).toThrow(/UNIQUE|constraint/i)
  })

  // ── 相同 toolCallId + 不同请求：必须拒绝 ────────────────

  it('相同 toolCallId + 不同 requestHash：拒绝并记录冲突，不能静默复用', () => {
    store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'hash-1', operationKey: 'op-1',
    })

    // 同一个 toolCallId 但参数不同——这是模型/调用方的 bug
    expect(() => store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'hash-2', operationKey: 'op-2',
    })).toThrow(/requestHash|冲突|不同/)
  })

  it('相同 toolCallId + 相同 requestHash：复用，不报错', () => {
    const a = store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'hash-1', operationKey: 'op-1',
    })
    const b = store.getOrCreateIntent({
      runId, stepId: 'step-B', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'hash-1', operationKey: 'op-1',
    })
    expect(b.created).toBe(false)
    expect(b.intent.id).toBe(a.intent.id)
  })

  // ── 不同 Run 的相同 toolCallId：互不干扰 ────────────────

  it('不同 Run 可以用相同的 toolCallId', () => {
    const s2 = store.createSession('t2')
    const t2 = store.createTask({ sessionId: s2.id, goal: 'g2' })
    const run2 = store.createRun({ taskId: t2.id, role: 'producer', budget: {} }).id

    const a = store.getOrCreateIntent({
      runId, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })
    const b = store.getOrCreateIntent({
      runId: run2, stepId: 'step-A', toolCallId: 'X',
      toolId: 'wt', toolName: 'wt', requestHash: 'h', operationKey: 'op',
    })

    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(a.intent.id).not.toBe(b.intent.id)
  })

  // ── Executor 层：模型重复发同一 toolCallId ──────────────

  it('Executor 级：模型重复发同一 toolCallId，只执行一次副作用', async () => {
    const target = join(workspace, 'dup.txt')
    const counter = { calls: 0 }
    store.createGrant({
      id: 'g1', runId, toolId: 'wt',
      constraints: { maxCalls: 10 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    // 手工构造一个「两轮都发同一个 toolCallId」的模型
    const adapter: ProviderAdapter = {
      async stream(_req, handlers) {
        // 第一轮和第二轮都发 id='same'
        const calls = (adapter as unknown as { n: number }).n ?? 0
        ;(adapter as unknown as { n: number }).n = calls + 1
        if (calls === 0) {
          handlers.onText?.('')
          return {
            text: '',
            toolCalls: [{
              id: 'same',
              name: 'wt',
              arguments: JSON.stringify({ path: target }),
            }],
            inputTokens: 10, outputTokens: 5, stopReason: 'tool_calls' as const,
          }
        }
        return {
          text: '完成', toolCalls: [],
          inputTokens: 10, outputTokens: 5, stopReason: 'stop' as const,
        }
      },
    }

    const ex = new RunExecutor(
      store, new ToolRegistry([writeTool(counter, target)]),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    await ex.execute({
      runId, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 只执行一次
    expect(counter.calls, `工具被执行了 ${counter.calls} 次`).toBe(1)
    // 只有一条 Intent
    expect(store.listIntents(runId)).toHaveLength(1)
  })

  // ── 重启后再次收到相同 toolCallId ───────────────────────

  it('重启后收到相同 toolCallId：复用原 Intent，不新建', async () => {
    const target = join(workspace, 'restart.txt')
    const counter = { calls: 0 }
    store.createGrant({
      id: 'g2', runId, toolId: 'wt',
      constraints: { maxCalls: 10 }, expiresAt: Date.now() + 60_000, status: 'active',
    })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'wt', args: { path: target } }] },
      { text: '完成' },
    ])
    const ex = makeExecutor(new ToolRegistry([writeTool(counter, target)]), script)
    await ex.execute({
      runId, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })
    expect(counter.calls).toBe(1)
    const first = store.listIntents(runId)[0]!
    expect(first.status).toBe('committed')

    // 「重启」：同一 db 重新打开
    const dbPath = join(dir, 't.db')
    store.close()
    store = new Store(dbPath)

    // 再次用相同 toolCallId 取
    const again = store.getOrCreateIntent({
      runId, stepId: first.stepId, toolCallId: first.toolCallId,
      toolId: 'wt', toolName: 'wt',
      requestHash: first.requestHash, operationKey: first.operationKey,
    })

    expect(again.created).toBe(false)
    expect(again.intent.id).toBe(first.id)
    expect(again.intent.status).toBe('committed')
    expect(store.listIntents(runId)).toHaveLength(1)
  })
})
