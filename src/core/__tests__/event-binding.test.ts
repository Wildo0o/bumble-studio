// 第五组（审计二轮 P1）：事件与证据。
//
// 三个问题：
//   1. acceptance / delivery 事件缺 taskId / artifactId
//      → 聚合 id 推导失败，事件被标记 inferred 或挂到 run 上，
//        按 Task / Artifact 查事件查不到
//   2. inferred 标记只在内存返回，没落库
//      → 重启后无法发现「这条事件的聚合是推定的」
//   3. EventStore 的聚合归属在 close/reopen 后必须保持
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { verifyBundle, replayBundle } from '../evidence.js'

describe('事件聚合绑定（审计二轮）', () => {
  let dir: string
  let dbPath: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-g5-'))
    dbPath = join(dir, 't.db')
    store = new Store(dbPath)
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('带 taskId 的事件落到 task 聚合，且不被标记 inferred', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const e = store.appendEvent(run.id, 'acceptance.accepted', {
      taskId: task.id,
      acceptanceId: 'acc-1',
      artifactId: 'art-1',
    })

    expect(e.aggregateType).toBe('task')
    expect(e.aggregateId).toBe(task.id)
    expect(e.aggregateIdInferred).toBe(false)
    expect(store.listEventsForAggregate('task', task.id).some((x) => x.kind === 'acceptance.accepted')).toBe(true)
  })

  it('带 artifactId 的交付事件落到 artifact 聚合', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const e = store.appendEvent(run.id, 'delivery.failed', {
      taskId: task.id,
      artifactId: 'art-9',
      deliveryId: 'd-1',
      error: 'disk full',
    })
    expect(e.aggregateType).toBe('artifact')
    expect(e.aggregateId).toBe('art-9')
    expect(e.aggregateIdInferred).toBe(false)
  })

  it('缺少聚合 id 时被标记 inferred（而不是静默挂错）', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    const e = store.appendEvent(run.id, 'acceptance.accepted', {})
    expect(e.aggregateIdInferred).toBe(true)
  })
})

describe('close / reopen 后聚合归属保持（审计二轮）', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-g5r-'))
    dbPath = join(dir, 't.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('重开后按 task 聚合仍能查到事件', () => {
    const first = new Store(dbPath)
    const s = first.createSession('t')
    const task = first.createTask({ sessionId: s.id, goal: 'g' })
    const run = first.createRun({ taskId: task.id, role: 'producer', budget: {} })
    first.appendEvent(run.id, 'acceptance.accepted', { taskId: task.id, artifactId: 'a' })
    first.close()

    const second = new Store(dbPath)
    try {
      const events = second.listEventsForAggregate('task', task.id)
      expect(events.some((e) => e.kind === 'acceptance.accepted')).toBe(true)
    } finally {
      second.close()
    }
  })
})

describe('Evidence replay 结构化失败（审计二轮）', () => {
  it('null snapshot 不抛异常，返回结构化结果', () => {
    const bundle = {
      bundleVersion: 1,
      generatedAt: 1,
      taskId: 't',
      runId: 'r',
      contract: { version: 1, hash: 'h', goal: 'g', acceptanceCriteria: [] },
      artifact: { id: 'a', type: 'file', status: 'candidate' },
      snapshot: null,
      audits: [
        {
          id: 'au', verdict: 'passed',
          boundArtifactIds: ['a'], boundContractHash: 'h',
          auditorProvider: 'p', auditorModel: 'm', createdAt: 1,
        },
      ],
      ruleChecks: [{ ruleId: 'x', ruleVersion: '1', passed: true }],
      partHashes: {},
      bundleHash: '',
    }
    expect(() => verifyBundle(bundle as never)).not.toThrow()
    expect(verifyBundle(bundle as never).ok).toBe(false)
    expect(() => replayBundle(bundle as never)).not.toThrow()
  })

  it.each([
    ['audits 是字符串', { audits: 'x' }],
    ['ruleChecks 是数字', { ruleChecks: 5 }],
    ['artifact 是数组', { artifact: [] }],
    ['contract 缺失', { contract: undefined }],
  ])('%s → 结构性失败而不是异常', (_label, patch) => {
    const base = {
      bundleVersion: 1, generatedAt: 1, taskId: 't', runId: 'r',
      contract: { version: 1, hash: 'h', goal: 'g', acceptanceCriteria: [] },
      artifact: { id: 'a', type: 'file', status: 'candidate' },
      audits: [], ruleChecks: [], partHashes: {}, bundleHash: '',
    }
    const bundle = { ...base, ...patch }
    let report: ReturnType<typeof verifyBundle> | undefined
    expect(() => { report = verifyBundle(bundle as never) }).not.toThrow()
    expect(report!.ok).toBe(false)
  })
})
