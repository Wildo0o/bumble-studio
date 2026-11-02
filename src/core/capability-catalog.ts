// 能力目录。
//
// 一个地方回答三个问题：
//
//   1. 这个 provider + model 能做什么？（ModelCapabilities）
//   2. 当前环境里的工具有哪些、哪些可用？（ToolDefinition 快照）
//   3. 想做一件事（例如「跑一个需要文件写入 + 视觉的审计」）现在可行吗？
//
// 为什么要把它们放在一起：
//   · 之前「能不能跑」的判断散落在 executor（工具存在性）、
//     registry（provider 族匹配）、review-loop（skill 查找）三处，
//     三者对「能力齐全」的口径不同。
//   · 能力目录是**只读快照**，可以在测试里穷举组合，
//     也方便 /meta 接口把「当前能做什么」暴露给 UI。
//
// 关键原则：**能力不足是可报告的失败，不是静默降级。**
//   缺能力时返回具体缺哪一项（CAPABILITY_UNAVAILABLE），
//   而不是「随便找个模型试试」或「跳过这个工具」。
import type {
  ModelCapabilities,
  ModelCapability,
  ToolDefinition,
} from '../shared/types.js'
import { DomainError } from './errors.js'
import type { SkillManifest } from './skill-registry.js'
import { presetFor, providerModelConflict, resolveModelIdentity } from '../providers/registry.js'

/**
 * 每个 provider 预设的**信任能力表**。
 *
 * 只声明能用代码证明的能力，不声明「大概支持」：
 *   · demo 是规则引擎，没有真实语言能力 → 只有 text（且不支持工具调用）
 *   · ollama / lmstudio 是本地 OpenAI 兼容端点 → text / streaming / tool_calling / local
 *   · 云端各家 → text / streaming / tool_calling；视觉只有明确的几家
 *
 * 不写 `structured_output` 给全部云端：JSON schema 约束各家不一致，
 * 声明了却用不了比不声明更糟。
 */
interface ProviderCapabilityProfile {
  capabilities: ModelCapability[]
  local: boolean
  /** 已知的上下文窗口（按模型族覆盖时用 modelOverrides）。 */
  contextWindow?: number
  maxOutputTokens?: number
}

const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilityProfile> = {
  demo: {
    // demo 是本地规则引擎：不需要网络，能力由代码确定。
    // tool_calling 也必须声明——执行内核会用同一套工具轮次跑它，
    // 不声明会让「用 demo provider 跑一次」被能力门挡住。
    capabilities: ['text', 'streaming', 'tool_calling'],
    local: true,
  },
  openai: {
    capabilities: ['text', 'streaming', 'tool_calling', 'vision', 'reasoning', 'long_context', 'structured_output'],
    local: false,
  },
  anthropic: {
    capabilities: ['text', 'streaming', 'tool_calling', 'vision', 'reasoning', 'long_context'],
    local: false,
  },
  deepseek: {
    capabilities: ['text', 'streaming', 'tool_calling', 'reasoning', 'long_context'],
    local: false,
  },
  gemini: {
    capabilities: ['text', 'streaming', 'tool_calling', 'vision', 'reasoning', 'long_context'],
    local: false,
  },
  openrouter: {
    // 聚合平台：能力取决于具体模型，这里只声明「普遍成立」的部分。
    // 具体模型的可信能力由 modelOverrides 或审计阶段的族判断补足。
    capabilities: ['text', 'streaming', 'tool_calling'],
    local: false,
  },
  ollama: {
    capabilities: ['text', 'streaming', 'tool_calling', 'local'],
    local: true,
  },
  lmstudio: {
    capabilities: ['text', 'streaming', 'tool_calling', 'local'],
    local: true,
  },
}

/**
 * 按模型族的覆盖。
 *
 * 用途：同一 provider 下不同族的模型能力不同。
 * 例如 openrouter 上的 claude 有视觉，某个 7B 开源模型没有。
 * 键是 `providerId:模型族`。
 */
const MODEL_FAMILY_CAPABILITIES: Record<string, ModelCapability[]> = {
  'openrouter:anthropic-claude': ['vision', 'long_context', 'reasoning'],
  'openrouter:openai-gpt': ['vision', 'long_context', 'reasoning'],
  'openrouter:google-gemini': ['vision', 'long_context'],
}

/**
 * 解析 provider + model 的能力声明。
 *
 * 流程：
 *   1. 用 resolveModelIdentity 得到**可信身份**（provider / 模型族是否自洽）。
 *      认不出模型族时，能力声明不可信 —— 返回 unknown 而不是猜。
 *   2. 取 provider 档案 + 族覆盖，合成能力列表。
 *
 * 返回值三种：
 *   known     —— 有可信身份和能力表
 *   unknown   —— 认不出模型族（能力未知，调用方必须 fail-closed 或显式降级）
 *   rejected  —— 声明自相矛盾（例如用 openai 跑 claude）
 */
export type CapabilityResolution =
  | { status: 'known'; model: ModelCapabilities }
  | { status: 'unknown'; reason: string }
  | { status: 'rejected'; reason: string }

export function resolveModelCapabilities(
  providerId: string,
  modelId: string,
): CapabilityResolution {
  const preset = presetFor(providerId)
  if (!preset) {
    return { status: 'rejected', reason: `未知服务商：${providerId}` }
  }
  const profile = PROVIDER_CAPABILITIES[providerId]
  if (!profile) {
    // 有预设但没写能力表：不能假装它什么都不会，也不能假装全都会。
    return { status: 'unknown', reason: `服务商 ${providerId} 没有声明能力表` }
  }

  // ── demo 是特例：能力由代码静态确定，与「模型族识别」无关 ──
  //
  // demo provider 是本地规则引擎（不是真实模型），它的能力写在
  // PROVIDER_CAPABILITIES['demo'] 里，不需要也无法通过模型名识别族。
  // 对 demo 走族识别会得到 unknown，从而让所有使用 demo 的执行
  // 都被能力门挡住——那是把「规则引擎」误当成「认不出的模型」。
  if (preset.protocol === 'demo') {
    return {
      status: 'known',
      model: {
        providerId,
        modelId,
        modelFamily: 'demo-rule-engine',
        capabilities: [...profile.capabilities],
        local: profile.local,
      },
    }
  }

  // ── 「知道不对」与「不知道」必须分开 ────────────────────
  //
  //   rejected  = 能证明 provider 与 model 矛盾（例如用 openai 跑 claude）
  //               → 这是请求写错了，应该 400，改参数就能重试
  //   unknown   = 认不出模型族
  //               → 能力无法确认，应该 503 / 不能用
  //
  // 旧实现把两者都归到 unknown，于是「参数写错」被报成
  // 「能力暂不可用，可重试」——客户端会一直重试同一个错误请求。
  const conflict = providerModelConflict(providerId, modelId)
  if (conflict) {
    return { status: 'rejected', reason: conflict }
  }

  const identity = resolveModelIdentity(providerId, modelId)
  if (!identity.ok) {
    return { status: 'unknown', reason: identity.reason }
  }

  const family = identity.identity.modelFamily
  const extra = MODEL_FAMILY_CAPABILITIES[`${providerId}:${family}`] ?? []
  const capabilities = [...new Set([...profile.capabilities, ...extra])]

  const model: ModelCapabilities = {
    providerId,
    modelId,
    modelFamily: family,
    capabilities,
    local: profile.local,
  }
  if (profile.contextWindow !== undefined) model.contextWindow = profile.contextWindow
  if (profile.maxOutputTokens !== undefined) model.maxOutputTokens = profile.maxOutputTokens

  return { status: 'known', model }
}

/** 这个模型（已知能力时）是否具备某项能力。unknown / rejected 一律 false（fail-closed）。 */
export function modelSupports(providerId: string, modelId: string, capability: ModelCapability): boolean {
  const r = resolveModelCapabilities(providerId, modelId)
  return r.status === 'known' && r.model.capabilities.includes(capability)
}

/** 能力检查的结果。 */
export interface CapabilityRequirement {
  capabilities?: ModelCapability[]
  tools?: string[]
  /** 是否要求本地运行（数据不出本机）。 */
  requireLocal?: boolean
}

export interface CapabilityCheck {
  ok: boolean
  /** 缺哪些模型能力 */
  missingCapabilities: ModelCapability[]
  /** 缺哪些工具 */
  missingTools: string[]
  /** 是否需要本地但模型不是本地 */
  localViolated: boolean
  /** 无法确认能力时的原因（认不出模型族之类） */
  unknownReason?: string
}

/**
 * 检查当前环境能否满足一组能力要求。
 *
 * 注意这里的 `tools` 是**工具定义**而不是注册表对象：
 * 能力目录接受快照，方便测试与 UI 复用，也避免能力判断依赖完整的执行栈。
 */
export function checkRequirements(input: {
  providerId: string
  modelId: string
  tools: readonly ToolDefinition[]
  requirement: CapabilityRequirement
}): CapabilityCheck {
  const { providerId, modelId, tools, requirement } = input

  const available = new Set(tools.filter((t) => t.enabled).map((t) => t.id))
  const missingTools = (requirement.tools ?? []).filter((t) => !available.has(t))

  const resolved = resolveModelCapabilities(providerId, modelId)

  if (resolved.status !== 'known') {
    // 能力未知时只能确定「工具缺了」，模型能力一律算不确定：
    // 不能让一个认不出族的模型被当成「全能」通过检查。
    return {
      ok: false,
      missingCapabilities: requirement.capabilities ?? [],
      missingTools,
      localViolated: false,
      unknownReason: resolved.reason,
    }
  }

  const have = new Set(resolved.model.capabilities)
  const missingCapabilities = (requirement.capabilities ?? []).filter((c) => !have.has(c))
  const localViolated = Boolean(requirement.requireLocal) && !resolved.model.local

  return {
    ok: missingTools.length === 0 && missingCapabilities.length === 0 && !localViolated,
    missingCapabilities,
    missingTools,
    localViolated,
  }
}

/** 检查失败时抛出 CAPABILITY_UNAVAILABLE（503，可重试）+ 具体缺项。 */
export function assertRequirements(input: {
  providerId: string
  modelId: string
  tools: readonly ToolDefinition[]
  requirement: CapabilityRequirement
  what?: string
}): void {
  // rejected（声明自相矛盾）是**请求**错误，先于能力检查判定。
  //
  // 用 openai 跑 claude 这类情况改个参数就能重试，返回 503
  // 会让客户端以为「稍后再试」，而重试原请求永远不会成功。
  const resolved = resolveModelCapabilities(input.providerId, input.modelId)
  if (resolved.status === 'rejected') {
    throw new DomainError(
      'INVALID_INPUT',
      `${input.what ?? '当前环境'}：${resolved.reason}`,
      { details: { providerId: input.providerId, modelId: input.modelId } },
    )
  }

  const check = checkRequirements(input)
  if (check.ok) return

  const parts: string[] = []
  if (check.missingTools.length > 0) parts.push(`缺少工具：${check.missingTools.join(', ')}`)
  if (check.missingCapabilities.length > 0) {
    parts.push(`缺少模型能力：${check.missingCapabilities.join(', ')}`)
  }
  if (check.localViolated) parts.push('要求本地模型，但该模型不是本地运行')
  if (check.unknownReason) parts.push(`能力无法确认：${check.unknownReason}`)

  throw new DomainError(
    'CAPABILITY_UNAVAILABLE',
    `${input.what ?? '当前环境'}不满足要求：${parts.join('；')}`,
    {
      details: {
        providerId: input.providerId,
        modelId: input.modelId,
        missingTools: check.missingTools,
        missingCapabilities: check.missingCapabilities,
        localViolated: check.localViolated,
      },
    },
  )
}

/** Skill 的 manifest 转成能力要求。 */
export function requirementForSkill(manifest: SkillManifest): CapabilityRequirement {
  return {
    capabilities: manifest.requiredCapabilities,
    tools: manifest.requiredTools,
  }
}

/**
 * 环境能力快照。给 /meta 与 UI 用。
 *
 * 只报告**声明层面**的事实，不做任何探测（不 ping provider）：
 * 探测会把「网络抖动」混进「能力不足」，而这两者的处理方式不同。
 */
export interface CapabilitySnapshot {
  providers: Array<{
    providerId: string
    capabilities: ModelCapability[]
    local: boolean
    hasProfile: boolean
  }>
  tools: Array<{
    id: string
    riskLevel: string
    sideEffect: string
    cancellable: boolean
    supportsIdempotencyKey: boolean
    enabled: boolean
  }>
}

export function capabilitySnapshot(tools: readonly ToolDefinition[], providerIds: readonly string[]): CapabilitySnapshot {
  return {
    providers: providerIds.map((providerId) => {
      const profile = PROVIDER_CAPABILITIES[providerId]
      return {
        providerId,
        capabilities: profile ? [...profile.capabilities] : [],
        local: profile?.local ?? false,
        hasProfile: profile !== undefined,
      }
    }),
    tools: tools.map((t) => ({
      id: t.id,
      riskLevel: t.riskLevel,
      sideEffect: t.sideEffect ?? 'none',
      cancellable: t.cancellable !== false,
      supportsIdempotencyKey: t.supportsIdempotencyKey === true,
      enabled: t.enabled,
    })),
  }
}

/** 全部已声明能力的 provider id。 */
export function profiledProviderIds(): string[] {
  return Object.keys(PROVIDER_CAPABILITIES)
}
