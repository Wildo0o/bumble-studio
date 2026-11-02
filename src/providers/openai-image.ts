// OpenAI 兼容的图像生成适配器。
//
// 覆盖 `/v1/images/generations` 这一协议形态（OpenAI 及其大部分兼容实现）。
// 不强行尝试统一所有 provider 的参数差异：
//   · 差异用 minProfile 表达（哪些字段可以安全传）
//   · 认不出的 provider → 不注册适配器（而不是传一堆可能无效的参数）
//
// 安全要点：
//   · 返回的图像内容只作为数据交给上层，不写磁盘——
//     落盘必须走产物 / 快照层，那里才有哈希、配额与清理
//   · 错误消息不透传第三方响应正文（可能含配额、账号信息）
import type { ImageAdapter, GeneratedImage, ImageGenerationRequest } from '../core/media.js'
import { DomainError } from '../core/errors.js'
import { ProviderError, isAbortError } from './types.js'

interface OpenAIImageOptions {
  providerId: string
  baseUrl: string
  apiKey?: string
  /**
   * 是否支持 `size` 参数。
   *
   * 有些兼容实现只接受默认尺寸，传 size 会 400。
   * 这属于「调用方必须知道的事实」，不是可以猜的默认值。
   */
  supportsSize?: boolean
  /** 是否返回 b64_json（否则返回 url，需要再下载一次——这里不支持）。 */
  responseFormat?: 'b64_json' | 'url'
  /** 模型 id。部分实现要求显式传。 */
  model?: string
  timeoutMs?: number
}

export function newOpenAIImageAdapter(options: OpenAIImageOptions): ImageAdapter {
  const timeoutMs = options.timeoutMs ?? 120_000
  const responseFormat = options.responseFormat ?? 'b64_json'

  return {
    providerId: options.providerId,
    async generate(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
      const url = `${options.baseUrl.replace(/\/$/, '')}/images/generations`

      const body: Record<string, unknown> = {
        prompt: request.prompt,
        n: request.n ?? 1,
        response_format: responseFormat,
      }
      if (options.supportsSize && request.size) body.size = request.size
      if (options.model) body.model = options.model

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (err) {
        if (isAbortError(err)) {
          throw new DomainError('CAPABILITY_UNAVAILABLE', '图像生成被取消或超时', {
            details: { providerId: options.providerId },
          })
        }
        throw new DomainError('CAPABILITY_UNAVAILABLE', `图像生成请求失败（${options.providerId}）`, {
          cause: err,
          details: { providerId: options.providerId },
        })
      }

      if (!res.ok) {
        // 只带状态码，不透传第三方正文。
        throw new ProviderError(
          `图像生成被拒绝（${options.providerId}）：HTTP ${res.status}`,
          res.status,
        )
      }

      let json: unknown
      try {
        json = await res.json()
      } catch {
        throw new ProviderError(`图像生成返回了非 JSON 响应（${options.providerId}）`, 502)
      }

      return parseImages(json, responseFormat, options.providerId)
    },
  }
}

function parseImages(
  json: unknown,
  responseFormat: 'b64_json' | 'url',
  providerId: string,
): GeneratedImage[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) {
    throw new ProviderError(`图像生成响应缺少 data 数组（${providerId}）`, 502)
  }

  const out: GeneratedImage[] = []
  for (const item of data) {
    const rec = item as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }
    if (responseFormat === 'b64_json') {
      if (typeof rec.b64_json !== 'string' || !rec.b64_json) continue
      out.push({
        data: rec.b64_json,
        mimeType: 'image/png',
        ...(typeof rec.revised_prompt === 'string' ? { revisedPrompt: rec.revised_prompt } : {}),
      })
    } else {
      // url 形态需要再下载一次。这里**不**自动下载：
      // 那会让服务端去访问一个由第三方指定的地址（SSRF 面），
      // 而且结果不受配额约束。需要时由上层显式实现。
      if (typeof rec.url === 'string' && rec.url) {
        throw new DomainError(
          'CAPABILITY_UNAVAILABLE',
          `图像生成返回的是 URL 而不是内联数据（${providerId}）。` +
          '服务端不自动下载第三方地址，请改用 b64_json 响应格式。',
          { details: { providerId } },
        )
      }
    }
  }

  if (out.length === 0) {
    throw new ProviderError(`图像生成没有返回任何图像（${providerId}）`, 502)
  }
  return out
}
