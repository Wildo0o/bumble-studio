// 副作用能力声明，不能用 riskLevel 代替。
//
// `riskLevel` 回答的是「要不要审批」，`sideEffect` 回答的是
// 「会不会改变外部状态」。两者不是一回事：
//
//   · `read_file`            riskLevel=read, sideEffect=none        → 不需要 Intent
//   · 未来可能的 HTTP GET    riskLevel=read, sideEffect=external    → 需要 Intent
//   · 日志写入 / 缓存更新     riskLevel=read, sideEffect=filesystem  → 需要 Intent
//
// 用 riskLevel 判断「能不能重试」是错的：一个只读的 HTTP GET 打出去
// 可能计费、可能写对方日志、可能触发限流——重复执行不是无害的。
//
// 这个文件先写红测：`riskLevel=read` 但 `sideEffect!=='none'` 的工具，
// 超时后必须走 Intent 保护，不能直接重试。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
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

/**
 * 有副作用的工具。
 *
 * 注意 riskLevel 用 `write`：本项目采用**方案 A**，
 * `read + sideEffect!=none` 在注册时就会被拒绝（见文件末尾的测试）。
 *
 * 这个 helper 验证的是「有副作用的工具必须走 Intent」，
 * 与 riskLevel 无关——那是另一个维度。
 */
function toolWithSideEffect(opts: {
  counter: { calls: number }
  target: string
  sideEffect: 'none' | 'filesystem' | 'external'
}): ToolImpl {
  return {
    definition: {
      id: 'sneaky',
      name: 'sneaky',
      description: '看起来是只读，其实会写东西',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      source: 'builtin',
      // 有副作用 → 必须 write，否则注册会被拒绝（方案 A）
      riskLevel: opts.sideEffect === 'none' ? 'read' : 'write',
      sideEffect: opts.sideEffect,
      enabled: true,
      timeoutMs: 30,
      maxOutputBytes: 8192,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run(input) {
      opts.counter.calls++
      // 慢到必然超时
      await new Promise((r) => setTimeout(r, 150))
      writeFileSync(String(input.path ?? opts.target), `wrote-${opts.counter.calls}`, 'utf8')
      return { ok: true, content: 'done' }
    },
  }
}

describe('副作用能力声明', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-side-'))
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

  function newRun() {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    return store.createRun({
      taskId: task.id, role: 'producer', budget: { maxSteps: 20, maxToolCalls: 20 },
    })
  }

  it('有副作用（sideEffect=external）：超时后必须记 unknown 并建 Intent', async () => {
    const target = join(workspace, 'a.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      toolWithSideEffect({ counter, target, sideEffect: 'external' }),
    ])

    const run = newRun()
    // 有副作用的工具需要 Grant（riskLevel=write）。
    // 这里直接给，专注验证「有副作用 → 走 Intent」这件事本身。
    store.createGrant({
      id: 'g-ext', runId: run.id, toolId: 'sneaky',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })
    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'sneaky', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)

    const out = await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // ★ 有副作用的工具超时 → 整个 Run 必须停在对账
    expect(out.status).toBe('needs_reconciliation')

    // ★ 必须存在 Intent 记录
    const intents = store.listIntents(run.id)
    expect(intents.length, '有副作用的工具没有创建 Intent').toBe(1)
    expect(intents[0]!.status).toBe('unknown')

    // 等晚到写入落地
    await new Promise((r) => setTimeout(r, 300))

    // 副作用确实发生了——这就是为什么不能当普通只读失败处理
    expect(existsSync(target)).toBe(true)
    expect(counter.calls).toBe(1)
  })

  it('无副作用（sideEffect=none）：超时不需要 Intent，可安全重试', async () => {
    const target = join(workspace, 'b.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      toolWithSideEffect({ counter, target, sideEffect: 'none' }),
    ])

    const run = newRun()
    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'sneaky', args: { path: target } }] },
      { text: '好' },
    ])
    const ex = makeExecutor(tools, script)

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    // 无副作用的工具不建 Intent
    expect(store.listIntents(run.id)).toHaveLength(0)
  })

  it('同一 toolCallId 在 sideEffect=external 下重复执行不会产生第二个 Intent', async () => {
    const target = join(workspace, 'c.txt')
    const counter = { calls: 0 }
    const tools = new ToolRegistry([
      toolWithSideEffect({ counter, target, sideEffect: 'external' }),
    ])

    const run = newRun()
    store.createGrant({
      id: 'g-dup', runId: run.id, toolId: 'sneaky',
      constraints: { maxCalls: 5 }, expiresAt: Date.now() + 60_000, status: 'active',
    })
    const ex = makeExecutor(tools, new ScriptedProvider([
      { toolCalls: [{ name: 'sneaky', args: { path: target } }] },
      { text: '好' },
    ]))

    await ex.execute({
      runId: run.id, provider: PROVIDER, model: { id: 'x' },
      messages: [userMessage('go')], signal: new AbortController().signal,
    })

    await new Promise((r) => setTimeout(r, 300))
    expect(store.listIntents(run.id)).toHaveLength(1)
  })
})

// ── 非法能力组合必须被拒绝 ───────────────────────────────
//
// `riskLevel=read` + `sideEffect!=none` 是危险组合：
//   · 它走「不需要审批」的白名单（riskLevel 决定审批）
//   · 但它会改变外部状态
// 结果是：一个有副作用的工具可以绕过审批直接执行。
//
// 两个维度必须自洽。方案 A（推荐）：注册时直接拒绝，fail-closed。

describe('非法能力组合', () => {
  function tool(sideEffect: 'none' | 'filesystem' | 'external', riskLevel: 'read' | 'write'): ToolImpl {
    return {
      definition: {
        id: `t-${riskLevel}-${sideEffect}`, name: 't', description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
        source: 'builtin', riskLevel, sideEffect, enabled: true,
        timeoutMs: 1000, maxOutputBytes: 1024,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run() { return { ok: true, content: 'ok' } },
    }
  }

  it('read + sideEffect=filesystem 必须注册失败（方案 A）', () => {
    expect(() => new ToolRegistry([tool('filesystem', 'read')]))
      .toThrow(/riskLevel|sideEffect/)
  })

  it('read + sideEffect=external 必须注册失败（方案 A）', () => {
    expect(() => new ToolRegistry([tool('external', 'read')]))
      .toThrow(/riskLevel|sideEffect/)
  })

  it('read + sideEffect=none 可以注册', () => {
    expect(() => new ToolRegistry([tool('none', 'read')])).not.toThrow()
  })

  it('write + 任意 sideEffect 都可以注册', () => {
    expect(() => new ToolRegistry([tool('none', 'write')])).not.toThrow()
    expect(() => new ToolRegistry([tool('filesystem', 'write')])).not.toThrow()
    expect(() => new ToolRegistry([tool('external', 'write')])).not.toThrow()
  })

  it('未声明 sideEffect 不再被推断放行（v0.9 收紧）', () => {
    // v0.8 及以前：未声明时按 riskLevel 推断（read → none），
    // 这条测试断言它能注册。
    //
    // v0.9 起改为**必须显式声明**：推断错了会让有副作用的工具
    // 被当成无副作用，从而跳过 Intent 保护。配置错误要在注册时暴露。
    //
    // 所以这条测试的期望反过来了。这是有意的收紧，不是回归。
    const noDecl: ToolImpl = {
      definition: {
        id: 'legacy', name: 'legacy', description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
        source: 'builtin', riskLevel: 'read', enabled: true,
        timeoutMs: 1000, maxOutputBytes: 1024,
        reconcile: { idempotent: false, unsafeToRetry: true },
      },
      async run() { return { ok: true, content: 'ok' } },
    }
    expect(() => new ToolRegistry([noDecl])).toThrow(/sideEffect/)
  })
})

// ── sideEffect 必须显式声明 ──────────────────────────────
//
// 「未声明就按 riskLevel 推断」仍然可能让工具绕过 Intent：
// 一个作者忘了写 sideEffect 的 write 工具会被推断成 filesystem（安全），
// 但如果他忘了写的是 read 工具、实际却有副作用，推断成 none 就漏了。
//
// 更严格的规则：**所有工具必须显式声明 sideEffect，缺失直接拒绝。**
// 唯一例外是内置工具——它们在注册表内部显式赋值，不依赖推断。

describe('sideEffect 必须显式声明', () => {
  function bareTool(id: string, riskLevel: 'read' | 'write', sideEffect?: 'none' | 'filesystem' | 'external'): ToolImpl {
    const def: ToolImpl['definition'] = {
      id, name: id, description: 'x',
      inputSchema: { type: 'object', properties: {}, required: [] },
      source: 'builtin', riskLevel, enabled: true,
      timeoutMs: 1000, maxOutputBytes: 1024,
      reconcile: { idempotent: false, unsafeToRetry: true },
    }
    if (sideEffect) def.sideEffect = sideEffect
    return { definition: def, async run() { return { ok: true, content: 'ok' } } }
  }

  it('缺失 sideEffect 的 read 工具 → 注册失败', () => {
    expect(() => new ToolRegistry([bareTool('r', 'read')]))
      .toThrow(/sideEffect/)
  })

  it('缺失 sideEffect 的 write 工具 → 注册失败', () => {
    expect(() => new ToolRegistry([bareTool('w', 'write')]))
      .toThrow(/sideEffect/)
  })

  it('未知的 sideEffect 值 → 注册失败', () => {
    const t = bareTool('u', 'write')
    ;(t.definition as unknown as { sideEffect: string }).sideEffect = 'network'
    expect(() => new ToolRegistry([t])).toThrow(/sideEffect/)
  })

  it('显式声明后可以注册', () => {
    expect(() => new ToolRegistry([bareTool('ok', 'write', 'filesystem')])).not.toThrow()
    expect(() => new ToolRegistry([bareTool('ok2', 'read', 'none')])).not.toThrow()
  })

  it('内置工具注册表不受影响（它们显式声明了 sideEffect）', () => {
    expect(() => new ToolRegistry()).not.toThrow()
    const reg = new ToolRegistry()
    for (const t of reg.listAll()) {
      expect(t.sideEffect, `内置工具 ${t.id} 没有声明 sideEffect`).toBeDefined()
    }
  })

  it('write + sideEffect=none 允许，但必须显式（表示「不产生外部影响」）', () => {
    // 这是合法组合：一个需要审批、但操作本身不改外部状态的工具
    // （例如「预览将要写入的内容」）。必须显式声明，不能靠推断。
    expect(() => new ToolRegistry([bareTool('preview', 'write', 'none')])).not.toThrow()
  })
})
