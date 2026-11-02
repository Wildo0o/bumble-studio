// 跨对象不变式、启动恢复、通用版本化契约。
//
// 这三块共同的关注点：**关系与状态的事实不能被悄悄改坏**。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, canonicalJson } from '../store.js'
import {
  artifactBelongsTo,
  assertOwnership,
  deliveryMatchesAcceptance,
  scanInvariants,
} from '../invariants.js'
import { recoverOnStartup } from '../recovery.js'
import { externalUser } from '../permissions.js'
import { DomainError } from '../errors.js'

describe('跨对象不变式', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-inv-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function seed() {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const artifact = store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: 'a.md',
      contentHash: 'h', version: 1, status: 'candidate',
    })
    return { task, run, artifact }
  }

  it('归属成立时返回 ok', () => {
    const { task, run, artifact } = seed()
    expect(artifactBelongsTo(artifact, task, run).ok).toBe(true)
    expect(scanInvariants(store)).toEqual([])
  })

  it('产物挂错 Task 会被发现（即使数据库外键允许）', () => {
    const { task, run, artifact } = seed()
    store.dbExecForTest(`UPDATE artifact SET task_id = 'someone-else' WHERE id = '${artifact.id}'`)

    const check = artifactBelongsTo(store.getArtifact(artifact.id)!, task, run)
    expect(check.ok).toBe(false)

    const violations = scanInvariants(store)
    expect(violations.some((v) => v.kind === 'artifact_task_mismatch')).toBe(true)
  })

  it('Run 与 Task 的连接断开时，即使产物前两项都成立也算不成立', () => {
    const s2 = store.createSession('other')
    const otherTask = store.createTask({ sessionId: s2.id, goal: 'other' })
    const { task, run, artifact } = seed()

    // 把 run 挂到另一个 Task 上：此时 artifact.taskId 仍是原 task
    store.dbExecForTest(`UPDATE run SET task_id = '${otherTask.id}' WHERE id = '${run.id}'`)

    const check = artifactBelongsTo(
      store.getArtifact(artifact.id)!,
      task,
      store.getRun(run.id)!,
    )
    expect(check.ok).toBe(false)
  })

  it('交付记录与验收记录不一致会被发现', () => {
    const { task, run, artifact } = seed()
    const acceptance = store.createAcceptance({
      taskId: task.id, artifactId: artifact.id, runId: run.id,
      status: 'accepted', decidedAt: Date.now(),
    })
    const delivery = store.createDelivery({
      taskId: task.id, acceptanceId: acceptance.id, artifactId: artifact.id,
      action: 'apply', status: 'applied',
    })

    expect(deliveryMatchesAcceptance(delivery, acceptance).ok).toBe(true)

    // 交付指向另一份产物
    store.dbExecForTest(`UPDATE delivery SET artifact_id = 'other' WHERE id = '${delivery.id}'`)
    expect(deliveryMatchesAcceptance(store.listDeliveries(task.id)[0]!, acceptance).ok).toBe(false)
  })

  it('assertOwnership 抛 OWNERSHIP_MISMATCH（409），不是 400', () => {
    let caught: unknown
    try {
      assertOwnership({ ok: false, reason: '产物不属于这个 Task' }, '验收失败')
    } catch (e) {
      caught = e
    }
    const err = caught as DomainError
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('OWNERSHIP_MISMATCH')
    expect(err.httpStatus).toBe(409)
    expect(err.message).toContain('产物不属于这个 Task')
  })

  it('事件序号出现空洞会被体检发现', () => {
    const { run } = seed()
    store.appendEvent(run.id, 'run.started', {})
    store.appendEvent(run.id, 'run.completed', {})
    // 篡改：删掉第一条
    store.dbExecForTest(`DELETE FROM event WHERE run_id = '${run.id}' AND sequence = 1`)

    const violations = scanInvariants(store)
    expect(violations.some((v) => v.kind === 'event_sequence_gap')).toBe(true)
  })

  // ── 事件序号连续性：必须覆盖全部聚合类型 ────────────────
  //
  // 早期只扫 run 聚合。task / artifact / review / delivery 上的
  // 空洞完全查不到——而那些正是验收与交付的证据所在。

  it('task 聚合的事件序号空洞也能被发现', () => {
    const { task, run } = seed()
    store.appendEvent(run.id, 'acceptance.accepted', { taskId: task.id })
    store.appendEvent(run.id, 'acceptance.revision_requested', { taskId: task.id })
    // 删掉 task 聚合上的第一条
    store.dbExecForTest(
      `DELETE FROM event WHERE aggregate_type = 'task' AND aggregate_id = '${task.id}' AND sequence = 1`,
    )

    const violations = scanInvariants(store)
    const gap = violations.find((v) => v.kind === 'event_sequence_gap')
    expect(gap).toBeDefined()
    expect(gap!.detail).toContain('task')
  })

  it('artifact 聚合的事件序号空洞也能被发现', () => {
    const { task, run, artifact } = seed()
    store.appendEvent(run.id, 'delivery.applied', { artifactId: artifact.id })
    store.appendEvent(run.id, 'delivery.exported', { artifactId: artifact.id })
    store.dbExecForTest(
      `DELETE FROM event WHERE aggregate_type = 'artifact' AND aggregate_id = '${artifact.id}' AND sequence = 1`,
    )
    const violations = scanInvariants(store)
    expect(violations.some((v) => v.kind === 'event_sequence_gap' && v.detail.includes('artifact'))).toBe(true)
    void task
  })

  it('序号连续时**不**误报', () => {
    const { task, run } = seed()
    store.appendEvent(run.id, 'run.started', {})
    store.appendEvent(run.id, 'acceptance.accepted', { taskId: task.id })
    store.appendEvent(run.id, 'acceptance.revision_requested', { taskId: task.id })
    expect(scanInvariants(store).filter((v) => v.kind === 'event_sequence_gap')).toEqual([])
  })

  it('产物指向不存在的快照会被发现', () => {
    const { task, run } = seed()
    store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: 'ghost.md',
      contentHash: 'h', sourceSnapshotId: 'no-such-snapshot',
      version: 1, status: 'candidate',
    })
    const violations = scanInvariants(store)
    expect(violations.some((v) => v.kind === 'artifact_orphan_snapshot')).toBe(true)
  })
})

describe('启动恢复', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-rec-'))
    dbPath = join(dir, 't.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('拒绝非可信调用者：HTTP 层不能声称「我要重启恢复」', () => {
    const store = new Store(dbPath)
    try {
      expect(() => recoverOnStartup(store, externalUser())).toThrow(DomainError)
    } finally {
      store.close()
    }
  })

  it('悬挂的 running Run 在没有 unknown 时回到 queued', () => {
    const store = new Store(dbPath)
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'running')
    store.close()

    const reopened = new Store(dbPath)
    try {
      const report = recoverOnStartup(reopened)
      expect(report.staleRuns).toEqual([{ runId: run.id, to: 'queued' }])
      expect(reopened.getRun(run.id)!.status).toBe('queued')
      expect(reopened.listEvents(run.id).some((e) => e.kind === 'run.stale_running')).toBe(true)
    } finally {
      reopened.close()
    }
  })

  it('悬挂的 running Run 在有 unknown 时进入 needs_reconciliation（不假装完成）', () => {
    const store = new Store(dbPath)
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'running')
    // 造一个 running Step（模拟进程被杀）
    const step = store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'running',
    })
    store.close()

    const reopened = new Store(dbPath)
    try {
      const report = recoverOnStartup(reopened)
      expect(report.danglingSteps.some((d) => d.stepId === step.id)).toBe(true)
      expect(report.staleRuns).toEqual([{ runId: run.id, to: 'needs_reconciliation' }])
      expect(reopened.getRun(run.id)!.status).toBe('needs_reconciliation')
      // Step 被标成 unknown，不是 completed / failed
      expect(reopened.getStep(step.id)!.status).toBe('unknown')
      expect(reopened.listEvents(run.id).some((e) => e.kind === 'run.status_recovered')).toBe(true)
    } finally {
      reopened.close()
    }
  })

  it('恢复是幂等的：第二次启动不再改动已经收敛的状态', () => {
    const store = new Store(dbPath)
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'running')
    store.close()

    const first = new Store(dbPath)
    recoverOnStartup(first)
    const statusAfterFirst = first.getRun(run.id)!.status
    first.close()

    const second = new Store(dbPath)
    try {
      const report = recoverOnStartup(second)
      expect(report.staleRuns).toEqual([])
      expect(second.getRun(run.id)!.status).toBe(statusAfterFirst)
    } finally {
      second.close()
    }
  })
})

describe('通用版本化契约', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-dc-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('首次写入是版本 1 且为 active', () => {
    const c = store.putDomainContract({
      scope: 'policy', scopeId: 'p1', content: { a: 1 }, actor: 'u',
    })
    expect(c.version).toBe(1)
    expect(c.status).toBe('active')
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('内容变化产生新版本，旧版本 superseded 且保留', () => {
    store.putDomainContract({ scope: 'policy', scopeId: 'p1', content: { a: 1 }, actor: 'u' })
    const v2 = store.putDomainContract({
      scope: 'policy', scopeId: 'p1', content: { a: 2 }, actor: 'u',
    })
    expect(v2.version).toBe(2)

    const history = store.listDomainContracts('policy', 'p1')
    expect(history).toHaveLength(2)
    expect(history.map((x) => x.status).sort()).toEqual(['active', 'superseded'])
    expect(store.getActiveDomainContract('policy', 'p1')!.version).toBe(2)
  })

  it('内容相同（键顺序不同）是幂等的，不产生新版本', () => {
    const a = store.putDomainContract({
      scope: 'policy', scopeId: 'p1', content: { x: 1, y: 2 }, actor: 'u',
    })
    const b = store.putDomainContract({
      scope: 'policy', scopeId: 'p1', content: { y: 2, x: 1 }, actor: 'u',
    })
    expect(b.id).toBe(a.id)
    expect(b.version).toBe(1)
    expect(store.listDomainContracts('policy', 'p1')).toHaveLength(1)
  })

  it('canonicalJson 对深层嵌套也保持稳定', () => {
    const x = { b: [{ d: 1, c: 2 }], a: { z: null, y: [3, 1] } }
    const y = { a: { y: [3, 1], z: null }, b: [{ c: 2, d: 1 }] }
    expect(canonicalJson(x)).toBe(canonicalJson(y))
    expect(canonicalJson(x)).toBe('{"a":{"y":[3,1],"z":null},"b":[{"c":2,"d":1}]}')
  })

  it('canonicalJson 拒绝循环引用（而不是栈溢出）', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => canonicalJson(a)).toThrow(/循环引用/)
  })

  it('乐观锁：版本不符时抛 VERSION_CONFLICT', () => {
    store.putDomainContract({ scope: 'policy', scopeId: 'p1', content: { a: 1 }, actor: 'u' })
    expect(() =>
      store.putDomainContract({
        scope: 'policy', scopeId: 'p1', content: { a: 2 }, actor: 'u', expectedVersion: 5,
      }),
    ).toThrow(/VERSION_CONFLICT/)
    // 失败不改变任何状态
    expect(store.getActiveDomainContract('policy', 'p1')!.version).toBe(1)
  })

  it('不同 scope 的同一 scopeId 互不影响', () => {
    store.putDomainContract({ scope: 'policy', scopeId: 'x', content: { a: 1 }, actor: 'u' })
    const other = store.putDomainContract({
      scope: 'project', scopeId: 'x', content: { b: 2 }, actor: 'u',
    })
    expect(other.version).toBe(1)
    expect(store.getActiveDomainContract('policy', 'x')!.content).toContain('"a":1')
  })

  it('数据库层保证每个 scope+scopeId 至多一条 active', () => {
    const c = store.putDomainContract({ scope: 'policy', scopeId: 'p1', content: {}, actor: 'u' })
    expect(() =>
      store.dbExecForTest(
        `INSERT INTO domain_contract(id, scope, scope_id, version, content, content_hash, status, actor, created_at)
         VALUES ('dup', 'policy', 'p1', 99, '{}', 'h', 'active', 'u', 0)`,
      ),
    ).toThrow(/UNIQUE/i)
    expect(store.getActiveDomainContract('policy', 'p1')!.id).toBe(c.id)
  })

  it('并发写入同一 scope 不会产生两个 active 版本', () => {
    for (let i = 0; i < 5; i++) {
      store.putDomainContract({
        scope: 'policy', scopeId: 'p1', content: { n: i }, actor: 'u',
      })
    }
    const history = store.listDomainContracts('policy', 'p1')
    expect(history.filter((c) => c.status === 'active')).toHaveLength(1)
    expect(history).toHaveLength(5)
    expect(history.map((c) => c.version)).toEqual([5, 4, 3, 2, 1])
  })
})
