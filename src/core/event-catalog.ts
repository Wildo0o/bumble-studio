// 事件目录：所有已定义的事件 kind，以及它们的聚合类型。
//
// 为什么要有目录，而不是「想写什么 kind 就写什么」：
//   · 事件是**事实记录**，会进入证据包、离线 replay 和 UI 活动流。
//   · 没有目录时，改一个拼写（`tool.done` → `tool.completed`）在运行时
//     完全静默，只有到「回放时找不到对应事件」才暴露。
//   · 目录让「未知 kind」在写入时就被拦下，
//     也让 `/meta/contracts` 能把事件契约暴露给客户端。
//
// 关键：目录必须与**实际发事件的代码**一一对应。
// 目录里多一个 kind = 声明了没人写的事件；少一个 = 运行期才炸。
// `event-catalog.test.ts` 会扫描源码里的 emit 调用点做双向比对。
//
// 兼容规则（改动即破坏兼容）：
//   1. kind 一旦发布，**不能改名**。要改语义就加新 kind。
//   2. 已有 kind 的 aggregateType 不能改。
//   3. 新 kind 必须同时更新 `docs/CONTRACTS.md`。
//
// 为什么 kind 是 `<聚合>.<动作>` 的扁平字符串而不是嵌套对象：
//   payload 的 shape 每个 kind 都不同，强类型化收益有限；
//   而一个稳定的字符串 + 一份可读目录，足以让 replay 与 UI 对齐。
import type { EventAggregateType, EventActor } from '../shared/types.js'

export interface EventKindDefinition {
  kind: string
  aggregateType: EventAggregateType
  /** 写这个事件的代码路径。用于审计时回答「谁写的」。 */
  emittedBy:
    | 'executor'
    | 'store'
    | 'review-loop'
    | 'acceptance'
    | 'server'
    | 'startup'
    | 'migration'
  description: string
}

/** 全部已定义事件。新增事件必须加在这里。 */
export const EVENT_CATALOG: readonly EventKindDefinition[] = [
  // ── run 生命周期 ───────────────────────────────────────
  { kind: 'run.started', aggregateType: 'run', emittedBy: 'executor', description: 'Run 开始执行' },
  { kind: 'run.completed', aggregateType: 'run', emittedBy: 'executor', description: 'Run 正常收束' },
  { kind: 'run.failed', aggregateType: 'run', emittedBy: 'executor', description: 'Run 明确失败' },
  { kind: 'run.cancelled', aggregateType: 'run', emittedBy: 'executor', description: 'Run 被取消' },
  { kind: 'run.expired', aggregateType: 'run', emittedBy: 'executor', description: 'Run 因预算/期限超限终止' },
  { kind: 'run.paused', aggregateType: 'run', emittedBy: 'executor', description: 'Run 因等待审批而暂停' },
  { kind: 'run.paused_by_user', aggregateType: 'run', emittedBy: 'executor', description: 'Run 被用户主动暂停' },
  { kind: 'run.resumed', aggregateType: 'run', emittedBy: 'executor', description: 'Run 从暂停状态恢复' },
  {
    kind: 'run.blocked_by_unknown',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: 'Run 因存在未解决的外部操作 unknown 而停下',
  },

  // ── 启动恢复（内核在进程重启后如实降级状态）────────────
  {
    kind: 'run.stale_running',
    aggregateType: 'run',
    emittedBy: 'startup',
    description: '启动时发现 Run 停在 running 且没有 unknown 残留，重新排队',
  },
  {
    kind: 'run.status_recovered',
    aggregateType: 'run',
    emittedBy: 'startup',
    description: '启动时因存在 unknown 把 running 的 Run 降级为 needs_reconciliation',
  },
  {
    kind: 'step.unknown',
    aggregateType: 'run',
    emittedBy: 'startup',
    description: '挂在 running 的 Step 因进程异常终止被标为 unknown',
  },
  {
    kind: 'intent.swept',
    aggregateType: 'run',
    emittedBy: 'startup',
    description: '停在 started 的 ToolIntent 被标为 unknown，不自动重试',
  },

  // ── 预算 ───────────────────────────────────────────────
  {
    kind: 'budget.reserve_failed',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '调用前预算预留失败（不发请求）',
  },
  { kind: 'budget.overshoot', aggregateType: 'run', emittedBy: 'executor', description: '调用后发现实际用量超出预算' },

  // ── step / tool ────────────────────────────────────────
  { kind: 'tool.done', aggregateType: 'run', emittedBy: 'executor', description: '工具调用完成' },
  { kind: 'tool.unknown', aggregateType: 'run', emittedBy: 'executor', description: '工具调用结果无法确认' },
  {
    kind: 'tool.replayed',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '同一个 toolCallId 的已记录结果被复用，未重复执行',
  },
  {
    kind: 'tool.intent_blocked',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '受 ToolIntent 状态阻挡，未执行工具',
  },
  {
    kind: 'tool.grant_unavailable',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '缺少可用授权，未执行工具',
  },
  {
    kind: 'tool.late_result',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '已判定 unknown 之后才返回的工具结果，仅记录不改状态',
  },

  // ── approval ───────────────────────────────────────────
  { kind: 'approval.approved', aggregateType: 'run', emittedBy: 'executor', description: '审批被批准' },
  { kind: 'approval.rejected', aggregateType: 'run', emittedBy: 'executor', description: '审批被拒绝' },
  { kind: 'approval.expired', aggregateType: 'run', emittedBy: 'executor', description: '审批超时自动拒绝' },
  {
    kind: 'approval.result',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: '审批结果已回填进 Run 历史',
  },

  // ── 对账 ───────────────────────────────────────────────
  {
    kind: 'intent.reconciled',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: 'ToolIntent 被裁决',
  },
  {
    kind: 'reconciliation.resolved',
    aggregateType: 'run',
    emittedBy: 'executor',
    description: 'unknown 已被对账裁决',
  },

  // ── snapshot / artifact ────────────────────────────────
  { kind: 'snapshot.captured', aggregateType: 'run', emittedBy: 'executor', description: '快照创建成功' },
  { kind: 'snapshot.failed', aggregateType: 'run', emittedBy: 'executor', description: '快照创建失败' },
  {
    kind: 'artifact.superseded_by_migration',
    aggregateType: 'artifact',
    emittedBy: 'migration',
    description: '迁移发现同一 Run 同一路径有多份候选，保留最早一份并将其余标为 superseded',
  },

  // ── review ─────────────────────────────────────────────
  { kind: 'review.audited', aggregateType: 'review', emittedBy: 'review-loop', description: '审计完成并写入结论' },
  { kind: 'review.escalated', aggregateType: 'review', emittedBy: 'server', description: '审计无法判断，转人工' },
  { kind: 'review.no_snapshot', aggregateType: 'review', emittedBy: 'review-loop', description: '缺少可审计快照' },
  {
    kind: 'review.contract_missing',
    aggregateType: 'review',
    emittedBy: 'review-loop',
    description: '缺少任务契约',
  },
  {
    kind: 'review.artifact_hash_mismatch',
    aggregateType: 'review',
    emittedBy: 'review-loop',
    description: '产物哈希与快照不一致',
  },
  {
    kind: 'review.budget_blocked',
    aggregateType: 'review',
    emittedBy: 'review-loop',
    description: '审计因预算受限未执行',
  },

  // ── acceptance / delivery ──────────────────────────────
  { kind: 'acceptance.accepted', aggregateType: 'task', emittedBy: 'acceptance', description: '用户接受产物' },
  {
    kind: 'acceptance.revision_requested',
    aggregateType: 'task',
    emittedBy: 'acceptance',
    description: '用户要求返工',
  },
  { kind: 'acceptance.rejected', aggregateType: 'task', emittedBy: 'acceptance', description: '用户拒绝产物' },
  { kind: 'delivery.applied', aggregateType: 'artifact', emittedBy: 'acceptance', description: '产物已应用到目标' },
  { kind: 'delivery.exported', aggregateType: 'artifact', emittedBy: 'acceptance', description: '产物已导出' },
  { kind: 'delivery.failed', aggregateType: 'artifact', emittedBy: 'acceptance', description: '交付失败' },
  {
    kind: 'delivery.conflict',
    aggregateType: 'artifact',
    emittedBy: 'acceptance',
    description: '交付冲突（同一事件 kind 用于 conflict/failed 分支的冲突形态）',
  },
] as const

const BY_KIND = new Map(EVENT_CATALOG.map((d) => [d.kind, d]))

/** 查目录。返回 undefined 表示这个 kind 未定义。 */
export function eventKindDefinition(kind: string): EventKindDefinition | undefined {
  return BY_KIND.get(kind)
}

/** 目录里定义的全部 kind，便于测试与元数据接口。 */
export function eventKinds(): string[] {
  return EVENT_CATALOG.map((d) => d.kind)
}

/**
 * 事件写入者（actor）。
 *
 * 与「谁触发的业务动作」不同：
 *   · user       用户直接发起的 HTTP 请求
 *   · coordinator 总控（workgroup 区块引入）
 *   · role       角色 Worker
 *   · system     执行内核 / 启动清理 / 调度器
 *   · provider   外部模型或服务回调
 */
export const EVENT_ACTORS: readonly EventActor[] = ['user', 'coordinator', 'role', 'system', 'provider']
