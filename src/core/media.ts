// 图像模型与本地模型能力接线。
//
// 这两个能力有一个共同点：**它们的「支持」不能靠猜**。
//
//   图像生成：不同 provider 的端点、参数名、返回形状互不相同。
//     声明支持却没有适配器 = 运行时必然失败。
//     所以这里要求「能力声明 + 适配器同时存在」才认为可用。
//
//   本地模型：关键属性不是「快不快」，而是**数据不出本机**。
//     一旦把「本地」标错，用户的代码会被发到云端——
//     这是不可回滚的信息泄露。所以本地判定只认**回环地址 + 预设白名单**，
//     不认模型名，也不认请求体声明。
import type { ModelCapability } from '../shared/types.js'
import { presetFor } from '../providers/registry.js'
import { DomainError } from './errors.js'

// ── 本地模型 ───────────────────────────────────────────────

/**
 * 判断一个地址是否指向本机。
 *
 * 只认回环：
 *   · 127.0.0.0/8
 *   · ::1
 *   · localhost
 *
 * 不认 `0.0.0.0`（那是「监听全部网卡」，不是「本机运行」），
 * 也不认局域网 IP（数据会离开本机）。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost') return true
  if (host === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * provider 是否可信地在本机运行。
 *
 * 两个条件同时成立：
 *   1. 预设声明该 provider 是本地的（例如 ollama / lmstudio）
 *   2. **实际生效的** baseUrl 指向回环
 *
 * 为什么两条都要：
 *   · 只看预设：用户可以覆盖 baseUrl 指向远端，模型就不在本地了
 *   · 只看 baseUrl：随便一个云端 provider 只要写 http://127.0.0.1
 *     就能被冒充成本地（背后可能是转发到云端的代理）
 */
export function isTrustedLocalModel(presetId: string, effectiveBaseUrl: string): boolean {
  const preset = presetFor(presetId)
  if (!preset) return false
  if (preset.protocol === 'demo') return true   // 纯本地规则引擎
  const localPresets = new Set(['ollama', 'lmstudio'])
  if (!localPresets.has(presetId)) return false
  return isLoopbackBaseUrl(effectiveBaseUrl)
}

/**
 * 校验「要求本地」的场景。
 *
 * 不满足时抛 CAPABILITY_UNAVAILABLE，而不是静默换成云端模型——
 * 用户选择本地通常是因为数据不能外传，静默降级等于违背其意愿且不可察觉。
 */
export function assertLocalModel(presetId: string, effectiveBaseUrl: string, what = '当前任务'): void {
  if (isTrustedLocalModel(presetId, effectiveBaseUrl)) return
  throw new DomainError(
    'CAPABILITY_UNAVAILABLE',
    `${what}要求本地模型，但 ${presetId}（${effectiveBaseUrl}）不可信地在本机运行。` +
    '本地判定要求：预设属于本地服务商，且实际 baseUrl 指向回环地址。',
    { details: { presetId, baseUrl: effectiveBaseUrl } },
  )
}

// ── 图像生成 ───────────────────────────────────────────────

/** 图像生成请求。 */
export interface ImageGenerationRequest {
  prompt: string
  /** 输出尺寸，形如 `1024x1024`。不传由 provider 决定。 */
  size?: string
  /** 生成张数。服务端会夹紧上限。 */
  n?: number
  signal?: AbortSignal
}

export interface GeneratedImage {
  /** base64 或 data URL。不写磁盘——落盘由快照/产物层负责。 */
  data: string
  mimeType: string
  /** provider 返回的修订/说明，可选。 */
  revisedPrompt?: string
}

/**
 * 图像生成适配器。
 *
 * 单独一个接口而不是塞进 ProviderAdapter：
 *   · 文本适配器的契约是流式 + 工具调用，与图像完全不同
 *   · 混在一起会让「这个模型能不能出图」变成运行时判断
 */
export interface ImageAdapter {
  readonly providerId: string
  generate(request: ImageGenerationRequest): Promise<GeneratedImage[]>
}

export const MAX_IMAGES_PER_REQUEST = 4

/** 服务端夹紧的生成张数。 */
export function clampImageCount(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 1
  return Math.max(1, Math.min(MAX_IMAGES_PER_REQUEST, Math.trunc(n)))
}

/**
 * 图像能力注册表。
 *
 * 只有「声明了 image_generation 能力」**并且**「注册了适配器」时才可用。
 * 只有一半等于不可用——这是一条 fail-closed 规则：
 * 声明了没实现会让调用方在运行时拿到一个无法解释的失败。
 */
export class ImageCapabilityRegistry {
  private adapters = new Map<string, ImageAdapter>()
  private declared = new Set<string>()

  /** 声明某 provider 具备图像生成能力（来自可信配置，不是请求体）。 */
  declare(providerId: string): void {
    this.declared.add(providerId)
  }

  /** 注册实现。未声明的 provider 也可以注册，但不会被视为可用。 */
  register(adapter: ImageAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      throw new Error(`图像适配器重复注册：${adapter.providerId}`)
    }
    this.adapters.set(adapter.providerId, adapter)
  }

  /** 这个 provider 现在**真的**能出图吗？ */
  isAvailable(providerId: string): boolean {
    return this.declared.has(providerId) && this.adapters.has(providerId)
  }

  /** 可用的 provider 列表。 */
  available(): string[] {
    return [...this.declared].filter((p) => this.adapters.has(p)).sort()
  }

  get(providerId: string): ImageAdapter {
    if (!this.isAvailable(providerId)) {
      throw new DomainError(
        'CAPABILITY_UNAVAILABLE',
        `服务商 ${providerId} 当前不可用于图像生成：` +
        (this.declared.has(providerId) ? '缺少适配器实现' : '未声明图像生成能力'),
        { details: { providerId } },
      )
    }
    return this.adapters.get(providerId)!
  }

  /** 能力声明快照，供 /meta 使用。 */
  describe(): Array<{ providerId: string; declared: boolean; hasAdapter: boolean; available: boolean }> {
    const ids = new Set([...this.declared, ...this.adapters.keys()])
    return [...ids].sort().map((providerId) => ({
      providerId,
      declared: this.declared.has(providerId),
      hasAdapter: this.adapters.has(providerId),
      available: this.isAvailable(providerId),
    }))
  }

  /** 模型能力列表中是否包含图像生成（与上面的可用性判断互补）。 */
  static listsImageGeneration(capabilities: ModelCapability[]): boolean {
    return capabilities.includes('image_generation')
  }
}

/** 校验图像请求的基本形状。 */
export function validateImageRequest(input: Record<string, unknown>): ImageGenerationRequest {
  const prompt = input.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new DomainError('INVALID_INPUT', '图像生成需要非空的 prompt')
  }
  // prompt 长度上限：超长 prompt 会直接变成超预算的调用。
  const MAX_PROMPT = 4000
  if (prompt.length > MAX_PROMPT) {
    throw new DomainError('INVALID_INPUT', `prompt 超过 ${MAX_PROMPT} 字符上限`)
  }

  const req: ImageGenerationRequest = { prompt }
  if (input.size !== undefined) {
    if (typeof input.size !== 'string' || !/^\d{1,5}x\d{1,5}$/.test(input.size)) {
      throw new DomainError('INVALID_INPUT', 'size 必须形如 1024x1024')
    }
    req.size = input.size
  }
  if (input.n !== undefined) {
    if (typeof input.n !== 'number' || !Number.isFinite(input.n) || input.n < 1) {
      throw new DomainError('INVALID_INPUT', 'n 必须是 >= 1 的数字')
    }
    req.n = clampImageCount(input.n)
  }
  return req
}
