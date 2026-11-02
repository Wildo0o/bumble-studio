// 测试用的假模型。不需要网络，不需要密钥。
//
// 它按预设脚本依次返回响应，从而让测试可以精确控制
// 「模型第 N 轮做什么」——这是验证工具循环的唯一可靠办法。
import type { ChatMessage, TaskContract, ToolCall } from '../../shared/types.js'
import type { ChatRequest, ChatResult, StreamHandlers } from '../../providers/types.js'
import { buildContractContent } from '../task-contract.js'

export interface ScriptedTurn {
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  inputTokens?: number
  outputTokens?: number
  /** 模拟请求失败 */
  error?: string
  /** 模拟超时：永远不返回 */
  hang?: boolean
}

export class ScriptedProvider {
  private cursor = 0
  readonly calls: ChatRequest[] = []

  constructor(private script: ScriptedTurn[]) {}

  get turnCount(): number {
    return this.calls.length
  }

  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    this.calls.push(request)
    const turn = this.script[this.cursor]
    this.cursor++

    if (!turn) throw new Error(`脚本已用尽（第 ${this.cursor} 次调用）`)
    if (turn.hang) {
      // 必须真的监听 abort——注释写了「靠 AbortSignal 中断」，
      // 但之前只写了永不 resolve 的 Promise，abort 根本不会让它退出。
      // 结果依赖 hang 的测试只能靠超时失败。
      await new Promise<void>((_, reject) => {
        const signal = request.signal
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        )
      })
    }
    if (turn.error) throw new Error(turn.error)

    if (turn.text) handlers.onText(turn.text)

    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((tc, i) => ({
      id: `call_${this.cursor}_${i}`,
      name: tc.name,
      arguments: JSON.stringify(tc.args),
    }))

    return {
      text: turn.text ?? '',
      toolCalls,
      inputTokens: turn.inputTokens ?? 100,
      outputTokens: turn.outputTokens ?? 50,
      stopReason: toolCalls.length ? 'tool_calls' : 'stop',
    }
  }
}

/** 把假模型包装成适配器接口，便于直接注入 executor。 */
export function scriptedAdapter(script: ScriptedTurn[]) {
  const provider = new ScriptedProvider(script)
  return {
    provider,
    adapter: {
      async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
        return provider.stream(request, handlers)
      },
    },
  }
}

export function userMessage(content: string): ChatMessage {
  return { role: 'user', content }
}

/**
 * 测试用的任务契约。
 *
 * 默认内容刻意做成「通用的、什么都能算完成」——
 * 这样那些不关心契约语义的老测试（测族隔离、测规则短路）不会被它干扰。
 * 需要验证「跑题产物不能过审」的测试必须自己传具体的 goal。
 */
export function makeContract(overrides: Partial<TaskContract> = {}): TaskContract {
  const base: Omit<TaskContract, 'canonical' | 'contractHash'> = {
    id: 'contract-test',
    taskId: 't1',
    goal: '完成任务',
    acceptanceCriteria: [],
    contractVersion: 1,
    status: 'active',
    actor: 'test',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
  const { canonical, contractHash } = buildContractContent({
    taskId: base.taskId,
    goal: base.goal,
    acceptanceCriteria: base.acceptanceCriteria,
    contractVersion: base.contractVersion,
    actor: base.actor,
  })
  return { ...base, canonical, contractHash }
}
