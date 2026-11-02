// 适配器注册表 + 服务商预设。
//
// 设计：适配器只有 2 个（openai / anthropic 协议），服务商差异用预设表达。
// 新增一个兼容 OpenAI 的服务商 = 加一条预设，不写代码。
import type { ProviderConfig } from '../shared/types.js'
import { anthropicAdapter } from './anthropic.js'
import { demoAdapter } from './demo.js'
import { openaiAdapter } from './openai.js'
import type { ProviderAdapter } from './types.js'

export interface ProviderPreset {
  id: string
  name: string
  /** 决定用哪个适配器 */
  protocol: 'openai' | 'anthropic' | 'demo'
  baseUrl: string
  requiresKey: boolean
  includeUsage?: boolean
  maxTokensParam?: 'none' | 'max_tokens' | 'max_completion_tokens'
  /** 价格（美元 / 百万 token）。留空则成本显示为未知。 */
  pricing?: { input: number; output: number }
  /** 模型 id 过滤正则，用于 /models 列表 */
  modelFilter?: string
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'demo',
    name: '演示模型（无需密钥）',
    protocol: 'demo',
    baseUrl: 'demo://local',
    requiresKey: false,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    includeUsage: true,
    maxTokensParam: 'max_completion_tokens',
    modelFilter: '^(?!.*(embedding|tts|whisper|dall-e|moderation))',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    includeUsage: true,
    maxTokensParam: 'max_tokens',
    pricing: { input: 0.27, output: 1.1 },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    includeUsage: true,
    maxTokensParam: 'max_tokens',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    maxTokensParam: 'max_tokens',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    maxTokensParam: 'max_tokens',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    includeUsage: true,
    maxTokensParam: 'max_tokens',
    modelFilter: '^(?!.*(embedding|aqa|imagen|veo))gemini',
  },
]

const ADAPTERS: Record<'openai' | 'anthropic' | 'demo', ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  demo: demoAdapter,
}

export function adapterFor(protocol: 'openai' | 'anthropic' | 'demo'): ProviderAdapter {
  const adapter = ADAPTERS[protocol]
  if (!adapter) throw new Error(`未知协议：${protocol}`)
  return adapter
}

export function presetFor(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** 把预设实例化成可用配置。apiKey 从调用方传入（来自密钥存储）。 */
export function providerFromPreset(presetId: string, apiKey?: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const preset = presetFor(presetId)
  if (!preset) throw new Error(`未知服务商：${presetId}`)
  return {
    id: preset.id,
    name: preset.name,
    kind: preset.protocol,
    baseUrl: preset.baseUrl,
    requiresKey: preset.requiresKey,
    includeUsage: preset.includeUsage,
    maxTokensParam: preset.maxTokensParam,
    pricing: preset.pricing,
    apiKey,
    ...overrides,
  }
}

/**
 * 每个 provider 允许使用的模型族。
 *
 * 这是**服务端 allowlist**：调用方不能声称「我用 openai 跑 claude」。
 * 名字是信任的起点——如果 provider 和 model 对不上，
 * 后面所有基于模型族的判断（隔离校验）都没有意义。
 */
const PROVIDER_ALLOWED_FAMILIES: Record<string, string[]> = {
  openai: ['openai-gpt'],
  anthropic: ['anthropic-claude'],
  deepseek: ['deepseek'],
  gemini: ['google-gemini'],
  openrouter: [
    'anthropic-claude', 'openai-gpt', 'google-gemini',
    'deepseek', 'meta-llama', 'alibaba-qwen', 'mistral',
  ],
  ollama: [
    'anthropic-claude', 'openai-gpt', 'google-gemini',
    'deepseek', 'meta-llama', 'alibaba-qwen', 'mistral',
  ],
  lmstudio: [
    'anthropic-claude', 'openai-gpt', 'google-gemini',
    'deepseek', 'meta-llama', 'alibaba-qwen', 'mistral',
  ],
  demo: [],
}

/** 模型族判定。与 audit.ts 的 modelFamily 保持一致，但这里不依赖它。 */
function familyOf(modelId: string): string | null {
  const id = modelId.toLowerCase()
  if (/claude/.test(id)) return 'anthropic-claude'
  if (/^(gpt|o1|o3|o4|chatgpt)/.test(id) || /openai/.test(id)) return 'openai-gpt'
  if (/gemini/.test(id)) return 'google-gemini'
  if (/deepseek/.test(id)) return 'deepseek'
  if (/llama/.test(id)) return 'meta-llama'
  if (/qwen/.test(id)) return 'alibaba-qwen'
  if (/mistral|mixtral/.test(id)) return 'mistral'
  return null
}

export interface TrustedModelIdentity {
  providerId: string
  modelId: string
  modelFamily: string
}

/**
 * 把「provider + model」解析成可信身份。
 *
 * 三层校验：
 *   1. provider 必须在 PRESETS 里
 *   2. model 必须能被识别出族（认不出 → 无法证明身份）
 *   3. 该族必须在 provider 的 allowlist 里（不能用 openai 跑 claude）
 *
 * 任一不满足都返回 ok:false —— 调用方必须 fail-closed。
 */
export function resolveModelIdentity(
  providerId: string,
  modelId: string,
): { ok: true; identity: TrustedModelIdentity } | { ok: false; reason: string } {
  const preset = presetFor(providerId)
  if (!preset) {
    return { ok: false, reason: `未知服务商：${providerId}` }
  }

  const family = familyOf(modelId)
  if (!family) {
    return {
      ok: false,
      reason: `无法识别模型 ${modelId} 的族——无法证明它与 Producer 不同族`,
    }
  }

  const allowed = PROVIDER_ALLOWED_FAMILIES[providerId]
  if (!allowed) {
    return { ok: false, reason: `服务商 ${providerId} 没有配置允许的模型族` }
  }
  if (!allowed.includes(family)) {
    return {
      ok: false,
      reason:
        `模型 ${modelId} 属于 ${family}，但服务商 ${providerId} ` +
        `只允许 ${allowed.join(' / ') || '（无）'}。` +
        'provider 与 model 不匹配的声明不可信。',
    }
  }

  return { ok: true, identity: { providerId, modelId, modelFamily: family } }
}

/**
 * provider 与 model **能被证明矛盾**时返回原因，否则返回 null。
 *
 * 与 resolveModelIdentity 的区别是「不知道」和「知道不对」：
 *
 *   · resolveModelIdentity：必须能证明身份才 ok —— 认不出模型就 fail-closed
 *   · 本函数：只在能证明声明是假的时候才拒绝 —— 认不出就放过
 *
 * 为什么要分开：
 *   执行阶段拒绝「认不出的模型」等于禁止所有新模型，产品直接不可用；
 *   而审计阶段对未知族 escalate 已经是 fail-closed 的终点。
 *   执行阶段该管的只有一件事：**声明本身自相矛盾**（用 openai 跑 claude）。
 *   那种情况下模型族是可确定的，隔离校验的前提（名字可信）已经不成立。
 *
 * 三种「无法证明矛盾」的情形都返回 null，不是漏判：
 *   1. provider 不是预设（自定义 / 测试用的假 provider）
 *   2. 预设没有声明 allowlist（demo 就是这种，它忽略 model 字段）
 *   3. 模型族认不出（留给审计按 unknown_model_family escalate）
 */
export function providerModelConflict(providerId: string, modelId: string): string | null {
  const preset = presetFor(providerId)
  if (!preset) return null

  const allowed = PROVIDER_ALLOWED_FAMILIES[providerId]
  // 空数组 = 这个服务商不按模型族声明（demo 是规则引擎，不看 model 字段）
  if (!allowed || allowed.length === 0) return null

  const family = familyOf(modelId)
  if (!family) return null

  if (allowed.includes(family)) return null
  return (
    `模型 ${modelId} 属于 ${family}，但服务商 ${providerId} ` +
    `只允许 ${allowed.join(' / ')}`
  )
}

/**
 * Auditor 是否在服务端 allowlist 内。
 *
 * 比 resolveModelIdentity 更严：demo 一律拒绝——
 * 它不是语言模型，不能作为可验收的审计者。
 */
export function isAllowedAuditor(providerId: string, modelId: string): boolean {
  if (providerId === 'demo' || modelId === 'demo') return false
  const r = resolveModelIdentity(providerId, modelId)
  return r.ok
}

/** 按价格表估算成本（美元）。价格未知时返回 undefined，绝不猜。 */
export function estimateCost(
  provider: ProviderConfig,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (!provider.pricing) return undefined
  if (inputTokens == null && outputTokens == null) return undefined
  const inCost = ((inputTokens ?? 0) / 1_000_000) * provider.pricing.input
  const outCost = ((outputTokens ?? 0) / 1_000_000) * provider.pricing.output
  return inCost + outCost
}
