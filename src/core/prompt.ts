// 提示词构造与上下文整理。
//
// 与常见实现的差异：这里把「消息规整」和「上下文预算」放在同一个模块，
// 因为二者互相制约——裁剪会改变消息顺序，顺序又影响首尾 user 的补齐。
// 分成两个模块反而容易写出互相打架的逻辑。
import type { ChatMessage, ToolCall } from '../shared/types.js'

// ── token 估算 ────────────────────────────────────────────
//
// 只用于预算保护，不用于展示。展示时必须带「约」字（见 format.ts）。
// 中日韩字符按 1 token/字，其余按 4 字符/token，再乘以保守系数。

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  // 保守系数 1.15：宁可高估而提前裁剪，也不要低估导致请求被拒
  return Math.ceil((cjk + other / 4) * 1.15)
}

export function estimateMessages(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    // 每条消息有固定的角色/分隔开销
    total += estimateTokens(m.content) + 6
    if (m.role === 'assistant' && m.toolCalls) {
      for (const call of m.toolCalls) {
        total += estimateTokens(call.name) + estimateTokens(call.arguments) + 12
      }
    }
  }
  return total
}

// ── 消息规整 ──────────────────────────────────────────────

/**
 * 部分 API 要求：消息首尾必须是 user，且不能有连续同角色。
 * 这里只在必要处插入占位，不改变原有的语义内容。
 */
export function tidy(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []

  for (const m of messages) {
    const prev = out[out.length - 1]
    // 连续同角色合并（tool 与 assistant 之间不合并，它们是协议的一部分）
    if (prev && prev.role === m.role && m.role !== 'tool' && m.role !== 'assistant') {
      out[out.length - 1] = { role: 'user', content: `${prev.content}\n\n${m.content}` }
      continue
    }
    out.push(m)
  }

  if (out.length === 0) return out

  // 首条是 assistant：补一条开场
  if (out[0]!.role === 'assistant') {
    out.unshift({ role: 'user', content: '(对话开始)' })
  }
  // 末条是 assistant：补一句催prompt，否则部分服务商会拒答
  if (out[out.length - 1]!.role === 'assistant') {
    out.push({ role: 'user', content: '请继续。' })
  }

  return out
}

// ── 说话人前缀剥离 ────────────────────────────────────────

/**
 * 多模型群聊时，模型常把别人的 "[名字]:" 前缀一起输出。
 * 这里剥掉开头的名字前缀，兼容 **[名字]：**、[名字]:、名字: 三种写法。
 *
 * 实现用 indexOf 扫描而不是正则拼接名字，避免名字里的特殊字符
 * 需要转义——这是正则方案最常见的踩坑点。
 */
export function stripNamePrefix(text: string, name: string): string {
  let i = 0
  const n = text.length
  const skipSpace = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  }

  skipSpace()
  // 可选的 ** 包裹
  if (text.startsWith('**', i)) i += 2
  skipSpace()

  // 可选的 [ ] 包裹
  const hasBracket = text[i] === '['
  if (hasBracket) i++
  skipSpace()

  // 名字本体（大小写不敏感）
  const rest = text.slice(i, i + name.length)
  if (rest.toLowerCase() !== name.toLowerCase()) return text
  i += name.length
  skipSpace()

  if (hasBracket) {
    if (text[i] !== ']') return text
    i++
  }

  if (text.startsWith('**', i)) i += 2
  skipSpace()

  // 必须有冒号（半角或全角）才算前缀
  if (text[i] !== ':' && text[i] !== '：') return text
  i++
  if (text.startsWith('**', i)) i += 2
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++

  return text.slice(i)
}

// ── 工具输出截断 ──────────────────────────────────────────

export interface Truncation {
  text: string
  truncated: boolean
  originalBytes: number
  keptBytes: number
}

/**
 * 工具输出超限时保留头尾、丢弃中间。
 * 保留尾部的原因：错误信息和总结通常在末尾，比开头的日志更有价值。
 */
export function clampToolOutput(text: string, maxBytes: number): Truncation {
  const buf = Buffer.from(text, 'utf8')
  const originalBytes = buf.length
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, keptBytes: originalBytes }
  }

  const headSize = Math.floor(maxBytes * 0.65)
  const tailSize = maxBytes - headSize
  // toString('utf8') 遇到被切断的多字节字符会产生替换符，可接受（截断本就损失信息）
  const head = buf.subarray(0, headSize).toString('utf8')
  const tail = buf.subarray(buf.length - tailSize).toString('utf8')
  const dropped = originalBytes - headSize - tailSize

  return {
    text: `${head}\n\n…[已截断 ${dropped} 字节，原始大小 ${originalBytes} 字节]…\n\n${tail}`,
    truncated: true,
    originalBytes,
    keptBytes: headSize + tailSize,
  }
}

// ── 上下文预算 ────────────────────────────────────────────

export interface FitResult {
  messages: ChatMessage[]
  droppedMessages: number
  estimatedTokens: number
}

/**
 * 把消息列表压进预算。
 *
 * 策略：从最旧的消息开始丢，但永远保留：
 *   1. system 消息
 *   2. 最后一条 user 消息
 *   3. 最近的工具往返（tool_call 与 tool_result 必须成对，否则 API 报错）
 *
 * 注意这里做的是「丢弃」而不是「摘要」。摘要需要再调一次模型，
 * 放在 RunExecutor 层做，不在这里——这个函数必须保持纯函数、可测试。
 */
export function fitToBudget(messages: ChatMessage[], budgetTokens: number): FitResult {
  const total = estimateMessages(messages)
  if (total <= budgetTokens) {
    return { messages, droppedMessages: 0, estimatedTokens: total }
  }

  const systems = messages.filter((m) => m.role === 'system')
  const conversation = messages.filter((m) => m.role !== 'system')

  // 找到最后一条 user 的位置，它之后的内容必须保留
  let lastUserIdx = -1
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }

  const keepTail = lastUserIdx >= 0 ? conversation.slice(lastUserIdx) : []
  const pool = lastUserIdx >= 0 ? conversation.slice(0, lastUserIdx) : conversation.slice()

  const baseCost = estimateMessages([...systems, ...keepTail])
  let available = budgetTokens - baseCost

  // 从尾部往前取，能装多少装多少
  const kept: ChatMessage[] = []
  for (let i = pool.length - 1; i >= 0; i--) {
    const msg = pool[i]!
    const cost = estimateMessages([msg])
    if (cost > available) break
    available -= cost
    kept.unshift(msg)
  }

  // 修复成对关系：如果保留区开头是 tool 消息，把它的 assistant 来源一起带上
  while (kept.length > 0 && kept[0]!.role === 'tool') {
    kept.shift()
  }
  // 如果保留区末尾是带 tool_calls 的 assistant，但对应的 tool 结果被丢掉了，
  // 一并丢弃，避免出现「有调用无结果」的非法序列
  while (kept.length > 0) {
    const last = kept[kept.length - 1]!
    if (last.role === 'assistant' && last.toolCalls?.length) kept.pop()
    else break
  }

  const result = tidy([...systems, ...kept, ...keepTail])
  return {
    messages: result,
    droppedMessages: conversation.length - kept.length - keepTail.length,
    estimatedTokens: estimateMessages(result),
  }
}

// ── 工具调用辅助 ──────────────────────────────────────────

export function toolCallsIn(message: ChatMessage): ToolCall[] {
  return message.role === 'assistant' ? (message.toolCalls ?? []) : []
}

export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return m.content
  }
  return ''
}
