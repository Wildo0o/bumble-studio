// 用例 G：审计协议（P1-A 验收）
//
// 验证 v0.3 §11.2 的三条硬规则：
//   1. 机器规则先跑，失败短路（不调用模型）
//   2. 模型 verdict 只能否决，不能单方面放行
//   3. Producer 与 Auditor 必须不同模型族
// 以及：
//   4. 审计输出无法解析时不能默认通过
//   5. 回归检测
//   6. weak 规则下模型 pass 不能单独放行
import { describe, it, expect, vi } from 'vitest'
import type { Artifact, AuditSkill, RuleContext } from '../../shared/types.js'
import type { ProviderAdapter } from '../../providers/types.js'
import {
  runAudit,
  sameModelFamily,
  modelFamily,
  BUILTIN_RULES,
} from '../audit.js'
import { makeContract } from './helpers.js'

// ── 测试辅助 ─────────────────────────────────────────────

function makeArtifact(path: string, hash = 'h'): Artifact {
  return {
    id: `art-${path}`,
    taskId: 't1',
    runId: 'r1',
    type: 'file',
    path,
    contentHash: hash,
    sourceSnapshotId: 'snap1',
    version: 1,
    status: 'candidate',
    createdAt: Date.now(),
  }
}

function makeContext(files: Record<string, string>, artifacts: Artifact[]): RuleContext {
  return {
    workspaceRoot: '/ws',
    snapshotRef: 'snap1',
    artifacts,
    async readFile(relPath) {
      return files[relPath] ?? null
    },
    async listFiles() {
      return Object.keys(files)
    },
  }
}

/** 一个可控的假 Auditor。按预设返回文本。 */
function fakeAdapter(text: string): ProviderAdapter {
  return {
    async stream() {
      return { text, toolCalls: [], inputTokens: 10, outputTokens: 5 }
    },
  }
}

function makeSkill(overrides: Partial<AuditSkill> = {}): AuditSkill {
  return {
    id: 'skill.test',
    version: '1',
    name: '测试技能',
    machineRules: [BUILTIN_RULES.artifactNotEmpty, BUILTIN_RULES.artifactInSnapshot],
    auditorInstructions: '你是审计者',
    maxCycles: 2,
    ...overrides,
  }
}

const baseInput = {
  producerModel: 'deepseek-chat',
  auditorModel: 'claude-sonnet-5-5',
  auditorProvider: { presetId: 'anthropic' },
  signal: new AbortController().signal,
  // 完整绑定要求快照与 cycleId。这个文件测的是 verdict 合并逻辑，
  // 不是绑定校验，所以夹具给出合法的最小完整输入。
  cycleId: 'cycle-t1',
  snapshot: { id: 'snap1', ref: 'ref1' },
}

// ── 测试 ─────────────────────────────────────────────────

describe('用例 G：审计协议', () => {
  describe('模型族判定', () => {
    it('能识别主流模型族', () => {
      expect(modelFamily('claude-sonnet-5-5')).toBe('anthropic-claude')
      expect(modelFamily('gpt-5')).toBe('openai-gpt')
      expect(modelFamily('o3-mini')).toBe('openai-gpt')
      expect(modelFamily('gemini-2.5-pro')).toBe('google-gemini')
      expect(modelFamily('deepseek-chat')).toBe('deepseek')
    })

    it('同族判定', () => {
      expect(sameModelFamily('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(true)
      expect(sameModelFamily('claude-sonnet-5-5', 'gpt-5')).toBe(false)
      expect(sameModelFamily('deepseek-chat', 'deepseek-reasoner')).toBe(true)
    })
  })

  describe('规则 1：机器规则先跑，失败短路', () => {
    it('机器规则失败时不调用模型', async () => {
      const streamSpy = vi.fn()
      const adapter: ProviderAdapter = {
        async stream(...args) {
          streamSpy(...args)
          return { text: '{"verdict":"pass"}', toolCalls: [] }
        },
      }

      const artifacts = [makeArtifact('a.md', '')]  // contentHash 为空 → not_empty 失败
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': '' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: '' }],
        adapterResolver: () => adapter,
      })

      expect(outcome.result.verdict).toBe('reject')
      // 关键：模型根本没被调用
      expect(streamSpy).not.toHaveBeenCalled()
      expect(outcome.result.summary).toContain('未调用 Auditor')
    })

    it('产物不在快照里时短路', async () => {
      const artifacts = [makeArtifact('missing.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({}, artifacts),  // 快照里没有这个文件
        artifactTexts: [],
        adapterResolver: () => fakeAdapter('{"verdict":"pass"}'),
      })

      expect(outcome.result.verdict).toBe('reject')
      expect(outcome.result.blockingIssues.some((i) => i.ruleId === 'artifact.in_snapshot')).toBe(true)
    })
  })

  describe('规则 2：模型 verdict 只能否决，不能单方面放行', () => {
    it('模型 reject 直接生效', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'content' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'content' }],
        adapterResolver: () =>
          fakeAdapter(JSON.stringify({
            verdict: 'reject',
            confidence: 0.9,
            issues: [{ feature: 'bad_quality', severity: 'blocking', description: '内容空洞' }],
            summary: '不合格',
          })),
      })

      expect(outcome.result.verdict).toBe('reject')
      expect(outcome.result.blockingIssues.some((i) => i.feature === 'bad_quality')).toBe(true)
    })

    it('机器规则全是 weak 时，模型 pass 降级为 escalate', async () => {
      const artifacts = [makeArtifact('a.md')]
      const skill = makeSkill()  // 默认两条规则都是 weak
      expect(skill.machineRules.every((r) => r.strength === 'weak')).toBe(true)

      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill,
        artifacts,
        ruleContext: makeContext({ 'a.md': 'content' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'content' }],
        adapterResolver: () =>
          fakeAdapter(JSON.stringify({
            verdict: 'pass',
            confidence: 0.95,
            issues: [],
            summary: '看起来不错',
          })),
      })

      // 关键：模型说 pass，但因为没有 strong 规则支撑，不能直接通过
      expect(outcome.result.verdict).toBe('escalate')
      expect(outcome.result.summary).toContain('weak')
      expect(outcome.result.summary).toContain('不足以证明质量')
    })

    it('有 strong 规则且全过时，模型 pass 生效', async () => {
      const artifacts = [makeArtifact('data.json')]
      const skill = makeSkill({
        machineRules: [
          BUILTIN_RULES.artifactNotEmpty,
          BUILTIN_RULES.validJson(/\.json$/),   // strong
        ],
      })

      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill,
        artifacts,
        ruleContext: makeContext({ 'data.json': '{"ok":true}' }, artifacts),
        artifactTexts: [{ path: 'data.json', content: '{"ok":true}' }],
        adapterResolver: () =>
          fakeAdapter(JSON.stringify({ verdict: 'pass', confidence: 0.9, issues: [], summary: '通过' })),
      })

      expect(outcome.result.verdict).toBe('pass')
    })

    it('模型输出无法解析时不能默认通过', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () => fakeAdapter('我觉得还行，通过吧'),  // 不是 JSON
      })

      expect(outcome.result.verdict).toBe('escalate')
      expect(outcome.result.blockingIssues.some((i) => i.feature === 'audit_error')).toBe(true)
    })

    it('模型调用失败时不能默认通过', async () => {
      const artifacts = [makeArtifact('a.md')]
      const adapter: ProviderAdapter = {
        async stream() {
          throw new Error('网络超时')
        },
      }
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () => adapter,
      })

      expect(outcome.result.verdict).toBe('escalate')
      expect(outcome.result.summary).toContain('审计调用失败')
    })
  })

  describe('规则 3：模型族隔离', () => {
    it('同族时直接 escalate，不调用模型', async () => {
      const streamSpy = vi.fn()
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        producerModel: 'claude-sonnet-5-5',
        auditorModel: 'claude-opus-5-5',   // 同族
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () => ({
          async stream(...args) {
            streamSpy(...args)
            return { text: '{"verdict":"pass"}', toolCalls: [] }
          },
        }),
      })

      expect(outcome.degraded).toBe(true)
      expect(outcome.result.verdict).toBe('escalate')
      expect(outcome.result.blockingIssues[0]!.feature).toBe('same_model_family')
      expect(outcome.result.blockingIssues[0]!.description).toContain('系统性相关盲区')
      expect(streamSpy).not.toHaveBeenCalled()
    })
  })

  describe('回归检测', () => {
    it('上一轮通过、本轮失败标记为 regression', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({}, artifacts),   // 快照里没有 → in_snapshot 失败
        artifactTexts: [],
        previousChecks: [
          { ruleId: 'artifact.not_empty', ruleVersion: '1', status: 'pass', phase: 'new' },
          { ruleId: 'artifact.in_snapshot', ruleVersion: '1', status: 'pass', phase: 'new' },  // 上轮通过
        ],
        adapterResolver: () => fakeAdapter('{}'),
      })

      expect(outcome.result.regression).toBe(true)
      const regressionIssue = outcome.result.blockingIssues.find((i) => i.feature === 'regression')
      expect(regressionIssue).toBeDefined()
      expect(regressionIssue!.description).toContain('回归')
    })

    it('无回归时不标 regression', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        previousChecks: [
          { ruleId: 'artifact.not_empty', ruleVersion: '1', status: 'pass', phase: 'new' },
        ],
        adapterResolver: () =>
          fakeAdapter('{"verdict":"reject","issues":[],"summary":"x"}'),
      })

      expect(outcome.result.regression).toBeFalsy()
    })
  })

  describe('审计结果的结构化输出', () => {
    it('包含 evidenceRefs 用于可复现', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () =>
          fakeAdapter('{"verdict":"reject","issues":[],"summary":"x"}'),
      })

      expect(outcome.result.evidenceRefs).toContain('art-a.md')
    })

    it('记录每条规则的检查结果与版本', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () =>
          fakeAdapter('{"verdict":"reject","issues":[],"summary":"x"}'),
      })

      expect(outcome.result.checkedRules).toHaveLength(2)
      expect(outcome.result.checkedRules.every((c) => c.ruleVersion === '1')).toBe(true)
      expect(outcome.result.checkedRules.every((c) => c.status === 'pass')).toBe(true)
    })

    it('审计输出支持 Markdown 代码块包裹', async () => {
      const artifacts = [makeArtifact('a.md')]
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill(),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () =>
          fakeAdapter('这是我的结论：\n```json\n{"verdict":"reject","issues":[{"feature":"x","severity":"blocking","description":"有问题"}],"summary":"不行"}\n```'),
      })

      expect(outcome.result.verdict).toBe('reject')
      expect(outcome.result.blockingIssues.some((i) => i.feature === 'x')).toBe(true)
    })

    it('规则执行异常标为 uncertain 而不是 pass', async () => {
      const artifacts = [makeArtifact('a.md')]
      const badRule = {
        id: 'bad.rule',
        version: '1',
        description: '会抛异常',
        strength: 'weak' as const,
        check() {
          throw new Error('规则炸了')
        },
      }
      const outcome = await runAudit({
        taskContract: makeContract(),
        ...baseInput,
        skill: makeSkill({ machineRules: [badRule] }),
        artifacts,
        ruleContext: makeContext({ 'a.md': 'x' }, artifacts),
        artifactTexts: [{ path: 'a.md', content: 'x' }],
        adapterResolver: () =>
          fakeAdapter('{"verdict":"pass","issues":[],"summary":"ok"}'),
      })

      const check = outcome.result.checkedRules[0]!
      expect(check.status).toBe('uncertain')
      expect(check.evidence).toContain('规则执行异常')
    })
  })
})
