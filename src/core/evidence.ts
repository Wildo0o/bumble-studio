// 证据包与离线 replay / verify。
//
// 问题：验收结论「这个产物通过审计」依赖一串分散的事实——
//   产物内容、来源快照、审计结论、绑定、契约版本、机器规则结果。
// 它们存在不同表里，随时可能被后续操作改变（新的产物、新的契约版本、
// 更晚的审计）。所以「三个月后有人说这条结论不对」时，
// 无法回答「当时到底看到了什么」。
//
// 证据包（EvidenceBundle）把这些事实**在某个时刻快照下来**，
// 自带内容哈希与整体哈希。之后：
//
//   · verify   —— 重新计算每个部分的哈希，确认包没有被篡改
//   · replay   —— 用包里的事实**重新推导**结论，而不是读当时的结论字段
//
// 两者是不同的东西：
//   verify 回答「包完好吗」
//   replay 回答「如果按现在的规则重算，还是同一个结论吗」
//
// replay 可能会给出**与当时不同**的结论——那正是它的价值：
// 规则变更、发现绑定时漏了契约版本，都会让重算结果不同。
// 这时不是「包坏了」，而是「当时的结论不可再现」，需要人工裁决。
import { createHash } from 'node:crypto'

/** 证据包的稳定格式版本。改动结构必须升版本。 */
export const EVIDENCE_BUNDLE_VERSION = 1

export interface EvidenceArtifact {
  id: string
  type: string
  path?: string
  contentHash?: string
  sourceSnapshotId?: string
  status: string
}

export interface EvidenceSnapshot {
  id: string
  ref: string
  reproducible: boolean
  notReproducibleReason?: string
  fileCount: number
  totalBytes: number
}

export interface EvidenceContract {
  version: number
  hash: string
  goal: string
  acceptanceCriteria: string[]
}

export interface EvidenceAudit {
  id: string
  verdict: 'passed' | 'failed' | 'escalated'
  reason?: string
  /** 审计时绑定的产物 id（必须覆盖当前产物） */
  boundArtifactIds: string[]
  /** 审计时绑定的契约哈希。缺失意味着「审计时没有校验契约」 */
  boundContractHash?: string
  auditorProvider: string
  auditorModel: string
  createdAt: number
}

/** 一个证据包。 */
export interface EvidenceBundle {
  bundleVersion: number
  /** 生成这个包的时刻 */
  generatedAt: number
  taskId: string
  runId: string
  contract: EvidenceContract
  artifact: EvidenceArtifact
  snapshot?: EvidenceSnapshot
  audits: EvidenceAudit[]
  /** 机器规则结果（rule id → passed） */
  ruleChecks: Array<{ ruleId: string; ruleVersion: string; passed: boolean }>
  /**
   * 审计方是否**显式声明**「这次审计不依赖机器规则」。
   *
   * 为什么需要这个字段：
   *   把「空规则 = 不通过」写死后，纯模型审计（没有可机判规则的
   *   场景，例如写一段文案）就永远无法通过 replay。
   *   但直接放行又会 fail-open。
   *
   * 折中：**必须显式声明**。空规则 + 未声明 = 不通过（漏写就等于没证据）；
   * 空规则 + 显式声明 = 允许，但 replay 报告里会标出来，
   * 让人能一眼看到「这次通过的依据不含机器规则」。
   */
  ruleChecksWaived?: boolean
  /** 每个部分的规范化哈希，便于定位「哪一段被改了」 */
  partHashes: Record<string, string>
  /** 整体哈希：partHashes 的规范化拼接 */
  bundleHash: string
}

/**
 * 规范化序列化（键排序）。
 *
 * 与 store.ts 的 canonicalJson 同一口径，但这里不 import 它：
 * 证据包需要能独立验证——依赖一个会演进的内部工具函数，
 * 会让「三年后还能 verify 旧包」变成不可能。
 */
function canonical(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) throw new Error('证据内容不能包含循环引用')
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[k]
      if (child === undefined) continue
      out[k] = walk(child)
    }
    return out
  }
  return JSON.stringify(walk(value))
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 计算某个部分的哈希。 */
export function hashPart(value: unknown): string {
  return sha256Hex(canonical(value))
}

/**
 * 计算整体哈希。
 *
 * 只用 partHashes（而不是重复序列化全部内容）：
 *   这样任何一部分变化都会改变整体哈希，同时 verify 能指出是哪一部分。
 */
export function computeBundleHash(partHashes: Record<string, string>): string {
  return sha256Hex(canonical(partHashes))
}

/** 组装证据包并计算哈希。 */
export function buildEvidenceBundle(
  input: Omit<EvidenceBundle, 'partHashes' | 'bundleHash' | 'bundleVersion' | 'generatedAt'> & {
    generatedAt?: number
  },
): EvidenceBundle {
  const partHashes: Record<string, string> = {
    contract: hashPart(input.contract),
    artifact: hashPart(input.artifact),
    snapshot: input.snapshot ? hashPart(input.snapshot) : 'none',
    audits: hashPart(input.audits),
    // 把 waived 一起哈希进 ruleChecks 部分。
    //
    // 为什么必须：如果没有纳入哈希，攻击者可以给一个「有失败规则」的
    // 证据包加上 ruleChecksWaived: true，绕过 machine_rules 检查——
    // verify 不会发现，replay 会放行。那是静默的 fail-open。
    ruleChecks: hashPart({
      checks: input.ruleChecks,
      waived: input.ruleChecksWaived === true,
    }),
  }
  return {
    bundleVersion: EVIDENCE_BUNDLE_VERSION,
    generatedAt: input.generatedAt ?? Date.now(),
    taskId: input.taskId,
    runId: input.runId,
    contract: input.contract,
    artifact: input.artifact,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    audits: input.audits,
    ruleChecks: input.ruleChecks,
    ...(input.ruleChecksWaived ? { ruleChecksWaived: true } : {}),
    partHashes,
    bundleHash: computeBundleHash(partHashes),
  }
}

// ── verify ────────────────────────────────────────────────

export interface VerifyReport {
  ok: boolean
  /** 被篡改 / 不一致的部分名 */
  mismatchedParts: string[]
  /** 整体哈希是否与内容一致 */
  bundleHashOk: boolean
  /** 结构问题（缺字段、版本不支持） */
  structuralErrors: string[]
}

/**
 * 校验证据包完整性。
 *
 * 逐部分重算哈希，再重算整体哈希。
 * 不抛错而是返回报告：调用方需要知道**哪一部分**不一致。
 */
export function verifyBundle(bundle: EvidenceBundle): VerifyReport {
  const structuralErrors: string[] = []

  // ── 入参本身就是非法值的防御 ──────────────────────────
  //
  // 这个函数会被 HTTP 接口直接调用（客户端上传的包）。如果这里
  // 直接访问 `bundle.contract`，一个 `null` 或字符串就会抛出
  // TypeError，穿透成 500——而那应该是「你给的包不合法」的 400。
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return {
      ok: false,
      mismatchedParts: [],
      bundleHashOk: false,
      structuralErrors: ['证据包必须是对象'],
    }
  }

  if (bundle.bundleVersion !== EVIDENCE_BUNDLE_VERSION) {
    structuralErrors.push(
      `不支持的证据包版本：${typeof bundle.bundleVersion === 'number' ? bundle.bundleVersion : String(bundle.bundleVersion)}（当前支持 ${EVIDENCE_BUNDLE_VERSION}）`,
    )
  }

  for (const key of ['taskId', 'runId', 'contract', 'artifact', 'audits', 'ruleChecks', 'partHashes', 'bundleHash']) {
    if (!(key in (bundle as unknown as Record<string, unknown>))) {
      structuralErrors.push(`缺少必需字段：${key}`)
    }
  }

  // 关键字段类型不对时，后续哈希计算无法进行——直接归为结构性错误，
  // 而不是让 hashPart 去序列化一个 undefined 然后得出一个无意义的结论。
  if (bundle.contract === null || typeof bundle.contract !== 'object') {
    structuralErrors.push('contract 必须是对象')
  }
  if (bundle.artifact === null || typeof bundle.artifact !== 'object') {
    structuralErrors.push('artifact 必须是对象')
  }
  if (!Array.isArray(bundle.audits)) structuralErrors.push('audits 必须是数组')
  if (!Array.isArray(bundle.ruleChecks)) structuralErrors.push('ruleChecks 必须是数组')
  if (bundle.partHashes === null || typeof bundle.partHashes !== 'object' || Array.isArray(bundle.partHashes)) {
    structuralErrors.push('partHashes 必须是对象')
  }
  if (typeof bundle.bundleHash !== 'string') structuralErrors.push('bundleHash 必须是字符串')

  // 结构已经坏了：不再尝试算哈希。
  // 在一个字段缺失的对象上算出的哈希没有任何意义，还会让人误以为
  // 「只有这一处不一致」。
  if (structuralErrors.length > 0) {
    return {
      ok: false,
      mismatchedParts: [],
      bundleHashOk: false,
      structuralErrors,
    }
  }

  const recomputed: Record<string, string> = {
    contract: hashPart(bundle.contract),
    artifact: hashPart(bundle.artifact),
    snapshot: bundle.snapshot ? hashPart(bundle.snapshot) : 'none',
    audits: hashPart(bundle.audits),
    ruleChecks: hashPart({
      checks: bundle.ruleChecks,
      waived: bundle.ruleChecksWaived === true,
    }),
  }

  const mismatchedParts: string[] = []
  for (const [part, hash] of Object.entries(recomputed)) {
    if (bundle.partHashes[part] !== hash) mismatchedParts.push(part)
  }

  const expectedBundle = computeBundleHash(bundle.partHashes)
  const bundleHashOk = bundle.bundleHash === expectedBundle

  return {
    ok: structuralErrors.length === 0 && mismatchedParts.length === 0 && bundleHashOk,
    mismatchedParts,
    bundleHashOk,
    structuralErrors,
  }
}

// ── replay ────────────────────────────────────────────────

export interface ReplayResult {
  /** 重算得到的结论 */
  verdict: 'would_pass' | 'would_fail' | 'would_escalate'
  /** 与包里的原始结论是否一致 */
  matchesOriginal: boolean
  /** 促进 / 阻止通过的逐条理由。可解释性是这里的重点。 */
  reasons: Array<{ ok: boolean; rule: string; detail: string }>
}

/**
 * 用包里的事实**重新推导**结论。
 *
 * 这是 replay，不是「读结论字段」。规则如下（与 AcceptanceService 的
 * fail-closed 口径一致）：
 *
 *   1. 必须有至少一条审计
 *   2. 必须存在 passed 的审计
 *   3. 该 passed 审计必须绑定当前产物
 *   4. 该 passed 审计的契约哈希必须与包里的契约一致
 *   5. 若快照不可复现，必须在包里显式记录（否则视为证据不足）
 *
 * 任何一条不满足都不通过。这比「有没有 passed 字段」严格得多：
 * 一份 passed 但绑定过期的审计，会在这里被判成不可通过。
 */
export function replayBundle(bundle: EvidenceBundle): ReplayResult {
  const reasons: Array<{ ok: boolean; rule: string; detail: string }> = []

  // 入参本身不是对象时直接给结论，不往下走。
  // 这个函数会被 HTTP 接口调用，任何 TypeError 都会变成 500 ——
  // 而「你给的包不合法」应该是可读的结论。
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    reasons.push({ ok: false, rule: 'structure', detail: '证据包必须是对象' })
    return { verdict: 'would_fail', matchesOriginal: false, reasons }
  }
  if (!Array.isArray(bundle.audits) || !Array.isArray(bundle.ruleChecks)) {
    reasons.push({
      ok: false,
      rule: 'structure',
      detail: 'audits 与 ruleChecks 必须是数组',
    })
    return { verdict: 'would_fail', matchesOriginal: false, reasons }
  }

  const hasAudit = bundle.audits.length > 0
  reasons.push({
    ok: hasAudit,
    rule: 'audit_present',
    detail: hasAudit ? `有 ${bundle.audits.length} 条审计记录` : '没有任何审计记录',
  })

  const passed = bundle.audits.filter((a) => a.verdict === 'passed')
  reasons.push({
    ok: passed.length > 0,
    rule: 'audit_passed',
    detail: passed.length > 0
      ? `${passed.length} 条审计结论为 passed`
      : `审计结论为 ${bundle.audits.map((a) => a.verdict).join(' / ') || '无'}`,
  })

  // ── 绑定与契约必须由**同一条**审计同时满足（审计 F）─────
  //
  // 早期写法分别用 `.some()`：
  //   bindingOk  = passed.some(a => a.boundArtifactIds.includes(artifact.id))
  //   contractOk = passed.some(a => a.boundContractHash === contract.hash)
  //
  // 这允许「拼接通过」：
  //   审计 A 绑定了产物（但契约哈希过期）
  //   审计 B 绑定了契约（但产物是旧的）
  //   两条合起来让两个 .some() 都成立 → 放行。
  //
  // 那正是审计要防的情况：没有任何一条审计真正同时看过
  // 「这份产物 + 这份契约」。
  //
  // 现在要求同一条 passed 审计同时满足两个条件。
  const fullyBound = passed.filter(
    (a) =>
      a.boundArtifactIds.includes(bundle.artifact.id) &&
      a.boundContractHash === bundle.contract.hash,
  )

  const bindingOk = fullyBound.length > 0
  reasons.push({
    ok: bindingOk,
    rule: 'audit_binding',
    detail: bindingOk
      ? `审计同时绑定了产物 ${bundle.artifact.id} 与当前契约`
      : `没有 passed 的审计同时绑定产物 ${bundle.artifact.id} 与当前契约版本`,
  })

  // 分开报告哪一项缺失，便于定位——但**通过判定**只认 fullyBound。
  const anyBoundArtifact = passed.some((a) => a.boundArtifactIds.includes(bundle.artifact.id))
  const anyBoundContract = passed.some((a) => a.boundContractHash === bundle.contract.hash)
  reasons.push({
    ok: bindingOk,
    rule: 'contract_hash',
    detail: bindingOk
      ? '审计绑定的契约哈希与包内契约一致'
      : anyBoundContract && !anyBoundArtifact
        ? '有审计绑定了当前契约，但没有一条同时绑定当前产物（不同审计不能拼接）'
        : anyBoundArtifact && !anyBoundContract
          ? '有审计绑定了当前产物，但没有一条同时绑定当前契约（契约可能在审计后被修改）'
          : '没有 passed 的审计绑定当前契约版本',
  })

  // ── 快照 ─────────────────────────────────────────────
  //
  // 用 **真值判断**而不是 `!== undefined`（审计二轮 P1-4）：
  // `snapshot: null` 会被 `!== undefined` 判成「有快照」，
  // 随后访问 .reproducible 抛 TypeError —— 畸形输入穿透成异常，
  // 而不是结构化的「证据不足」。
  const snapshot = bundle.snapshot ?? undefined
  const snapshotOk = snapshot !== undefined ? snapshot.reproducible === true : false
  reasons.push({
    ok: snapshotOk,
    rule: 'snapshot_reproducible',
    detail:
      snapshot === undefined
        ? '证据包里没有来源快照，无法追溯产物来源'
        : snapshotOk
          ? '来源快照可复现'
          : `来源快照不可复现：${snapshot.notReproducibleReason ?? '未说明原因'}`,
  })

  // ── 机器规则 ──────────────────────────────────────────
  //
  // 语义分三种：
  //   有规则且全过     → 通过
  //   有规则但有失败   → 不通过
  //   没有规则         → 只有**显式声明豁免**时才通过
  //
  // 为什么最后一条这么严：`[].every(...)` 为 true，所以旧写法在
  // 「没有任何机器证据」时也会放行——那是证据系统的 fail-open。
  // 而完全禁止空规则又会让纯模型审计无法通过 replay，
  // 所以要求一个显式开关，且 replay 报告里保留可见性。
  const hasMachineRules = bundle.ruleChecks.length > 0
  const waived = bundle.ruleChecksWaived === true
  const machineRulesOk = hasMachineRules
    ? bundle.ruleChecks.every((r) => r.passed)
    : waived
  reasons.push({
    ok: machineRulesOk,
    rule: 'machine_rules',
    detail: hasMachineRules
      ? bundle.ruleChecks.every((r) => r.passed)
        ? `机器规则全部通过（${bundle.ruleChecks.length} 条）`
        : `失败的机器规则：${bundle.ruleChecks.filter((r) => !r.passed).map((r) => r.ruleId).join(', ')}`
      : waived
        ? '没有机器规则，但审计方显式声明豁免（通过依据不含机器可判规则）'
        : '证据包里没有任何机器规则检查结果，且未声明豁免：不能据此判定通过',
  })

  const originalVerdict =
    passed.length > 0 ? 'would_pass' : bundle.audits.some((a) => a.verdict === 'escalated')
      ? 'would_escalate'
      : 'would_fail'

  const allOk = reasons.every((r) => r.ok)
  let verdict: ReplayResult['verdict']
  if (allOk) verdict = 'would_pass'
  else if (bundle.audits.some((a) => a.verdict === 'escalated') && !passed.length) {
    verdict = 'would_escalate'
  } else verdict = 'would_fail'

  return {
    verdict,
    matchesOriginal: verdict === originalVerdict,
    reasons,
  }
}

/**
 * 完整核对：先 verify 完整性，再 replay 结论。
 *
 * 为什么必须合起来做：
 *   · 只 verify：包完好，但可能记录的是一个本该失败的结论
 *   · 只 replay：结论对，但包可能被改过（改了产物哈希但没改 partHashes）
 */
export function inspectBundle(bundle: EvidenceBundle): {
  verify: VerifyReport
  replay: ReplayResult
  /** 两项都通过才为 true */
  ok: boolean
} {
  const verify = verifyBundle(bundle)
  const replay = replayBundle(bundle)
  return {
    verify,
    replay,
    // 完整性坏了就不信 replay 结果——在被篡改的数据上重算没有意义。
    ok: verify.ok && replay.verdict === 'would_pass',
  }
}

// ── 人工裁决 ───────────────────────────────────────────────

export interface HumanDecision {
  id: string
  taskId: string
  artifactId: string
  /** 裁决人 */
  actor: string
  decision: 'approve' | 'reject'
  /** 必须给出理由：例外必须能回答「为什么」 */
  reason: string
  /** 被裁决的对象：转人工的审计，或 replay 不一致的结论 */
  subject: { kind: 'escalated_audit' | 'replay_mismatch'; ref: string }
  createdAt: number
}

export function validateHumanDecision(input: Record<string, unknown>): {
  decision: 'approve' | 'reject'
  reason: string
  actor: string
} {
  const decision = input.decision === 'approve' ? 'approve' : input.decision === 'reject' ? 'reject' : undefined
  if (!decision) throw new Error('decision 只能是 approve / reject')
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) {
    // 没有理由的人工裁决等于「我说了算」，无法审计也无法追溯。
    throw new Error('人工裁决必须提供 reason')
  }
  const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'user'
  return { decision, reason, actor }
}
