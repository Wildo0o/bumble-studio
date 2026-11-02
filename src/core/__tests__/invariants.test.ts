// 不变量测试。
//
// 这些测试描述的是「系统必须满足的安全边界」。
// 它们不是功能测试——功能测试问「这个功能能用吗」，
// 不变量测试问「这个安全边界会被破坏吗」。
//
// 每一组都对应一个曾经出过问题、或极易出问题的边界：
//   1. 验收必须经过审计（且审计要绑定到被接受的产物）
//   2. unknown 必须阻塞完成，且立即停止执行
//   3. 模型 pass 不能绕过机器规则（含混合规则场景）
//   4. apply 必须真的写入文件
//   5. export 必须读已验收快照
//   6. 预算超限必须阻止后续调用
//   7. 工具结果必须持久化
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { SnapshotManager } from '../snapshot.js'
import { AcceptanceService } from '../acceptance.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry, type ToolImpl } from '../tools.js'
import { ReviewLoop, registerSkill, clearSkills } from '../review-loop.js'
import { runAudit, BUILTIN_RULES } from '../audit.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import type { Artifact, AuditSkill, MachineRule } from '../../shared/types.js'
import { ScriptedProvider, userMessage, makeContract } from './helpers.js'

// ══════════════════════════════════════════════════════════
// 不变量 1：未审计不可 accept
// ══════════════════════════════════════════════════════════

describe('不变量 1：验收必须经过审计', () => {
  let dir: string
  let workspace: string
  let store: Store
  let service: AcceptanceService
  let taskId: string
  let runId: string
  let artifactId: string
  let snapId: string
  let REAL_HASH: string
  let REAL_REF: string
  let contract: import('../../shared/types.js').TaskContract | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'inv1-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    service = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [join(dir, 'exports')],
      snapshotManager: new SnapshotManager(workspace, { repoDir: join(dir, 'snap') }),
    })

    const session = store.createSession('t')
    taskId = store.createTask({ sessionId: session.id, goal: 'g' }).id
    contract = store.putTaskContract({
      taskId, goal: 'g', acceptanceCriteria: [], actor: 'test',
    })
    runId = store.createRun({ taskId, role: 'producer', budget: {} }).id

    // 真实快照：验收门会重新读快照并算 hash。
    const CONTENT = 'out content'
    writeFileSync(join(workspace, 'out.md'), CONTENT, 'utf8')
    const snapMgr = new SnapshotManager(workspace, { repoDir: join(dir, 'snap') })
    const realSnap = await snapMgr.capture()
    REAL_HASH = createHash('sha256').update(CONTENT, 'utf8').digest('hex')
    REAL_REF = realSnap.ref

    const snap = store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: realSnap.ref,
      reproducible: true, fileCount: realSnap.fileCount, totalBytes: realSnap.totalBytes,
    })
    artifactId = store.createArtifact({
      taskId, runId, type: 'file', path: 'out.md',
      contentHash: REAL_HASH, sourceSnapshotId: snap.id, version: 1, status: 'candidate',
    }).id
    snapId = snap.id

    store.updateTaskStatus(taskId, 'awaiting_acceptance')
    store.setRunStatus(runId, 'completed')
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('未审计的 Task 不能被接受', async () => {
    // 现状：没有任何审计记录，但 Task 在 awaiting_acceptance，accept 会成功
    // 期望：必须拒绝
    await expect(service.accept({ taskId, artifactId, runId })).rejects.toThrow(/审计/)
  })

  it('审计 reject 后不能被接受', async () => {
    const cycle = store.createReviewCycle({
      taskId, skillId: 'general', skillVersion: '1',
      cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id,
      taskId,
      result: {
        verdict: 'reject',
        blockingIssues: [{
          ruleId: 'r', feature: 'f', severity: 'blocking', description: '不合格',
        }],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        summary: '不合格',
      },
    })
    store.updateTaskStatus(taskId, 'awaiting_acceptance')

    await expect(service.accept({ taskId, artifactId, runId })).rejects.toThrow(/审计/)
  })

  // ── 验收接口统一状态门（第四批 N 项） ──────────────────

  it('已 accepted 的 Task 不能被 requestRevision 回退', async () => {
    // 先造一条 pass 审计并接受
    const cycle = store.createReviewCycle({
      taskId, skillId: 'g', skillVersion: '1', cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass', blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [artifactId],
          producerRunId: runId,
          snapshotId: snapId,
          snapshotRef: REAL_REF,
          contentHashes: { 'out.md': REAL_HASH },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })
    await service.accept({ taskId, artifactId, runId })
    expect(store.getTask(taskId)!.status).toBe('accepted')

    // 再试图返工 —— 必须被拒
    expect(() =>
      service.requestRevision({ taskId, artifactId, runId, note: '想再改改' }),
    ).toThrow(/只有 awaiting_acceptance|不能.*回退/)
  })

  it('已 accepted 的 Task 不能被 reject 回退', async () => {
    const cycle = store.createReviewCycle({
      taskId, skillId: 'g', skillVersion: '1', cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass', blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        binding: {
          taskId, cycleId: cycle.id, artifactIds: [artifactId],
          producerRunId: runId, snapshotId: snapId, snapshotRef: REAL_REF,
          contentHashes: { 'out.md': REAL_HASH },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })
    await service.accept({ taskId, artifactId, runId })

    expect(() =>
      service.reject({ taskId, artifactId, runId, reason: '反悔了' }),
    ).toThrow(/只有 awaiting_acceptance/)
  })

  it('非 candidate 的产物不能被 requestRevision', () => {
    store.setArtifactStatus(artifactId, 'superseded')

    expect(() =>
      service.requestRevision({ taskId, artifactId, runId, note: '改改' }),
    ).toThrow(/只有 candidate/)
  })

  it('返工不要求审计通过（那是接受的要求）', () => {
    // 没有审计记录时 requestRevision 仍然可以工作
    // 理由：要求返工是「不满意」，不需要先证明「合格」
    const record = service.requestRevision({
      taskId, artifactId, runId, note: '内容太短',
    })
    expect(record.status).toBe('revision_requested')
  })

  it('审计绑定的是别的产物时不能被接受', async () => {
    // 造两条审计：一条针对 A，一条针对 B
    // 当前要接受 A，但最新审计是针对 B 的 → 必须拒绝
    const otherArtifact = store.createArtifact({
      taskId, runId, type: 'file', path: 'other.md',
      contentHash: 'h2', version: 1, status: 'candidate',
    })

    const cycle = store.createReviewCycle({
      taskId, skillId: 'general', skillVersion: '1',
      cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass',
        blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [otherArtifact.id],   // ← 审的是另一个产物
          producerRunId: runId,
          snapshotId: snapId,
          snapshotRef: REAL_REF,
          contentHashes: { 'other.md': 'h2' },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })

    // 现在按「归属关系」查审计：找不到针对这个产物的审计 → 拒绝
    await expect(service.accept({ taskId, artifactId, runId }))
      .rejects.toThrow(/没有找到针对产物/)
  })

  it('审计的 contentHash 与当前产物不一致时不能被接受', async () => {
    const cycle = store.createReviewCycle({
      taskId, skillId: 'general', skillVersion: '1',
      cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass',
        blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [artifactId],
          producerRunId: runId,
          snapshotId: snapId,
          snapshotRef: REAL_REF,
          contentHashes: { 'out.md': 'OLD_HASH' },   // ← 与产物当前 hash 'h1' 不同
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })

    await expect(service.accept({ taskId, artifactId, runId }))
      .rejects.toThrow(/内容在审计之后发生了变化/)
  })

  it('产物不属于指定 Task 时不能被接受', async () => {
    const otherSession = store.createSession('other')
    const otherTask = store.createTask({ sessionId: otherSession.id, goal: 'g' })

    await expect(service.accept({
      taskId: otherTask.id,       // ← 别的 Task
      artifactId,
      runId,
    })).rejects.toThrow(/产物属于 Task|Task 当前状态|还没有经过审计/)
  })

  it('产物不属于指定 Run 时不能被接受', async () => {
    const otherRun = store.createRun({ taskId, role: 'producer', budget: {} })

    await expect(service.accept({
      taskId,
      artifactId,
      runId: otherRun.id,          // ← 别的 Run
    })).rejects.toThrow(/产物属于 Run/)
  })

  it('审计 escalate 后不能被接受', async () => {
    const cycle = store.createReviewCycle({
      taskId, skillId: 'general', skillVersion: '1',
      cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id,
      taskId,
      result: {
        verdict: 'escalate',
        escalateReason: 'uncertain',
        blockingIssues: [],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        summary: '无法判断',
      },
    })
    store.updateTaskStatus(taskId, 'awaiting_acceptance')

    await expect(service.accept({ taskId, artifactId, runId })).rejects.toThrow(/审计/)
  })
})

// ══════════════════════════════════════════════════════════
// 不变量 2：unknown 阻塞完成路径
// ══════════════════════════════════════════════════════════

describe('不变量 2：unknown 时 Run 不得 completed', () => {
  let dir: string
  let workspace: string
  let store: Store

  const hangingTool: ToolImpl = {
    definition: {
      id: 'slow', name: 'slow', description: '卡住',
      inputSchema: { type: 'object', properties: {}, required: [] },
      source: 'builtin', riskLevel: 'read', sideEffect: 'none', enabled: true,
      timeoutMs: 50, maxOutputBytes: 1024,
      reconcile: { idempotent: false, unsafeToRetry: true },
    },
    async run() {
      await new Promise(() => { /* 永不 resolve */ })
      return { ok: true, content: '' }
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inv2-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具超时后立即停止，不再调用模型', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'slow', args: {} }] },
      { text: '这一轮不应该被调用' },
    ])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    const executor = new RunExecutor(
      store, new ToolRegistry([hangingTool]),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('执行')],
      signal: new AbortController().signal,
    })

    // 结果类型必须是 needs_reconciliation，不是 failed
    expect(outcome.status).toBe('needs_reconciliation')

    // 关键：只调用了 1 次模型（超时后立即停止）
    expect(script.turnCount).toBe(1)

    // Run 状态正确
    expect(store.getRun(run.id)!.status).toBe('needs_reconciliation')

    // Task 不能进 awaiting_acceptance
    expect(store.getTask(task.id)!.status).not.toBe('awaiting_acceptance')
  })

  it('同批多个工具调用时，超时后不再处理后续工具', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 20 } })

    // 同一轮里发两个工具调用：第一个超时，第二个不应该被执行
    let secondToolCalled = false
    const trackingTool: ToolImpl = {
      definition: {
        id: 'track', name: 'track', description: '记录是否被调用',
        inputSchema: { type: 'object', properties: {}, required: [] },
        source: 'builtin', riskLevel: 'read', sideEffect: 'none', enabled: true,
        timeoutMs: 1000, maxOutputBytes: 1024,
        reconcile: { idempotent: true, unsafeToRetry: false },
      },
      async run() {
        secondToolCalled = true
        return { ok: true, content: 'executed' }
      },
    }

    const script = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'slow', args: {} },
          { name: 'track', args: {} },
        ],
      },
      { text: '不应该到这里' },
    ])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    const executor = new RunExecutor(
      store, new ToolRegistry([hangingTool, trackingTool]),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('执行两个工具')],
      signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('needs_reconciliation')
    // 关键：第二个工具没有被执行
    expect(secondToolCalled).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════
// 不变量 3：Audit pass 的合并逻辑
// ══════════════════════════════════════════════════════════

describe('不变量 3：strong rule uncertain 时模型 pass 必须 escalate', () => {
  function makeArtifact(path: string): Artifact {
    return {
      id: `a-${path}`, taskId: 't', runId: 'r', type: 'file',
      path, contentHash: 'h', sourceSnapshotId: 's',
      version: 1, status: 'candidate', createdAt: Date.now(),
    }
  }

  function ctx(files: Record<string, string>, artifacts: Artifact[]) {
    return {
      workspaceRoot: '/ws', snapshotRef: 's', artifacts,
      readFile: async (p: string) => files[p] ?? null,
      listFiles: async () => Object.keys(files),
    }
  }

  const uncertainStrongRule: MachineRule = {
    id: 'strong.uncertain',
    version: '1',
    description: '强规则，但无法判断',
    strength: 'strong',
    check() {
      return { status: 'uncertain', evidence: '无法读取外部系统' }
    },
  }

  it('strong 规则 uncertain + 模型 pass → 必须 escalate', async () => {
    const artifacts = [makeArtifact('a.md')]
    const skill: AuditSkill = {
      id: 's', version: '1', name: 's',
      machineRules: [uncertainStrongRule],
      auditorInstructions: '审计',
      maxCycles: 2,
    }

    const outcome = await runAudit({
        taskContract: makeContract(),
      skill,
      artifacts,
      ruleContext: ctx({ 'a.md': 'x' }, artifacts),
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      artifactTexts: [{ path: 'a.md', content: 'x' }],
      signal: new AbortController().signal,
      adapterResolver: () => ({
        async stream() {
          return {
            text: JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [], summary: 'ok' }),
            toolCalls: [],
          }
        },
      }),
    })

    // 现状：hasStrongRules 为 true（因为有 strong 规则），但它的状态是 uncertain
    //       → allUncertain 为 true → 应该降级... 需要验证实际行为
    // 期望：verdict 必须是 escalate
    expect(outcome.result.verdict).toBe('escalate')
    expect(outcome.result.escalateReason).toBe('uncertain')
  })

  it('strong 规则 not_applicable + 模型 pass → 必须 escalate', async () => {
    const artifacts = [makeArtifact('a.md')]
    const naRule: MachineRule = {
      id: 'strong.na', version: '1', description: '不适用', strength: 'strong',
      check() {
        return { status: 'not_applicable' as never }
      },
    }
    const skill: AuditSkill = {
      id: 's', version: '1', name: 's',
      machineRules: [naRule],
      auditorInstructions: '审计',
      maxCycles: 2,
    }

    const outcome = await runAudit({
        taskContract: makeContract(),
      skill, artifacts,
      ruleContext: ctx({ 'a.md': 'x' }, artifacts),
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      artifactTexts: [{ path: 'a.md', content: 'x' }],
      signal: new AbortController().signal,
      adapterResolver: () => ({
        async stream() {
          return {
            text: JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [], summary: 'ok' }),
            toolCalls: [],
          }
        },
      }),
    })

    expect(outcome.result.verdict).toBe('escalate')
  })

  // ── 混合规则场景 ──────────────────────────────────────
  //
  // 这一组是回归防护。曾经有过一个 fail-open：
  // 「weak pass + strong uncertain」被放行成 pass，
  // 因为旧逻辑只看聚合标志（allUncertain / hasStrongRules），
  // 没有逐条检查每条规则是否明确通过。

  const weakPassRule: MachineRule = {
    id: 'weak.pass', version: '1', description: 'weak 规则通过', strength: 'weak',
    check() {
      return { status: 'pass', evidence: 'ok' }
    },
  }

  function makeStrongRule(id: string, status: 'pass' | 'uncertain' | 'not_applicable'): MachineRule {
    return {
      id, version: '1', description: `strong ${status}`, strength: 'strong',
      check() {
        return status === 'not_applicable'
          ? { status: 'not_applicable' as never }
          : { status, evidence: status }
      },
    }
  }

  const passAdapter = () => ({
    async stream() {
      return {
        text: JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [], summary: 'ok' }),
        toolCalls: [],
      }
    },
  })

  async function auditWith(rules: MachineRule[]) {
    const artifacts = [makeArtifact('a.md')]
    return runAudit({
        taskContract: makeContract(),
      // 完整绑定要求快照与 cycleId。这一组测的是 verdict 合并，
      // 不是绑定校验，夹具给出合法的最小完整输入。
      cycleId: 'cycle-t1',
      snapshot: { id: 'snap1', ref: 'ref1' },
      skill: {
        id: 's', version: '1', name: 's',
        machineRules: rules,
        auditorInstructions: '审计',
        maxCycles: 2,
      },
      artifacts,
      ruleContext: ctx({ 'a.md': 'x' }, artifacts),
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      artifactTexts: [{ path: 'a.md', content: 'x' }],
      signal: new AbortController().signal,
      adapterResolver: passAdapter,
    })
  }

  it('weak pass + strong uncertain + 模型 pass → 必须 escalate', async () => {
    const outcome = await auditWith([weakPassRule, makeStrongRule('strong.u', 'uncertain')])
    expect(outcome.result.verdict).toBe('escalate')
    expect(outcome.result.escalateReason).toBe('uncertain')
  })

  it('weak pass + strong not_applicable + 模型 pass → 必须 escalate', async () => {
    const outcome = await auditWith([weakPassRule, makeStrongRule('strong.na', 'not_applicable')])
    expect(outcome.result.verdict).toBe('escalate')
  })

  it('strong pass + weak pass + 模型 pass → 允许 pass', async () => {
    const outcome = await auditWith([weakPassRule, makeStrongRule('strong.p', 'pass')])
    expect(outcome.result.verdict).toBe('pass')
  })

  it('strong pass + weak uncertain + 模型 pass → 必须 escalate', async () => {
    const weakUncertain: MachineRule = {
      id: 'weak.u', version: '1', description: 'weak uncertain', strength: 'weak',
      check() {
        return { status: 'uncertain', evidence: '不确定' }
      },
    }
    const outcome = await auditWith([weakUncertain, makeStrongRule('strong.p', 'pass')])
    // 只要有一条规则没明确 pass，就不能放行
    expect(outcome.result.verdict).toBe('escalate')
  })

  it('没有任何规则 + 模型 pass → 必须 escalate', async () => {
    const outcome = await auditWith([])
    expect(outcome.result.verdict).toBe('escalate')
  })

  // ── 模型输出自相矛盾：pass 但含 blocking issue ──────────

  it('模型说 pass 但列出 blocking issue → 必须 reject', async () => {
    const artifacts = [makeArtifact('data.json')]
    const outcome = await runAudit({
        taskContract: makeContract(),
      cycleId: 'cycle-t1',
      snapshot: { id: 'snap1', ref: 'ref1' },
      skill: {
        id: 's', version: '1', name: 's',
        // 全 strong 且全通过，正常情况下模型 pass 会生效
        machineRules: [makeStrongRule('strong.p', 'pass')],
        auditorInstructions: '审计',
        maxCycles: 2,
      },
      artifacts,
      ruleContext: ctx({ 'data.json': '{"ok":true}' }, artifacts),
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      artifactTexts: [{ path: 'data.json', content: '{"ok":true}' }],
      signal: new AbortController().signal,
      adapterResolver: () => ({
        async stream() {
          return {
            // 自相矛盾：verdict 是 pass，但 issue 是 blocking
            text: JSON.stringify({
              verdict: 'pass',
              confidence: 0.9,
              issues: [{
                feature: 'missing_source',
                severity: 'blocking',
                description: '关键结论缺少来源',
              }],
              summary: '看起来还行，但有个大问题',
            }),
            toolCalls: [],
          }
        },
      }),
    })

    expect(outcome.result.verdict).toBe('reject')
    expect(outcome.result.summary).toContain('阻断')
  })

  it('模型说 pass 但只列 warning issue → 允许 pass', async () => {
    const artifacts = [makeArtifact('data.json')]
    const outcome = await runAudit({
        taskContract: makeContract(),
      cycleId: 'cycle-t1',
      snapshot: { id: 'snap1', ref: 'ref1' },
      skill: {
        id: 's', version: '1', name: 's',
        machineRules: [makeStrongRule('strong.p', 'pass')],
        auditorInstructions: '审计',
        maxCycles: 2,
      },
      artifacts,
      ruleContext: ctx({ 'data.json': '{"ok":true}' }, artifacts),
      producerModel: 'deepseek-chat',
      auditorModel: 'claude-sonnet-5-5',
      auditorProvider: { presetId: 'anthropic' },
      artifactTexts: [{ path: 'data.json', content: '{"ok":true}' }],
      signal: new AbortController().signal,
      adapterResolver: () => ({
        async stream() {
          return {
            text: JSON.stringify({
              verdict: 'pass',
              confidence: 0.9,
              issues: [{
                feature: 'style',
                severity: 'warning',   // ← 只是警告
                description: '排版可以更好',
              }],
              summary: '通过，有个小建议',
            }),
            toolCalls: [],
          }
        },
      }),
    })

    expect(outcome.result.verdict).toBe('pass')
    expect(outcome.result.nonBlockingIssues.length).toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════════════════
// 不变量 4/5：apply 与 export 必须真的操作文件
// ══════════════════════════════════════════════════════════

describe('不变量 4：apply 必须真正写入文件', () => {
  let dir: string
  let workspace: string
  let store: Store
  let snapshot: SnapshotManager
  let service: AcceptanceService
  let taskId: string
  let runId: string
  let acceptanceId: string
  let contract: import('../../shared/types.js').TaskContract | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'inv4-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
    snapshot = new SnapshotManager(workspace, { repoDir: join(dir, 'snap') })
    service = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [join(dir, 'exports')],
      snapshotManager: snapshot,
    })

    // 造一个真实快照，内容为 accepted version
    writeFileSync(join(workspace, 'out.md'), 'ACCEPTED CONTENT', 'utf8')
    const snap = await snapshot.capture()

    const session = store.createSession('t')
    taskId = store.createTask({ sessionId: session.id, goal: 'g' }).id
    contract = store.putTaskContract({
      taskId, goal: 'g', acceptanceCriteria: [], actor: 'test',
    })
    runId = store.createRun({ taskId, role: 'producer', budget: {} }).id

    const snapRecord = store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: snap.ref,
      reproducible: true, fileCount: snap.fileCount, totalBytes: snap.totalBytes,
    })
    // contentHash 必须与快照里的真实内容一致，否则交付时的哈希校验会失败
    const realHash = createHash('sha256').update('ACCEPTED CONTENT', 'utf8').digest('hex')
    const artifact = store.createArtifact({
      taskId, runId, type: 'file', path: 'out.md',
      contentHash: realHash, sourceSnapshotId: snapRecord.id,
      version: 1, status: 'candidate',
    })

    // 造一个 pass 审计
    const cycle = store.createReviewCycle({
      taskId, skillId: 'g', skillVersion: '1', cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass', confidence: 0.9,
        blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        // 必须绑定到具体产物，否则验收门会拒绝
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [artifact.id],
          producerRunId: runId,
          snapshotId: snapRecord.id,
          snapshotRef: snap.ref,
          contentHashes: { 'out.md': realHash },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })
    store.updateTaskStatus(taskId, 'awaiting_acceptance')

    const acc = await service.accept({ taskId, artifactId: artifact.id, runId })
    acceptanceId = acc.id

    // 现在把工作区文件改掉，模拟「快照之后又被改动」
    writeFileSync(join(workspace, 'out.md'), 'DRIFTED CONTENT', 'utf8')
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('工作区漂移时 apply 必须报冲突，不得静默覆盖', async () => {
    // 场景：验收之后用户手动改了工作区文件
    // 立场：不能覆盖用户的修改，必须报 conflict
    const delivery = await service.apply(acceptanceId)

    expect(delivery.status).toBe('conflict')
    expect(delivery.error).toContain('漂移')
    // 用户的内容没有被覆盖
    expect(readFileSync(join(workspace, 'out.md'), 'utf8')).toBe('DRIFTED CONTENT')
  })

  it('工作区一致时 apply 必须真正写入并校验', async () => {
    // 把工作区恢复成与快照一致
    writeFileSync(join(workspace, 'out.md'), 'ACCEPTED CONTENT', 'utf8')

    const delivery = await service.apply(acceptanceId)
    expect(delivery.status).toBe('applied')

    // 关键：内容必须来自快照
    expect(readFileSync(join(workspace, 'out.md'), 'utf8')).toBe('ACCEPTED CONTENT')
  })

  it('目标不存在时 apply 必须创建文件', async () => {
    // 删掉目标文件，模拟产物是「新建文件」
    rmSync(join(workspace, 'out.md'), { force: true })

    const delivery = await service.apply(acceptanceId)
    expect(delivery.status).toBe('applied')
    expect(existsSync(join(workspace, 'out.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'out.md'), 'utf8')).toBe('ACCEPTED CONTENT')
  })
})

describe('不变量 5：export 必须读已验收快照而非当前工作区', () => {
  let dir: string
  let workspace: string
  let exportsDir: string
  let store: Store
  let snapshot: SnapshotManager
  let service: AcceptanceService
  let acceptanceId: string
  let contract: import('../../shared/types.js').TaskContract | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'inv5-'))
    workspace = join(dir, 'workspace')
    exportsDir = join(dir, 'exports')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(exportsDir, { recursive: true })
    store = new Store(join(dir, 't.db'))
    snapshot = new SnapshotManager(workspace, { repoDir: join(dir, 'snap') })
    service = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [exportsDir],
      snapshotManager: snapshot,
    })

    writeFileSync(join(workspace, 'report.md'), 'SNAPSHOT VERSION', 'utf8')
    const snap = await snapshot.capture()

    const session = store.createSession('t')
    const taskId = store.createTask({ sessionId: session.id, goal: 'g' }).id
    const contract = store.putTaskContract({
      taskId, goal: 'g', acceptanceCriteria: [], actor: 'test',
    })
    const runId = store.createRun({ taskId, role: 'producer', budget: {} }).id
    const snapRecord = store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: snap.ref,
      reproducible: true, fileCount: snap.fileCount, totalBytes: snap.totalBytes,
    })
    const realHash = createHash('sha256').update('SNAPSHOT VERSION', 'utf8').digest('hex')
    const artifact = store.createArtifact({
      taskId, runId, type: 'file', path: 'report.md',
      contentHash: realHash, sourceSnapshotId: snapRecord.id,
      version: 1, status: 'candidate',
    })

    const cycle = store.createReviewCycle({
      taskId, skillId: 'g', skillVersion: '1', cycleNumber: 1, producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id, taskId,
      result: {
        verdict: 'pass', blockingIssues: [], nonBlockingIssues: [],
        checkedRules: [], evidenceRefs: [], summary: 'ok',
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [artifact.id],
          producerRunId: runId,
          snapshotId: snapRecord.id,
          snapshotRef: snap.ref,
          contentHashes: { 'report.md': realHash },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })
    store.updateTaskStatus(taskId, 'awaiting_acceptance')
    acceptanceId = (await service.accept({ taskId, artifactId: artifact.id, runId })).id

    // 工作区漂移
    writeFileSync(join(workspace, 'report.md'), 'DRIFTED VERSION', 'utf8')
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('export 出的内容必须等于已验收快照，不是当前工作区', async () => {
    const delivery = await service.export(acceptanceId, exportsDir)

    expect(delivery.status).toBe('exported')
    const exported = readFileSync(delivery.destination!, 'utf8')
    // 现状：export 从当前工作区 copyFile → 得到 DRIFTED
    // 期望：必须从快照读 → SNAPSHOT VERSION
    expect(exported).toBe('SNAPSHOT VERSION')
  })
})

// ══════════════════════════════════════════════════════════
// 不变量 6：预算必须阻止下一次超限调用
// ══════════════════════════════════════════════════════════

describe('不变量 6：预算超限必须阻止下一次调用', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inv6-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('usage 已达上限时不得再发起调用', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxTotalTokens: 100 },
    })

    // 手动把用量推到恰好等于上限
    store.addRunUsage(run.id, { inputTokens: 100, outputTokens: 0 })

    const script = new ScriptedProvider([{ text: '不应该被调用' }])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    const executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    // 现状：`>` 而非 `>=`，100 > 100 为 false → 放行
    // 期望：必须拦截
    expect(outcome.status).toBe('expired')
    expect(script.turnCount).toBe(0)
  })

  it('调用后 overshoot 必须终止后续调用', async () => {
    // 注意：v0.10 起有了调用前 reservation，这个场景的**第一次**调用
    // 现在会在预留阶段就被拦下（因为估算 output = outputReserve = 8000 > 100）。
    //
    // 但 overshoot 检查仍然保留，作为第二道防线：
    // 估算不可能精确，真实用量可能超过估算。这时必须立刻终止。
    //
    // 所以这里给一个足够大的预算让第一次通过预留，
    // 再用**真实返回的超量 usage** 触发 overshoot。
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({
      taskId: task.id, role: 'producer',
      budget: { maxTotalTokens: 9000 },
    })

    // 第一次调用返回超量 usage（合计 13000 > 9000），然后模型还想继续
    const script = new ScriptedProvider([
      { text: '第一步', inputTokens: 8000, outputTokens: 5000 },
      { text: '不应该继续' },
    ])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    const executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    // 期望：第一次调用就超了，不能有第二次
    expect(script.turnCount).toBe(1)
    expect(outcome.status).toBe('expired')
  })
})

// ══════════════════════════════════════════════════════════
// 不变量 7：普通工具结果必须持久化
// ══════════════════════════════════════════════════════════

describe('不变量 7：普通工具结果必须写入 run_message', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inv7-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'data.txt'), 'file content', 'utf8')
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具执行后 run_message 必须包含 tool 结果', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([
      { toolCalls: [{ name: 'read_file', args: { path: join(workspace, 'data.txt') } }] },
      { text: '完成' },
    ])
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    const executor = new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )

    await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('读文件')],
      signal: new AbortController().signal,
    })

    const messages = store.listRunMessages<{ role: string; content: string }>(run.id)
    const toolMessages = messages.filter((m) => m.role === 'tool')

    // 现状：普通工具结果只进内存 history，不写库
    // 期望：必须持久化，重启后才能恢复
    expect(toolMessages.length).toBeGreaterThan(0)
    expect(toolMessages[0]!.content).toContain('file content')
  })
})
