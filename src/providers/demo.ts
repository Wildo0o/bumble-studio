// 演示模型：不需要任何 API 密钥，让用户第一次打开就能跑通完整流程。
//
// 它不是「假装在聊天」，而是真的会调用工具——这样用户能立刻看到
// 审批、工具执行、Trace 这些本产品的核心能力，而不是只看到一段文字。
//
// 实现方式：一个极小的规则引擎，按用户输入的意图选择动作。
// 它的输出末尾永远带免责说明，避免被误认为真实模型的回答。
import type { ChatMessage, ToolCall } from '../shared/types.js'
import type { ChatRequest, ChatResult, ProviderAdapter, StreamHandlers } from './types.js'

const DISCLAIMER = '\n\n---\n*这是演示模型的模拟回复，不需要密钥。配置真实服务商后即可获得真实回答。*'

interface Intent {
  /** 触发词 */
  keywords: string[]
  /** 需要调用的工具 */
  tool?: { name: string; args: (input: string) => Record<string, unknown> }
  /** 收束时的文字 */
  reply: (ctx: DemoContext) => string
}

interface DemoContext {
  lastUserText: string
  lastToolResult?: string
  hadToolCall: boolean
}

/** 从消息里找出最近的用户输入和最近的工具结果。 */
function analyze(messages: ChatMessage[]): DemoContext {
  let lastUserText = ''
  let lastToolResult: string | undefined
  let hadToolCall = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'tool' && lastToolResult === undefined) lastToolResult = m.content
    if (m.role === 'assistant' && m.toolCalls?.length) hadToolCall = true
    if (m.role === 'user' && !lastUserText) lastUserText = m.content
  }

  return { lastUserText, lastToolResult, hadToolCall }
}

/** 从用户输入里猜测一个路径。没猜到就用工作区根目录。 */
function guessPath(text: string): string | undefined {
  const winPath = text.match(/[A-Za-z]:[\\/][^\s，。,'"）)]+/)
  if (winPath) return winPath[0]
  const posixPath = text.match(/(?:^|\s)(\/[^\s，。,'"）)]+)/)
  if (posixPath) return posixPath[1]
  const quoted = text.match(/["'「]([^"'」]+)["'」]/)
  if (quoted) return quoted[1]
  return undefined
}

function classify(text: string): 'read' | 'list' | 'write' | 'chat' {
  const lower = text.toLowerCase()
  if (/写|创建|保存|生成.*文件|write|create|save/.test(lower)) return 'write'
  if (/列|目录|文件夹|有哪些|list|ls|dir/.test(lower)) return 'list'
  if (/读|查看|看看|内容|打开|read|cat|show/.test(lower)) return 'read'
  return 'chat'
}

export const demoAdapter: ProviderAdapter = {
  async stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    // 审计场景：system 里带审计指令时，直接产出结构化审计结果。
    // 这样无需密钥就能完整验证 ReviewLoop 链路。
    const system = request.messages.find((m) => m.role === 'system')
    if (system && /审计者|auditor/i.test(system.content)) {
      return auditReply(request, handlers)
    }

    const ctx = analyze(request.messages)

    // 工具已经执行过：给出基于结果的收束回复
    if (ctx.hadToolCall && ctx.lastToolResult !== undefined) {
      const body = summarizeToolResult(ctx.lastToolResult)
      await emit(handlers, body + DISCLAIMER)
      return {
        text: body + DISCLAIMER,
        toolCalls: [],
        inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
        outputTokens: Math.ceil(body.length / 4),
        stopReason: 'stop',
      }
    }

    const kind = classify(ctx.lastUserText)

    // 还没有调用过工具：按意图决定是否发起工具调用
    if (kind !== 'chat') {
      const path = guessPath(ctx.lastUserText) ?? '.'

      let toolCall: ToolCall | undefined
      if (kind === 'read') {
        toolCall = { id: `demo_${Date.now()}`, name: 'read_file', arguments: JSON.stringify({ path }) }
      } else if (kind === 'list') {
        toolCall = { id: `demo_${Date.now()}`, name: 'list_dir', arguments: JSON.stringify({ path }) }
      } else if (kind === 'write') {
        toolCall = {
          id: `demo_${Date.now()}`,
          name: 'write_file',
          arguments: JSON.stringify({ path, content: `由演示模型生成于 ${new Date().toISOString()}\n` }),
        }
      }

      if (toolCall) {
        const intro = {
          read: `好的，我先读一下 ${path}。`,
          list: `好的，我看一下 ${path} 里有什么。`,
          write: `好的，我来写 ${path}。这个操作需要你授权。`,
        }[kind]

        await emit(handlers, intro)
        return {
          text: intro,
          toolCalls: [toolCall],
          inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
          outputTokens: Math.ceil(intro.length / 4),
          stopReason: 'tool_calls',
        }
      }
    }

    // 纯聊天
    const body = chatReply(ctx.lastUserText)
    await emit(handlers, body + DISCLAIMER)
    return {
      text: body + DISCLAIMER,
      toolCalls: [],
      inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
      outputTokens: Math.ceil(body.length / 4),
      stopReason: 'stop',
    }
  },
}

/**
 * 演示用的审计输出。
 *
 * 不是随机判断：按产物内容做最基础的形式检查，
 * 免得演示模型永远给 pass 而掩盖了审计流程本身。
 */
async function auditReply(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
  const user = request.messages.find((m) => m.role === 'user')
  const text = user?.content ?? ''

  const issues: Array<{ feature: string; severity: string; description: string; suggestedFix?: string }> = []
  let verdict: 'pass' | 'reject' | 'escalate' = 'pass'
  let summary = '产物通过检查'

  // 内容太短 → 判定不合格
  const lengthMatch = text.match(/### (.+)\n```\n([\s\S]*?)\n```/)
  if (lengthMatch) {
    const content = lengthMatch[2] ?? ''
    if (content.trim().length < 20) {
      verdict = 'reject'
      summary = '产物内容过短，不构成有效交付'
      issues.push({
        feature: 'content_too_short',
        severity: 'blocking',
        description: `产物只有 ${content.trim().length} 个字符，不足以构成有效交付`,
        suggestedFix: '补充实际内容，而不是只放占位符',
      })
    } else if (/TODO|占位|placeholder|待补充/i.test(content)) {
      verdict = 'reject'
      summary = '产物包含未完成的占位内容'
      issues.push({
        feature: 'incomplete_content',
        severity: 'blocking',
        description: '产物中存在 TODO / 占位符，说明任务并未真正完成',
        suggestedFix: '把占位内容替换为实际内容',
      })
    }
  }

  // 没有产物 → 无法判断，升级人工
  if (!lengthMatch) {
    verdict = 'escalate'
    summary = '没有可审计的产物内容'
    issues.push({
      feature: 'no_artifact_content',
      severity: 'blocking',
      description: '审计输入中没有任何产物文本',
    })
  }

  const payload = {
    verdict,
    confidence: verdict === 'pass' ? 0.8 : 0.85,
    issues,
    summary,
  }
  const body = JSON.stringify(payload, null, 2)
  await emit(handlers, body)

  return {
    text: body,
    toolCalls: [],
    inputTokens: Math.ceil(text.length / 4),
    outputTokens: Math.ceil(body.length / 4),
    stopReason: 'stop',
  }
}

async function emit(handlers: StreamHandlers, text: string): Promise<void> {
  // 分块吐出，模拟真实流式，让 UI 能验证增量渲染
  const size = 12
  for (let i = 0; i < text.length; i += size) {
    handlers.onText(text.slice(i, i + size))
    await new Promise((r) => setTimeout(r, 8))
  }
}

function summarizeToolResult(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return '工具返回了空结果。'
  if (trimmed.startsWith('已拒绝')) {
    return '我理解，不会执行这个操作。如果你想换个方式完成，可以告诉我。'
  }
  if (trimmed.startsWith('结果未知')) {
    return '这个操作的结果无法确认——它可能已经生效，也可能没有。建议你检查一下实际状态再决定是否重试。'
  }
  if (trimmed.startsWith('错误') || trimmed.startsWith('工具执行失败')) {
    return `遇到问题：${trimmed}\n\n可以调整参数或换个思路再试。`
  }

  const lines = trimmed.split('\n')
  const preview = lines.slice(0, 20).join('\n')
  const more = lines.length > 20 ? `\n…（还有 ${lines.length - 20} 行）` : ''
  return `拿到了结果：\n\n\`\`\`\n${preview}${more}\n\`\`\``
}

function chatReply(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return '你好。我是演示模型，可以帮你读文件、列目录、写文件。'

  if (/你好|hi|hello|嗨/i.test(trimmed)) {
    return '你好。我是演示模型，运行在本地，不需要 API 密钥。\n\n你可以试试：\n- 「列出当前目录有什么」\n- 「读一下 README.md」\n- 「帮我写个文件」'
  }
  if (/能做什么|功能|会什么|help|帮助/i.test(trimmed)) {
    return [
      '我目前能做这些：',
      '',
      '1. **读文件** — 说「读一下 xxx」，我会调用 read_file',
      '2. **列目录** — 说「看看有哪些文件」，我会调用 list_dir',
      '3. **写文件** — 说「帮我写个文件」，我会调用 write_file（会先请求你授权）',
      '',
      '每次工具调用都会记录成 Step，你可以在 Trace 里看到完整过程。',
    ].join('\n')
  }

  return `你说的是：「${trimmed}」\n\n我是演示模型，只能理解简单的文件操作意图。要获得真正的对话能力，请在设置里配置一个真实服务商（OpenAI、Anthropic、DeepSeek 或本地 Ollama 都可以）。`
}
