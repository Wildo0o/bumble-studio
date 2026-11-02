// Anthropic Messages API 适配器。
//
// 与 OpenAI 协议的主要差异（这里是踩坑点）：
//   1. system 不是消息，是顶层字段
//   2. 消息角色只能 user / assistant，工具结果要包成 user 里的 tool_result block
//   3. 同角色连续会报错，必须合并
//   4. 工具调用的参数是流式的 input_json_delta，要按 content block index 累积
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

type WireBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface WireTurn {
  role: 'user' | 'assistant'
  content: WireBlock[]
}

interface StreamEvent {
  type: string
  index?: number
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  content_block?: { type?: string; id?: string; name?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

/**
 * 内部消息 → Anthropic wire 格式。
 *
 * 关键：tool_result 必须紧跟在带 tool_use 的 assistant 之后，且同属一条 user 消息。
 * 如果连续多个工具结果，它们要合并进同一个 user turn 的多个 block。
 */
function toWire(messages: ChatMessage[]): { system?: string; turns: WireTurn[] } {
  const systemChunks: string[] = []
  const turns: WireTurn[] = []

  const append = (role: 'user' | 'assistant', blocks: WireBlock[]): void => {
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }

  for (const m of messages) {
    switch (m.role) {
      case 'system':
        systemChunks.push(m.content)
        break

      case 'user':
        append('user', [{ type: 'text', text: m.content || '(空)' }])
        break

      case 'assistant': {
        const blocks: WireBlock[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const call of m.toolCalls ?? []) {
          let parsed: unknown
          try {
            parsed = JSON.parse(call.arguments)
          } catch {
            parsed = {}
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parsed })
        }
        // Anthropic 不接受空 content
        append('assistant', blocks.length ? blocks : [{ type: 'text', text: '(无内容)' }])
        break
      }

      case 'tool':
        append('user', [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
            ...(m.isError ? { is_error: true } : {}),
          },
        ])
        break
    }
  }

  return {
    system: systemChunks.length ? systemChunks.join('\n\n') : undefined,
    turns,
  }
}

export const anthropicAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const { provider, model } = request
    if (!provider.baseUrl) throw new ProviderError(`服务商 ${provider.name} 未配置 baseUrl`)

    const { system, turns } = toWire(request.messages)

    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: request.maxOutputTokens ?? 4096,
      stream: true,
      messages: turns,
    }
    if (system) body.system = system
    if (request.temperature != null) body.temperature = request.temperature
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    }
    if (provider.requiresKey && provider.apiKey) headers['x-api-key'] = provider.apiKey

    const url = provider.baseUrl.replace(/\/+$/, '') + '/v1/messages'

    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.signal })
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      const reason = err instanceof Error ? err.message : String(err)
      throw new ProviderError(`无法连接 ${provider.baseUrl}：${reason}`)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new ProviderError(`${provider.name} 返回 ${response.status}：${detail.slice(0, 500)}`, response.status)
    }
    if (!response.body) throw new ProviderError(`${provider.name} 返回了空响应`)

    let text = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let stopReason: string | undefined
    const toolSlots = new Map<number, { id: string; name: string; json: string }>()

    try {
      for await (const event of readSSE(response.body)) {
        let ev: StreamEvent
        try {
          ev = JSON.parse(event.data) as StreamEvent
        } catch {
          continue
        }

        switch (ev.type) {
          case 'error':
            throw new ProviderError(`${provider.name}: ${ev.error?.message ?? '未知错误'}`)

          case 'message_start':
            inputTokens = ev.message?.usage?.input_tokens
            break

          case 'content_block_start':
            if (ev.content_block?.type === 'tool_use' && typeof ev.index === 'number') {
              toolSlots.set(ev.index, {
                id: ev.content_block.id ?? `tool_${ev.index}`,
                name: ev.content_block.name ?? '',
                json: '',
              })
            }
            break

          case 'content_block_delta': {
            const d = ev.delta
            if (!d) break
            if (d.type === 'text_delta' && d.text) {
              text += d.text
              handlers.onText(d.text)
            } else if (d.type === 'thinking_delta' && d.thinking) {
              handlers.onReasoning(d.thinking)
            } else if (d.type === 'input_json_delta' && typeof ev.index === 'number') {
              const slot = toolSlots.get(ev.index)
              if (slot) {
                const fragment = d.partial_json ?? ''
                slot.json += fragment
                handlers.onToolCallDelta?.(ev.index, undefined, undefined, fragment)
              }
            }
            break
          }

          case 'message_delta':
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
            if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens
            break
        }
      }
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) throw abortError()
      throw err
    }

    const toolCalls: ToolCall[] = [...toolSlots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({ id: slot.id, name: slot.name, arguments: slot.json || '{}' }))
      .filter((c) => c.name.length > 0)

    const result: ChatResult = { text, toolCalls, stopReason, inputTokens, outputTokens }
    if (stopReason === 'max_tokens') result.notice = '输出达到上限被截断'
    if (stopReason === 'refusal') result.notice = '模型拒绝回答'
    return result
  },
}
