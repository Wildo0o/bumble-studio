// demo 作为 Auditor 的完整链路：从 ReviewLoop 到 Acceptance。
//
// 与 quality-gates.test.ts 的 P0-1 互补，不重复：
//   · P0-1 断言的是「audit() 的返回值不能是 pass」
//   · 这里断言的是「即便 demo 适配器自己吐出了 verdict:"pass"，
//     整个链路也不能把它变成一次可验收的通过」
//
// 为什么要两条：
//   demo 适配器的 auditReply() 内部**确实**会返回 verdict:"pass"
//   （产物够长且不含 TODO 时）。它之所以不可验收，靠的是 audit.ts
//   在调用模型之前就短路 escalate。也就是说——
//   「demo 不能放行」这个结论依赖一个前置判断，
//   一旦那个判断被移走或写错，demo 的 pass 就会直达验收。
//   P0-1 只测了前者（返回值），没测后者（acceptance 门）。
//
// 这条测试用真实 demoAdapter，不用替身：
// 替身返回什么由我决定，而 demoAdapter 返回 pass 是它的既定行为。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../store.js'
import { SnapshotManager } from '../snapshot.js'
import { AcceptanceService } from '../acceptance.js'
import { ReviewLoop, registerSkill, clearSkills } from '../review-loop.js'
import { demoAdapter } from '../../providers/demo.js'
import type { AuditSkill } from '../../shared/types.js'

const skill: AuditSkill = {
  id: 'general',
  version: '1',
  name: '通用任务',
  machineRules: [],
  auditorInstructions: '你是审计者',
  maxCycles: 3,
}

describe('demo Auditor 不可验收', () => {
  let dir: string
  let workspace: string
  let store: Store
  let snapshot: SnapshotManager
  let loop: ReviewLoop
  let acceptance: AcceptanceService

  beforeEach(() => {
    clearSkills()
    registerSkill(skill)
    dir = mkdtempSync(join(tmpdir(), 'demo-accept-'))
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

  it('demo 适配器自己给出 pass 时，acceptance 仍然拒绝', async () => {
    const content = '这是一段足够长的产物内容，用来通过 demo 的长度检查。'
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: '写报告' })
    store.putTaskContract({
      taskId: task.id, goal: '写报告', acceptanceCriteria: [], actor: 'user',
    })
    writeFileSync(join(workspace, 'report.md'), content, 'utf8')

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
    const artifact = store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: 'report.md',
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      sourceSnapshotId: snapRecord.id, version: 1, status: 'candidate',
    })
    store.setRunStatus(run.id, 'completed', { endedAt: Date.now() })
    store.updateTaskStatus(task.id, 'awaiting_acceptance')

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    // 先证明前提成立：demo 适配器对这段产物确实会给 pass。
    // 如果这一点不成立，下面的「不可验收」就没有证明力——
    // 它可能只是碰巧没拿到 pass 而已。
    const direct = await demoAdapter.stream(
      {
        provider: { id: 'demo', name: 'demo', kind: 'demo', baseUrl: 'demo://', requiresKey: false },
        model: { id: 'demo' },
        messages: [
          { role: 'system', content: '你是一个严格的审计者' },
          { role: 'user', content: `### report.md\n\`\`\`\n${content}\n\`\`\`` },
        ],
        signal: new AbortController().signal,
      },
      { onText: () => {}, onReasoning: () => {} },
    )
    expect(JSON.parse(direct.text).verdict, 'demo 没给 pass，这条测试失去意义').toBe('pass')

    // ── 真实链路：demo 作为 Auditor ──────────────────────
    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'demo',
      auditorProvider: { presetId: 'demo' },
      signal: new AbortController().signal,
      adapterResolver: () => demoAdapter,
    })

    expect(outcome.audit.result.verdict, 'demo 的 pass 漏进了审计结果').toBe('escalate')
    expect(outcome.audit.result.escalateReason).toBe('uncertain')

    // ── 关键：验收门必须拒绝 ─────────────────────────────
    const err = await acceptance.accept({
      taskId: task.id, artifactId: artifact.id, runId: run.id,
    }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    )
    expect(err.ok, 'demo 审计的产物被验收通过了').toBe(false)
    if (!err.ok) {
      // 必须是因为审计，而不是别的门（比如 Task 状态）
      expect(String(err.e.message)).toMatch(/audit|审计|escalate|pass/i)
    }

    expect(store.listAcceptances(task.id), '被拒绝的验收却留下了记录').toHaveLength(0)
  })
})
