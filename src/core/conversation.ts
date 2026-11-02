// 会话壳：run_message → message 投影 + 用户可见的活动流。
//
// 为什么需要投影：
//
//   一次 Run 的内部历史（run_message）是**给模型看的**：
//   它包含 system prompt、被裁剪掉的工具输出、完整的 tool 结果。
//   会话（message）是**给人看的**：
//   它是对话本身——用户说了什么、模型回了什么、什么时候需要我审批。
//
//   两者不能合并：
//     · 把 run_message 直接当消息展示，会把 system prompt 和
//       上下文裁剪留下的残缺内容暴露给用户
//     · 把 message 当模型历史，会丢失工具调用等结构化信息
//
// 所以投影是**有损且有规则**的：只挑确定要展示的部分，附加事件时间线。
//
// 活动流（activity）与消息的区别：
//   活动是「发生了什么」（Run 开始、工具被拒绝、等待审批），
//   消息是「说了什么」。用户需要能一眼看到「它在等我点什么」。
import type { ChatMessage } from '../shared/types.js'

/** 会话的对外状态。UI 用它决定显示「空闲 / 运行中 / 等待审批」。 */
export type ConversationStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'waiting_reconciliation'
  | 'failed'

/** 活动流条目。 */
export interface ActivityEntry {
  id: number
  kind: string
  /** 给用户看的短句。由服务端生成，不把原始 payload 直接丢给 UI。 */
  summary: string
  /** 相关对象，便于 UI 跳转。 */
  refs: { runId?: string; taskId?: string; approvalId?: string; artifactId?: string }
  occurredAt: number
}

/** 投影出的一条会话消息。 */
export interface ProjectedMessage {
  /** 来源：会话直接消息，或从 Run 历史投影而来 */
  source: 'session' | 'run'
  /** session 消息用 message.id；run 投影用 `run:<runId>:<seq>` */
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  /** 工具调用摘要（只有名字与参数摘要，不暴露完整参数） */
  toolCalls?: Array<{ name: string; summary: string }>
  createdAt: number
  runId?: string
}

/**
 * 把一条 run_message 转成要展示的内容。
 *
 * 规则（每一条都是为了「不把内部细节泄露给用户」）：
 *   · system 消息不投影——那是给模型的指令，不是对话
 *   · assistant 的 toolCalls 只保留名字 + 参数摘要
 *   · tool 结果截断到可读长度
 *   · 空内容且无工具调用 → 跳过（避免空白气泡）
 */
export const MAX_TOOL_RESULT_PREVIEW = 800
export const MAX_TOOL_ARGS_PREVIEW = 120

export function projectRunMessage(
  raw: unknown,
  meta: { runId: string; seq: number; createdAt: number },
): ProjectedMessage | undefined {
  const msg = raw as Partial<ChatMessage> | null
  if (!msg || typeof msg !== 'object') return undefined
  if (msg.role === 'system') return undefined

  const content = typeof msg.content === 'string' ? msg.content : ''

  if (msg.role === 'tool') {
    const preview = content.length > MAX_TOOL_RESULT_PREVIEW
      ? `${content.slice(0, MAX_TOOL_RESULT_PREVIEW)}…（已截断，共 ${content.length} 字符）`
      : content
    if (!preview.trim()) return undefined
    return {
      source: 'run',
      id: `run:${meta.runId}:${meta.seq}`,
      role: 'tool',
      content: preview,
      createdAt: meta.createdAt,
      runId: meta.runId,
    }
  }

  if (msg.role === 'assistant') {
    const calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
    const toolCalls = calls.map((c) => ({
      name: typeof c?.name === 'string' ? c.name : '(未知工具)',
      summary: previewArgs(c?.arguments),
    }))
    if (!content.trim() && toolCalls.length === 0) return undefined
    const out: ProjectedMessage = {
      source: 'run',
      id: `run:${meta.runId}:${meta.seq}`,
      role: 'assistant',
      content,
      createdAt: meta.createdAt,
      runId: meta.runId,
    }
    if (toolCalls.length > 0) out.toolCalls = toolCalls
    return out
  }

  if (msg.role === 'user') {
    if (!content.trim()) return undefined
    return {
      source: 'run',
      id: `run:${meta.runId}:${meta.seq}`,
      role: 'user',
      content,
      createdAt: meta.createdAt,
      runId: meta.runId,
    }
  }

  return undefined
}

/** 参数摘要：只留前一段，避免把完整文件内容塞进 UI 列表。 */
function previewArgs(args: unknown): string {
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  if (text.length <= MAX_TOOL_ARGS_PREVIEW) return text
  return `${text.slice(0, MAX_TOOL_ARGS_PREVIEW)}…`
}

// ── 活动摘要 ───────────────────────────────────────────────

/**
 * 把领域事件翻译成一句人话。
 *
 * 为什么需要这层：事件 kind 是给程序用的（`tool.grant_unavailable`），
 * 直接展示给用户只会让人困惑。这里只做**事实描述**，
 * 不评价成败、不解释原因——原因在 details 里，由 UI 按需展开。
 */
export function summarizeEvent(kind: string, payload: unknown): { summary: string; refs: ActivityEntry['refs'] } {
  const p = (payload ?? {}) as Record<string, unknown>
  const refs: ActivityEntry['refs'] = {}
  if (typeof p.runId === 'string') refs.runId = p.runId
  if (typeof p.taskId === 'string') refs.taskId = p.taskId
  if (typeof p.approvalId === 'string') refs.approvalId = p.approvalId
  if (typeof p.artifactId === 'string') refs.artifactId = p.artifactId

  switch (kind) {
    case 'run.started':
      return { summary: '开始执行', refs }
    case 'run.completed':
      return { summary: '执行完成', refs }
    case 'run.failed':
      return { summary: '执行失败', refs }
    case 'run.cancelled':
      return { summary: '执行已取消', refs }
    case 'run.expired':
      return { summary: '执行因预算或期限耗尽而停止', refs }
    case 'run.paused':
      return { summary: '等待审批', refs }
    case 'run.paused_by_user':
      return { summary: '已被用户暂停', refs }
    case 'run.resumed':
      return { summary: '已恢复执行', refs }
    case 'run.blocked_by_unknown':
      return { summary: '存在无法确认的操作结果，需要人工对账', refs }
    case 'run.stale_running':
      return { summary: '上次执行未正常结束，已重新排队', refs }
    case 'run.status_recovered':
      return { summary: '上次执行未正常结束，存在未确认操作，需要先对账', refs }
    case 'tool.done': {
      const name = typeof p.toolName === 'string' ? p.toolName : '工具'
      return { summary: `已执行 ${name}`, refs }
    }
    case 'tool.unknown': {
      const name = typeof p.toolName === 'string' ? p.toolName : '工具'
      return { summary: `无法确认 ${name} 是否生效`, refs }
    }
    case 'tool.intent_blocked':
      return { summary: '工具调用被已记录的执行意图挡住，未执行', refs }
    case 'tool.grant_unavailable':
      return { summary: '缺少授权，工具未执行', refs }
    case 'tool.replayed':
      return { summary: '复用了已记录的工具结果，未重复执行', refs }
    case 'tool.late_result':
      return { summary: '超时后才返回的工具结果已记录', refs }
    case 'approval.approved':
      return { summary: '审批已批准', refs }
    case 'approval.rejected':
      return { summary: '审批已拒绝', refs }
    case 'approval.expired':
      return { summary: '审批超时，已按安全规则自动拒绝', refs }
    case 'intent.reconciled':
    case 'reconciliation.resolved':
      return { summary: '已完成对账裁决', refs }
    case 'step.unknown':
      return { summary: '有一步执行中断，结果未知', refs }
    case 'intent.swept':
      return { summary: '上次进程异常退出，未完成的工具调用已标记为未知', refs }
    case 'snapshot.captured':
      return { summary: '已创建快照', refs }
    case 'snapshot.failed':
      return { summary: '创建快照失败', refs }
    case 'review.audited':
      return { summary: '审计完成', refs }
    case 'review.escalated':
      return { summary: '审计无法判断，已转人工', refs }
    case 'review.no_snapshot':
      return { summary: '缺少可审计的快照', refs }
    case 'review.contract_missing':
      return { summary: '缺少任务契约，无法审计', refs }
    case 'review.artifact_hash_mismatch':
      return { summary: '产物内容与快照不一致', refs }
    case 'review.budget_blocked':
      return { summary: '审计因预算受限未执行', refs }
    case 'acceptance.accepted':
      return { summary: '产物已被接受', refs }
    case 'acceptance.revision_requested':
      return { summary: '已要求返工', refs }
    case 'acceptance.rejected':
      return { summary: '产物已被拒绝', refs }
    case 'delivery.applied':
      return { summary: '产物已应用', refs }
    case 'delivery.exported':
      return { summary: '产物已导出', refs }
    case 'delivery.conflict':
      return { summary: '交付发生冲突，未覆盖', refs }
    case 'delivery.failed':
      return { summary: '交付失败', refs }
    default:
      // 未在字典里的事件仍然展示，但用 kind 原文——
      // 隐藏它会让「活动流里少了什么」无从发现。
      return { summary: kind, refs }
  }
}

/**
 * 由 Run 状态推导会话状态。
 *
 * 多个 Run 同时存在时取「最需要注意」的那个：
 *   等待审批 > 等待对账 > 运行中 > 失败 > 空闲
 *
 * 为什么等待类优先：用户在会话里最需要知道的是「它在等我」。
 */
export function deriveConversationStatus(
  runs: Array<{ status: string; endedAt?: number }>,
): ConversationStatus {
  if (runs.length === 0) return 'idle'
  const has = (s: string): boolean => runs.some((r) => r.status === s)
  if (has('waiting_approval')) return 'waiting_approval'
  if (has('needs_reconciliation')) return 'waiting_reconciliation'
  if (has('running') || has('queued') || has('auditing') || has('paused')) return 'running'
  if (has('failed') || has('expired')) return 'failed'
  return 'idle'
}

// ── 附件 ───────────────────────────────────────────────────

/** 附件元信息。内容不进数据库（大文件会撑爆 SQLite）。 */
export interface Attachment {
  id: string
  sessionId: string
  /** 原始文件名（仅用于展示，不能当路径用）。 */
  name: string
  mimeType: string
  bytes: number
  /** 内容寻址存储里的相对路径。 */
  storagePath: string
  contentHash: string
  createdAt: number
  deletedAt?: number
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * 文件名安全化。
 *
 * 只允许一段安全字符，且不保留任何路径成分：
 * 附件名来自用户上传，直接当路径用会构成目录穿越。
 * 真正的存储路径由 id + 哈希决定，文件名只用于展示。
 */
export function safeAttachmentName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim()
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_')
  const trimmed = cleaned.slice(0, 200)
  return trimmed.length > 0 ? trimmed : 'attachment'
}

export function validateAttachmentMeta(input: Record<string, unknown>): {
  name: string
  mimeType: string
  bytes: number
} {
  const rawName = typeof input.name === 'string' ? input.name : ''
  const name = safeAttachmentName(rawName)
  const mimeType = typeof input.mimeType === 'string' && input.mimeType.trim()
    ? input.mimeType.trim()
    : 'application/octet-stream'
  const bytes = typeof input.bytes === 'number' ? input.bytes : NaN
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('附件大小必须是正数')
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限`)
  }
  return { name, mimeType, bytes }
}
