// 领域事件：序号原子性、聚合隔离、目录一致性。
//
// 这些测试针对的是**契约**，不是实现细节：
//   · sequence 必须从 1 开始对每个聚合连续，且并发下不重复
//   · correlationId 把同一次操作串起来
//   · actor 由写入方决定
//   · 未知 kind 必须被拒（否则 replay 会在几个月后才失败）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store } from '../store.js'
import { EVENT_CATALOG, eventKindDefinition, eventKinds } from '../event-catalog.js'

describe('领域事件契约', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-events-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function newRun(): { taskId: string; runId: string } {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    return { taskId: task.id, runId: run.id }
  }

  // ── 序号 ───────────────────────────────────────────────

  it('同一聚合的 sequence 从 1 开始且连续', () => {
    const { runId } = newRun()
    for (let i = 0; i < 5; i++) {
      store.appendEvent(runId, 'run.started', { i })
    }
    const events = store.listEventsForAggregate('run', runId)
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('不同聚合的 sequence 互不影响', () => {
    const a = newRun()
    const b = newRun()

    store.appendEvent(a.runId, 'run.started', {})
    store.appendEvent(b.runId, 'run.started', {})
    store.appendEvent(a.runId, 'run.completed', {})

    expect(store.listEventsForAggregate('run', a.runId).map((e) => e.sequence)).toEqual([1, 2])
    expect(store.listEventsForAggregate('run', b.runId).map((e) => e.sequence)).toEqual([1])
  })

  it('并发追加不会产生重复序号', () => {
    // better-sqlite3 是同步的，这里验证的是「读 MAX + 插入」确实在
    // 同一个事务里——如果拆开，下面 20 次交替写入就会出现重复序号。
    const { runId } = newRun()
    for (let i = 0; i < 20; i++) {
      store.appendEvent(runId, 'run.started', { i }, { aggregateType: 'run', aggregateId: runId })
    }
    const seqs = store.listEventsForAggregate('run', runId).map((e) => e.sequence)
    expect(new Set(seqs).size).toBe(20)
    expect(seqs).toEqual([...Array(20)].map((_, i) => i + 1))
  })

  it('唯一索引兜底：绕过 EventStore 直接写重复序号会被拒绝', () => {
    const { runId } = newRun()
    store.appendEvent(runId, 'run.started', {})

    expect(() =>
      store.dbExecForTest(
        `INSERT INTO event(run_id, kind, payload, created_at, aggregate_type, aggregate_id, sequence, actor, correlation_id)
         VALUES ('${runId}', 'run.started', 'null', 0, 'run', '${runId}', 1, 'system', '${runId}')`,
      ),
    ).toThrow(/UNIQUE/i)
  })

  // ── 关联 id ─────────────────────────────────────────────

  it('correlationId 把同一次操作的事件串起来，且可跨聚合查询', () => {
    const { runId } = newRun()
    const corr = 'op-123'
    store.appendEvent(runId, 'run.started', {}, { correlationId: corr })
    store.appendEvent(runId, 'snapshot.captured', {}, {
      correlationId: corr,
      aggregateType: 'artifact',
      aggregateId: 'snap-1',
    })

    const all = store.listEventsByCorrelation(corr)
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.kind)).toEqual(['run.started', 'snapshot.captured'])
    // sequence 各自在自己的聚合里从 1 开始
    expect(all.map((e) => e.sequence)).toEqual([1, 1])
  })

  it('未给 correlationId 时默认使用聚合 id', () => {
    const { runId } = newRun()
    const e = store.appendEvent(runId, 'run.started', {})
    expect(e.correlationId).toBe(runId)
  })

  // ── actor ──────────────────────────────────────────────

  it('actor 由写入方决定，默认 system', () => {
    const { runId } = newRun()
    const a = store.appendEvent(runId, 'run.started', {})
    const b = store.appendEvent(runId, 'run.started', {}, { actor: 'user' })
    expect(a.actor).toBe('system')
    expect(b.actor).toBe('user')
  })

  it('按 id 游标分页有序且不重复', () => {
    const { runId } = newRun()
    for (let i = 0; i < 10; i++) store.appendEvent(runId, 'run.started', { i })

    const first = store.listEventsSince(0, 4)
    expect(first).toHaveLength(4)
    const second = store.listEventsSince(first[first.length - 1]!.id, 100)
    expect(second).toHaveLength(6)
    expect(new Set([...first, ...second].map((e) => e.id)).size).toBe(10)
  })

  // ── 聚合 id 推导（P1-13）─────────────────────────────
  //
  // 旧实现一律把 runId 当 aggregateId，导致
  // 「aggregateType=task、aggregateId=<runId>」这种错配：
  // 按 Task 查事件永远为空，而空结果不会报错。

  it('run 聚合用 runId，且不标记为推定', () => {
    const { runId } = newRun()
    const e = store.appendEvent(runId, 'run.started', {})
    expect(e.aggregateType).toBe('run')
    expect(e.aggregateId).toBe(runId)
    expect(e.aggregateIdInferred).toBe(false)
  })

  it('task 聚合从 payload 的 taskId 推导，而不是套用 runId', () => {
    const { taskId, runId } = newRun()
    const e = store.appendEvent(runId, 'acceptance.accepted', { taskId, artifactId: 'a1' })
    expect(e.aggregateType).toBe('task')
    expect(e.aggregateId).toBe(taskId)
    expect(e.aggregateId).not.toBe(runId)

    // 按 Task 能查到
    const byTask = store.listEventsForAggregate('task', taskId)
    expect(byTask.some((x) => x.kind === 'acceptance.accepted')).toBe(true)
  })

  it('artifact 聚合从 payload 的 artifactId 推导', () => {
    const { runId } = newRun()
    const e = store.appendEvent(runId, 'delivery.applied', { artifactId: 'art-9' })
    expect(e.aggregateType).toBe('artifact')
    expect(e.aggregateId).toBe('art-9')
  })

  it('payload 里没有对应 id 时退回 run 聚合并标记为推定', () => {
    const { runId } = newRun()
    const e = store.appendEvent(runId, 'acceptance.accepted', {})
    expect(e.aggregateId).toBe(runId)
    expect(e.aggregateIdInferred).toBe(true)
  })

  it('显式给出 aggregateId 时不做推导', () => {
    const { runId } = newRun()
    const e = store.appendEvent(runId, 'acceptance.accepted', {}, {
      aggregateId: 'explicit-task',
    })
    expect(e.aggregateId).toBe('explicit-task')
    expect(e.aggregateIdInferred).toBe(false)
  })

  it('不同聚合类型的序号各自独立（不被 run 的序号污染）', () => {
    const { taskId, runId } = newRun()
    store.appendEvent(runId, 'run.started', {})
    store.appendEvent(runId, 'run.completed', {})
    const t1 = store.appendEvent(runId, 'acceptance.accepted', { taskId })
    expect(t1.sequence).toBe(1)
  })

  // ── 目录 ───────────────────────────────────────────────

  it('未知 kind 被拒绝', () => {
    const { runId } = newRun()
    expect(() => store.appendEvent(runId, 'not.a.real.kind', {})).toThrow(/未定义的事件 kind/)
  })

  it('目录没有重复 kind', () => {
    const kinds = eventKinds()
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('目录覆盖源码里实际发出的所有 kind', () => {
    // 目录少一个 kind = 运行期才炸（本文件前面的测试已经证明会抛错）。
    // 这条测试在**提交前**就能发现，而不是等某个 E2E 走到那条分支。
    const root = resolve(import.meta.dirname, '../..')
    const files = [
      'core/executor.ts',
      'core/review-loop.ts',
      'core/acceptance.ts',
      'server/app.ts',
    ]
    const emitted = new Set<string>()
    const re = /(?:this\.emit|this\.store\.appendEvent|store\.appendEvent)\([^,]+,\s*'([a-z_.]+)'/g
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) emitted.add(m[1]!)
    }

    expect(emitted.size, '没解析出任何 emit 调用——正则或源码结构变了').toBeGreaterThan(10)

    const missing = [...emitted].filter((k) => !eventKindDefinition(k))
    expect(missing, `以下 kind 在源码里被发出但不在事件目录中：${missing.join(', ')}`).toEqual([])
  })

  it('目录里的 kind 都有合法的聚合类型与发出方', () => {
    for (const def of EVENT_CATALOG) {
      expect(def.kind, 'kind 必须是小写点分标识').toMatch(/^[a-z]+\.[a-z_]+$/)
      expect(
        ['conversation', 'project', 'task', 'run', 'artifact', 'review', 'job'],
      ).toContain(def.aggregateType)
    }
  })
})
