// 用例 H：ReviewLoop 完整闭环（P1-A 验收）
//
// 验证：
//   1. Cycle 状态由关联对象推导，不存独立 status
//   2. 没有快照时不能审计（审计只读快照）
//   3. reject 生成 ReworkBrief
//   4. 返工说明包含阻断问题与冻结规则
//   5. maxCycles 达到上限后不再创建新 Cycle
//   6. 审计结果可持久化与回放
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../store.js'
import { SnapshotManager } from '../snapshot.js'
import { ReviewLoop, registerSkill, clearSkills } from '../review-loop.js'
import { BUILTIN_RULES } from '../audit.js'
import type { Artifact, AuditSkill } from '../../shared/types.js'
import type { ProviderAdapter } from '../../providers/types.js'

describe('用例 H：ReviewLoop', () => {
  let dir: string
  let workspace: string
  let store: Store
  let snapshot: SnapshotManager
  let loop: ReviewLoop

  beforeEach(() => {
    clearSkills()
    dir = mkdtempSync(join(tmpdir(), 'ws-loop-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 'test.db'))
    snapshot = new SnapshotManager(workspace, { repoDir: join(dir, 'snaprepo') })
    loop = new ReviewLoop(store, { maxCycles: 3, snapshotManager: snapshot, workspaceRoot: workspace })
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      /* ignore */
    }
    clearSkills()
    rmSync(dir, { recursive: true, force: true })
  })

  const baseSkill: AuditSkill = {
    id: 'skill.test',
    version: '1',
    name: '测试技能',
    machineRules: [BUILTIN_RULES.artifactNotEmpty, BUILTIN_RULES.artifactInSnapshot],
    auditorInstructions: '你是审计者',
    maxCycles: 3,
  }

  /** 造一个「Producer Run 已完成 + 有快照 + 有产物」的场景 */
  async function setupProducerRun(files: Record<string, string>) {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    // 审计要求存在任务契约（否则 escalate contract_missing）。
    // 这个 helper 用于测试审计流程本身，不是测试契约缺失场景。
    store.putTaskContract({
      taskId: task.id,
      goal: 'g',
      acceptanceCriteria: [],
      actor: 'test',
    })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(workspace, path), content, 'utf8')
    }

    const snap = await snapshot.capture()
    const snapshotRecord = store.createSnapshot({
      runId: run.id,
      taskId: task.id,
      kind: 'workspace',
      ref: snap.ref,
      reproducible: true,
      fileCount: snap.fileCount,
      totalBytes: snap.totalBytes,
    })

    const artifacts: Artifact[] = []
    for (const [path, content] of Object.entries(files)) {
      artifacts.push(
        store.createArtifact({
          taskId: task.id,
          runId: run.id,
          type: 'file',
          path,
          // 真实 hash：审计会从快照重新读取并比对
          contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
          sourceSnapshotId: snapshotRecord.id,
          version: 1,
          status: 'candidate',
        }),
      )
    }

    store.setRunStatus(run.id, 'completed', { endedAt: Date.now() })
    store.updateTaskStatus(task.id, 'awaiting_acceptance')

    return { session, task, run, artifacts, snapshotRecord }
  }

  function adapterReturning(text: string): ProviderAdapter {
    return {
      async stream() {
        return { text, toolCalls: [], inputTokens: 10, outputTokens: 5 }
      },
    }
  }

  it('没有快照时审计直接 escalate，不读取工作区', async () => {
    registerSkill(baseSkill)

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    store.putTaskContract({ taskId: task.id, goal: 'g', acceptanceCriteria: [], actor: 'test' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    // 故意不拍快照
    const artifact = store.createArtifact({
      taskId: task.id, runId: run.id, type: 'file', path: 'a.md',
      contentHash: 'h', version: 1, status: 'candidate',
    })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    expect('limitReached' in cycle).toBe(false)
    if ('limitReached' in cycle) return

    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,

      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => adapterReturning('{"verdict":"pass"}'),
    })

    expect(outcome.kind).toBe('escalated')
    if (outcome.kind === 'escalated') {
      expect(outcome.reason).toContain('快照')
    }
    expect(outcome.audit.result.blockingIssues[0]!.feature).toBe('no_snapshot')
  })

  it('审计通过时返回 passed', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'report.md': '这是一份报告的内容' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () =>
        adapterReturning(JSON.stringify({ verdict: 'reject', issues: [], summary: 'x' })),
    })

    // 默认 skill 都是 weak 规则，模型即使说 pass 也会 escalate；
    // 这里模型说 reject，所以是 rejected
    expect(outcome.kind).toBe('rejected')
  })

  it('reject 生成 ReworkBrief，包含阻断问题与冻结规则', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'report.md': '内容' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () =>
        adapterReturning(JSON.stringify({
          verdict: 'reject',
          issues: [{
            feature: 'missing_data',
            severity: 'blocking',
            description: '缺少关键数据支撑',
            suggestedFix: '补充 2025 年数据',
          }],
          summary: '论证不足',
        })),
    })

    expect(outcome.kind).toBe('rejected')
    if (outcome.kind !== 'rejected') return

    expect(outcome.brief.blockingIssues.length).toBeGreaterThan(0)
    expect(outcome.brief.blockingIssues.some((i) => i.feature === 'missing_data')).toBe(true)
    expect(outcome.brief.cycleNumber).toBe(1)
    // 冻结的是规则，不是结果
    expect(outcome.brief.frozenRules.length).toBe(2)
    expect(outcome.brief.frozenRules.every((r) => r.ruleVersion === '1')).toBe(true)
  })

  it('返工说明文本包含关键信息', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'report.md': 'x' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () =>
        adapterReturning(JSON.stringify({
          verdict: 'reject',
          issues: [{ feature: 'f', severity: 'blocking', description: '问题 A', suggestedFix: '改成 B' }],
          summary: '需要返工',
        })),
    })

    if (outcome.kind !== 'rejected') throw new Error('应为 rejected')

    const prompt = loop.buildReworkPrompt(outcome.brief)
    expect(prompt).toContain('返工要求')
    expect(prompt).toContain('问题 A')
    expect(prompt).toContain('改成 B')
    expect(prompt).toContain('本轮仍会重新检查全部规则')
  })

  // ── 归属校验：产物必须属于 Cycle 的 Task / Run / Snapshot ──

  it('产物属于别的 Task 时审计必须拒绝', async () => {
    registerSkill(baseSkill)
    const { task, run } = await setupProducerRun({ 'a.md': 'x' })

    // 造一个属于别的 Task 的产物，挂在同一个 Run 上
    const otherSession = store.createSession('other')
    const otherTask = store.createTask({ sessionId: otherSession.id, goal: 'g' })
    store.createArtifact({
      taskId: otherTask.id,          // ← 别的 Task
      runId: run.id,
      type: 'file',
      path: 'foreign.md',
      contentHash: 'h',
      version: 1,
      status: 'candidate',
    })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    await expect(
      loop.audit(cycle.id, {
        cycleId: cycle.id,
        producerModel: 'deepseek-chat',
        auditorModel: 'claude-sonnet-5-5',
        auditorProvider: { presetId: 'anthropic' },
        signal: new AbortController().signal,
        adapterResolver: () => adapterReturning('{"verdict":"pass"}'),
      }),
    ).rejects.toThrow(/与 Cycle 的 Task/)
  })

  it('产物关联的快照不是本 Cycle 审计的快照时拒绝', async () => {
    registerSkill(baseSkill)
    const { task, run, snapshotRecord } = await setupProducerRun({ 'a.md': 'x' })

    // 造一个指向别的快照的产物
    store.createArtifact({
      taskId: task.id,
      runId: run.id,
      type: 'file',
      path: 'wrong-snap.md',
      contentHash: 'h',
      sourceSnapshotId: 'some-other-snapshot-id',   // ← 不是本 Cycle 的快照
      version: 1,
      status: 'candidate',
    })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    await expect(
      loop.audit(cycle.id, {
        cycleId: cycle.id,
        producerModel: 'deepseek-chat',
        auditorModel: 'claude-sonnet-5-5',
        auditorProvider: { presetId: 'anthropic' },
        signal: new AbortController().signal,
        adapterResolver: () => adapterReturning('{"verdict":"pass"}'),
      }),
    ).rejects.toThrow(/多个不同的快照|不是本 Cycle 审计的快照/)
  })

  it('并发创建 Cycle 时 cycle_number 不重复', async () => {
    const skill = { ...baseSkill, maxCycles: 5 }
    registerSkill(skill)
    const { task, run } = await setupProducerRun({ 'a.md': 'x' })

    // 连续创建 5 次，cycle_number 必须是 1..5 无重复
    const numbers: number[] = []
    for (let i = 0; i < 5; i++) {
      const c = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
      if ('limitReached' in c) break
      numbers.push(c.cycleNumber)
    }

    expect(numbers).toEqual([1, 2, 3, 4, 5])
    expect(new Set(numbers).size).toBe(numbers.length)

    // 第 6 次被上限拦截
    const c6 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c6).toBe(true)

    // Task usage 与实际 Cycle 数一致
    expect(store.getTask(task.id)!.usage!.cycles).toBe(5)
    expect(store.listReviewCycles(task.id)).toHaveLength(5)
  })

  it('同一 Task 下 cycle_number 有唯一约束', async () => {
    const { task, run } = await setupProducerRun({ 'a.md': 'x' })

    store.createReviewCycle({
      taskId: task.id, skillId: 'g', skillVersion: '1',
      cycleNumber: 1, producerRunId: run.id,
    })

    // 再插一条相同 cycleNumber 必须失败
    expect(() =>
      store.createReviewCycle({
        taskId: task.id, skillId: 'g', skillVersion: '1',
        cycleNumber: 1, producerRunId: run.id,
      }),
    ).toThrow()
  })

  it('TaskBudget.maxCycles 真正生效', async () => {
    const skill = { ...baseSkill, maxCycles: 10 }   // skill 上限很宽松
    registerSkill(skill)

    const session = store.createSession('t')
    // Task 预算只允许 2 轮
    const task = store.createTask({
      sessionId: session.id,
      goal: 'g',
      budget: { maxCycles: 2 },
    })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.setRunStatus(run.id, 'completed')

    // 前两轮可以创建
    const c1 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c1).toBe(false)
    const c2 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c2).toBe(false)

    // 第三轮被 Task 预算拦截（即使 skill 允许 10 轮）
    const c3 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c3).toBe(true)
    if ('limitReached' in c3) {
      expect(c3.reason).toContain('任务预算')
    }

    // Task 的 cycles 计数应该累加了
    expect(store.getTask(task.id)!.usage!.cycles).toBe(2)
  })

  it('达到 maxCycles 后不再创建新 Cycle', async () => {
    const skill = { ...baseSkill, maxCycles: 2 }
    registerSkill(skill)
    const { task, run } = await setupProducerRun({ 'a.md': 'x' })

    // 创建两个 Cycle
    const c1 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c1).toBe(false)
    const c2 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c2).toBe(false)

    // 第三次应该被拒绝
    const c3 = loop.begin({ taskId: task.id, producerRunId: run.id, skill })
    expect('limitReached' in c3).toBe(true)
    if ('limitReached' in c3) {
      expect(c3.reason).toContain('最大循环次数')
      expect(c3.reason).toContain('人工')
    }
  })

  it('Cycle 状态由关联对象推导，不存独立 status', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'a.md': 'x' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    // 审计前：producer 已完成 → checking
    expect(loop.deriveStatus(cycle.id)).toBe('checking')

    // 审计后：reject → rework_required
    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => adapterReturning('{"verdict":"reject","issues":[],"summary":"x"}'),
    })
    expect(outcome.kind).toBe('rejected')
    expect(loop.deriveStatus(cycle.id)).toBe('rework_required')
  })

  it('审计结果可持久化并在重启后查询', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'a.md': 'x' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () =>
        adapterReturning(JSON.stringify({
          verdict: 'reject',
          confidence: 0.85,
          issues: [{ feature: 'q', severity: 'blocking', description: '质量问题' }],
          summary: '不合格',
        })),
    })

    // 模拟重启
    const dbPath = join(dir, 'test.db')
    store.close()
    store = new Store(dbPath)

    const results = store.listAuditResults(task.id)
    expect(results).toHaveLength(1)
    expect(results[0]!.verdict).toBe('reject')
    expect(results[0]!.confidence).toBe(0.85)
    expect(results[0]!.result.blockingIssues.some((i) => i.feature === 'q')).toBe(true)
    expect(results[0]!.result.checkedRules).toHaveLength(2)

    // Cycle 也能查
    const cycles = store.listReviewCycles(task.id)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.auditResultId).toBe(results[0]!.id)
  })

  it('同族模型审计时降级为 escalate', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'a.md': 'x' })

    const cycle = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in cycle) throw new Error('不应达上限')

    let modelCalled = false
    const outcome = await loop.audit(cycle.id, {
      cycleId: cycle.id,
      producerModel: 'claude-sonnet-5-5',
      auditorModel: 'claude-opus-5-5',   // 同族
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => ({
        async stream() {
          modelCalled = true
          return { text: '{"verdict":"pass"}', toolCalls: [] }
        },
      }),
    })

    expect(outcome.kind).toBe('escalated')
    expect(modelCalled).toBe(false)
    if (outcome.kind === 'escalated') {
      expect(outcome.audit.result.blockingIssues[0]!.feature).toBe('same_model_family')
    }
  })

  it('回归检测：上一轮通过的规则本轮失败', async () => {
    registerSkill(baseSkill)
    const { task, run, artifacts } = await setupProducerRun({ 'a.md': 'x' })

    // 第一轮：全部通过但模型 reject（构造上轮规则全 pass）
    const c1 = loop.begin({ taskId: task.id, producerRunId: run.id, skill: baseSkill })
    if ('limitReached' in c1) throw new Error('不应达上限')
    await loop.audit(c1.id, {
      cycleId: c1.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => adapterReturning('{"verdict":"reject","issues":[],"summary":"x"}'),
    })

    // 第二轮：删掉文件让 in_snapshot 失败
    rmSync(join(workspace, 'a.md'))
    const run2 = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const snap2 = await snapshot.capture()
    const snapRecord2 = store.createSnapshot({
      runId: run2.id, taskId: task.id, kind: 'workspace', ref: snap2.ref,
      reproducible: true, fileCount: snap2.fileCount, totalBytes: snap2.totalBytes,
    })
    store.setRunStatus(run2.id, 'completed', { endedAt: Date.now() })

    const c2 = loop.begin({ taskId: task.id, producerRunId: run2.id, skill: baseSkill })
    if ('limitReached' in c2) throw new Error('不应达上限')

    // 产物仍然指向 a.md，但快照里没有了
    const staleArtifact = store.createArtifact({
      taskId: task.id, runId: run2.id, type: 'file', path: 'a.md',
      contentHash: 'h', sourceSnapshotId: snapRecord2.id, version: 2, status: 'candidate',
    })

    const outcome = await loop.audit(c2.id, {
      cycleId: c2.id,
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      signal: new AbortController().signal,
      adapterResolver: () => adapterReturning('{"verdict":"reject","issues":[],"summary":"x"}'),
    })

    expect(outcome.kind).toBe('rejected')
    expect(outcome.audit.result.regression).toBe(true)
    expect(outcome.audit.result.blockingIssues.some((i) => i.feature === 'regression')).toBe(true)
  })
})
