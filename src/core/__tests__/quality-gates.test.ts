// 质量门（区块 6）：证据包完整性、离线 replay、人工裁决。
//
// 这一块测的核心是**fail-closed 不被放宽**：
//   · 篡改任何一部分，verify 必须发现
//   · 审计绑定了旧契约，replay 必须判不通过
//   · 审计没绑定当前产物，replay 必须判不通过
//   · 没有快照，replay 必须判不通过（证据不足不等于通过）
import { describe, it, expect } from 'vitest'
import {
  EVIDENCE_BUNDLE_VERSION,
  buildEvidenceBundle,
  computeBundleHash,
  hashPart,
  inspectBundle,
  replayBundle,
  validateHumanDecision,
  verifyBundle,
  type EvidenceBundle,
} from '../evidence.js'
import { canonicalJson } from '../store.js'

function makeBundle(over: {
  audits?: EvidenceBundle['audits']
  contractHash?: string
  artifactId?: string
  snapshot?: EvidenceBundle['snapshot'] | null
  ruleChecks?: EvidenceBundle['ruleChecks']
} = {}): EvidenceBundle {
  const artifactId = over.artifactId ?? 'a1'
  const contractHash = over.contractHash ?? 'contract-hash-v1'
  const audits: EvidenceBundle['audits'] = over.audits ?? [
    {
      id: 'au1',
      verdict: 'passed',
      boundArtifactIds: [artifactId],
      boundContractHash: contractHash,
      auditorProvider: 'anthropic',
      auditorModel: 'claude-3',
      createdAt: 1,
    },
  ]
  const snapshot =
    over.snapshot === null
      ? undefined
      : over.snapshot ?? {
          id: 's1',
          ref: 'abc123',
          reproducible: true,
          fileCount: 3,
          totalBytes: 100,
        }

  return buildEvidenceBundle({
    taskId: 't1',
    runId: 'r1',
    contract: {
      version: 1,
      hash: contractHash,
      goal: '做一件事',
      acceptanceCriteria: ['能用'],
    },
    artifact: {
      id: artifactId,
      type: 'file',
      path: 'a.md',
      contentHash: 'content-hash',
      status: 'candidate',
      ...(snapshot ? { sourceSnapshotId: snapshot.id } : {}),
    },
    ...(snapshot ? { snapshot } : {}),
    audits,
    ruleChecks: over.ruleChecks ?? [
      { ruleId: 'r1', ruleVersion: '1', passed: true },
    ],
    generatedAt: 1000,
  })
}

describe('证据包完整性（verify）', () => {
  it('刚生成的包通过校验', () => {
    const b = makeBundle()
    const v = verifyBundle(b)
    expect(v.ok).toBe(true)
    expect(v.mismatchedParts).toEqual([])
    expect(v.bundleHashOk).toBe(true)
  })

  it('包版本正确', () => {
    expect(makeBundle().bundleVersion).toBe(EVIDENCE_BUNDLE_VERSION)
  })

  it('篡改产物内容 → 指出被改的是 artifact 部分', () => {
    const b = makeBundle()
    // 注意：如果直接改 artifact 再调用 makeBundle，buildEvidenceBundle
    // 会重新计算哈希，那就不是「篡改」而是「合法的另一个包」。
    // 所以这里必须直接改已生成包的字段。
    const tampered: EvidenceBundle = { ...b, artifact: { ...b.artifact, contentHash: 'evil' } }
    const v = verifyBundle(tampered)
    expect(v.ok).toBe(false)
    // 重算的 artifact 哈希与记录的 partHashes.artifact 不一致
    expect(v.mismatchedParts).toContain('artifact')
    // bundleHash 本身仍然等于 hash(partHashes)——它保护的是 partHashes 不被改。
    // 内容被改但 partHashes 未动时，暴露它的是 mismatchedParts；
    // 两者都改时，暴露它的是 bundleHashOk（见下一个用例）。
    expect(v.bundleHashOk).toBe(true)
  })

  it('篡改契约 → 指出 contract 部分', () => {
    const b = makeBundle()
    const tampered = { ...b, contract: { ...b.contract, goal: '偷偷改目标' } }
    expect(verifyBundle(tampered).mismatchedParts).toContain('contract')
  })

  it('篡改审计结论 → 指出 audits 部分', () => {
    const b = makeBundle()
    const tampered = {
      ...b,
      audits: [{ ...b.audits[0]!, verdict: 'passed' as const, reason: '伪造理由' }],
    }
    expect(verifyBundle(tampered).mismatchedParts).toContain('audits')
  })

  it('同时改内容和哈希 → 整体哈希对不上', () => {
    // 攻击者知道哈希就会想「改内容再改 partHashes」。
    // 这种攻击会在整体哈希上暴露：bundleHash 是 partHashes 的哈希。
    const b = makeBundle()
    const newArtifact = { ...b.artifact, contentHash: 'evil' }
    const partHashes = { ...b.partHashes, artifact: hashPart(newArtifact) }
    const tampered = { ...b, artifact: newArtifact, partHashes }
    const v = verifyBundle(tampered)
    // 各部分都自洽了……
    expect(v.mismatchedParts).toEqual([])
    // ……但整体哈希没跟着改
    expect(v.bundleHashOk).toBe(false)
    expect(v.ok).toBe(false)

    // 连整体哈希一起改才能「自洽」——但那已经是造了一个新包，
    // 而不是篡改原来那个。签名 / 时间戳留痕是这层的补充手段。
    const fullyConsistent = { ...tampered, bundleHash: computeBundleHash(partHashes) }
    expect(verifyBundle(fullyConsistent).ok).toBe(true)
  })

  it('缺少必需字段 → 结构性错误', () => {
    const broken = { ...makeBundle() } as Partial<EvidenceBundle>
    delete broken.partHashes
    const v = verifyBundle(broken as EvidenceBundle)
    expect(v.ok).toBe(false)
    expect(v.structuralErrors.join()).toContain('partHashes')
  })

  it('不支持的包版本被拒绝', () => {
    const b = { ...makeBundle(), bundleVersion: 999 }
    expect(verifyBundle(b).structuralErrors.join()).toContain('不支持')
  })

  // ── P1-8：畸形输入必须是「结构性错误」，不能抛异常 ──────
  //
  // 这个函数会被 HTTP 接口直接调用。任何 TypeError 穿透都会变成 500，
  // 而正确行为是「你给的包不合法」。
  it.each([
    ['null', null],
    ['字符串', 'not-a-bundle'],
    ['数组', [1, 2, 3]],
    ['空对象', {}],
    ['contract 为 null', { ...makeBundle(), contract: null }],
    ['audits 不是数组', { ...makeBundle(), audits: 'x' }],
    ['partHashes 为 null', { ...makeBundle(), partHashes: null }],
    ['bundleHash 是数字', { ...makeBundle(), bundleHash: 42 }],
  ])('畸形输入（%s）不抛异常，返回结构性错误', (_label, input) => {
    let report: ReturnType<typeof verifyBundle> | undefined
    expect(() => {
      report = verifyBundle(input as unknown as EvidenceBundle)
    }).not.toThrow()
    expect(report!.ok).toBe(false)
    expect(report!.structuralErrors.length).toBeGreaterThan(0)
  })

  it('hashPart 与 canonicalJson 口径一致', () => {
    // 证据包的 canonical 实现刻意独立于 store.ts，
    // 但两者必须对同样的输入给出同样结果，否则「同一份内容」会有两个哈希。
    const value = { b: 2, a: [1, { d: 4, c: 3 }] }
    expect(hashPart(value)).toBe(hashPart(JSON.parse(canonicalJson(value)) as unknown))
  })
})

describe('离线 replay', () => {
  it('证据齐全 → would_pass 且与原始结论一致', () => {
    const r = replayBundle(makeBundle())
    expect(r.verdict).toBe('would_pass')
    expect(r.matchesOriginal).toBe(true)
    expect(r.reasons.every((x) => x.ok)).toBe(true)
  })

  it('没有任何审计 → 不通过', () => {
    const r = replayBundle(makeBundle({ audits: [] }))
    expect(r.verdict).toBe('would_fail')
    expect(r.reasons.find((x) => x.rule === 'audit_present')!.ok).toBe(false)
  })

  it('审计绑定了旧契约 → 不通过（契约可能在审计后被改）', () => {
    const b = makeBundle({ contractHash: 'contract-hash-v2' })
    // 模拟真实场景：审计发生时契约是 v1，之后契约改成 v2。
    // 直接把已生成包里的审计绑定改成 v1——不能用 makeBundle 构造，
    // 那会让契约与审计绑定同时变成 v2，等于「审计时契约就是 v2」。
    const stale: EvidenceBundle = {
      ...b,
      audits: [{ ...b.audits[0]!, boundContractHash: 'contract-hash-v1' }],
    }
    const r = replayBundle(stale)
    expect(r.verdict).toBe('would_fail')
    const reason = r.reasons.find((x) => x.rule === 'contract_hash')!
    expect(reason.ok).toBe(false)
    expect(reason.detail).toContain('契约')
  })

  // ── F：两条不同的 passed 审计不能拼接通过 ───────────────
  //
  // 审计要防的正是这种情况：
  //   · 审计 A 看了产物，但当时契约是旧版
  //   · 审计 B 看了新契约，但产物是旧的
  // 两条合起来「产物有人看过、契约也有人看过」，但没有任何一条
  // 真正同时验证过「这份产物 + 这份契约」。

  it('审计 A 绑产物、审计 B 绑契约 → 不能拼接通过', () => {
    const b = makeBundle()
    const patched: EvidenceBundle = {
      ...b,
      audits: [
        {
          id: 'au-A', verdict: 'passed',
          boundArtifactIds: [b.artifact.id],
          boundContractHash: 'contract-hash-OLD',
          auditorProvider: 'p', auditorModel: 'm', createdAt: 1,
        },
        {
          id: 'au-B', verdict: 'passed',
          boundArtifactIds: ['some-other-artifact'],
          boundContractHash: b.contract.hash,
          auditorProvider: 'p', auditorModel: 'm', createdAt: 2,
        },
      ],
    }

    const r = replayBundle(patched)
    expect(r.verdict).toBe('would_fail')
    const reason = r.reasons.find((x) => x.rule === 'audit_binding')!
    expect(reason.ok).toBe(false)
    expect(reason.detail).toContain('同时绑定')
  })

  it('fail 审计 + passed 审计的组合也不能拼接', () => {
    const b = makeBundle()
    const patched: EvidenceBundle = {
      ...b,
      audits: [
        {
          id: 'au-fail', verdict: 'failed',
          boundArtifactIds: [b.artifact.id],
          boundContractHash: b.contract.hash,
          auditorProvider: 'p', auditorModel: 'm', createdAt: 1,
        },
        {
          id: 'au-pass', verdict: 'passed',
          boundArtifactIds: [b.artifact.id],
          // 只差契约：这条 passed 没有契约绑定
          auditorProvider: 'p', auditorModel: 'm', createdAt: 2,
        },
      ],
    }
    expect(replayBundle(patched).verdict).toBe('would_fail')
  })

  it('同一条审计同时绑定产物与契约 → 通过', () => {
    // 对照：单条审计两个条件都满足时正常通过
    expect(replayBundle(makeBundle()).verdict).toBe('would_pass')
  })

  it('passed 审计没有绑定当前产物 → 不通过', () => {
    const b = makeBundle()
    const tampered: EvidenceBundle = {
      ...b,
      audits: [{ ...b.audits[0]!, boundArtifactIds: ['other-artifact'] }],
    }
    // 注意：这里不重新算哈希，因为要测的是 replay 逻辑本身
    const r = replayBundle(tampered)
    expect(r.verdict).toBe('would_fail')
    expect(r.reasons.find((x) => x.rule === 'audit_binding')!.ok).toBe(false)
  })

  it('passed 审计没有契约哈希（部分绑定）→ 不通过', () => {
    const b = makeBundle()
    const partial: EvidenceBundle = {
      ...b,
      audits: [{ ...b.audits[0]!, boundContractHash: undefined }],
    }
    const r = replayBundle(partial)
    expect(r.reasons.find((x) => x.rule === 'contract_hash')!.ok).toBe(false)
    expect(r.verdict).toBe('would_fail')
  })

  it('没有快照 → 证据不足，不通过（不是「无关紧要」）', () => {
    const r = replayBundle(makeBundle({ snapshot: null }))
    expect(r.verdict).toBe('would_fail')
    const reason = r.reasons.find((x) => x.rule === 'snapshot_reproducible')!
    expect(reason.ok).toBe(false)
    expect(reason.detail).toContain('没有来源快照')
  })

  it('快照不可复现且无人工放行 → 不通过', () => {
    const b = makeBundle({
      snapshot: { id: 's1', ref: 'x', reproducible: false, notReproducibleReason: '外部 API', fileCount: 1, totalBytes: 1 },
    })
    const r = replayBundle(b)
    expect(r.verdict).toBe('would_fail')
    expect(r.reasons.find((x) => x.rule === 'snapshot_reproducible')!.detail).toContain('外部 API')
  })

  it('机器规则失败 → 不通过', () => {
    const r = replayBundle(
      makeBundle({ ruleChecks: [{ ruleId: 'lint', ruleVersion: '1', passed: false }] }),
    )
    expect(r.verdict).toBe('would_fail')
    expect(r.reasons.find((x) => x.rule === 'machine_rules')!.detail).toContain('lint')
  })

  // ── P1-7：空规则列表不能 fail-open ──────────────────────
  //
  // `[].every(...)` 为 true，所以旧写法会在「没有任何机器规则证据」时
  // 放行。这是证据系统最危险的一类错误：在缺少证据时给出通过。
  it('没有任何机器规则 → 不通过（不能因为空数组 every 为 true 就放行）', () => {
    const r = replayBundle(makeBundle({ ruleChecks: [] }))
    expect(r.verdict).toBe('would_fail')
    const reason = r.reasons.find((x) => x.rule === 'machine_rules')!
    expect(reason.ok).toBe(false)
    expect(reason.detail).toContain('没有任何机器规则')
  })

  // ── 空规则的显式豁免（设计判断，需可回退）─────────────
  //
  // 单纯「空规则 = 不通过」会误伤纯模型审计（没有可机判规则）。
  // 单纯放行又是 fail-open。折中是**必须显式声明**。

  it('空规则 + 未声明豁免 → 不通过', () => {
    const r = replayBundle(makeBundle({ ruleChecks: [] }))
    expect(r.verdict).toBe('would_fail')
    expect(r.reasons.find((x) => x.rule === 'machine_rules')!.detail).toContain('未声明豁免')
  })

  it('空规则 + 显式声明豁免 → 可以通过，但报告里标明依据不含规则', () => {
    const b = buildEvidenceBundle({
      ...(() => {
        const base = makeBundle()
        return {
          taskId: base.taskId,
          runId: base.runId,
          contract: base.contract,
          artifact: base.artifact,
          snapshot: base.snapshot!,
          audits: base.audits,
        }
      })(),
      ruleChecks: [],
      ruleChecksWaived: true,
    })
    const r = replayBundle(b)
    expect(r.verdict).toBe('would_pass')
    // 关键：豁免是可见的，不是静默通过
    const reason = r.reasons.find((x) => x.rule === 'machine_rules')!
    expect(reason.ok).toBe(true)
    expect(reason.detail).toContain('显式声明豁免')
  })

  it('篡改 ruleChecksWaived 会被完整性校验发现', () => {
    // 如果不把 waived 纳入哈希，攻击者可以给一个有失败规则证据包
    // 加上 waived: true 来绕过 machine_rules 检查——那是静默 fail-open。
    const b = makeBundle({ ruleChecks: [{ ruleId: 'lint', ruleVersion: '1', passed: false }] })
    const forged = { ...b, ruleChecksWaived: true }

    const v = verifyBundle(forged)
    expect(v.ok, '伪造豁免必须被校验发现').toBe(false)
    expect(v.mismatchedParts).toContain('ruleChecks')
  })

  it('几乎没有证据的空包 → 不通过', () => {
    const b = makeBundle({ audits: [], snapshot: null, ruleChecks: [] })
    expect(replayBundle(b).verdict).toBe('would_fail')
    expect(inspectBundle(b).ok).toBe(false)
  })

  it('只有 escalated 的审计 → would_escalate（不是 fail）', () => {
    const b = makeBundle({
      audits: [
        {
          id: 'au1', verdict: 'escalated', reason: 'uncertain',
          boundArtifactIds: ['a1'], auditorProvider: 'demo', auditorModel: '',
          createdAt: 1,
        } as EvidenceBundle['audits'][0],
      ],
    })
    const r = replayBundle(b)
    expect(r.verdict).toBe('would_escalate')
  })

  it('replay 结果可解释：每条规则都有明确的 ok 与说明', () => {
    const r = replayBundle(makeBundle())
    expect(r.reasons.length).toBeGreaterThanOrEqual(6)
    for (const reason of r.reasons) {
      expect(typeof reason.rule).toBe('string')
      expect(reason.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('inspectBundle', () => {
  it('完整且可复现 → ok', () => {
    expect(inspectBundle(makeBundle()).ok).toBe(true)
  })

  it('完整性坏了就不信 replay：ok 为 false', () => {
    const b = makeBundle()
    const tampered = { ...b, artifact: { ...b.artifact, contentHash: 'evil' } }
    const r = inspectBundle(tampered)
    expect(r.verify.ok).toBe(false)
    // replay 本身可能仍然 would_pass（因为 replay 只看审计与绑定）
    // 但 ok 必须为 false——不能拿被篡改的证据去支持通过。
    expect(r.ok).toBe(false)
  })
})

describe('人工裁决', () => {
  it('必须给出 reason', () => {
    expect(() => validateHumanDecision({ decision: 'approve' })).toThrow(/reason/)
    expect(() => validateHumanDecision({ decision: 'approve', reason: '   ' })).toThrow(/reason/)
  })

  it('decision 只能是 approve / reject', () => {
    expect(() => validateHumanDecision({ decision: 'maybe', reason: 'x' })).toThrow(/approve \/ reject/)
    expect(validateHumanDecision({ decision: 'reject', reason: '内容不符' }).decision).toBe('reject')
  })

  it('actor 缺省为 user', () => {
    expect(validateHumanDecision({ decision: 'approve', reason: 'x' }).actor).toBe('user')
    expect(validateHumanDecision({ decision: 'approve', reason: 'x', actor: 'alice' }).actor).toBe('alice')
  })
})
