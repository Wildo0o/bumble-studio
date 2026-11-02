// 状态机的**声明式**描述。
//
// 为什么必须有一张表，而不是把「哪些状态能转成哪些」散落在代码里：
//   · 状态是公共契约：UI、审计、runner 都要按同一份规则解释。
//   · 分散判断时，两个入口对同一个迁移的结论可能不同——
//     一个允许 `completed → running`，另一个不允许，数据就会自相矛盾。
//   · 表可以被穷举测试：每个状态的每个目标都有明确的 allow / deny。
//
// 注意分工：
//   · 这张表规定**结构上**允许的迁移；
//   · 业务前置条件（比如「必须有通过的审计才能验收」）不在这里，
//     它们由对应的服务在迁移之前检查。
//   · 两者都必须满足，迁移才发生。任何一个缺失，都是 bug。
import type {
  AcceptanceRecord,
  ArtifactStatus,
  DeliveryRecord,
  Grant,
  RunStatus,
  StepStatus,
  TaskStatus,
} from '../shared/types.js'

/** 对象种类。`unknown` 状态由调用方处理（本文件对它一律放行，见 state-machine.ts）。 */
export type StatefulKind =
  | 'run'
  | 'task'
  | 'step'
  | 'approval'
  | 'grant'
  | 'artifact'
  | 'acceptance'
  | 'delivery'

export interface TransitionTable<S extends string> {
  /** 所有合法状态，含终态。 */
  states: readonly S[]
  /**
   * 创建记录时的初始状态。
   *
   * 显式声明而不是从图里推：有些表存在「重试边」（如 delivery 的
   * failed → pending），整张图没有入度为 0 的节点，
   * 从图论上推不出起点。
   */
  initial: S
  /** 允许的迁移。键是起始状态。 */
  transitions: Record<S, readonly S[]>
  /** 终态：不再有任何出边。 */
  terminal: readonly S[]
}

/**
 * Run。
 *
 * 关键约束（每一项都有对应的回归测试）：
 *   · `waiting_approval → running` 只能来自有效审批（入口：resumeWithDecision）
 *   · `needs_reconciliation → running` 只能来自对账结论或人工决定
 *   · `completed` 不出边：完成的 Run 不能被「重新执行」偷偷复用
 *   · `queued → waiting_*` 不允许：还没开始执行就等待，说明有人在伪造状态
 */
export const RUN_TRANSITIONS: TransitionTable<RunStatus> = {
  states: [
    'queued',
    'running',
    'paused',
    'waiting_approval',
    'needs_reconciliation',
    'auditing',
    'completed',
    'failed',
    'cancelled',
    'expired',
  ],
  initial: 'queued',
  transitions: {
    queued: ['running', 'cancelled', 'expired', 'failed'],
    running: [
      'paused',
      'waiting_approval',
      'needs_reconciliation',
      'auditing',
      'completed',
      'failed',
      'cancelled',
      'expired',
    ],
    paused: ['running', 'cancelled', 'expired', 'failed'],
    waiting_approval: ['running', 'cancelled', 'expired', 'failed', 'needs_reconciliation'],
    needs_reconciliation: ['running', 'failed', 'cancelled', 'expired'],
    auditing: ['completed', 'failed', 'needs_reconciliation', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
    expired: [],
  },
  terminal: ['completed', 'failed', 'cancelled', 'expired'],
}

/**
 * Task。
 *
 * `accepted` 只能来自 `awaiting_acceptance`：验收前必须有质量门，
 * 这由 AcceptanceService 保证；这里保证结构上不能跳过中间态。
 *
 * 关于 accepted / rejected 的出边：只有 `archived`。
 * 归档是**簿记动作**（从活动列表里收起来），不改变业务结论；
 * 而 accepted 不是「不能变」，是「不能变成另一个质量结论」。
 * 若把 archived 也去掉，这些 Task 就永远无法从活动视图里消失。
 */
export const TASK_TRANSITIONS: TransitionTable<TaskStatus> = {
  states: [
    'draft',
    'ready',
    'queued',
    'in_progress',
    'awaiting_acceptance',
    'accepted',
    'revision_requested',
    'rejected',
    'cancelled',
    'failed',
    'expired',
    'archived',
  ],
  initial: 'draft',
  transitions: {
    draft: ['ready', 'cancelled', 'archived'],
    ready: ['queued', 'in_progress', 'cancelled', 'archived'],
    queued: ['in_progress', 'cancelled', 'failed', 'expired', 'archived'],
    in_progress: [
      'awaiting_acceptance',
      'revision_requested',
      'rejected',
      'failed',
      'cancelled',
      'expired',
      'archived',
    ],
    awaiting_acceptance: [
      'accepted',
      'revision_requested',
      'rejected',
      'in_progress',
      'failed',
      'expired',
      'archived',
    ],
    accepted: ['archived'],
    revision_requested: ['in_progress', 'queued', 'awaiting_acceptance', 'cancelled', 'rejected', 'archived'],
    rejected: ['archived'],
    cancelled: ['archived'],
    failed: ['in_progress', 'archived'],
    expired: ['archived'],
    archived: [],
  },
  // 终态 = 「不能再有业务结论变化」。archived 是唯一的真正终态。
  terminal: ['archived'],
}

export const STEP_TRANSITIONS: TransitionTable<StepStatus> = {
  states: [
    'pending',
    'running',
    'waiting_approval',
    'completed',
    'failed',
    'rejected',
    'skipped',
    'cancelled',
    'unknown',
  ],
  initial: 'pending',
  transitions: {
    pending: ['running', 'skipped', 'cancelled', 'waiting_approval'],
    running: ['completed', 'failed', 'cancelled', 'unknown', 'waiting_approval'],
    waiting_approval: ['running', 'completed', 'failed', 'rejected', 'cancelled', 'unknown'],
    // `unknown` 必须由对账处理，不能直接改成 completed / failed
    unknown: ['failed', 'completed', 'cancelled'],
    completed: [],
    failed: [],
    rejected: [],
    skipped: [],
    cancelled: [],
  },
  terminal: ['completed', 'failed', 'rejected', 'skipped', 'cancelled'],
}

type ApprovalRecordStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export const APPROVAL_TRANSITIONS: TransitionTable<ApprovalRecordStatus> = {
  states: ['pending', 'approved', 'rejected', 'expired'],
  initial: 'pending',
  transitions: {
    pending: ['approved', 'rejected', 'expired'],
    approved: [],
    rejected: [],
    expired: [],
  },
  terminal: ['approved', 'rejected', 'expired'],
}

export const GRANT_TRANSITIONS: TransitionTable<Grant['status']> = {
  states: ['active', 'revoked', 'expired'],
  initial: 'active',
  transitions: {
    active: ['revoked', 'expired'],
    revoked: [],
    expired: [],
  },
  terminal: ['revoked', 'expired'],
}

export const ARTIFACT_TRANSITIONS: TransitionTable<ArtifactStatus> = {
  states: ['candidate', 'accepted', 'rejected', 'superseded'],
  initial: 'candidate',
  transitions: {
    candidate: ['accepted', 'rejected', 'superseded'],
    accepted: ['superseded'],
    rejected: [],
    superseded: [],
  },
  terminal: ['rejected', 'superseded'],
}

export const ACCEPTANCE_TRANSITIONS: TransitionTable<AcceptanceRecord['status']> = {
  states: ['pending', 'accepted', 'revision_requested', 'rejected'],
  initial: 'pending',
  transitions: {
    pending: ['accepted', 'revision_requested', 'rejected'],
    accepted: [],
    revision_requested: ['accepted', 'rejected'],
    rejected: [],
  },
  terminal: ['accepted', 'rejected'],
}

/**
 * 交付。
 *
 * 起始状态是 `pending`（记录已创建、动作未开始）。
 * 注意 `conflict` / `failed` 有回到 `pending` 的边：
 * 交付失败是可重试的**动作**失败，不是「这份产物废了」——
 * 用户修好磁盘或改掉目标路径后应该能重试同一份已验收产物。
 */
export const DELIVERY_TRANSITIONS: TransitionTable<DeliveryRecord['status']> = {
  states: ['pending', 'running', 'applied', 'exported', 'conflict', 'failed', 'cancelled'],
  initial: 'pending',
  transitions: {
    pending: ['running', 'cancelled', 'failed', 'conflict'],
    running: ['applied', 'exported', 'conflict', 'failed', 'cancelled'],
    applied: [],
    exported: [],
    conflict: ['pending', 'running', 'cancelled'],
    failed: ['pending'],
    cancelled: [],
  },
  terminal: ['applied', 'exported', 'cancelled'],
}
