// P1 Acceptance / ReviewCycle：事务边界与前置检查。
//
// 每条测试都从真实入口走：
//   · AcceptanceService / ReviewLoop（core 层真实路径）
//   · 真实 HTTP（server.listen + fetch）
//
// 故障注入用 SQLite 触发器，不用 monkey-patch：
// 触发器模拟的是「数据库层写入失败」，会真的触发事务回滚路径。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SnapshotManager } from '../snapshot.js'
import { ReviewLoop, registerSkill, clearSkills } from '../review-loop.js'
import { BUILTIN_RULES } from '../audit.js'
import { AcceptanceService } from '../acceptance.js'
import { createWorkstationServer, type WorkstationServer } from '../../server/app.js'
import type { AuditSkill } from '../../shared/types.js'
import type { ChatRequest, ProviderAdapter } from '../../providers/types.js'

const PASS_JSON = JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [], summary: 'ok' })
const CONTENT = '销售额 1.2 亿元，同比增长 18%。'
const FILE = 'report.md'

const skill: AuditSkill = {
  id: 'skill.p1acc',
  version: '1',
  name: 'p1acc',
  machineRules: [
    BUILTIN_RULES.artifactNotEmpty,
    BUILTIN_RULES.artifactInSnapshot,
    BUILTIN_RULES.minLength(10),
    BUILTIN_RULES.artifactEvidenceComplete,
  ],
  auditorInstructions: '你是审计者',
  maxCycles: 3,
}

function recorder(text: string): ProviderAdapter {
  return {
    async stream(_req: ChatRequest) {
      return { text, toolCalls: [], inputTokens: 10, outputTokens: 5 }
    },
  }
}

describe('P1 acceptance / review-cycle 事务边界', () => {
  let dir: string
  let workspace: string
  let store: Store
  let snapshot: SnapshotManager
  let loop: ReviewLoop
  let acceptance: AcceptanceService

  beforeEach(() => {
    clearSkills()
    registerSkill(skill)
    dir = mkdtempSync(join(tmpdir(), 'p1acc-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    snapshot = new SnapshotManager(workspace, { repoDir: join(dir, 'snaprepo') })
    loop = new ReviewLoop(store, {
      maxCycles: 3, snapshotManager: snapshot, workspaceRoot: workspace,
    })
    acceptance = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [workspace],
      snapshotManager: snapshot,
    })
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    clearSkills()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 造一个「已完成 Producer + 快照 + 候选产物 + awaiting_acceptance」的场景。 */
  async function scenario() {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: '写销售报告' })
    const contract = store.putTaskContract({
      taskId: task.id, goal: '写销售报告', acceptanceCriteria: [], actor: 'user',
    })

    writeFileSync(join(workspace, FILE), CONTENT, 'utf8')
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.recordModelIdentity(run.id, {
      providerId: 'p', modelId: 'deepseek-chat',
      modelFamily: 'deepseek', recordedAt: Date.now(),
    })

    const snap = await snapshot.capture()
    const snapRecord = store.createSnapshot({
      runId: run.id, taskId: task.id, kind: 'workspace', ref: snap.ref,
      reproducible: true, fileCount: snap.fileCount, totalBytes: snap.totalBytes,
    })

    const realHash = createHash('sha256').update(CONTENT, 'utf8').digest('hex')
    const artifact = store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: FILE,
      contentHash: realHash, sourceSnapshotId: snapRecord.id,
      version: 1, status: 'candidate',
    })

    store.setRunStatus(run.id, 'completed', { endedAt: Date.now() })
    store.updateTaskStatus(task.id, 'awaiting_acceptance')

    return { task, contract, run, artifact, realHash }
  }

  async function auditPass(taskId: string, runId: string) {
    const c = loop.begin({ taskId, producerRunId: runId, skill })
    if ('limitReached' in c) throw new Error('不应达上限')
    return loop.audit(c.id, {
      cycleId: c.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => recorder(PASS_JSON),
    })
  }

  // ══════════════════════════════════════════════════════
  // 第 2 项：并发 accept 必须走 CAS，而不是靠前置状态门碰运气
  // ══════════════════════════════════════════════════════

  describe('并发 accept', () => {
    it('失败方必须是 CAS 拒绝（"已经被其他请求处理过"），不是前置状态门', async () => {
      const s = await scenario()
      await auditPass(s.task.id, s.run.id)

      // 两个调用都先同步跑到 assertAuditPassedForArtifact 里的第一个 await，
      // 所以两边都会通过「Task 是 awaiting_acceptance」的前置检查，
      // 只有事务里的条件 UPDATE 能分出胜负。
      const results = await Promise.allSettled([
        acceptance.accept({ taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id }),
        acceptance.accept({ taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id }),
      ])

      const ok = results.filter((r) => r.status === 'fulfilled')
      const bad = results.filter((r) => r.status === 'rejected')
      expect(ok.length, '并发 accept 两个都成功了').toBe(1)
      expect(bad.length).toBe(1)

      const err = (bad[0] as PromiseRejectedResult).reason as Error & { code?: string }
      expect(err.code, `失败原因不是状态冲突：${err.message}`).toBe('STATE_CONFLICT')
      expect(
        err.message,
        `失败方是被前置状态门挡下的，说明 CAS 根本没被走到：${err.message}`,
      ).toContain('已经被其他请求处理过')

      expect(store.listAcceptances(s.task.id)).toHaveLength(1)
      expect(store.getTask(s.task.id)!.status).toBe('accepted')
      expect(store.getArtifact(s.artifact.id)!.status).toBe('accepted')
    })
  })

  // ══════════════════════════════════════════════════════
  // 第 4 项：requestRevision / reject 必须与 accept 一样原子
  // ══════════════════════════════════════════════════════

  describe('requestRevision / reject 事务一致性', () => {
    it('requestRevision 写入失败时整体回滚，不留半成品', async () => {
      const s = await scenario()

      store.dbExecForTest(`
        CREATE TRIGGER fail_acceptance_rev BEFORE INSERT ON acceptance
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
      `)

      let threw = false
      try {
        acceptance.requestRevision({
          taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id, note: '内容太短',
        })
      } catch {
        threw = true
      } finally {
        store.dbExecForTest('DROP TRIGGER IF EXISTS fail_acceptance_rev')
      }

      expect(threw, '写入失败却没有抛错').toBe(true)
      expect(
        store.getArtifact(s.artifact.id)!.status,
        '产物停在 rejected 但没有 AcceptanceRecord',
      ).toBe('candidate')
      expect(
        store.getTask(s.task.id)!.status,
        'Task 停在 revision_requested 但没有 AcceptanceRecord',
      ).toBe('awaiting_acceptance')
      expect(store.listAcceptances(s.task.id)).toHaveLength(0)
      expect(
        store.listEvents(s.run.id).filter((e) => e.kind === 'acceptance.revision_requested'),
        '回滚后仍然写了事件',
      ).toHaveLength(0)
    })

    it('reject 写入失败时整体回滚，不留半成品', async () => {
      const s = await scenario()

      store.dbExecForTest(`
        CREATE TRIGGER fail_acceptance_rej BEFORE INSERT ON acceptance
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
      `)

      let threw = false
      try {
        acceptance.reject({
          taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id, reason: '不要了',
        })
      } catch {
        threw = true
      } finally {
        store.dbExecForTest('DROP TRIGGER IF EXISTS fail_acceptance_rej')
      }

      expect(threw, '写入失败却没有抛错').toBe(true)
      expect(
        store.getArtifact(s.artifact.id)!.status,
        '产物停在 rejected 但没有 AcceptanceRecord',
      ).toBe('candidate')
      expect(
        store.getTask(s.task.id)!.status,
        'Task 停在 rejected 但没有 AcceptanceRecord',
      ).toBe('awaiting_acceptance')
      expect(store.listAcceptances(s.task.id)).toHaveLength(0)
      expect(
        store.listEvents(s.run.id).filter((e) => e.kind === 'acceptance.rejected'),
        '回滚后仍然写了事件',
      ).toHaveLength(0)
    })

    it('requestRevision 成功时四处写入一起提交', async () => {
      const s = await scenario()

      const record = acceptance.requestRevision({
        taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id, note: '内容太短',
      })

      expect(record.status).toBe('revision_requested')
      expect(store.getArtifact(s.artifact.id)!.status).toBe('rejected')
      expect(store.getTask(s.task.id)!.status).toBe('revision_requested')
      expect(store.listAcceptances(s.task.id)).toHaveLength(1)
      expect(
        store.listEvents(s.run.id).filter((e) => e.kind === 'acceptance.revision_requested'),
      ).toHaveLength(1)
    })

    it('已 accepted 之后 reject 仍然被状态门挡住', async () => {
      const s = await scenario()
      await auditPass(s.task.id, s.run.id)
      await acceptance.accept({ taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id })

      expect(() =>
        acceptance.reject({ taskId: s.task.id, artifactId: s.artifact.id, runId: s.run.id }),
      ).toThrow(/只有 awaiting_acceptance/)
      expect(store.getTask(s.task.id)!.status).toBe('accepted')
    })
  })

  // ══════════════════════════════════════════════════════
  // 第 7 项：AuditResult 插入与 Cycle 更新同一事务
  // ══════════════════════════════════════════════════════

  describe('AuditResult 与 ReviewCycle 同一事务', () => {
    it('audit_result 插入失败时，Cycle 不能指向一条不存在的审计', async () => {
      const s = await scenario()
      store.updateTaskStatus(s.task.id, 'in_progress')
      const c = loop.begin({ taskId: s.task.id, producerRunId: s.run.id, skill })
      if ('limitReached' in c) throw new Error('不应达上限')

      store.dbExecForTest(`
        CREATE TRIGGER fail_audit_result BEFORE INSERT ON audit_result
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
      `)

      let threw = false
      try {
        await loop.audit(c.id, {
          cycleId: c.id,
          producerModel: 'deepseek-chat',
          auditorModel: 'claude-sonnet-5-5',
          auditorProvider: { presetId: 'anthropic' },
          signal: new AbortController().signal,
          adapterResolver: () => recorder(PASS_JSON),
        })
      } catch {
        threw = true
      } finally {
        store.dbExecForTest('DROP TRIGGER IF EXISTS fail_audit_result')
      }

      expect(threw, '写入失败却没有抛错').toBe(true)
      expect(
        store.listAuditResults(s.task.id),
        '回滚后仍然留下了审计记录',
      ).toHaveLength(0)
      expect(
        store.getReviewCycle(c.id)!.auditResultId,
        'Cycle 指向了一条不存在的审计',
      ).toBeFalsy()
    })
  })
})

// ══════════════════════════════════════════════════════
// HTTP 入口：前置检查顺序与 accepted 终态
// ══════════════════════════════════════════════════════

describe('P1 review 前置检查（真实 HTTP）', () => {
  let dir: string
  let workspace: string
  let ws: WorkstationServer
  let base: string
  const token = 'p1-acceptance-token-0123456789'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'p1acc-http-'))
    workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    ws = await createWorkstationServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      workspace,
      snapshotDir: join(dir, 'snapshots'),
      auth: { token, source: 'env' },
      auditorAdapterResolver: () => recorder(PASS_JSON),
    })
    const port = await ws.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await ws.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }

  async function makeTask(goal: string) {
    const session = await api('POST', '/sessions', { title: 't' })
    const task = await api('POST', '/tasks', { sessionId: session.json.id, goal })
    expect(task.status).toBe(201)
    return task.json as { id: string }
  }

  async function makeCompletedRun(taskId: string) {
    const run = await api('POST', '/runs', { taskId, role: 'producer' })
    expect(run.status).toBe(201)
    ws.store.recordModelIdentity(run.json.id, {
      providerId: 'p', modelId: 'deepseek-chat',
      modelFamily: 'deepseek', recordedAt: Date.now(),
    })
    ws.store.setRunStatus(run.json.id, 'completed', { endedAt: Date.now() })
    return run.json as { id: string }
  }

  async function makeSnapshotAndArtifact(taskId: string, runId: string) {
    writeFileSync(join(workspace, FILE), CONTENT, 'utf8')
    const snap = await ws.snapshot.capture()
    const snapRecord = ws.store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: snap.ref, reproducible: true,
      fileCount: snap.fileCount, totalBytes: snap.totalBytes,
    })
    const realHash = createHash('sha256').update(CONTENT, 'utf8').digest('hex')
    const artifact = ws.store.createArtifact({
      taskId, runId, type: 'file', path: FILE,
      contentHash: realHash, sourceSnapshotId: snapRecord.id,
      version: 1, status: 'candidate',
    })
    return { snapRecord, artifact, realHash }
  }

  it('没有产物时 /review 返回 409，且不创建 Cycle、不消耗 cycles', async () => {
    const task = await makeTask('写报告')
    const run = await makeCompletedRun(task.id)

    const res = await api('POST', `/tasks/${task.id}/review`, { runId: run.id })

    expect(res.status).toBe(409)
    expect(res.json.error).toContain('没有产物')
    expect(
      ws.store.listReviewCycles(task.id),
      '前置检查失败却创建了 Cycle',
    ).toHaveLength(0)
    expect(
      ws.store.getTask(task.id)!.usage?.cycles ?? 0,
      '前置检查失败却消耗了 cycles 额度',
    ).toBe(0)
  })

  it('产物证据不完整时 /review 返回 409，且不创建 Cycle、不消耗 cycles', async () => {
    const task = await makeTask('写报告')
    const run = await makeCompletedRun(task.id)
    // 产物缺 contentHash 与 sourceSnapshotId
    ws.store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: FILE,
      version: 1, status: 'candidate',
    })

    const res = await api('POST', `/tasks/${task.id}/review`, { runId: run.id })

    expect(res.status).toBe(409)
    expect(res.json.error).toContain('证据不完整')
    expect(ws.store.listReviewCycles(task.id)).toHaveLength(0)
    expect(ws.store.getTask(task.id)!.usage?.cycles ?? 0).toBe(0)
  })

  it('产物指向的快照不存在时 /review 返回 409，且不创建 Cycle、不消耗 cycles', async () => {
    const task = await makeTask('写报告')
    const run = await makeCompletedRun(task.id)
    // 证据字段齐全，但 sourceSnapshotId 指向一条不存在的快照。
    // 这是数据完整性问题，不是「审计无法判断」——不该消耗一次 Cycle 额度。
    ws.store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: FILE,
      contentHash: 'a'.repeat(64),
      sourceSnapshotId: 'nonexistent-snapshot-id',
      version: 1, status: 'candidate',
    })

    const res = await api('POST', `/tasks/${task.id}/review`, { runId: run.id })

    expect(res.status).toBe(409)
    expect(
      ws.store.listReviewCycles(task.id),
      '快照不存在却仍然创建了 Cycle',
    ).toHaveLength(0)
    expect(
      ws.store.getTask(task.id)!.usage?.cycles ?? 0,
      '快照不存在却消耗了 cycles 额度',
    ).toBe(0)
  })

  it('accepted 之后再次 /review 返回 409，且不新增 Cycle', async () => {
    const task = await makeTask('写一份销售数据分析报告')
    const run = await makeCompletedRun(task.id)
    const { artifact } = await makeSnapshotAndArtifact(task.id, run.id)

    const review = await api('POST', `/tasks/${task.id}/review`, {
      runId: run.id, auditorModel: 'claude-sonnet-5-5', auditorProvider: 'anthropic',
    })
    expect(review.status).toBe(200)
    expect(review.json.outcome).toBe('passed')
    expect(review.json.taskStatus).toBe('awaiting_acceptance')

    const accepted = await api('POST', `/tasks/${task.id}/accept`, {
      artifactId: artifact.id, runId: run.id,
    })
    expect(accepted.status).toBe(201)
    expect(accepted.json.task.status).toBe('accepted')

    const cyclesBefore = ws.store.listReviewCycles(task.id).length
    const usageBefore = ws.store.getTask(task.id)!.usage?.cycles ?? 0

    const again = await api('POST', `/tasks/${task.id}/review`, {
      runId: run.id, auditorModel: 'claude-sonnet-5-5', auditorProvider: 'anthropic',
    })

    expect(again.status).toBe(409)
    expect(again.json.error).toContain('已经验收通过')
    expect(
      ws.store.listReviewCycles(task.id).length,
      '被拒绝的 review 仍然新增了 Cycle',
    ).toBe(cyclesBefore)
    expect(
      ws.store.getTask(task.id)!.usage?.cycles ?? 0,
      '被拒绝的 review 仍然消耗了 cycles',
    ).toBe(usageBefore)
    expect(ws.store.getTask(task.id)!.status).toBe('accepted')
  })

  it('accepted 之后 request-revision / reject 都返回 409，Task 保持 accepted', async () => {
    const task = await makeTask('写一份销售数据分析报告')
    const run = await makeCompletedRun(task.id)
    const { artifact } = await makeSnapshotAndArtifact(task.id, run.id)

    const review = await api('POST', `/tasks/${task.id}/review`, {
      runId: run.id, auditorModel: 'claude-sonnet-5-5', auditorProvider: 'anthropic',
    })
    expect(review.status).toBe(200)
    await api('POST', `/tasks/${task.id}/accept`, { artifactId: artifact.id, runId: run.id })

    const rev = await api('POST', `/tasks/${task.id}/request-revision`, {
      artifactId: artifact.id, runId: run.id, note: '想再改改',
    })
    expect(rev.status).toBe(409)

    const rej = await api('POST', `/tasks/${task.id}/reject`, {
      artifactId: artifact.id, runId: run.id,
    })
    expect(rej.status).toBe(409)

    expect(ws.store.getTask(task.id)!.status).toBe('accepted')
    expect(ws.store.listAcceptances(task.id)).toHaveLength(1)
  })
})
