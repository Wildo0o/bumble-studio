// OpenAI Chat Completions 适配器（含流式工具调用）。
// 覆盖 OpenAI 及所有兼容实现：Gemini 兼容端点、OpenRouter、Groq、DeepSeek、
// Mistral、xAI、Together、Ollama、LM Studio、vLLM 等。
import type { ChatMessage, ToolCall } from '../shared/types.js'
import { readSSE } from '../core/sse.js'
import {
  ProviderError,
  abortError,
  isAbortError,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter,
  type StreamHandlers,
} from './types.js'

interface ToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: ToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: { message?: string } | string
}

/** 把内部消息格式转成 OpenAI 的 messages 数组。 */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || null }
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }))
      }
      return out
    }
    return { role: m.role, content: m.content }
  })
}

export const openaiAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const { provider, model } = request
    if (!provider.baseUrl) throw new ProviderError(`服务商 ${provider.name} 未配置 baseUrl`)

    const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions'
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toWireMessages(request.messages),
      stream: true,
    }
    if (request.temperature != null) body.temperature = request.temperature
    const tokensParam = provider.maxTokensParam ?? 'none'
    if (tokensParam !== 'none' && request.maxOutputTokens) body[tokensParam] = request.maxOutputTokens
    if (provider.includeUsage) body.stream_options = { include_usage: true }
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
    if (provider.requiresKey && provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      })
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      const reason = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`无法连接 ${provider.baseUrl}：${reason}`)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ProviderError(`${provider.name} 返回 ${response.status}：${text.slice(0, 500)}`, response.status)
    }
    if (!response.body) throw new ProviderError(`${provider.name} 返回了空响应`)

    let text = ''
    const stopReasonRef: { value?: string } = {}
    let inputTokens: number | undefined
    let outputTokens: number | undefined

    // 流式工具调用累积：按 index 分桶，id/name 只取首次，arguments 拼接
    const acc = new Map<number, { id: string; name: string; args: string }>()

    try {
      for await (const event of readSSE(response.body)) {
        if (event.data === '[DONE]') break
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(event.data) as StreamChunk
        } catch {
          continue
        }
        if (chunk.error) {
          const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? '未知错误')
          throw new ProviderError(`${provider.name}: ${message}`)
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta) {
          if (delta.content) {
            text += delta.content
            handlers.onText(delta.content)
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (reasoning) handlers.onReasoning(reasoning)

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0
              let slot = acc.get(index)
              if (!slot) {
                slot = { id: '', name: '', args: '' }
                acc.set(index, slot)
              }
              if (tc.id) slot.id = tc.id
              if (tc.function?.name) slot.name += tc.function.name
              const argsDelta = tc.function?.arguments ?? ''
              if (argsDelta) slot.args += argsDelta
              handlers.onToolCallDelta?.(index, tc.id, tc.function?.name, argsDelta)
            }
          }
        }
        if (choice?.finish_reason) stopReasonRef.value = choice.finish_reason
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }
      }
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      throw err
    }

    const toolCalls: ToolCall[] = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, slot]) => ({
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.args || '{}',
      }))
      .filter((c) => c.name)

    const result: ChatResult = { text, toolCalls, stopReason: stopReasonRef.value, inputTokens, outputTokens }
    if (stopReasonRef.value === 'length') result.notice = '输出达到上限被截断'
    if (stopReasonRef.value === 'content_filter') result.notice = '内容被服务商过滤'
    return result
  },
}
