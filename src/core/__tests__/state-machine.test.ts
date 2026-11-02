// 状态机契约。
//
// 两组性质：
//   1. **表本身自洽**：终态没有出边、每条边指向已知状态、
//      不允许「从终态复活」。
//   2. **执行门与表同源**：RUN_EXECUTABLE_FROM 里的每个状态都真的能迁到
//      running；表里不允许迁到 running 的状态都不在执行门里。
//      这组测试就是发现「状态机加了新状态、执行门忘了同步」的那个机制。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ARTIFACT_TRANSITIONS,
  APPROVAL_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  GRANT_TRANSITIONS,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  TASK_TRANSITIONS,
  type StatefulKind,
} from '../state-tables.js'
import {
  RUN_EXECUTABLE_FROM,
  RUN_PAUSED_STATES,
  canTransition,
  isKnownState,
  isTerminal,
  machineSummary,
  tableFor,
} from '../state-machine.js'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { ScriptedProvider, userMessage } from './helpers.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import type { RunStatus } from '../../shared/types.js'

const ALL_TABLES: Array<[StatefulKind, { states: readonly string[]; initial: string; transitions: Record<string, readonly string[]>; terminal: readonly string[] }]> = [
  ['run', RUN_TRANSITIONS],
  ['task', TASK_TRANSITIONS],
  ['step', STEP_TRANSITIONS],
  ['approval', APPROVAL_TRANSITIONS],
  ['grant', GRANT_TRANSITIONS],
  ['artifact', ARTIFACT_TRANSITIONS],
  ['delivery', DELIVERY_TRANSITIONS],
]

describe('状态机表自洽', () => {
  it.each(ALL_TABLES)('%s：每条边都指向已声明状态', (_kind, table) => {
    for (const [from, targets] of Object.entries(table.transitions)) {
      expect(table.states, `起始状态 ${from} 不在 states 里`).toContain(from)
      for (const to of targets) {
        expect(table.states, `${from} → ${to}：目标状态未声明`).toContain(to)
      }
    }
  })

  it.each(ALL_TABLES)('%s：每个状态都有出边声明（终态为空数组）', (_kind, table) => {
    for (const state of table.states) {
      expect(Object.hasOwn(table.transitions, state), `${state} 缺少 transitions 条目`).toBe(true)
    }
  })

  it.each(ALL_TABLES)('%s：终态没有出边', (_kind, table) => {
    for (const terminal of table.terminal) {
      const edges = table.transitions[terminal] ?? []
      expect(edges, `终态 ${terminal} 不应有出边，实际 ${edges.join(', ')}`).toEqual([])
    }
  })

  it.each(ALL_TABLES)('%s：terminal 是 states 的子集', (_kind, table) => {
    for (const t of table.terminal) expect(table.states).toContain(t)
  })

  it.each(ALL_TABLES)('%s：没有最终无法到达的孤立状态', (kind, table) => {
    // 从声明的 initial 出发，每个状态都必须可达。
    //
    // 为什么用 initial 而不是「入度为 0 的节点」：
    // delivery 有 failed → pending 的重试边，整张图没有任何入度为 0 的节点，
    // 从图论上推不出起点。initial 必须是显式事实，不是推导结果。
    expect(table.states, `${kind} 的 initial 不在 states 里`).toContain(table.initial)

    const seen = new Set([table.initial])
    const queue = [table.initial]
    while (queue.length) {
      const cur = queue.shift()!
      for (const next of table.transitions[cur] ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    const unreachable = table.states.filter((s) => !seen.has(s))
    expect(unreachable, `${kind} 有不可达状态：${unreachable.join(', ')}`).toEqual([])
  })
})

describe('canTransition 语义', () => {
  it('允许声明过的迁移', () => {
    expect(canTransition('run', 'queued', 'running')).toBe(true)
    expect(canTransition('run', 'running', 'completed')).toBe(true)
    expect(canTransition('task', 'awaiting_acceptance', 'accepted')).toBe(true)
  })

  it('拒绝未声明的迁移（终态复活、跳过中间态）', () => {
    expect(canTransition('run', 'completed', 'running')).toBe(false)
    expect(canTransition('run', 'failed', 'completed')).toBe(false)
    expect(canTransition('run', 'queued', 'completed')).toBe(false)
    // 验收必须经过 awaiting_acceptance，不能从 in_progress 直接 accepted
    expect(canTransition('task', 'in_progress', 'accepted')).toBe(false)
  })

  it('自迁移视为幂等写入，允许', () => {
    expect(canTransition('run', 'running', 'running')).toBe(true)
    expect(canTransition('task', 'accepted', 'accepted')).toBe(true)
  })

  it('未知状态一律拒绝（不猜）', () => {
    expect(canTransition('run', 'nonsense', 'running')).toBe(false)
    expect(isKnownState('run', 'nonsense')).toBe(false)
    expect(isTerminal('run', 'completed')).toBe(true)
    expect(isTerminal('run', 'running')).toBe(false)
  })

  it('tableFor 对每种对象返回同一份表', () => {
    expect(tableFor('run')).toBe(RUN_TRANSITIONS as never)
    expect(machineSummary().map((m) => m.kind)).toEqual([
      'run',
      'task',
      'step',
      'approval',
      'grant',
      'artifact',
      'acceptance',
      'delivery',
    ])
  })
})

describe('执行门与状态机同源', () => {
  let dir: string
  let workspace: string
  let store: Store
  let script: ScriptedProvider
  let executor: RunExecutor

  function build(): void {
    dir = mkdtempSync(join(tmpdir(), 'ws-sm-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    script = new ScriptedProvider(
      Array.from({ length: 3 }, (_, i) => ({ text: `turn-${i}` })),
    )
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    executor = new RunExecutor(
      store,
      new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  function makeRun(status: RunStatus) {
    build()
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    if (status !== 'queued') store.setRunStatus(run.id, status)
    return run
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

  it('RUN_EXECUTABLE_FROM 里的每个状态都能真的开始执行', async () => {
    // queued 是常规入口。
    {
      const run = makeRun('queued')
      const outcome = await tryExecute(run.id)
      expect(outcome.status, 'queued 应该可以执行').toBe('completed')
      try { store.close() } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }

    // running 只有在显式 resumeStale 时才允许重入（崩溃恢复），
    // 不加 resumeStale 会被 CAS 抢状态拦住——这是刻意的并发保护：
    // 两个 execute 同时进来时只能有一个拿到 running。
    {
      const run = makeRun('running')
      const outcome = await tryExecute(run.id)
      expect(outcome.status, 'running 未显式 resumeStale 时不应重入').not.toBe('completed')
      expect(script.turnCount, '未抢到状态时不应调用模型').toBe(0)
      try { store.close() } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }

    // 显式 resumeStale 时，running 可以重入并正常完成。
    {
      const run = makeRun('running')
      const outcome = await executor.execute({
        runId: run.id,
        provider: providerFromPreset('ollama'),
        model: { id: 'test' },
        messages: [userMessage('go')],
        signal: new AbortController().signal,
        resumeStale: true,
      })
      expect(outcome.status, 'resumeStale 时 running 应该可以执行').toBe('completed')
      try { store.close() } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('表里迁不到 running 的状态，执行门一律拒绝且不调模型', async () => {
    const nonExecutable = RUN_TRANSITIONS.states.filter(
      (s) => !RUN_EXECUTABLE_FROM.includes(s as RunStatus) && !canTransition('run', s, 'running'),
    )
    expect(nonExecutable.length).toBeGreaterThan(3)

    for (const status of nonExecutable) {
      const run = makeRun(status as RunStatus)
      const before = script.turnCount
      const outcome = await tryExecute(run.id)
      // 注意不能用 `!== 'completed'` 判断：一个已经完成的 Run 被执行门拒绝时
      // 也会返回 status:'completed'（表示「它确实是完成的」），
      // 但**模型一次都没被调用**才是真正的判据。
      expect(outcome.status).not.toBe('running')
      expect(script.turnCount, `${status} 被拒绝时不应调用模型`).toBe(before)
      // 状态没有被改动
      expect(store.getRun(run.id)!.status).toBe(status)
      try { store.close() } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('暂停类是 paused / waiting_approval / needs_reconciliation，对外都表现为暂停', () => {
    expect([...RUN_PAUSED_STATES].sort()).toEqual(
      ['needs_reconciliation', 'paused', 'waiting_approval'],
    )
    for (const s of RUN_PAUSED_STATES) {
      expect(RUN_EXECUTABLE_FROM).not.toContain(s)
    }
  })

  it('已完成的 Run 不能被再次执行（终态不是执行入口）', async () => {
    const run = makeRun('completed')
    const outcome = await tryExecute(run.id)
    expect(outcome.status).toBe('completed')
    expect(script.turnCount).toBe(0)
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('Table 与 summary 对外暴露一致', () => {
    for (const m of machineSummary()) {
      for (const t of m.terminal) expect(m.states).toContain(t)
    }
  })
})
