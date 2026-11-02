import type { ChatMessage, ModelInfo, ProviderConfig, ToolCall } from '../shared/types.js'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  provider: ProviderConfig
  model: ModelInfo
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature?: number
  maxOutputTokens?: number
  signal: AbortSignal
}

export interface StreamHandlers {
  onText(delta: string): void
  onReasoning(delta: string): void
  /** 工具调用参数增量（流式） */
  onToolCallDelta?(index: number, id: string | undefined, name: string | undefined, argsDelta: string): void
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  servedBy?: string
  notice?: string
}

export interface ProviderAdapter {
  stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>
}

export class ProviderError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted')
}

export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}
