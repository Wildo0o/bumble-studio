// Skill 注册表。
//
// 之前的实现是 review-loop.ts 里的一个 Map：
//   · 只在进程内、只按 `id@version` 存，没有 manifest（适用范围、所需能力）
//   · 没有「这个 Skill 需要哪些工具 / 模型能力」的声明
//   · 换掉注册表时会影响 review-loop 的导入
//
// 这里把它升级为**带 manifest 的注册表**：
//
//   manifest 回答「这个 Skill 需要什么才能跑」：
//     · requiredTools        缺工具时应该在审计开始前就拒绝，
//                            而不是跑到一半才发现工具不存在
//     · requiredCapabilities 需要的能力（图像 / 推理 / 长上下文）
//     · appliesTo           适用范围（只用于某类产物）
//
// 与能力目录（capability-catalog.ts）配合：
//   注册时校验 manifest 本身自洽；运行时由调用方用能力目录做可用性检查。
//   两者分开，因为「Skill 声明了什么」和「当前环境有什么」是两件事。
import type { AuditSkill, ModelCapability, ToolDefinition } from '../shared/types.js'

/** Skill 的声明式清单。与 AuditSkill 分离：manifest 描述依赖，AuditSkill 描述行为。 */
export interface SkillManifest {
  id: string
  version: string
  name: string
  description: string
  /** 跑这个 Skill 必须存在的工具 id。 */
  requiredTools: string[]
  /** 必须被 provider / 模型声明支持的能力。 */
  requiredCapabilities: ModelCapability[]
  /** 适用的产物类型。空数组表示适用于全部。 */
  appliesTo: string[]
  /** 需要人工关注（例如高风险领域的审计）。UI 据此高亮。 */
  requiresHumanAttention: boolean
}

export interface RegisteredSkill {
  manifest: SkillManifest
  /** 行为定义。manifest 决定「能不能跑」，skill 决定「跑什么」。 */
  skill: AuditSkill
}

export class SkillRegistry {
  private skills = new Map<string, RegisteredSkill>()

  constructor(skills: Array<{ manifest: SkillManifest; skill: AuditSkill }> = []) {
    for (const s of skills) this.register(s.manifest, s.skill)
  }

  /**
   * 注册一个 Skill。
   *
   * 校验（都在注册时完成，fail-fast）：
   *   1. manifest.id / skill.id 必须一致 —— 否则 `get(id)` 拿到的和
   *      审计时记录的不是同一个东西
   *   2. manifest.version / skill.version 必须一致 —— 审计记录里存的是
   *      `id@version`，版本对不上等于审计结论无法复现
   *   3. 同一个 `id@version` 不能注册两次
   */
  register(manifest: SkillManifest, skill: AuditSkill): void {
    if (!manifest.id.trim()) throw new Error('Skill manifest 必须提供 id')
    if (manifest.id !== skill.id) {
      throw new Error(
        `Skill id 不一致：manifest='${manifest.id}'，skill='${skill.id}'。` +
        '两者必须相同，否则按 id 查找会拿到与审计记录不符的定义。',
      )
    }
    if (manifest.version !== skill.version) {
      throw new Error(
        `Skill 版本不一致：manifest='${manifest.version}'，skill='${skill.version}'。` +
        '审计记录按 id@version 引用，版本对不上就无法复现结论。',
      )
    }
    if (!manifest.version.trim()) throw new Error('Skill manifest 必须提供 version')

    const key = skillKey(manifest.id, manifest.version)
    const existing = this.skills.get(key)
    if (existing) {
      // 重复注册同一个 id@version 视为幂等，而不是错误。
      //
      // 为什么改：注册表是**模块级单例**，而测试与服务实例会反复初始化。
      // 同一个 Skill 定义被注册两次是完全正常的事，抛错只会让
      // 「新建一个服务」这种常规操作失败。
      //
      // 但**同名不同内容**必须拒绝：那意味着两个不同的定义抢同一个
      // id@version，审计记录按 id@version 引用，结果无法确定。
      if (!sameSkill(existing.skill, skill)) {
        throw new Error(
          `Skill ${key} 已被不同的定义注册。` +
          '同一个 id@version 必须对应唯一的行为定义，否则审计结论无法复现。',
        )
      }
      return
    }
    this.skills.set(key, { manifest: { ...manifest }, skill })
  }

  get(id: string, version: string): RegisteredSkill | undefined {
    return this.skills.get(skillKey(id, version))
  }

  /** 某个 id 的全部版本，新的在前（按语义化版本的字符串序，与 task_contract 一致）。 */
  versionsOf(id: string): RegisteredSkill[] {
    return [...this.skills.values()]
      .filter((s) => s.manifest.id === id)
      .sort((a, b) => compareVersion(b.manifest.version, a.manifest.version))
  }

  /** 某个 id 的最新版本。 */
  latest(id: string): RegisteredSkill | undefined {
    return this.versionsOf(id)[0]
  }

  list(): SkillManifest[] {
    return [...this.skills.values()].map((s) => s.manifest)
  }

  clear(): void {
    this.skills.clear()
  }

  get size(): number {
    return this.skills.size
  }
}

/**
 * 两个 Skill 定义是否等价。
 *
 * 用结构化序列化比较行为相关字段，而不是对象引用：
 * 调用方每次可能构造新对象，但语义相同就应该视为同一个 Skill。
 * 规则按 id 排序后再序列化，避免顺序差异造成误判。
 */
function sameSkill(a: AuditSkill, b: AuditSkill): boolean {
  const norm = (s: AuditSkill): string =>
    JSON.stringify({
      id: s.id,
      version: s.version,
      name: s.name,
      instructions: s.auditorInstructions,
      maxCycles: s.maxCycles,
      rules: [...s.machineRules]
        .map((r) => JSON.stringify(r))
        .sort(),
    })
  return norm(a) === norm(b)
}

function skillKey(id: string, version: string): string {
  return `${id}@${version}`
}

/** 粗略比较版本：数字段按数值，其余按字符串。与契约版本排序口径一致。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 全局注册表：与旧 review-loop 的 SKILL_REGISTRY 并存，供迁移期使用。 */
export const globalSkillRegistry = new SkillRegistry()
