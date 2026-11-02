// ReviewLoop 编排。
//
// 一次 ReviewCycle 的完整流程：
//   Producer Run 完成 → 已有快照与产物
//   → 机器规则（失败短路）
//   → Auditor 只读快照
//   → 结构化 verdict
//   → pass / reject / escalate
//   → reject 生成 ReworkBrief，下一轮 Producer 用它
//   → 达到 maxCycles 或预算上限则 escalate
//
// 关键约束：
//   · ReviewCycle 不存独立 status，由关联对象推导
//   · 审计只读快照，不读变化中的工作区
//   · 每轮必须重新检查所有规则（不继承上轮的 pass）
import type {
  Artifact,
  AuditResult,
  AuditSkill,
  PartialAuditBinding,
  ReviewCycle,
  RuleCheck,
  StoredAuditResult,
} from '../shared/types.js'
import { createHash } from 'node:crypto'
import type { ProviderAdapter } from '../providers/types.js'
import { Store } from './store.js'
import { SkillRegistry as GlobalSkillRegistry, type SkillManifest } from './skill-registry.js'
import { runAudit, type AuditOutcome } from './audit.js'
import { SnapshotManager } from './snapshot.js'
import type { RuleContext } from '../shared/types.js'

/** 返工说明。下一轮 Producer 用它知道要改什么。 */
export interface ReworkBrief {
  cycleNumber: number
  blockingIssues: AuditResult['blockingIssues']
  /** 冻结的标准，不是结果——下一轮必须重新检查 */
  frozenRules: Array<{ ruleId: string; ruleVersion: string }>
  previousSummary: string
}

export type CycleOutcome =
  | { kind: 'passed'; audit: StoredAuditResult; cycle: ReviewCycle }
  | { kind: 'rejected'; audit: StoredAuditResult; cycle: ReviewCycle; brief: ReworkBrief }
  | { kind: 'escalated'; audit: StoredAuditResult; cycle: ReviewCycle; reason: string }

/** audit() 的结果一定有 audit 字段。cycle_limit 只由 begin() 返回。 */
export type AuditOutcomeResult = CycleOutcome

export interface ReviewLoopConfig {
  maxCycles: number
  snapshotManager: SnapshotManager
  workspaceRoot: string
}

export interface PrepareCycleInput {
  taskId: string
  producerRunId: string
  skill: AuditSkill
}

export interface RunAuditInput {
  cycleId: string
  /**
   * 注意：不接收 artifacts。
   *
   * 产物由 ReviewLoop 自己根据 cycle.producerRunId 从 Store 读取并校验归属。
   * 让调用方传产物会带来污染风险——外部可以构造任意 artifact 数组，
   * 从而让审计的 binding 指向不该被审计的东西。
   */
  producerModel: string
  auditorModel: string
  auditorProvider: { presetId: string; apiKey?: string } | import('../shared/types.js').ProviderConfig
  signal: AbortSignal
  adapterResolver?: (kind: 'openai' | 'anthropic' | 'demo') => ProviderAdapter
}

/**
 * 从产物推断 Producer 完成时的快照 id。
 *
 * 规则：
 *   · 没有产物 → undefined（无法推断）
 *   · 有产物但任一缺少 sourceSnapshotId → undefined（证据不完整）
 *   · 产物指向的快照不一致 → 抛错（它们来自不同时刻，无法确定审计基准）
 *   · 全部一致 → 返回该 id
 *
 * 为什么不返回「第一个产物的快照」：
 * 不一致说明数据本身有问题，猜一个等于把问题藏起来。
 */
function resolveCompletionSnapshot(artifacts: Artifact[]): string | undefined {
  if (artifacts.length === 0) return undefined

  const ids = new Set(artifacts.map((a) => a.sourceSnapshotId ?? ''))
  if (ids.has('')) return undefined
  if (ids.size > 1) {
    throw new Error(
      '产物来自多个不同的快照，无法确定审计基准：' +
      [...ids].join(', ') +
      '。所有可审计产物必须来自 Producer 完成时的同一份快照。',
    )
  }
  return [...ids][0]
}

/**
 * 早期失败（契约缺失 / 无快照 / 契约损坏）的部分绑定。
 *
 * 这类结果无法构造完整绑定，但仍要能回答
 * 「审的是哪个 Task、哪一轮、哪些产物」。
 * `complete: false` 让验收门可以直接拒绝。
 */
function buildPartialBinding(
  cycle: ReviewCycle,
  artifacts: Artifact[],
  failureReason: string,
): PartialAuditBinding {
  return {
    complete: false,
    taskId: cycle.taskId,
    cycleId: cycle.id,
    artifactIds: artifacts.map((a) => a.id),
    producerRunId: cycle.producerRunId,
    failureReason,
  }
}

export class ReviewLoop {
  constructor(
    private store: Store,
    private config: ReviewLoopConfig,
  ) {}

  /**
   * 开始一个新的 ReviewCycle。
   *
   * 超过 maxCycles 时不再创建新循环，直接返回 cycle_limit。
   */
  begin(input: PrepareCycleInput): ReviewCycle | { limitReached: true; reason: string } {
    // ── 前置：Task 状态门 ─────────────────────────────────
    //
    // 已 accepted 的任务不能再开新 Cycle。
    // 理由：验收是「用户已经确认这份产物可以交付」的终态。
    // 重新审计会让这个结论失效——而且失败时会把 Task 从 accepted
    // 改回 revision_requested，等于用户的决定被系统推翻。
    //
    // 要重新审，应该新建一个 Task，而不是复活一个已交付的。
    const task = this.store.getTask(input.taskId)
    if (!task) {
      return { limitReached: true, reason: `Task 不存在：${input.taskId}` }
    }
    if (task.status === 'accepted') {
      return {
        limitReached: true,
        reason:
          '这个 Task 已经验收通过（accepted），不能再发起审计。' +
          '如果确实需要重新审查，请新建一个 Task。',
      }
    }

    // 检查上限 + 创建 Cycle + 累加计数，必须在同一个事务里完成。
    //
    // 分开做的话，两个并发请求会同时读到 cycles=1、都通过检查、
    // 都创建 #2，maxCycles 被超发，cycleNumber 也重复。
    // 这里交给 Store 的 createReviewCycleAtomic 用 SQLite 事务保证串行。
    const result = this.store.createReviewCycleAtomic({
      taskId: input.taskId,
      skillId: input.skill.id,
      skillVersion: input.skill.version,
      producerRunId: input.producerRunId,
      skillMaxCycles: input.skill.maxCycles,
    })

    if (!result.ok) {
      return { limitReached: true, reason: result.reason }
    }
    return result.cycle
  }

  /**
   * 对某个 Cycle 执行审计。
   *
   * 前置：Producer Run 已完成并拍过快照、生成过产物。
   */
  async audit(cycleId: string, input: RunAuditInput): Promise<CycleOutcome> {
    const cycle = this.store.getReviewCycle(cycleId)
    if (!cycle) throw new Error(`ReviewCycle 不存在：${cycleId}`)

    const skill = this.resolveSkill(cycle)
    if (!skill) throw new Error(`找不到 Skill：${cycle.skillId}@${cycle.skillVersion}`)

    // ── 产物由 ReviewLoop 自己取并校验归属 ────────────────
    //
    // 不信任调用方传入的 artifacts 数组。
    const artifacts = this.store.listArtifacts(cycle.producerRunId)

    for (const artifact of artifacts) {
      if (artifact.taskId !== cycle.taskId) {
        throw new Error(
          `产物 ${artifact.id} 属于 Task ${artifact.taskId}，与 Cycle 的 Task ${cycle.taskId} 不一致`,
        )
      }
      if (artifact.runId !== cycle.producerRunId) {
        throw new Error(
          `产物 ${artifact.id} 属于 Run ${artifact.runId}，与 Cycle 的 Run ${cycle.producerRunId} 不一致`,
        )
      }
    }

    // ── 定位 Producer 完成时的快照 ────────────────────────
    //
    // 不能用 `find(s => s.kind === 'workspace')`：
    //   · 一个 Run 可能有多个 workspace 快照（中途拍过、恢复过）
    //   · 数组顺序不保证就是时间顺序
    //   · 拿错快照 → 审计的是一份不是最终产物的内容
    //
    // 唯一可靠的依据是 **产物自己记录的 sourceSnapshotId**：
    // 每个可审计产物都必须指向它被创建时的那份快照，
    // 而且所有产物必须指向同一份（否则它们来自不同时刻的工作区）。
    const completionSnapshotId = resolveCompletionSnapshot(artifacts)
    const workspaceSnapshot = completionSnapshotId
      ? this.store.getSnapshot(completionSnapshotId)
      : undefined

    if (!workspaceSnapshot) {
      // 没有可用的完成快照 → 不能审计（不能读变化中的工作区）
      const result: AuditResult = {
        verdict: 'escalate',
        escalateReason: 'no_snapshot',
        blockingIssues: [{
          ruleId: 'audit.snapshot',
          feature: 'no_snapshot',
          severity: 'blocking',
          description:
            '无法确定 Producer 完成时的快照：没有产物，或产物缺少 sourceSnapshotId，' +
            '或产物指向的快照不存在。审计必须基于固定快照，否则不可复现。',
        }],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        binding: buildPartialBinding(cycle, artifacts, 'no_snapshot'),
        summary: '缺少完成快照，审计无法进行',
      }
      const stored = this.store.createAuditResult({ cycleId, taskId: cycle.taskId, result })
      this.store.appendEvent(cycle.producerRunId, 'review.no_snapshot', { cycleId })
      return { kind: 'escalated', audit: stored, cycle, reason: result.summary }
    }

    // 快照归属必须匹配
    if (workspaceSnapshot.runId !== cycle.producerRunId) {
      throw new Error(
        `快照 ${workspaceSnapshot.id} 属于 Run ${workspaceSnapshot.runId}，` +
        `不是本 Cycle 的 Run ${cycle.producerRunId}`,
      )
    }
    if (workspaceSnapshot.taskId !== cycle.taskId) {
      throw new Error(
        `快照 ${workspaceSnapshot.id} 属于 Task ${workspaceSnapshot.taskId}，` +
        `不是本 Cycle 的 Task ${cycle.taskId}`,
      )
    }

    // ── 任务契约：只从数据库读，绝不从调用方拿 ────────────
    //
    // 审计的标准必须是服务端持久化的那一份。
    // 如果接受调用方传进来的 goal/criteria，
    // 「先写一个跑题的产物，再声明任务是『写点东西』」就能过审。
    const taskContract = this.store.getActiveTaskContract(cycle.taskId)
    if (!taskContract) {
      // 没有契约 → 不能审计。
      // 不要退回「只看产物文本」的老路——那正是这次要修的问题。
      const result: AuditResult = {
        verdict: 'escalate',
        escalateReason: 'contract_missing',
        blockingIssues: [{
          ruleId: 'audit.contract',
          feature: 'contract_missing',
          severity: 'blocking',
          description:
            `Task ${cycle.taskId} 没有任务契约，无法审计。` +
            '没有「任务要求完成什么」的定义，任何 pass 都只是对格式的认可，不是对内容的认可。',
          suggestedFix: '先调用 PUT /tasks/:id/contract 定义 goal 与 acceptanceCriteria',
        }],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        binding: buildPartialBinding(cycle, artifacts, 'contract_missing'),
        summary: '任务契约缺失，审计无法进行',
      }
      const stored = this.store.createAuditResult({
        cycleId,
        taskId: cycle.taskId,
        result,
      })
      this.store.appendEvent(cycle.producerRunId, 'review.contract_missing', {
        cycleId,
        taskId: cycle.taskId,
      })
      return { kind: 'escalated', audit: stored, cycle, reason: result.summary }
    }


    const snapshotFiles = await this.config.snapshotManager.listFiles(workspaceSnapshot.ref)
    const snapshotFileSet = new Set(snapshotFiles)

    // 用闭包捕获 manager 与 ref，避免对象字面量里的 this 语义问题
    const manager = this.config.snapshotManager
    const ref = workspaceSnapshot.ref

    const ruleContext: RuleContext = {
      workspaceRoot: this.config.workspaceRoot,
      snapshotRef: ref,
      artifacts,
      readFile: (relPath: string) => manager.readFileAt(ref, relPath),
      listFiles: async () => snapshotFiles,
    }

    // ── 准备上一轮的规则结果，用于回归检测 ────────────────
    const previousChecks = this.previousRuleChecks(cycle)

    // ── 读产物内容，并**重新计算字节 hash** ───────────────
    //
    // 为什么必须重算：
    //   artifact.contentHash 是数据库里的一个字符串。
    //   它可能是：
    //     · 创建产物时算的（正常）
    //     · 被手工 SQL 改过的（攻击）
    //     · 快照被替换后残留的旧值（数据损坏）
    //   只检查「字段非空」或「和 binding 里的值相等」都证明不了
    //   「快照里的字节真的就是这份内容」——binding 也是数据库里的值。
    //
    // 唯一的可信来源是**快照本身**：readFileAt(ref, path) 拿到字节，
    // 现场 sha256，再和 artifact.contentHash 比对。
    const artifactTexts: Array<{ path: string; content: string }> = []
    const hashMismatches: Array<{ artifactId: string; path: string; expected: string; actual: string }> = []
    /** 记录的路径在快照里不存在，或存在但读不出来 */
    const unreadable: Array<{ artifactId: string; path: string; reason: string }> = []

    for (const artifact of artifacts) {
      if (!artifact.path) continue

      // 路径不在快照里 → 必须报告，不能跳过。
      //
      // 旧实现这里是 `continue`：产物被静默排除在审计之外，
      // 但 binding.contentHashes 仍然记着它。于是审计可以拿到一份
      // 「覆盖了一个谁都没看过的产物」的 pass——只要 skill 没装
      // artifact.in_snapshot，这条路径完全没有痕迹。
      //
      // 自定义 skill 不装那条规则是正常配置，所以证据完整性
      // 不能只靠某一条机器规则兜底，必须由编排层自己保证。
      if (!snapshotFileSet.has(artifact.path)) {
        unreadable.push({
          artifactId: artifact.id,
          path: artifact.path,
          reason: '完成快照里不存在这个路径',
        })
        continue
      }

      const content = await this.config.snapshotManager.readFileAt(
        workspaceSnapshot.ref,
        artifact.path,
      )
      if (content === null) {
        // 列得出来却读不出来 —— 快照本身有问题，同样不能当成「没有产物」
        unreadable.push({
          artifactId: artifact.id,
          path: artifact.path,
          reason: '快照列出该路径但读取失败',
        })
        continue
      }

      const actualHash = createHash('sha256').update(content, 'utf8').digest('hex')
      if (artifact.contentHash !== actualHash) {
        hashMismatches.push({
          artifactId: artifact.id,
          path: artifact.path,
          expected: artifact.contentHash ?? '(空)',
          actual: actualHash,
        })
        continue
      }

      artifactTexts.push({ path: artifact.path, content })
    }

    // 内容对不上 → 不能审计。
    //
    // 这比「机器规则不通过」更早：如果连「快照里的字节是不是产物记录的那份」
    // 都无法确认，后面所有判断（包括 reject）都建立在一个错误前提上。
    if (hashMismatches.length > 0) {
      const detail = hashMismatches
        .map((m) => `${m.path}：记录 ${m.expected.slice(0, 12)}，实际 ${m.actual.slice(0, 12)}`)
        .join('；')

      const result: AuditResult = {
        verdict: 'escalate',
        escalateReason: 'artifact_hash_mismatch',
        blockingIssues: [{
          ruleId: 'audit.artifact_hash',
          feature: 'artifact_hash_mismatch',
          severity: 'blocking',
          probability: 1,
          description:
            `产物的 contentHash 与快照里的实际内容不一致：${detail}。` +
            '这可能是数据库被篡改、快照被替换，或产物创建后内容被改过。' +
            '在这种情况下，审计结论无法与任何一份具体内容建立对应关系。',
          suggestedFix: '重新执行 Producer Run 生成新的产物与快照，再审计',
        }],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        binding: buildPartialBinding(cycle, artifacts, 'artifact_hash_mismatch'),
        summary: '产物内容与快照不一致，审计无法进行',
      }
      const stored = this.store.createAuditResult({
        cycleId, taskId: cycle.taskId, result,
      })
      this.store.appendEvent(cycle.producerRunId, 'review.artifact_hash_mismatch', {
        cycleId,
        mismatches: hashMismatches.map((m) => m.path),
      })
      return { kind: 'escalated', audit: stored, cycle, reason: result.summary }
    }

    // ── 预算预留（Auditor 也是模型调用）────────────────────
    //
    // 估算方式：input = 产物文本 + 规则摘要的粗略 token 数，
    //          output = 留给审计结论的空间。
    //
    // 为什么不精确：审计的输入包含全部产物，无法提前精确分词。
    // 但**方向要对**：估高一点，让预算不足在调用前就被拦下，
    // 而不是审完了才发现超支。
    const estimatedAuditInput =
      Math.ceil(
        artifactTexts.reduce((sum, a) => sum + a.content.length, 0) / 3,
      ) + 2000
    const estimatedAuditOutput = 2000

    const auditReservation = this.store.reserveBudget({
      runId: cycle.producerRunId,
      taskId: cycle.taskId,
      purpose: 'auditor',
      inputTokens: estimatedAuditInput,
      outputTokens: estimatedAuditOutput,
      owner: `cycle:${cycleId}`,
      ttlMs: 10 * 60_000,
    })

    if (!auditReservation.ok) {
      this.store.appendEvent(cycle.producerRunId, 'review.budget_blocked', {
        cycleId,
        dimension: auditReservation.dimension,
        reason: auditReservation.reason,
      })
      throw new Error(
        `审计预算不足（${auditReservation.dimension}）：${auditReservation.reason}`,
      )
    }

    // ── 执行审计 ──────────────────────────────────────────
    let outcome: AuditOutcome
    try {
      outcome = await runAudit({
        skill,
        artifacts,
        // 服务端读出的契约。runAudit 会再校验一次完整性（fail-closed）。
        taskContract,
        cycleId,
        // 把快照传给审计，写进 binding —— 验收时会核对这个绑定
        snapshot: { id: workspaceSnapshot.id, ref: workspaceSnapshot.ref },
        ruleContext,
        previousChecks,
        producerModel: input.producerModel,
        auditorModel: input.auditorModel,
        auditorProvider: input.auditorProvider,
        artifactTexts,
        // 快照里读不到的产物。
        //
        // 为什么不在这里直接 escalate：装了 artifact.in_snapshot 的 skill
        // 会对「路径不在快照里」给出明确的 reject——那是「交付不合格」的
        // 确定性结论，不该被编排层降级成「不确定」。
        // 所以交给 runAudit 在**机器规则之后**兜底：
        //   规则命中 → reject（明确否定）
        //   规则未覆盖 → escalate（无法证明）
        unreadableArtifacts: unreadable.map((u) => ({ path: u.path, reason: u.reason })),
        signal: input.signal,
        adapterResolver: input.adapterResolver,
      })
    } catch (err) {
      // 审计失败 → 释放预留（没有可计量的成功用量）
      this.store.releaseBudget(auditReservation.reservationId, { owner: `cycle:${cycleId}` })
      throw err
    }

    // 按实际用量结算。
    // costKnown 必须如实传：审计模型没配价格时，「不知道花了多少」
    // 不能被写成「花了 0 元」。
    this.store.settleBudget(auditReservation.reservationId, {
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      costUsd: outcome.usage?.costUsd ?? 0,
      costKnown: outcome.usage?.costKnown ?? false,
    }, { owner: `cycle:${cycleId}` })

    const stored = this.store.createAuditResult({
      cycleId,
      taskId: cycle.taskId,
      result: outcome.result,
    })

    this.store.appendEvent(cycle.producerRunId, 'review.audited', {
      cycleId,
      auditId: stored.id,
      verdict: outcome.result.verdict,
      degraded: outcome.degraded,
    })

    switch (outcome.result.verdict) {
      case 'pass':
        return { kind: 'passed', audit: stored, cycle }

      case 'reject': {
        const brief: ReworkBrief = {
          cycleNumber: cycle.cycleNumber,
          blockingIssues: outcome.result.blockingIssues,
          // 冻结的是标准（规则 id + 版本），不是结果
          frozenRules: outcome.result.checkedRules.map((c) => ({
            ruleId: c.ruleId,
            ruleVersion: c.ruleVersion,
          })),
          previousSummary: outcome.result.summary,
        }
        return { kind: 'rejected', audit: stored, cycle, brief }
      }

      case 'escalate':
        return { kind: 'escalated', audit: stored, cycle, reason: outcome.result.summary }
    }
  }

  /**
   * 推导 Cycle 的当前状态。
   *
   * 不存独立 status 字段——由关联对象推导，避免事实分裂。
   */
  deriveStatus(cycleId: string): string {
    const cycle = this.store.getReviewCycle(cycleId)
    if (!cycle) return 'unknown'

    if (!cycle.auditResultId) {
      // 还没审计：看 producer run 的状态
      const run = this.store.getRun(cycle.producerRunId)
      if (!run) return 'unknown'
      if (run.status === 'running') return 'producing'
      if (run.status === 'waiting_approval') return 'waiting_approval'
      if (run.status === 'completed') return 'checking'
      return `producer_${run.status}`
    }

    const results = this.store.listAuditResults(cycle.taskId)
    const audit = results.find((r) => r.id === cycle.auditResultId)
    if (!audit) return 'unknown'

    switch (audit.verdict) {
      case 'pass':
        return 'passed'
      case 'reject':
        return 'rework_required'
      case 'escalate':
        return 'escalated'
    }
  }

  /** 生成返工说明，供下一轮 Producer 使用。 */
  buildReworkPrompt(brief: ReworkBrief): string {
    const lines = [
      '## 返工要求',
      '',
      `这是第 ${brief.cycleNumber} 轮返工。上一轮的审计结论：`,
      brief.previousSummary,
      '',
      '### 必须解决的问题',
    ]
    for (const issue of brief.blockingIssues) {
      lines.push(`- [${issue.feature}] ${issue.description}`)
      if (issue.location) lines.push(`  位置：${issue.location}`)
      if (issue.evidence) lines.push(`  证据：${issue.evidence}`)
      if (issue.suggestedFix) lines.push(`  建议：${issue.suggestedFix}`)
    }
    lines.push('')
    lines.push('### 注意')
    lines.push('以下标准不会因为上一轮通过而降低要求，本轮仍会重新检查全部规则：')
    for (const rule of brief.frozenRules) {
      lines.push(`- ${rule.ruleId} (v${rule.ruleVersion})`)
    }
    return lines.join('\n')
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 上一轮的规则检查结果，用于回归检测。 */
  private previousRuleChecks(cycle: ReviewCycle): RuleCheck[] | undefined {
    if (cycle.cycleNumber <= 1) return undefined
    const results = this.store.listAuditResults(cycle.taskId)
    const previous = results.filter((r) => r.id !== cycle.auditResultId).pop()
    return previous?.result.checkedRules
  }

  private resolveSkill(cycle: ReviewCycle): AuditSkill | undefined {
    // 从**带 manifest 的注册表**取定义。
    //
    // 之前这里是一个裸 Map（只存 AuditSkill）。换成带 manifest 的注册表后，
    // 审计时不仅能拿到行为定义，也能拿到「这个 Skill 声明了需要什么」——
    // 缺少的工具 / 能力在审计开始前就能被拒绝，而不是跑到一半才失败。
    return skillRegistry.get(cycle.skillId, cycle.skillVersion)?.skill
  }
}

/**
 * 全局 Skill 注册表。
 *
 * 保留同名的 registerSkill / getSkill / clearSkills 导出，
 * 使既有调用点（server/app.ts、测试）无需改动；
 * 但底层从裸 Map 换成带 manifest 的注册表，语义更严格：
 *   · manifest 与 skill 的 id / version 必须一致
 *   · 同 id@version 不允许重复注册（重复注册通常是静默覆盖，很危险）
 */
const skillRegistry = new GlobalSkillRegistry()

function defaultManifest(skill: AuditSkill): SkillManifest {
  // 旧调用点只传 AuditSkill，没有 manifest。
  //
  // 这里生成一个**最小但诚实**的 manifest：
  //   requiredTools / requiredCapabilities 为空 = 「没有额外要求」
  //   （不是「不需要工具」，而是「未声明」；需要强约束的 Skill 应显式提供 manifest）
  //   appliesTo 为空 = 适用于全部
  // 不猜它需要什么——猜高了会误拒，猜低了等于没检查。
  return {
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.name,
    requiredTools: [],
    requiredCapabilities: [],
    appliesTo: [],
    requiresHumanAttention: false,
  }
}

/** 注册 Skill。有 manifest 时按 manifest 校验依赖；没有时生成最小 manifest。 */
export function registerSkill(skill: AuditSkill, manifest?: SkillManifest): void {
  skillRegistry.register(manifest ?? defaultManifest(skill), skill)
}

export function getSkill(id: string, version: string): AuditSkill | undefined {
  return skillRegistry.get(id, version)?.skill
}

export function getSkillManifest(id: string, version: string): SkillManifest | undefined {
  return skillRegistry.get(id, version)?.manifest
}

/** 供能力平台与 UI 读取全部已注册 Skill。 */
export function listSkills(): SkillManifest[] {
  return skillRegistry.list()
}

export function clearSkills(): void {
  skillRegistry.clear()
}
