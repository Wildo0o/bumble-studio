// 证据包服务：从真实数据组装 / 校验 / 重算 / 人工裁决。
//
// 这一层只做「读数据 + 组装」，不做任何写操作。
// 唯一的写是人工裁决，那是独立的、必须留痕的记录。
//
// 为什么组装逻辑放在服务端而不是让客户端自己拼：
//   · 客户端能拼的话，同一份审计可以拼出两个不一样的包
//   · hashes 必须由服务端计算——让客户端提供哈希等于让它自己证明自己
import type { Store } from './store.js'
import type { AuditBinding, AuditResult, StoredAuditResult } from '../shared/types.js'
import {
  buildEvidenceBundle,
  replayBundle,
  verifyBundle,
  type EvidenceArtifact,
  type EvidenceAudit,
  type EvidenceBundle,
  type EvidenceContract,
  type EvidenceSnapshot,
} from './evidence.js'
import { DomainError } from './errors.js'

export interface BuildBundleInput {
  taskId: string
  runId: string
  artifactId: string
}

/**
 * 从存储组装证据包。
 *
 * 每条事实都从**权威表**读，不使用任何缓存的「当时结论」摘要：
 *   · 契约 → task_contract 的 active 版本
 *   · 产物 → artifact 行
 *   · 快照 → artifact.sourceSnapshotId 指向的 snapshot
 *   · 审计 → audit_result 里属于这个 Task 的全部记录
 *   · 机器规则 → 各审计的 checkedRules 汇总（取最严：任一失败即失败）
 */
export function buildBundleFromStore(store: Store, input: BuildBundleInput): EvidenceBundle {
  const task = store.getTask(input.taskId)
  if (!task) throw new DomainError('NOT_FOUND', `任务不存在：${input.taskId}`)

  const run = store.getRun(input.runId)
  if (!run) throw new DomainError('NOT_FOUND', `Run 不存在：${input.runId}`)
  if (run.taskId !== task.id) {
    throw new DomainError(
      'OWNERSHIP_MISMATCH',
      `Run ${run.id} 属于 Task ${run.taskId}，不是 ${task.id}`,
    )
  }

  const artifact = store.getArtifact(input.artifactId)
  if (!artifact) throw new DomainError('NOT_FOUND', `产物不存在：${input.artifactId}`)
  if (artifact.taskId !== task.id) {
    throw new DomainError(
      'OWNERSHIP_MISMATCH',
      `产物属于 Task ${artifact.taskId}，不是 ${task.id}`,
    )
  }
  if (artifact.runId !== run.id) {
    throw new DomainError(
      'OWNERSHIP_MISMATCH',
      `产物属于 Run ${artifact.runId}，不是 ${run.id}`,
    )
  }

  const contract = store.getActiveTaskContract(task.id)
  if (!contract) {
    // 没有契约就没有验收标准。证据包里缺失契约会让 replay 无法判断
    // 「按什么标准通过」，所以这里直接拒绝组装。
    throw new DomainError(
      'CONTRACT_MISMATCH',
      '这个任务没有生效的任务契约，无法生成证据包',
    )
  }

  const evidenceContract: EvidenceContract = {
    version: contract.contractVersion,
    hash: contract.contractHash,
    goal: contract.goal,
    acceptanceCriteria: contract.acceptanceCriteria,
  }

  const evidenceArtifact: EvidenceArtifact = {
    id: artifact.id,
    type: artifact.type,
    status: artifact.status,
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.contentHash ? { contentHash: artifact.contentHash } : {}),
    ...(artifact.sourceSnapshotId ? { sourceSnapshotId: artifact.sourceSnapshotId } : {}),
  }

  let evidenceSnapshot: EvidenceSnapshot | undefined
  if (artifact.sourceSnapshotId) {
    const snap = store.getSnapshot(artifact.sourceSnapshotId)
    if (snap) {
      evidenceSnapshot = {
        id: snap.id,
        ref: snap.ref,
        reproducible: snap.reproducible,
        ...(snap.notReproducibleReason ? { notReproducibleReason: snap.notReproducibleReason } : {}),
        fileCount: snap.fileCount,
        totalBytes: snap.totalBytes,
      }
    }
    // 快照 id 存在但记录不存在：不编造一个空快照，
    // 让 replay 的 snapshot_reproducible 规则自然失败。
  }

  const stored = store.listAuditResults(task.id)
  const audits: EvidenceAudit[] = stored.map((s) => toEvidenceAudit(s))

  // 机器规则汇总：同名规则取**最严**结果。
  //
  // 为什么取最严：两轮审计里第一轮某规则失败、第二轮通过，
  // 说明中间修过。但包描述的是「这个产物的当前状态」，
  // 如果最新一轮通过就应当以最新为准——所以按 ruleId 取**最后一条**记录，
  // 而不是合并成「任一失败即失败」（那会让修复永远无法生效）。
  const latestRule = new Map<string, { ruleId: string; ruleVersion: string; passed: boolean }>()
  for (const s of stored) {
    for (const r of s.result.checkedRules ?? []) {
      latestRule.set(r.ruleId, {
        ruleId: r.ruleId,
        ruleVersion: r.ruleVersion,
        passed: r.status === 'pass',
      })
    }
  }

  return buildEvidenceBundle({
    taskId: task.id,
    runId: run.id,
    contract: evidenceContract,
    artifact: evidenceArtifact,
    ...(evidenceSnapshot ? { snapshot: evidenceSnapshot } : {}),
    audits,
    ruleChecks: [...latestRule.values()],
  })
}

function toEvidenceAudit(s: StoredAuditResult): EvidenceAudit {
  const binding = s.result.binding
  const boundArtifactIds = boundArtifacts(binding)
  const out: EvidenceAudit = {
    id: s.id,
    verdict: mapVerdict(s.result),
    ...(s.result.escalateReason ? { reason: s.result.escalateReason } : {}),
    boundArtifactIds,
    // 审计者身份必须留下：离线证据要能回答「到底是谁审的」。
    //
    // 拿不到时写 'unknown' 而不是空字符串——空字符串看起来像
    // 「字段缺失」，而 unknown 明确表示「记录了但无法确定」。
    auditorProvider: auditorOf(s),
    auditorModel: auditorModelOf(s),
    createdAt: s.createdAt,
  }
  // 只有完整绑定才记录契约哈希：部分绑定意味着审计没校验契约，
  // 把它当成「绑定过了」会让 replay 误判通过。
  if (binding && 'contractHash' in binding && typeof binding.contractHash === 'string') {
    out.boundContractHash = binding.contractHash
  }
  return out
}

/**
 * 审计绑定了哪些产物。
 *
 * 部分绑定（complete: false）返回空数组——那是刻意的：
 * replay 的 audit_binding 规则要求「passed 的审计绑定了当前产物」，
 * 把部分绑定的 artifactIds 当成有效绑定，会让一次没有校验契约的
 * 审计在 replay 里被判成通过。
 */
function boundArtifacts(binding: AuditResult['binding']): string[] {
  if (!binding) return []
  if ('complete' in binding && binding.complete === false) return []
  return (binding as AuditBinding).artifactIds ?? []
}

/**
 * 审计者的 provider。
 *
 * 从审计结果里读**记录下来的**身份，不推断。
 * 拿不到时返回 'unknown' 而不是空字符串——空字符串看起来像
 * 「字段缺失」，而 unknown 明确表示「记录了但无法确定」。
 */
function auditorOf(s: StoredAuditResult): string {
  const r = s.result as { auditor?: { providerId?: string } }
  return r.auditor?.providerId ?? 'unknown'
}

/** 审计者的 model。同样只读记录，不推断。 */
function auditorModelOf(s: StoredAuditResult): string {
  const r = s.result as { auditor?: { modelId?: string } }
  return r.auditor?.modelId ?? ''
}

/** 审计 verdict 到证据包 verdict 的映射。pass 之外都按最保守的方式处理。 */
function mapVerdict(result: AuditResult): EvidenceAudit['verdict'] {
  if (result.verdict === 'pass') return 'passed'
  if (result.verdict === 'escalate') return 'escalated'
  return 'failed'
}

/** 内核可用的完整检查（verify + replay）。 */
export function inspectFromStore(store: Store, input: BuildBundleInput): {
  bundle: EvidenceBundle
  verify: ReturnType<typeof verifyBundle>
  replay: ReturnType<typeof replayBundle>
  ok: boolean
} {
  const bundle = buildBundleFromStore(store, input)
  const verify = verifyBundle(bundle)
  const replay = replayBundle(bundle)
  return { bundle, verify, replay, ok: verify.ok && replay.verdict === 'would_pass' }
}
