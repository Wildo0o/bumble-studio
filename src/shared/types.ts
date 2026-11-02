// 核心领域类型。与 SPEC_V1 一一对应。
//
// 公共契约版本：见 `src/core/contracts.ts` 的 CONTRACTS_VERSION。
// 本文件里的类型是**唯一权威**：core / server / 将来的 desktop 都从这里取，
// 不允许各模块自定义同名字段（那会让「同一个对象」在两个地方长得不一样）。

export type RunStatus =
  | 'queued'
  | 'running'
  /** 用户主动暂停。可以直接恢复，不需要任何前置决定。 */
  | 'paused'
  /** 等待用户审批。必须先处理审批才能继续，不能直接 resume。 */
  | 'waiting_approval'
  /** 存在未解决的 unknown 外部操作。阻塞验收、应用、导出。 */
  | 'needs_reconciliation'
  /** P1 引入：进入机器检查 / Auditor 阶段。 */
  | 'auditing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'skipped'
  | 'cancelled'
  | 'unknown'

export type StepKind = 'llm' | 'tool' | 'approval' | 'check'

export type RiskLevel = 'read' | 'write' | 'external'

export type RunRole = 'producer' | 'auditor'

export interface RunBudget {
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxSteps?: number
  maxToolCalls?: number
  maxCostUsd?: number
  deadlineAt?: number
}

/**
 * 一次预算预留。
 *
 * 为什么需要：没有它的时候，预算是「调用前查已用、调用后累加」。
 * 两个并发 Run 都读到「已用 0」，都以为自己有全额额度，
 * 结果合计超支。而且只能在**调用之后**发现（overshoot），那时钱已经花了。
 *
 * reservation 把「判定 + 占用」放进一个事务：
 *   usage + reserved + estimate <= limit
 * 不满足就不发起调用。
 *
 * 生命周期：
 *   reserve → （调用发生） → settle（按实际用量结算，释放多余）
 *           → （没调用/异常） → release（全额释放）
 *           → （崩溃） → 过期回收
 */
/**
 * 一次预算预留的终态。
 *
 * 为什么不能只用一个 `settled: boolean`：
 *   「结算了」和「释放了」和「过期回收了」是三件不同的事，
 *   在审计上必须能区分——
 *     settled  = 调用发生了，实际用量已计入 usage
 *     released = 调用没发生（或失败），额度全额退回
 *     expired  = 进程崩溃，不知道调用有没有发生
 *   如果都记成 settled=true，事后无法回答「这次调用到底花了多少」。
 */
export type ReservationStatus = 'reserved' | 'settled' | 'released' | 'expired'

export interface BudgetReservation {
  id: string
  runId: string
  taskId: string
  /** 预留的各类额度（估计值） */
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /**
   * 实际用量。只在 status='settled' 时有意义。
   *
   * 为什么必须单独记：预留是估算，实际可能多也可能少。
   * 只记预留值的话，事后无法回答「这次调用到底花了多少」，
   * 也无法校准估算模型。
   */
  actualSteps: number
  actualToolCalls: number
  actualInputTokens: number
  actualOutputTokens: number
  actualCostUsd: number
  /**
   * actualCostUsd 是否是精确值。
   *
   * false 表示「成本未知」——provider 没配价格，算不出这次调用花了多少。
   * 这时 actualCostUsd 只是已知部分（通常是 0），**不是精确值**。
   *
   * 为什么必须单独记：把未知成本写成 0，事后读起来就像
   * 「这次调用确实花了 0 元」。那是伪造精确性——比不记更糟。
   */
  actualCostKnown: boolean
  /** 用途，用于诊断（'model' / 'tool' / 'auditor'） */
  purpose: string
  /** 谁占用了这笔额度。没有 owner 时任何调用方都能结算（旧数据）。 */
  owner?: string
  status: ReservationStatus
  createdAt: number
  /** 超过这个时间仍未结算，视为悬挂，可被回收 */
  expiresAt: number
  /** 结算/释放/回收发生的时间 */
  settledAt?: number
}

export interface StepTrace {
  firstTokenMs?: number
  totalMs?: number
  inputTokens?: number
  outputTokens?: number
  servedBy?: string
  costUsd?: number
  toolName?: string
  toolLatencyMs?: number
  retryCount?: number
  routeReason?: string
  /** 结果被截断时记录：原始字节数与保留范围 */
  truncation?: { originalBytes: number; keptBytes: number; reason: string }
}

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'in_progress'
  /** 至少有一个 Run 形成了候选产物，但用户还没做质量决定。 */
  | 'awaiting_acceptance'
  /** 只由用户接受候选产物触发。交付失败不回滚这个状态。 */
  | 'accepted'
  | 'revision_requested'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'expired'
  | 'archived'

export interface Task {
  id: string
  sessionId: string
  goal: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  /** Task 级累计预算。ReviewLoop 多轮返工共用，不每轮重置。 */
  budget?: TaskBudget
  /** 已累计消耗，用于 Task 级预算硬限制 */
  usage?: TaskUsage
}

/**
 * 任务契约的一个版本。
 *
 * 存在的理由：Auditor 之前只看得到「产物文本 + 机器规则」，
 * 看不到「这个任务到底要求完成什么」。于是格式正确、内容完全
 * 跑题的东西也能拿 pass——审计者没有标准可比对。
 *
 * 契约必须**版本化**且**不可变**：
 *   · 每次修改生成新 version + 新 hash，旧版本保留为 superseded
 *   · 审计结果绑定当时的 contractHash，契约变了旧审计就不再适用
 *   · 验收时重新核对，防止「先审计、后改契约」蒙混过关
 */
export interface TaskContract {
  id: string
  taskId: string
  goal: string
  acceptanceCriteria: string[]
  /** 从 1 开始，每次修改 +1 */
  contractVersion: number
  /**
   * 规范化后的契约 JSON。hash 就是它的 sha256。
   *
   * 为什么要把 canonical 文本也存下来：
   * 只存字段的话，重新序列化的结果依赖当时的代码；
   * 存下原文才能证明「当时参与 hash 的到底是哪串字节」。
   */
  canonical: string
  /** sha256(canonical) 的小写十六进制 */
  contractHash: string
  status: 'active' | 'superseded'
  /** 谁创建/修改的。系统自动创建时为 'system'。 */
  actor: string
  createdAt: number
  updatedAt: number
}

export interface TaskBudget {
  maxCostUsd?: number
  maxDurationMs?: number
  maxSteps?: number
  maxCycles?: number
}

export interface TaskUsage {
  costUsd: number
  steps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cycles: number
  startedAt: number
  /** 同 RunUsage.costUnknown：至少有一次调用成本无法计算。 */
  costUnknown?: boolean
}

export interface Run {
  id: string
  taskId: string
  parentRunId?: string
  role: RunRole
  status: RunStatus
  budget: RunBudget
  grantIds: string[]
  startedAt?: number
  endedAt?: number
  /** 累计消耗，用于预算硬限制 */
  usage: RunUsage
  /**
   * 实际使用的模型身份。执行时写入，之后不可改。
   *
   * 为什么必须持久化：审计的模型族隔离校验依赖它。
   * 如果 /review 接受请求体里的 producerModel，
   * 调用方可以把同族模型伪装成不同族，绕过隔离。
   */
  modelIdentity?: ModelIdentity
}

export interface ModelIdentity {
  providerId: string
  modelId: string
  /**
   * 服务端算出的族名，不是调用方可控的。
   *
   * `null` 表示**认不出来**。这不是「没有族」，而是「无法证明它属于哪一族」——
   * 审计时遇到 null 必须 escalate，不能当成「和别的模型不同族」放行。
   */
  modelFamily: string | null
  recordedAt: number
}

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  steps: number
  toolCalls: number
  costUsd: number
  /**
   * 是否至少有一次调用的成本无法计算。
   *
   * true 表示 costUsd 只是「已知部分之和」，不是真实总成本。
   * 任何依赖 costUsd 做判断的地方（比如成本上限）都必须先看这个标志：
   * 成本未知时，costUsd 偏小是必然的，用它做上限判断会 fail-open。
   */
  costUnknown?: boolean
}

export interface Step {
  id: string
  runId: string
  index: number
  kind: StepKind
  status: StepStatus
  input?: unknown
  output?: unknown
  retryCount: number
  /** 重试时指向首次 Step，不覆盖历史 */
  attemptOf?: string
  trace: StepTrace
  createdAt: number
}

// ── 审计 ────────────────────────────────────────────────

/** 机器规则。能由代码判断的，绝不交给模型。 */
export interface MachineRule {
  id: string
  version: string
  description: string
  /** strong = 能判定核心质量；weak = 只能做形式检查 */
  strength: 'strong' | 'weak'
  /** 检查函数。返回 pass / fail / uncertain */
  check(ctx: RuleContext): RuleCheckResult | Promise<RuleCheckResult>
}

export interface RuleContext {
  workspaceRoot: string
  /** 快照 ref，审计只读这个 */
  snapshotRef: string
  /** 产物清单 */
  artifacts: Artifact[]
  /** 读取快照里的文件内容 */
  readFile(relPath: string): Promise<string | null>
  /** 列出快照里的文件 */
  listFiles(): Promise<string[]>
  /** 执行命令（受限，仅 Skill 预先声明的） */
  runCommand?(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export interface RuleCheckResult {
  status: 'pass' | 'fail' | 'uncertain'
  evidence?: string
}

export interface RuleCheck {
  ruleId: string
  ruleVersion: string
  status: 'pass' | 'fail' | 'uncertain' | 'not_applicable'
  phase: 'new' | 'recheck' | 'regression_check'
  evidence?: string
}

/** escalate 的具体原因。用户需要知道「是产物有问题」还是「是系统配置不够」。 */
export type EscalateReason =
  /** 审计者无法判断 */
  | 'uncertain'
  /** 模型族隔离未通过 */
  | 'same_model_family'
  /** 模型族无法识别——无法证明独立性 */
  | 'unknown_model_family'
  /** 产物 contentHash 与快照实际内容不一致 */
  | 'artifact_hash_mismatch'
  /** 产物记录的路径在完成快照里不存在——无法确认审计的是哪份内容 */
  | 'artifact_missing_in_snapshot'
  /** 没有 strong 规则支撑，模型 pass 不能单独放行 */
  | 'no_strong_rules'
  /** 缺少快照 */
  | 'no_snapshot'
  /** 审计调用或解析失败 */
  | 'audit_error'
  /** 任务契约缺失——没有标准就没有审计 */
  | 'contract_missing'
  /** 任务契约损坏或 hash 不一致——内容不可信 */
  | 'contract_invalid'

export interface AuditIssue {
  ruleId: string
  /** 分类特征，用于聚合统计。如 "missing_section"、"broken_reference" */
  feature: string
  /** 0-1 概率。分类器给不出时省略，不要编。 */
  probability?: number
  severity: 'blocking' | 'warning'
  location?: string
  description: string
  evidence?: string
  suggestedFix?: string
}

export interface AuditResult {
  verdict: 'pass' | 'reject' | 'escalate'
  /** verdict 是 escalate 时的具体原因。用户需要知道问题出在产物还是配置。 */
  escalateReason?: EscalateReason
  /** 0-1。是依据，不是放行条件。 */
  confidence?: number
  blockingIssues: AuditIssue[]
  nonBlockingIssues: AuditIssue[]
  checkedRules: RuleCheck[]
  /** 审计依据：引用了哪些 Step / 事件。用例 D（可复现）需要。 */
  evidenceRefs: string[]
  /** 上一轮通过、本轮失败的规则 */
  regression?: boolean
  summary: string
  /**
   * 这次审计到底审的是哪一份东西。
   *
   * 没有这组字段，就无法区分「这个 Artifact 通过审计」
   * 和「同一个 Task 里另一个 Artifact 通过审计」。
   * 验收时必须核对这组绑定关系，否则可以拿 A 的 pass 去接受 B。
   *
   * 两种形态：
   *   · 完整绑定（AuditBinding）→ 可以参与验收判断
   *   · 早期失败的部分绑定（PartialAuditBinding，complete:false）→ 一律不可验收
   */
  binding?: AuditBinding | PartialAuditBinding
}

/**
 * 审计绑定：这个结论到底审的是哪一份东西。
 *
 * **所有字段都是必填的**，没有「可选」这一档。
 *
 * 为什么不允许可选：
 *   可选字段意味着「忘了填也能通过」，而忘了填的后果是
 *   验收时无法确认审计与产物的对应关系。旧实现里
 *   `snapshotId?` / `contractHash?` 都是可选的，
 *   于是可以拿一条「什么都绑不上」的 pass 去验收任何产物。
 *
 * 允许不完整的绑定，等于允许「审计结论与审计对象脱钩」。
 */
export interface AuditBinding {
  taskId: string
  cycleId: string
  /** 被审计的产物 id 列表。不能为空。 */
  artifactIds: string[]
  producerRunId: string
  snapshotId: string
  snapshotRef: string
  /** 产物路径 → 内容哈希。必须覆盖每一个被审计的产物。 */
  contentHashes: Record<string, string>
  contractHash: string
  contractVersion: number
}

/**
 * 早期失败（契约缺失 / 无快照 / 契约损坏）的审计结果。
 *
 * 这类结果无法构成完整绑定——比如契约缺失时根本没有 contractHash。
 * 但它们仍然要能回答「审的是哪个 Task、哪一轮、哪些产物」。
 *
 * 用 `complete: false` 显式标记：验收时**必须**拒绝，
 * 不允许把它当成「字段刚好缺失的完整绑定」。
 */
export interface PartialAuditBinding {
  complete: false
  taskId: string
  cycleId: string
  artifactIds: string[]
  producerRunId: string
  /** 失败原因，用于事后追溯 */
  failureReason: string
}

/**
 * ReviewCycle。
 *
 * 注意：不存独立的可修改 status。
 * 状态由关联的 Run / Step / AuditResult 推导，避免事实分裂。
 */
export interface ReviewCycle {
  id: string
  taskId: string
  skillId: string
  skillVersion: string
  cycleNumber: number
  producerRunId: string
  auditorRunId?: string
  /** 审计结果。没有则为「还没审计」 */
  auditResultId?: string
  createdAt: number
}

/** 已持久化的审计结果 */
export interface StoredAuditResult {
  id: string
  cycleId: string
  taskId: string
  verdict: AuditResult['verdict']
  confidence?: number
  result: AuditResult
  createdAt: number
}

/** 审计所需的 Skill 定义。第一版只保留最小字段。 */
export interface AuditSkill {
  id: string
  version: string
  name: string
  /** 机器规则。先跑，失败短路。 */
  machineRules: MachineRule[]
  /** Auditor 的指令 */
  auditorInstructions: string
  /** 最多几轮返工 */
  maxCycles: number
}

export interface GrantConstraints {
  maxCalls?: number
  allowedPaths?: string[]
  allowedHosts?: string[]
  maxBytes?: number
}

export interface Grant {
  id: string
  runId: string
  toolId: string
  scope?: unknown
  constraints: GrantConstraints
  expiresAt: number
  status: 'active' | 'revoked' | 'expired'
  approver?: string
  /** 已使用次数，用于 maxCalls */
  usedCalls: number
}

/**
 * ToolIntent：一次外部副作用调用的持久化记录。
 *
 * 存在的唯一理由：**进程会在任何时刻死掉**。
 *
 * 没有它的时候，系统面对「文件已经写了，但结果还没落库就崩了」只能靠猜：
 * 要么重试（可能写两次），要么放弃（可能漏写）。两者都是错的。
 *
 * 有了它，重启后可以准确回答：这次 toolCallId 调用进行到哪一步了？
 *
 * 状态机（只能通过条件更新转换）：
 *
 *   prepared ──→ started ──→ committed
 *                   ├──→ failed
 *                   └──→ unknown ──→ reconciled
 *
 * 禁止：
 *   committed → started      （已成功的不能重放）
 *   unknown   → started      （不知道结果时自动重试，会制造第二次副作用）
 *   failed    → started      （同上，且 failed 不代表外部没生效）
 *
 * 注意 `unknown → reconciled` **不是**「重试」：
 * reconciled 只表示「有人查证过了」，查证结果记录在 resolution 里，
 * 不自动再执行一次工具。
 */
export type ToolIntentStatus =
  | 'prepared'
  | 'started'
  | 'committed'
  | 'failed'
  | 'unknown'
  | 'reconciled'

export interface ToolIntent {
  id: string
  runId: string
  stepId: string
  /** 模型发出的 tool_call id。同一 Run 内唯一。 */
  toolCallId: string
  toolId: string
  /** 工具名（用于展示与对账提示） */
  toolName: string
  /** 参数的稳定哈希。相同参数 + 相同工具 = 同一个操作。 */
  requestHash: string
  /**
   * 操作键：跨重试保持稳定的标识。
   *
   * 支持幂等键的外部服务可以拿它当 idempotency-key，
   * 服务端据此去重；不支持的只能靠 reconciled 人工处理。
   */
  operationKey: string
  status: ToolIntentStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  /** 工具返回内容的哈希。用于确认「缓存的结果就是当时的结果」。 */
  resultHash?: string
  /** 结果内容。committed 后重放时直接返回它，不再调用工具。 */
  resultContent?: string
  resultIsError?: boolean
  error?: string
  unknownReason?: string
  /** 对账结论（仅 reconciled 状态有值） */
  resolution?: string
}

export interface Approval {
  id: string
  runId: string
  stepId: string
  toolId: string
  /** 模型发出的 tool_call id。恢复执行时必须用它把结果对回去。 */
  toolCallId: string
  arguments: unknown
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  reason?: string
  decidedAt?: number
  createdAt: number
  /** 审批超时时间。超时后自动转为 rejected（fail-closed）。 */
  expiresAt: number
  /**
   * 结果是否已经回填进 Run 历史。
   * 恢复执行时靠它区分「还没执行的审批」和「已经处理完的审批」，
   * 避免重复执行工具（尤其是写操作）。
   */
  resultConsumed: boolean
  /**
   * 谁做的决定。
   *
   *   user   用户在界面上点了批准/拒绝
   *   system 内核按 fail-closed 规则自动拒绝（超时）
   *
   * 由服务端写入，请求体不能指定：否则客户端可以声称自己是 system，
   * 让一次「用户批准」在审计里看起来像「系统自动放行」。
   */
  approver?: 'user' | 'system'
}

/**
 * unknown 的解决记录。
 *
 * `unknown` 表示「请求中断，无法确认外部操作是否已发生」。
 * 这个状态不能自动消除——必须有人（用户或对账工具）做出判断。
 * 没有这条记录，「未解决」和「已解决」在数据上无法区分。
 */
export interface ReconciliationRecord {
  id: string
  runId: string
  stepId: string
  /**
   * 这次裁决针对的 ToolIntent。
   *
   * 为什么必须绑定：Step 只是执行轨迹，Intent 才是
   * 「这次外部调用到底怎么样了」的记录。只绑 Step 会让
   * 「这条裁决对应哪次副作用」变得模糊——尤其是审批恢复路径，
   * Step 每次恢复都会新建，而 Intent 是跨恢复稳定的。
   */
  intentId?: string
  /** 模型的 tool_call id，与 Intent 一致 */
  toolCallId?: string
  /** 为什么无法确认 */
  unknownReason: string
  /** 最终裁决 */
  resolution: 'confirmed_success' | 'confirmed_failure' | 'abandoned' | 'retried'
  /** 凭什么这么判断（对账查询结果、用户观察、工具日志等，结构化 JSON） */
  evidence?: string
  decidedBy: 'user' | 'reconciler' | 'system'
  decidedAt: number
}

export interface DeniedRequest {
  runId: string
  toolId: string
  argumentHash: string
  reason: string
  createdAt: number
}

/**
 * 工具会不会改变外部状态。
 *
 * **与 riskLevel 是两个独立的维度**，不能互相替代：
 *
 *   riskLevel  回答「要不要先问用户」
 *   sideEffect 回答「重复执行是否安全」
 *
 * 反例：一个只读的 HTTP GET（riskLevel=read）可能计费、写对方访问日志、
 * 触发限流——重复执行不是无害的。用 riskLevel 判断能否重试会误判。
 */
/**
 * 模型能力声明。
 *
 * 为什么需要它：能力不是「有 / 没有模型」，而是「这个模型能做什么」。
 * 把能力显式化后，两件事才能做对：
 *   · 选模型时按需求过滤（需要看图的任务不能派给纯文本模型）
 *   · 审计时区分「它答得不好」和「它根本做不了这件事」
 *
 * 声明来源必须可信：由 provider 预设声明，不接受请求体自称。
 */
export type ModelCapability =
  /** 文本输入 / 输出 */
  | 'text'
  /** 图像输入 */
  | 'vision'
  /** 图像生成 */
  | 'image_generation'
  /** 工具调用 / function calling */
  | 'tool_calling'
  /** 流式输出 */
  | 'streaming'
  /** 推理模型（可显式提高推理预算） */
  | 'reasoning'
  /** 长上下文（>= 100k tokens） */
  | 'long_context'
  /** 结构化输出（JSON schema 约束） */
  | 'structured_output'
  /** 本地运行（数据不出本机） */
  | 'local'

/** 一个模型的可信能力声明。 */
export interface ModelCapabilities {
  providerId: string
  modelId: string
  modelFamily: string
  capabilities: ModelCapability[]
  /** 上下文窗口（tokens）。未知时为 undefined，不猜。 */
  contextWindow?: number
  /** 单次最大输出 tokens。未知时为 undefined。 */
  maxOutputTokens?: number
  /** 是否在本地运行（数据不出本机）。 */
  local: boolean
}

export type SideEffect =
  /** 纯计算或只读本地，重复执行完全无害 */
  | 'none'
  /** 写本地文件系统 */
  | 'filesystem'
  /** 调用外部服务（网络、数据库、第三方 API） */
  | 'external'

export interface ToolDefinition {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  source: 'builtin' | 'mcp'
  serverId?: string
  riskLevel: RiskLevel
  /**
   * 副作用等级。**决定这个工具是否需要 ToolIntent 保护。**
   *
   * 只有 `'none'` 才允许绕过 Intent。
   * 不填时按 riskLevel 推断（read → none，write/external → filesystem），
   * 但这是兼容旧工具的兜底，新工具必须显式声明。
   */
  sideEffect?: SideEffect
  /** 外部服务是否接受幂等键（决定能否安全重试） */
  supportsIdempotencyKey?: boolean
  /** 工具是否响应 AbortSignal。false 时超时可能留下晚到的副作用。 */
  cancellable?: boolean
  enabled: boolean
  timeoutMs: number
  maxOutputBytes: number
  /** unknown 状态的对账策略 */
  reconcile: {
    idempotent: boolean
    queryToolId?: string
    unsafeToRetry: boolean
  }
}

export type ArtifactStatus = 'candidate' | 'accepted' | 'rejected' | 'superseded'

export interface Artifact {
  id: string
  taskId: string
  runId: string
  type: 'code_diff' | 'file' | 'report' | 'image' | 'dataset' | 'bundle' | 'text' | 'code'
  /** 相对工作区根目录的路径 */
  path?: string
  /** 内容哈希，用于比对与去重 */
  contentHash?: string
  /** 指向 Snapshot 的 ID */
  sourceSnapshotId?: string
  version: number
  parentArtifactId?: string
  status: ArtifactStatus
  createdAt: number
}

/**
 * 用户对产物质量的明确决定。
 *
 * 关键：这只表示「质量决定」，与「是否成功应用/导出」无关。
 * 交付失败不得抹掉接受证据。
 */
export interface AcceptanceRecord {
  id: string
  taskId: string
  /** 被接受的产物 */
  artifactId: string
  runId: string
  status: 'pending' | 'accepted' | 'revision_requested' | 'rejected'
  /** 要求返工时的说明，会作为下一轮 Producer 的输入 */
  revisionNote?: string
  /**
   * 人工放行不可复现快照时记录的操作者。
   *
   * 为什么必须留痕：不可复现意味着「无法从快照重建这份内容」，
   * 验收它等于信任用户当时看到的东西。这是一个**例外**，
   * 例外必须能回答「谁批的、为什么批」。
   */
  overrideActor?: string
  overrideReason?: string
  decidedAt?: number
  createdAt: number
  /**
   * 谁做的这个质量决定。
   *
   * 由服务端写入，不接受请求体指定：'user' 是用户路径，'system' 只用于
   * 内部自动路径（例如策略驱动的自动接受）。默认 'user'——
   * 声称 system 是更强的声明，必须显式。
   */
  decidedBy?: 'user' | 'system'
}

/**
 * 交付动作的记录。
 *
 * 与 AcceptanceRecord 分开的原因：
 * 用户可能已经认可了内容质量，但导出时磁盘满了。
 * 这不该把「用户接受」这个事实抹掉。
 */
export interface DeliveryRecord {
  id: string
  taskId: string
  acceptanceId: string
  artifactId: string
  action: 'apply' | 'export'
  status: 'pending' | 'running' | 'applied' | 'exported' | 'conflict' | 'failed' | 'cancelled'
  /** 交付失败或冲突的原因 */
  error?: string
  /** 应用/导出到哪里 */
  destination?: string
  createdAt: number
  endedAt?: number
  /** 谁触发了这次交付。服务端写入，默认 'user'。 */
  actor?: 'user' | 'system'
}

/**
 * 快照。审计只读快照，不读变化中的目录。
 */
export interface Snapshot {
  id: string
  runId: string
  taskId: string
  kind: 'workspace' | 'artifact' | 'source'
  /** git ref 或内容寻址路径 */
  ref: string
  /** 是否可完整复现。外部副作用导致的不可复现必须显式标记。 */
  reproducible: boolean
  /** 不可复现的原因 */
  notReproducibleReason?: string
  /** 快照覆盖的文件数 */
  fileCount: number
  /** 快照总字节数 */
  totalBytes: number
  createdAt: number
  /**
   * 软删除时间。
   *
   * 为什么是软删除而不是直接删：快照可能是「某个产物为什么长这样」的
   * 唯一证据。硬删会在「还被人引用」时无声地毁掉证据链。
   * 软删除让对象先不可见、可审计，之后由 GC 决定是否真正回收。
   */
  deletedAt?: number
}

// ── 模型消息 ─────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串；流式时可能分片到达 */
  arguments: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean }

export interface ModelInfo {
  id: string
  label?: string
}

export interface ProviderConfig {
  id: string
  name: string
  /** 协议类型。demo 是本地模拟，不需要网络。 */
  kind: 'openai' | 'anthropic' | 'demo'
  baseUrl: string
  apiKey?: string
  requiresKey: boolean
  includeUsage?: boolean
  maxTokensParam?: 'none' | 'max_tokens' | 'max_completion_tokens'
  /** 每百万 token 价格（输入/输出），用于成本核算 */
  pricing?: { input: number; output: number }
}

// ── 公共契约：事件、错误、执行者 ─────────────────────────
//
// 这一节是 foundation-contracts 的一部分，后续区块（workgroup / quality-gates /
// autonomous-runner / desktop）只依赖这里的定义，不重新发明字段。

/** 事件的聚合根类型。 */
export type EventAggregateType =
  | 'conversation'
  | 'project'
  | 'task'
  | 'run'
  | 'artifact'
  | 'review'
  | 'job'

/** 事件写入者。 */
export type EventActor = 'user' | 'coordinator' | 'role' | 'system' | 'provider'

/**
 * 领域事件。
 *
 * `sequence` 由存储层在**同一事务内**原子分配，对 `(aggregateType, aggregateId)`
 * 唯一并且从 1 开始连续。绝不能用「先读 MAX 再插入」——
 * 那是竞争实现，两个并发写入会拿到同一个序号。
 *
 * `correlationId` 用一个请求 / 一次 Run 贯穿所有事件，
 * 让「这一串事件属于同一次操作」可以被查询，而不是靠时间戳猜。
 */
export interface DomainEvent {
  /** 全局自增 id（回放顺序）。与 sequence 不同：sequence 只在聚合内有序。 */
  id: number
  aggregateType: EventAggregateType
  aggregateId: string
  /** 聚合内序号，从 1 开始，连续无洞 */
  sequence: number
  kind: string
  actor: EventActor
  payload: unknown
  occurredAt: number
  correlationId: string
  /**
   * 聚合 id 是否是**推定**出来的（调用方没给，由 payload 推断后仍退回 runId）。
   *
   * 事件回放按聚合查询。推定错的事件不会报错，只是「查不到」——
   * 那是最难发现的一类错误。标出来让 invariant 扫描能报告它。
   */
  aggregateIdInferred?: boolean
}

/** 写入事件时可以省略的参数。 */
export interface EventAppendOptions {
  actor?: EventActor
  aggregateType?: EventAggregateType
  aggregateId?: string
  correlationId?: string
}

/**
 * 通用版本化契约的作用域。
 *
 * 与 task_contract 的关系：task_contract 是 scope='task' 的**领域专用**形态
 * （带 goal / acceptanceCriteria）。其他策略（权限、项目、无人值守）
 * 只需要「版本化 + 单 active + 内容哈希」，用这张通用表。
 */
export type DomainContractScope =
  | 'task'
  | 'project'
  | 'workspace'
  | 'role'
  | 'policy'
  | 'unattended'
  | 'review'

/**
 * 通用版本化契约记录。
 *
 * 不变量（由 Store 与唯一索引共同保证）：
 *   · (scope, scopeId, version) 唯一
 *   · 同一 (scope, scopeId) 最多一条 status='active'
 *   · contentHash = sha256(content)，content 是规范化 JSON
 *   · superseded 记录永不删除（历史必须可回答「改之前是什么」）
 */
export interface DomainContract {
  id: string
  scope: DomainContractScope
  scopeId: string
  version: number
  /** 规范化 JSON 文本 */
  content: string
  contentHash: string
  status: 'active' | 'superseded'
  actor: string
  createdAt: number
  supersededAt?: number
}

/**
 * 领域错误码。
 *
 * 三个契约性字段：
 *   code       稳定的机器可读标识，调用方按它分支
 *   retryable  这个错误重试是否有意义
 *   httpStatus HTTP 层映射（IPC 层用同一个数字表达同样的语义）
 *
 * 为什么 code 必须是封闭集合：见 `src/core/errors.ts` 的说明。
 */
export interface DomainErrorBody {
  code: string
  message: string
  retryable: boolean
  /** 可选的已脱敏细节。绝不能放密钥、堆栈或第三方原始响应。 */
  details?: unknown
  /** 贯穿日志与响应的关联 id。 */
  correlationId: string
}
