// RunExecutor —— 唯一的写入权威。
//
// 职责边界（严格）：
//   · 工具本身不得修改 Run / Step / Grant，只能返回结果
//   · 所有状态变更都经过这个类
//   · 预算在每次模型调用和每次工具调用前检查，超限立即中断
//
// 一次 execute() 的完整生命周期：
//   queued → running → (paused ↔ running)* → completed | failed | cancelled | expired
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { modelFamily } from './audit.js'
import type {
  Approval,
  Artifact,
  ChatMessage,
  Grant,
  ModelInfo,
  ProviderConfig,
  ReconciliationRecord,
  Run,
  RunBudget,
  RunStatus,
  RunRole,
  Snapshot,
  Step,
  SideEffect,
  StepStatus,
  StepTrace,
  Task,
  ToolCall,
  ToolDefinition,
  ToolIntent,
} from '../shared/types.js'
import { Store } from './store.js'
import { ToolRegistry, runWithTimeout, validateArgs } from './tools.js'
import type { ToolImpl } from './tools.js'
import { clampToolOutput, estimateMessages, fitToBudget, tidy } from './prompt.js'
import { hashArguments } from './paths.js'
import { RUN_EXECUTABLE_FROM, canTransition } from './state-machine.js'
import type { LeaseGuard } from './lease-fencing.js'
import { adapterFor, estimateCost, providerModelConflict } from '../providers/registry.js'
import type { ProviderAdapter, StreamHandlers } from '../providers/types.js'

/** 适配器协议类型。与 ProviderConfig['kind'] 一致。 */
type ProviderKind = 'openai' | 'anthropic' | 'demo'

export interface SnapshotHook {
  /** 拍快照。返回 ref、文件数、字节数 */
  capture(): Promise<{ ref: string; fileCount: number; totalBytes: number }>
  /**
   * 从快照里读取文件内容。
   *
   * 必须从快照读，不能从工作区读——工作区在拍完快照后可能还会被改动，
   * 那时算出来的哈希与快照内容不一致，交付时的校验会失败。
   */
  readFileAt(ref: string, relPath: string): Promise<string | null>
}

export interface ExecutorConfig {
  /** 单次 Run 允许的工作区根目录。路径校验以此为界。 */
  workspaceRoots: string[]
  /** 上下文预算上限（token）。超过则丢弃最旧的消息。 */
  contextBudget: number
  /** 预留输出空间 */
  outputReserve: number
  /** 最大工具循环轮数，防止模型无限调用 */
  maxToolRounds: number
  /** 审批超时（毫秒）。超时 fail-closed，按拒绝处理。 */
  approvalTimeoutMs?: number
  /** 快照钩子。不提供则跳过快照（用于测试或 git 不可用的环境）。 */
  snapshot?: SnapshotHook
}

export interface ExecuteOptions {
  runId: string
  provider: ProviderConfig
  model: ModelInfo
  system?: string
  /** 初始消息（不含 system） */
  messages: ChatMessage[]
  /**
   * 允许从 running 状态重入。
   *
   * 只应在「确认这个 running 是上次进程异常退出留下的」时使用。
   * 默认 false：running 表示已被占用，不允许并发重入。
   */
  resumeStale?: boolean
  signal: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onStep?: (step: Step) => void
  onStatusChange?: (run: Run) => void
  /**
   * 租约守卫。
   *
   * 传入时，执行器会在每个关键写入前校验 epoch：
   * 一旦被接管，本次执行的所有状态写入都会被拒绝，
   * 不会污染新 owner 的 Run。
   *
   * 不传时行为与以前一致（单进程 / 测试直接调用）。
   */
  leaseGuard?: LeaseGuard
}

export type ExecuteOutcome =
  | { status: 'completed'; text: string; run: Run }
  | { status: 'failed'; error: string; run: Run }
  | { status: 'cancelled'; run: Run }
  /** 需要审批时带 approval；被状态门拦截时只带 reason。 */
  | { status: 'paused'; approval?: Approval; reason?: string; run: Run }
  | { status: 'expired'; reason: string; run: Run }
  /**
   * 有未解决的 unknown 外部操作，必须先对账。
   *
   * 与 failed 的区别：failed 是明确失败，可以重试；
   * needs_reconciliation 是「不知道成没成」，不能自动重试。
   * 调用方如果把它当 failed 处理并重试，就会重复执行副作用。
   */
  | { status: 'needs_reconciliation'; reason: string; run: Run }
  /**
   * 租约已被其他执行者接管，本次结果不被采纳。
   *
   * 与 failed 的区别：这不是「执行失败」，而是「这次执行的结果没有资格
   * 写入」。Run 的真实状态由新 owner 决定，这里只如实报告。
   */
  | { status: 'lease_lost'; reason: string; run: Run }

/**
 * 根据 Run 的真实状态构造 outcome。
 *
 * 用于「想写某个终态但状态已被别人改了」的情况：
 * 返回的是**事实**，不是我们的意图。硬编 status 会让调用方
 * 以为「取消成功了」，而实际状态可能是 cancelled 也可能是 completed。
 */
function outcomeForExisting(run: Run, error?: string): ExecuteOutcome {
  switch (run.status) {
    case 'completed': return { status: 'completed', text: '', run }
    case 'failed': return { status: 'failed', error: error ?? '执行失败', run }
    case 'cancelled': return { status: 'cancelled', run }
    case 'expired': return { status: 'expired', reason: error ?? '已过期', run }
    case 'needs_reconciliation':
      return { status: 'needs_reconciliation', reason: error ?? '需要人工对账', run }
    case 'paused':
    case 'waiting_approval':
      return { status: 'paused', ...(error ? { reason: error } : {}), run }
    default:
      return { status: 'failed', error: error ?? `Run 处于 ${run.status} 状态`, run }
  }
}

/**
 * 从 Step 的 output 里提取 unknown 的原因。
 *
 * 不能假设固定结构——不同来源（超时、崩溃清理、外部中断）
 * 写入的 output 形态不同。这里做多形态兼容，拿不到才用兜底文案。
 */
function extractUnknownReason(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>
    for (const key of ['error', 'reason', 'message', 'detail']) {
      const v = o[key]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  return '未知原因（未能从 Step 记录中提取）'
}

/**
 * 对账证据不合法。
 *
 * 单独一个类型，而不是靠匹配错误文案：
 * 服务层据此返回 400（请求不合法），
 * 而其他 reconcile 错误（Step 不存在、归属不符）各有自己的状态码。
 */
export class InvalidReconcileEvidence extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReconcileEvidence'
  }
}

/**
 * execute() 的调用方参数不合法。
 *
 * 单独一个类型，理由与 InvalidReconcileEvidence 相同：
 * 这是**请求**的问题，不是 Run 的问题。服务层必须映射到 400，
 * 而不是 500——500 会告诉客户端「服务端坏了，重试吧」，
 * 而它真正要做的是改请求体。
 *
 * 抛出这个错误时 Run 状态**没有任何变化**：校验发生在状态门和 CAS 之前。
 */
export class InvalidExecuteRequest extends Error {
  /**
   * 领域错误码。
   *
   * 必须有：这是**请求**错误（messages 里有 system 消息、未知 role 等），
   * 应该映射到 400。没有 code 的错误会被统一归一化成 INTERNAL → 500，
   * 而 500 会让客户端以为服务端坏了、去重试同一个错误请求。
   */
  readonly code = 'INVALID_INPUT' as const

  constructor(message: string) {
    super(message)
    this.name = 'InvalidExecuteRequest'
  }
}

/**
 * reconcile 的状态/归属错误。
 *
 * 为什么需要单独的类型：
 * 服务层的 `statusForError` 优先读 `code`，读不到才退回正则匹配文案。
 * reconcile 抛的是普通 Error，只能走正则兜底——而兜底正则
 * 认不出「必须通过 intentId 或 toolCallId 指定」这类新文案，
 * 于是本该是 409 的请求歧义变成了 500。
 *
 * 这是本文件注释里反复警告过的形态：新增错误文案时必须记得
 * 同步正则，忘了就变成 500。用 code 就不用记。
 *
 * 状态码的归属：
 *   409  资源存在，但当前状态不允许这个操作
 *        （Step 已解决、多个 unknown 无法确定目标、Intent 与 Step 不符）
 *   404  被引用的资源不存在
 */
export class ReconcileError extends Error {
  readonly code: 'STATE_CONFLICT' | 'NOT_FOUND'
  constructor(message: string, code: 'STATE_CONFLICT' | 'NOT_FOUND' = 'STATE_CONFLICT') {
    super(message)
    this.name = 'ReconcileError'
    this.code = code
  }
}

/** reconcile 证据的结构。 */
interface ReconcileEvidence {
  type: 'external_query' | 'manual_inspection' | 'tool_log'
  source: string
  observed: 'exists' | 'not_found' | 'partial' | 'indeterminate'
  /**
   * 证据声称的操作者。
   *
   * **只用于记录，不用于决定 decidedBy**。
   * 谁做的裁决由服务端（trusted 标记 / HTTP 层）决定，
   * 请求体里写什么都改变不了这一点。
   */
  actor: string
  /** 可验证来源必须给出具体路径（file_stat 用）。 */
  path?: string
  observedAt?: number
  contentHash?: string
  note?: string
}

/**
 * 需要服务端重新验证的证据来源。
 *
 * `file_stat` 是唯一能在这里真实验证的：
 * 服务端可以自己 stat + 读文件，不依赖调用方的说法。
 *
 * 其他来源（db_query / git / tool_log）需要连接外部系统，
 * 本进程无法独立验证 → 只能走人工复核，不能自动解除 unknown。
 */
const SERVER_VERIFIABLE_SOURCES = new Set(['file_stat'])

/**
 * 解析并校验对账证据。
 *
 * 拒绝的情况（都会抛错，调用方映射成 400）：
 *   · 空 / 纯空白
 *   · 不是 JSON
 *   · 缺必需字段
 *   · observed 与 resolution 矛盾
 *
 * **为什么要求 JSON 而不是随便一段文字**：
 * 如果只要求「非空字符串」，那么 `"我确认过了"` 就能解除 unknown。
 * 那等于把「不确定」改成「确定」只差一次点击——
 * reconcile 就不再是证据校验，而是免责声明。
 *
 * 结构化字段本身不能保证人说真话，但它至少强制区分：
 *   「查过文件系统，看到 exists」 vs 「我觉得应该成功了」。
 */
function parseReconcileEvidence(
  raw: string | undefined,
  resolution: ReconciliationRecord['resolution'],
): ReconcileEvidence {
  if (!raw || !raw.trim()) {
    throw new InvalidReconcileEvidence(
      '对账必须提供证据：unknown 表示「不知道外部发生了什么」，' +
      '解除它需要可核验的依据，不能只写一句确认。',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidReconcileEvidence(
      '对账证据必须是 JSON 对象，包含 type / source / observed / actor。' +
      '纯文字描述无法核验，不能解除 unknown。',
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidReconcileEvidence('对账证据必须是 JSON 对象')
  }

  const o = parsed as Record<string, unknown>
  const type = o.type
  const source = o.source
  const observed = o.observed
  const actor = o.actor

  const validTypes = ['external_query', 'manual_inspection', 'tool_log']
  if (typeof type !== 'string' || !validTypes.includes(type)) {
    throw new InvalidReconcileEvidence(`对账证据的 type 必须是 ${validTypes.join(' / ')} 之一`)
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw new InvalidReconcileEvidence('对账证据必须说明 source（具体从哪查的，如 file_stat / git / db_query）')
  }
  if (typeof actor !== 'string' || !actor.trim()) {
    throw new InvalidReconcileEvidence('对账证据必须说明 actor（谁做的判断）')
  }

  const validObserved = ['exists', 'not_found', 'partial', 'indeterminate']
  if (typeof observed !== 'string' || !validObserved.includes(observed)) {
    throw new InvalidReconcileEvidence(`对账证据的 observed 必须是 ${validObserved.join(' / ')} 之一`)
  }

  // 自洽性检查：这是「随手点确认」最容易穿帮的地方
  if (resolution === 'confirmed_success' && observed === 'not_found') {
    throw new InvalidReconcileEvidence(
      '证据自相矛盾：裁决是 confirmed_success，但 observed=not_found。' +
      '请重新核对后再对账。',
    )
  }
  if (resolution === 'confirmed_failure' && observed === 'exists') {
    throw new InvalidReconcileEvidence(
      '证据自相矛盾：裁决是 confirmed_failure，但 observed=exists。' +
      '请重新核对后再对账。',
    )
  }
  // indeterminate 不能支撑任何「确认」类裁决——
  // 它本身就是「还是不知道」，那就该保持 unknown
  if (observed === 'indeterminate' &&
      (resolution === 'confirmed_success' || resolution === 'confirmed_failure')) {
    throw new InvalidReconcileEvidence(
      '证据的 observed=indeterminate 表示仍然无法确认，' +
      '不能用来支持 confirmed_success / confirmed_failure。',
    )
  }

  return {
    type: type as ReconcileEvidence['type'],
    source: source.trim(),
    observed: observed as ReconcileEvidence['observed'],
    actor: actor.trim(),
    path: typeof o.path === 'string' ? o.path : undefined,
    observedAt: typeof o.observedAt === 'number' ? o.observedAt : undefined,
    contentHash: typeof o.contentHash === 'string' ? o.contentHash : undefined,
    note: typeof o.note === 'string' ? o.note : undefined,
  }
}

/**
 * 取工具的副作用等级。
 *
 * 优先用显式声明。没声明时按 riskLevel 兜底推断，
 * 但**兜底方向是保守的**：write/external 一律当有副作用。
 *
 * 为什么不干脆要求必填：现有代码里还有测试用的临时工具没加这个字段，
 * 强制必填会一次性打断几十处。兜底规则写在这里，新工具应该显式声明。
 */
function sideEffectOf(def: { sideEffect?: SideEffect; riskLevel: string }): SideEffect {
  if (def.sideEffect) return def.sideEffect
  return def.riskLevel === 'read' ? 'none' : 'filesystem'
}

/** 预算超限异常，与普通错误区分开，便于映射到 expired 状态 */
class BudgetExceeded extends Error {
  constructor(readonly dimension: string, readonly limit: number) {
    super(`预算超限：${dimension} 超过 ${limit}`)
    this.name = 'BudgetExceeded'
  }
}

export class RunExecutor {
  /** 适配器解析器。默认按 provider.kind 取内置适配器；测试或扩展时可替换。 */
  private resolveAdapter: (kind: ProviderKind) => ProviderAdapter

  constructor(
    private store: Store,
    private tools: ToolRegistry,
    private config: ExecutorConfig,
    adapterResolver?: (kind: ProviderKind) => ProviderAdapter,
  ) {
    this.resolveAdapter = adapterResolver ?? adapterFor
  }

  // ── 公共入口 ─────────────────────────────────────────────

  async execute(opts: ExecuteOptions): Promise<ExecuteOutcome> {
    const run = this.store.getRun(opts.runId)
    if (!run) throw new Error(`Run 不存在：${opts.runId}`)

    // ── 调用方参数校验（在任何状态变更之前）───────────────
    //
    // 放在状态门和 CAS 之前是刻意的：这些是**调用方传错了参数**，
    // 不是 Run 本身出了问题。如果先抢到 running 再报错，一个
    // 打错的 model 名就能把 Run 烧成 failed，用户必须重建 Run。
    // 参数错误应该 throw —— 与「Run 不存在」同一档，不改变任何状态。

    // provider 与 model 自相矛盾（例如用 openai 跑 claude）。
    //
    // 只拦「能被证明为假」的组合，不拦「认不出」的模型——
    // 后者在审计阶段按 unknown_model_family escalate，
    // 在这里拦等于禁止所有新模型。
    const conflict = providerModelConflict(opts.provider.id, opts.model.id)
    if (conflict) {
      throw new InvalidExecuteRequest(
        `provider 与 model 不匹配：${conflict}。` +
        '这条声明本身是假的，执行它会写下一份不可信的身份记录，' +
        '后面的模型族隔离校验也就失去依据。请改成匹配的组合。',
      )
    }

    // messages 只接受 user / assistant / tool。
    //
    // 为什么 system 单独给一条提示：它是这里唯一有安全含义的越界。
    // messages 是「对话历史」，system 是「指令」。混在一起时无法区分
    // 哪一条 system 是产品注入的、哪一条是调用方塞进来的；而下游的
    // tidy() / fitToBudget() 都会保留 system 消息，等于让它带着指令
    // 权限直达模型。system 只能走 opts.system 这个唯一的通道。
    //
    // 为什么未知角色也拒绝而不是「不认识就当 user」：那等于把一条
    // 来源不明的消息提升成用户指令。适配器只转发这三种角色，
    // 其余角色在线上协议里根本不存在，唯一的作用就是骗过校验。
    //
    // 为什么拦而不是过滤：静默丢弃会让调用方以为自己设置的角色生效了。
    for (let i = 0; i < opts.messages.length; i++) {
      const role = (opts.messages[i] as { role?: unknown }).role
      if (role === 'user' || role === 'assistant' || role === 'tool') continue

      if (role === 'system') {
        throw new InvalidExecuteRequest(
          `messages[${i}] 的 role 是 system。` +
          'system 指令必须通过 opts.system 传入，不能夹在 messages 里。' +
          'messages 只接受 user / assistant / tool。',
        )
      }
      throw new InvalidExecuteRequest(
        `messages[${i}] 的 role 是 ${JSON.stringify(role)}，` +
        '不是 user / assistant / tool。未知角色不会被当成 user 处理。',
      )
    }

    // ── 状态门（阻塞级） ──────────────────────────────────
    //
    // 只能从 queued 或 running 进入执行。
    // 其他状态的恢复路径各不相同，混在一起会绕过安全检查：
    //   paused              → 必须走 resume()（用户主动暂停，允许恢复）
    //   waiting_approval    → 必须走 approve/reject（不能直接跑）
    //   needs_reconciliation→ 必须走 reconcile（有未确认的副作用）
    //   completed/failed/cancelled/expired → 终态，禁止重执行
    const gate = this.checkExecuteGate(run)
    if (!gate.allowed) {
      // 每种状态带上对应的说明字段，调用方才可能知道该怎么办
      switch (gate.resultStatus) {
        case 'failed':
          return { status: 'failed', error: gate.reason, run }
        case 'paused':
          return { status: 'paused', reason: gate.reason, run }
        case 'needs_reconciliation':
          return { status: 'needs_reconciliation', reason: gate.reason, run }
        case 'expired':
          return { status: 'expired', reason: gate.reason, run }
        case 'completed':
          return { status: 'completed', text: gate.reason, run }
        case 'cancelled':
          return { status: 'cancelled', run }
        default:
          return { status: 'failed', error: gate.reason, run }
      }
    }

    // ── 有未解决的 unknown 时，不能继续执行 ──────────────
    if (this.store.hasUnresolvedUnknown(run.id)) {
      this.store.transitionRunStatus(run.id, ['queued', 'running'], 'needs_reconciliation')
      return {
        status: 'needs_reconciliation',
        reason: '这个 Run 有未解决的 unknown 操作，必须先对账确认后才能继续',
        run: this.store.getRun(run.id)!,
      }
    }

    // ── CAS 抢状态：只有抢到的人才真正开始执行 ────────────
    //
    // 只能从 queued 迁移到 running。
    //
    // 不能把 running 也放进起始状态集合：那样两个并发请求
    // 都会匹配到 status='running' 并"成功"更新成 running，
    // 结果两个都开始执行、模型被调用两次。
    //
    // running 表示"已经被某个执行者占用"，不应该再被抢。
    // 崩溃后需要恢复的场景，应该由 restore/对账路径处理，
    // 而不是让 execute 自己重入。
    //
    // opts.resumeStale 用于崩溃恢复：调用方明确知道这个 running 是上次
    // 异常退出留下的，才允许重入。默认不允许，避免并发重入。
    const claimFrom: RunStatus | RunStatus[] = opts.resumeStale
      ? ['queued', 'running']
      : 'queued'
    // ── 用 epoch 认领（fencing 的起点）───────────────
    //
    // 认领时把当前租约 epoch 写进 run.lease_epoch。
    // 之后所有写入都要求 epoch 相符——被接管后旧 owner 的写入必然失败。
    //
    // 没有 leaseGuard 时（测试 / 单进程直接调用）epoch 记 0，
    // 表示「不受租约约束」。这不是削弱：没有租约就没有接管，
    // 也就没有需要 fencing 的并发执行者。
    const claimEpoch = opts.leaseGuard?.token.epoch ?? 0
    const claimed = claimEpoch > 0
      ? this.store.claimRunForEpoch(run.id, claimFrom, claimEpoch, {
          startedAt: run.startedAt ?? Date.now(),
        })
      : this.store.transitionRunStatus(run.id, claimFrom, 'running', {
          startedAt: run.startedAt ?? Date.now(),
        })
    if (!claimed) {
      const current = this.store.getRun(run.id)!
      return {
        status: 'failed',
        error: `Run 当前状态是 ${current.status}，无法执行（可能已被其他执行占用）`,
        run: current,
      }
    }

    // ── 记录模型身份 ──────────────────────────────────────
    //
    // 必须在这里写，而不是让调用方在 /review 时传入。
    // 模型族隔离校验读的是这条记录，不是请求体——
    // 否则调用方可以把同族模型伪装成不同族，绕过隔离。
    //
    // 用 modelFamily() 在服务端算族名，不信任任何外部输入。
    this.store.recordModelIdentity(run.id, {
      providerId: opts.provider.id,
      modelId: opts.model.id,
      modelFamily: modelFamily(opts.model.id),
      recordedAt: Date.now(),
    })

    this.emit(run.id, 'run.started', { role: run.role })
    this.notify(opts, run.id)

    // 恢复已有历史：暂停后重新进入时必须接着上次的上下文继续，
    // 否则模型看不到自己发出的 tool_call 和工具结果。
    //
    // system 也走持久化历史，而不是每次从 opts 重新拼：
    //   恢复执行时调用方不一定会再传 system（HTTP 层有默认值，
    //   直接调 executor 的调用方未必有）。如果 system 只活在本次
    //   opts 里，一次暂停恢复就能让模型丢掉全部工作方式约束。
    //   落库之后，「这个 Run 在什么指令下跑的」也变成可追溯的事实。
    const persisted = this.store.listRunMessages<ChatMessage>(run.id)
    const history: ChatMessage[] = persisted.length > 0 ? persisted : [...opts.messages]

    // 首次执行才把初始消息落盘。system 排在最前面，
    // 与 provider 适配器的约定一致（Anthropic 会把它提到顶层字段）。
    if (persisted.length === 0) {
      if (opts.system !== undefined) {
        const systemMessage: ChatMessage = { role: 'system', content: opts.system }
        this.store.appendRunMessage(run.id, systemMessage)
        history.unshift(systemMessage)
      }
      for (const m of opts.messages) this.store.appendRunMessage(run.id, m)
    }

    let stepIndex = this.store.listSteps(run.id).length
    let finalText = ''

    try {
      // ── 恢复：先把已决定但未回填的审批结果补进历史 ────────
      // 这一步必须做，否则模型看到的序列是「assistant 有 tool_calls 但没有 tool 结果」，
      // 会被大多数 API 直接判为非法请求。
      const resolved = this.store.pendingResolutions(run.id)
      for (const approval of resolved) {
        const definition = this.tools.listAll().find((d) => d.id === approval.toolId)
        const toolName = definition?.name ?? approval.toolId

        if (approval.status === 'rejected') {
          const msg: ChatMessage = {
            role: 'tool',
            toolCallId: approval.toolCallId,
            content: `已拒绝：这个操作被用户拒绝，原因：${approval.reason ?? '未说明'}。不要重复请求相同操作，请换个方案或说明无法完成。`,
            isError: true,
          }
          history.push(msg)
          this.store.appendRunMessage(run.id, msg)
          this.store.markApprovalConsumed(approval.id)
          this.emit(run.id, 'approval.result', { approvalId: approval.id, outcome: 'rejected' })
          continue
        }

        // 已批准：现在才真正执行工具
        const step = this.store.createStep({
          runId: run.id,
          index: stepIndex++,
          kind: 'tool',
          status: 'running',
          input: { tool: toolName, args: approval.arguments, resumed: true },
        })

        // ── Intent 的键必须用**原始审批的 stepId** ──────────
        //
        // 上面新建的 step 只是这一次恢复执行的追踪记录，每次恢复都会换一个。
        // 如果用它的 id 当 Intent 键，每次恢复都会得到一条全新的 Intent，
        // 查不到「上次执行过」——整个机制就白做了。
        //
        // approval.stepId 指向最初那次调用的 step，它在审批创建时就固定了，
        // 跨恢复保持不变。配合 toolCallId，正好唯一确定「这一次调用」。
        const execResult = await this.invokeTool({
          definition,
          toolName,
          args: (approval.arguments ?? {}) as Record<string, unknown>,
          runId: run.id,
          taskId: run.taskId,
          stepId: approval.stepId,
          // 用 approval 里记录的原始 toolCallId，
          // 这样普通路径和恢复路径命中同一个 Intent。
          toolCallId: approval.toolCallId,
          signal: opts.signal,
          // 追踪用的实际 Step（Intent 状态写到这里）
          traceStepId: step.id,
        })

        const msg: ChatMessage = {
          role: 'tool',
          toolCallId: approval.toolCallId,
          content: execResult.content,
          isError: execResult.outcome !== 'ok',
        }
        history.push(msg)
        this.store.appendRunMessage(run.id, msg)
        this.store.markApprovalConsumed(approval.id)

        // ── 审批路径也必须立即停止 on unknown ─────────────
        //
        // 不能只把字符串塞给模型让它继续。
        // 与普通工具路径保持一致：不知道外部状态时，整个循环必须停。
        if (execResult.outcome === 'unknown') {
          this.store.setRunStatus(run.id, 'needs_reconciliation')
          this.emit(run.id, 'run.blocked_by_unknown', {
            toolCallId: approval.toolCallId,
            reason: execResult.reason ?? '审批后执行结果未知',
            viaApproval: true,
          })
          this.notify(opts, run.id)
          return {
            status: 'needs_reconciliation',
            reason: execResult.reason ?? '审批后执行结果未知',
            run: this.store.getRun(run.id)!,
          }
        }
        this.notify(opts, run.id)
      }

      for (let round = 0; round < this.config.maxToolRounds; round++) {
        if (opts.signal.aborted) return this.cancel(run.id, opts)

        // ── 上下文裁剪 ──────────────────────────────────────
        const budgetForMessages = this.config.contextBudget - this.config.outputReserve
        const fitted = fitToBudget(tidy(history), budgetForMessages)

        // ── 预算预留（模型调用前，事务内判定）────────────────
        //
        // ── 估算值 ──────────────────────────────────────
        //
        // input = 当前上下文的 token 估算（可算准，误差小）
        //
        // output 是难点。上一版固定用 outputReserve=8000，导致
        // maxTotalTokens=100 这类合法小预算永远无法执行——
        // 估算值本身就超了，调用还没发生就被拒。
        //
        // 现在的策略（方案 A + C 结合）：
        //   1. Run 显式给了 maxOutputTokens → 用它（最准确）
        //   2. 否则取「剩余预算」和「默认上限」的较小值
        //   3. 剩余预算 <= 0 时直接拒绝（预算已经不可能满足）
        //
        // 这样小预算能跑，同时估算仍然偏向保守（不会低估输出）。
        const estimatedInput = estimateMessages(fitted.messages)
        const estimatedOutput = this.resolveOutputEstimate(run, estimatedInput)

        if (estimatedOutput === null) {
          // 剩余预算连一个 token 的输出都放不下
          this.store.transitionRunStatus(run.id, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
          this.emit(run.id, 'budget.reserve_failed', {
            dimension: 'outputTokens',
            reason: '剩余预算不足以容纳任何输出',
          })
          this.notify(opts, run.id)
          return {
            status: 'expired',
            reason: '预算预留失败（outputTokens）：剩余预算不足以容纳任何输出',
            run: this.store.getRun(run.id)!,
          }
        }

        // ── 成本估算：价格未知时 fail-closed ─────────────
        //
        // 上一版 `?? 0` 把「价格未知」当成「成本为 0」，
        // 于是 maxCostUsd 形同虚设——用户以为有成本上限，
        // 实际一分钱都没被限制。
        //
        // 现在：用户明确设了 maxCostUsd 但价格未知 → 拒绝调用。
        // 没设 maxCostUsd 时价格未知不影响执行（用户没要求成本控制）。
        const costEstimate = estimateCost(opts.provider, estimatedInput, estimatedOutput)
        // Task 级的 maxCostUsd 同样要求可计算成本。
        // 只看 Run 的话，用户设了 Task 成本上限、Run 没设，
        // 价格未知时调用照样放行——上限形同虚设。
        const taskBudget = this.store.getTask(run.taskId)?.budget
        const needsCost =
          run.budget.maxCostUsd != null || taskBudget?.maxCostUsd != null

        if (needsCost && costEstimate == null) {
          this.store.transitionRunStatus(run.id, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
          this.emit(run.id, 'budget.reserve_failed', {
            dimension: 'maxCostUsd',
            reason: '价格未知，无法保证不超过成本上限',
          })
          this.notify(opts, run.id)
          return {
            status: 'expired',
            reason:
              '预算预留失败（maxCostUsd）：这个 provider 没有配置价格，' +
              '无法保证不超过成本上限。请配置价格，或去掉 maxCostUsd。',
            run: this.store.getRun(run.id)!,
          }
        }

        const estimatedCost = costEstimate ?? 0

        const reservation = this.store.reserveBudget({
          runId: run.id,
          taskId: run.taskId,
          purpose: 'model',
          steps: 1,
          inputTokens: estimatedInput,
          outputTokens: estimatedOutput,
          costUsd: estimatedCost,
          // owner 用 Run id：同一 Run 的调用共享归属，
          // 别的 Run 不能替你结算。
          owner: `run:${run.id}`,
          // 模型调用的 TTL：一次调用不可能超过 10 分钟
          ttlMs: 10 * 60_000,
        })

        if (!reservation.ok) {
          // 预留失败 → **不发起调用**
          this.store.transitionRunStatus(run.id, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
          this.emit(run.id, 'budget.reserve_failed', {
            dimension: reservation.dimension,
            reason: reservation.reason,
          })
          this.notify(opts, run.id)
          return {
            status: 'expired',
            reason: `预算预留失败（${reservation.dimension}）：${reservation.reason}`,
            run: this.store.getRun(run.id)!,
          }
        }

        const reservationId = reservation.reservationId
        // 保证无论走哪条路径都会结算或释放，不会留下悬挂预留
        let settled = false
        const settleOrRelease = (usage?: {
          inputTokens?: number
          outputTokens?: number
          costUsd?: number
          costKnown?: boolean
        }): void => {
          if (settled) return
          settled = true
          if (usage) {
            this.store.settleBudget(reservationId, {
              steps: 1,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              costUsd: usage.costUsd ?? 0,
              // 价格未知时 cost 是 undefined。必须显式告诉 Store
              // 「这个 0 不是精确值」，否则事后读起来就像真的花了 0 元。
              costKnown: usage.costKnown ?? true,
            }, { owner: `run:${run.id}` })
          } else {
            this.store.releaseBudget(reservationId, { owner: `run:${run.id}` })
          }
        }

        // ── 模型调用 ────────────────────────────────────────
        const llmStep = this.store.createStep({
          runId: run.id,
          index: stepIndex++,
          kind: 'llm',
          status: 'running',
          input: { round, messages: fitted.messages.length, dropped: fitted.droppedMessages },
        })
        this.notify(opts, run.id, llmStep)

        const llmStart = Date.now()
        let firstTokenAt: number | undefined

        const handlers: StreamHandlers = {
          onText: (delta) => {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            opts.onText?.(delta)
          },
          onReasoning: (delta) => {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            opts.onReasoning?.(delta)
          },
        }

        let result
        try {
          result = await this.resolveAdapter(opts.provider.kind).stream(
            {
              provider: opts.provider,
              model: opts.model,
              messages: fitted.messages,
              tools: this.toolSpecs(),
              signal: opts.signal,
            },
            handlers,
          )
        } catch (err) {
          // 调用失败 → 释放预留（没有真实用量）
          settleOrRelease()
          if (opts.signal.aborted) return this.cancel(run.id, opts)
          const message = err instanceof Error ? err.message : String(err)
          this.finishStep(llmStep.id, 'failed', { error: message }, {
            totalMs: Date.now() - llmStart,
            retryCount: 0,
          })
          return this.fail(run.id, message, opts)
        }

        const cost = estimateCost(opts.provider, result.inputTokens, result.outputTokens)
        const trace: StepTrace = {
          totalMs: Date.now() - llmStart,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: cost,
          servedBy: result.servedBy,
        }
        if (firstTokenAt !== undefined) trace.firstTokenMs = firstTokenAt - llmStart

        this.finishStep(llmStep.id, 'completed', {
          text: result.text,
          toolCalls: result.toolCalls.length,
          notice: result.notice,
        }, trace)

        // ── 结算：按实际用量 ────────────────────────────────
        //
        // 这里**不再**直接 addRunUsage —— 结算会把 usage 累加和
        // 预留释放放在同一个事务里，并且是幂等的。
        // 直接累加会让「预留」和「结算」两条路径都能改 usage，
        // 重复执行时会双计。
        settleOrRelease({
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
          costUsd: cost ?? 0,
          costKnown: cost != null,
        })

        // ── 调用后 overshoot 检查 ──────────────────────────
        // 真实用量只有模型返回后才知道。如果这次调用把预算撑破了，
        // 必须立即终止，绝不能再发起下一次调用。
        const overshoot = this.detectOvershoot(run.id)
        if (overshoot) {
          this.store.transitionRunStatus(run.id, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
          this.emit(run.id, 'budget.overshoot', overshoot)
          this.notify(opts, run.id)
          return {
            status: 'expired',
            reason: `调用后超出预算：${overshoot.dimension} 上限 ${overshoot.limit}，实际 ${overshoot.actual}`,
            run: this.store.getRun(run.id)!,
          }
        }

        finalText = result.text

        // ── 无工具调用：模型收束，本轮结束 ──────────────────
        if (result.toolCalls.length === 0) {
          const closing: ChatMessage = { role: 'assistant', content: result.text }
          history.push(closing)
          this.store.appendRunMessage(run.id, closing)

          // ── 有未解决的 unknown：不能算完成 ────────────────
          //
          // 这是状态安全边界。如果某个工具操作的结果不确定，
          // 那么「任务完成」这个结论本身就是没有依据的。
          // 必须停在 needs_reconciliation，等对账确认。
          if (this.store.hasUnresolvedUnknown(run.id)) {
            this.store.setRunStatus(run.id, 'needs_reconciliation')
            this.emit(run.id, 'run.blocked_by_unknown', {
              text: result.text,
              reason: '有未解决的 unknown 操作，不能判定为完成',
            })
            this.notify(opts, run.id)
            return {
              status: 'needs_reconciliation',
              reason:
                '这个 Run 有未解决的 unknown 操作，不能判定为完成。' +
                '请先对账确认（POST /runs/:id/reconcile）后再继续。',
              run: this.store.getRun(run.id)!,
            }
          }

          // 拍快照。必须在「模型明确收束」这一刻拍，
          // 而不是 Run 开始时——否则拍到的是半成品。
          await this.captureSnapshot(run, 'workspace')

          // 被接管后不允许再标完成——否则会把新 owner 的工作结果覆盖掉。
          if (opts.leaseGuard && !opts.leaseGuard.check()) {
            return {
              status: 'lease_lost',
              reason: opts.leaseGuard.invalidReason ?? '租约已失效',
              run: this.store.getRun(run.id)!,
            }
          }

          // CAS：被取消过就不能再标完成。
          this.store.transitionRunStatus(
            run.id,
            ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'],
            'completed',
            { endedAt: Date.now() },
          )

          // Run 完成 ≠ Task 完成。
          // Run.completed 只表示「执行完并形成了候选结果」，
          // Task 必须进入 awaiting_acceptance 等用户做质量决定。
          const task = this.store.getTask(run.taskId)
          if (task && task.status !== 'accepted') {
            this.store.updateTaskStatus(run.taskId, 'awaiting_acceptance')
          }

          this.emit(run.id, 'run.completed', { text: result.text })
          this.notify(opts, run.id)
          return { status: 'completed', text: result.text, run: this.store.getRun(run.id)! }
        }

        // ── 有工具调用：记录 assistant 消息，逐个执行 ────────
        const assistantTurn: ChatMessage = { role: 'assistant', content: result.text, toolCalls: result.toolCalls }
        history.push(assistantTurn)
        this.store.appendRunMessage(run.id, assistantTurn)

        for (const call of result.toolCalls) {
          if (opts.signal.aborted) return this.cancel(run.id, opts)

          const outcome = await this.runTool({
            call,
            run,
            opts,
            stepIndex: stepIndex++,
          })

          if (outcome.kind === 'paused') {
            // Run 进入 paused，等审批。把当前历史存下来以便恢复。
            this.emit(run.id, 'run.paused', { approvalId: outcome.approval.id })
            return {
              status: 'paused',
              approval: outcome.approval,
              run: this.store.getRun(run.id)!,
            }
          }

          if (outcome.kind === 'fatal') {
            return this.fail(run.id, outcome.error, opts)
          }

          // ── 结果未知：立即停止整个执行循环 ────────────────
          //
          // 不能继续调模型，也不能处理同一批里的其他工具。
          // 理由：我们已经不知道外部世界处于什么状态了，
          // 继续操作等于在不确定的地基上盖楼。
          //
          // 但结果仍要写入历史：这样对账后恢复时，模型能看到这一步发生过什么。
          if (outcome.kind === 'unknown') {
            const unknownMsg: ChatMessage = {
              role: 'tool',
              toolCallId: call.id,
              content: outcome.content,
              isError: true,
            }
            history.push(unknownMsg)
            this.store.appendRunMessage(run.id, unknownMsg)

            this.store.setRunStatus(run.id, 'needs_reconciliation')
            this.emit(run.id, 'run.blocked_by_unknown', {
              toolCallId: call.id,
              reason: outcome.reason,
            })
            this.notify(opts, run.id)
            return {
              status: 'needs_reconciliation',
              reason: outcome.reason,
              run: this.store.getRun(run.id)!,
            }
          }

          // 把工具结果追加进历史，继续下一轮。
          //
          // 必须同时落库：否则进程崩溃后恢复时，
          // 模型看到的序列是「assistant 有 tool_calls 但没有对应 tool 结果」，
          // 会被 API 判定为非法请求，而且我们也不知道这个工具到底执行过没有。
          const toolMsg: ChatMessage = {
            role: 'tool',
            toolCallId: call.id,
            content: outcome.content,
            isError: outcome.isError,
          }
          history.push(toolMsg)
          this.store.appendRunMessage(run.id, toolMsg)
        }
      }

      // 工具轮数耗尽
      return this.fail(run.id, `工具调用轮数超过上限（${this.config.maxToolRounds}）`, opts)
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        this.store.transitionRunStatus(run.id, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
        this.emit(run.id, 'run.expired', { dimension: err.dimension, limit: err.limit })
        return { status: 'expired', reason: err.message, run: this.store.getRun(run.id)! }
      }
      const message = err instanceof Error ? err.message : String(err)
      return this.fail(run.id, message, opts)
    }
  }

  // ── 工具执行 ─────────────────────────────────────────────

  private async runTool(input: {
    call: ToolCall
    run: Run
    opts: ExecuteOptions
    stepIndex: number
  }): Promise<
    | { kind: 'ok'; content: string; isError?: boolean }
    | { kind: 'paused'; approval: Approval }
    | { kind: 'fatal'; error: string }
    /**
     * 工具结果无法确认。
     *
     * 与 ok 的区别：ok 表示「有确定结果，可以继续」；
     * unknown 表示「不知道外部操作成没成」，必须立即停止整个执行循环，
     * 不能继续调模型、也不能处理同一批里的其他工具。
     */
    | { kind: 'unknown'; content: string; reason: string }
  > {
    const { call, run, opts, stepIndex } = input
    const definition = this.tools.listAll().find((d) => d.name === call.name)

    // ── 工具不存在 ──────────────────────────────────────────
    if (!definition) {
      const step = this.store.createStep({
        runId: run.id,
        index: stepIndex,
        kind: 'tool',
        status: 'failed',
        input: { tool: call.name, args: call.arguments },
      })
      this.finishStep(step.id, 'failed', { error: '未知工具' }, { toolName: call.name })
      this.notify(opts, run.id)
      // 作为可重试错误返回给模型，让它换个做法
      return { kind: 'ok', content: `错误：不存在名为 ${call.name} 的工具。可用工具：${this.tools.listEnabled().map((t) => t.name).join(', ')}`, isError: true }
    }

    // ── 参数解析 ────────────────────────────────────────────
    let parsedArgs: unknown
    try {
      parsedArgs = JSON.parse(call.arguments || '{}')
    } catch {
      const step = this.store.createStep({
        runId: run.id,
        index: stepIndex,
        kind: 'tool',
        status: 'failed',
        input: { tool: call.name, rawArgs: call.arguments },
      })
      this.finishStep(step.id, 'failed', { error: '参数不是合法 JSON' }, { toolName: call.name })
      this.notify(opts, run.id)
      return { kind: 'ok', content: '错误：工具参数不是合法的 JSON，请重新生成。', isError: true }
    }

    const validation = validateArgs(definition.inputSchema, parsedArgs)
    if (!validation.ok) {
      const step = this.store.createStep({
        runId: run.id,
        index: stepIndex,
        kind: 'tool',
        status: 'failed',
        input: { tool: call.name, args: parsedArgs },
      })
      this.finishStep(step.id, 'failed', { error: validation.error }, { toolName: call.name })
      this.notify(opts, run.id)
      return { kind: 'ok', content: `错误：${validation.error}`, isError: true }
    }

    const args = validation.value
    const argHash = hashArguments(args)

    // ── 拒绝去重 ────────────────────────────────────────────
    const denied = this.store.findDenied(run.id, definition.id, argHash)
    if (denied) {
      const step = this.store.createStep({
        runId: run.id,
        index: stepIndex,
        kind: 'tool',
        status: 'rejected',
        input: { tool: definition.name, args },
      })
      this.finishStep(step.id, 'rejected', { reason: denied.reason }, { toolName: definition.name })
      this.notify(opts, run.id)
      return {
        kind: 'ok',
        content: `已拒绝：这个操作之前被你拒绝过，原因：${denied.reason}。不要重复请求，请换个方案或直接说明无法完成。`,
        isError: true,
      }
    }

    // ── Grant 检查 / 审批 ──────────────────────────────────
    //
    // **这里只检查、不认领。**
    //
    // 曾经的实现有两个问题：
    //   1. 这里 claim 一次，invokeTool 里又 claim 一次 → 扣两次
    //   2. 这里 claim 之后如果预算不足，额度已经被扣掉了
    //
    // 现在的分工：
    //   · 这里只回答「要不要走审批」（只读判断）
    //   · 真正的扣减在 invokeTool 的 beginToolAttempt 事务里
    //     （检查授权 + 扣减 + 标记 started 一起提交）
    //
    // 为什么可以只读判断：如果这里看到有可用 Grant，但执行时被别人抢走了，
    // invokeTool 会 fail-closed 并回给模型「授权不可用」——
    // 那是正确结果，不需要在这里预扣来「占位」。
    const hasUsableGrant = this.findUsableGrant(run.id, definition.id) !== undefined

    // 权限只能来自 Grant，不能来自调用参数。
    //
    // 旧签名里有个 autoApprove?: string[]，由 HTTP 层从请求体透传。
    // 结果是任何能发 HTTP 的人写 autoApprove:['write_file'] 就绕过了审批。
    // 现在这个入口被彻底删除：write/external 工具只有两种命运，
    // 要么已有可用的 Grant，要么进审批。
    if (!hasUsableGrant && definition.riskLevel !== 'read') {
      const step = this.store.createStep({
        runId: run.id,
        index: stepIndex,
        kind: 'approval',
        status: 'waiting_approval',
        input: { tool: definition.name, args, riskLevel: definition.riskLevel },
      })
      this.notify(opts, run.id)

      const approval = this.store.createApproval({
        runId: run.id,
        stepId: step.id,
        toolId: definition.id,
        toolCallId: call.id,
        arguments: args,
        timeoutMs: this.config.approvalTimeoutMs,
      })
      // 等审批是 waiting_approval，不是 paused。
      // 两者语义不同：paused 是用户主动暂停（可直接恢复），
      // waiting_approval 必须先处理审批才能继续。
      this.store.setRunStatus(run.id, 'waiting_approval')
      return { kind: 'paused', approval }
    }

    // ── 预算检查（工具调用前） ──────────────────────────────
    try {
      this.checkBudget(run.id, 'toolCalls', 1)
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err
      throw err
    }

    // ── 执行 ────────────────────────────────────────────────
    const step = this.store.createStep({
      runId: run.id,
      index: stepIndex,
      kind: 'tool',
      status: 'running',
      input: { tool: definition.name, args, riskLevel: definition.riskLevel },
    })
    this.notify(opts, run.id, step)

    // 普通路径与审批恢复路径共用同一个副作用入口。
    const execResult = await this.invokeTool({
      definition,
      toolName: definition.name,
      args,
      runId: run.id,
      taskId: run.taskId,
      stepId: step.id,
      toolCallId: call.id,
      signal: opts.signal,
    })

    this.notify(opts, run.id)

    if (execResult.outcome === 'unknown') {
      // 与审批路径一致：不知道外部状态时，整个循环必须停。
      this.notify(opts, run.id)
      return {
        kind: 'unknown',
        reason: execResult.reason ?? '工具执行结果未知',
        content: execResult.content,
      }
    }

    return {
      kind: 'ok',
      content: execResult.content,
      isError: execResult.outcome === 'failed',
    }
  }

  /**
   * 工具调用的**唯一**副作用执行入口。
   *
   * 普通循环和审批恢复都必须走这里。以前是两套逻辑：
   * 普通路径有 claim + Intent 缺失，恢复路径连 claim 都没有。
   * 结果就是「同一次调用在不同入口下语义不同」——这种分裂迟早出事。
   *
   * 执行顺序（严格按此顺序，不能调换）：
   *
   *   1. 校验工具存在
   *   2. 取或建 Intent（唯一约束保证同一 toolCallId 只有一条）
   *   3. Intent 已 committed  → 直接返回保存的结果，**不再执行**
   *   4. Intent 是 started    → 说明另一个执行正在跑（或崩溃了），拒绝
   *   5. Intent 是 unknown    → 拒绝，必须人工对账
   *   6. Intent 是 reconciled → 同上，已查证过，不重放
   *   7. 只有 prepared 能原子转 started
   *   8. 认领 Grant（write/external 必须有）
   *   9. 检查预算
   *  10. 执行，按结果写 committed / failed / unknown
   *
   * 第 3 步是整个 ToolIntent 机制存在的理由：
   * 「副作用已经发生，但结果落库前崩溃」之后再执行到这里，
   * 能认出这次调用做过，直接复用结果。
   */
  private async invokeTool(input: {
    definition: ToolDefinition | undefined
    toolName: string
    args: Record<string, unknown>
    runId: string
    taskId: string
    /** Intent 的键：必须是**最初那次调用**的 stepId，跨恢复保持不变 */
    stepId: string
    /**
     * Step 状态写到哪里。不传则用 stepId。
     *
     * 恢复执行时会新建一个追踪 Step，但 Intent 仍挂在该调用最初的 stepId 上。
     * 两者分开，否则每次恢复都会产生一条新 Intent。
     */
    traceStepId?: string
    toolCallId: string
    signal: AbortSignal
  }): Promise<{
    outcome: 'ok' | 'failed' | 'unknown'
    content: string
    reason?: string
    /** 结果来自 Intent 缓存（没有真正执行工具） */
    fromIntent?: boolean
  }> {
    const {
      definition, toolName, args, runId, taskId, stepId, toolCallId, signal,
    } = input
    const traceStep = input.traceStepId ?? stepId

    // ── 1. 工具存在性 ──────────────────────────────────────
    if (!definition) {
      this.finishStep(traceStep, 'failed', { error: '未知工具' }, { toolName })
      return { outcome: 'failed', content: `错误：不存在名为 ${toolName} 的工具。` }
    }

    const impl = this.tools.get(definition.id)
    if (!impl) {
      this.finishStep(traceStep, 'failed', { error: '工具实现缺失' }, { toolName })
      return { outcome: 'failed', content: `错误：工具 ${toolName} 没有可用的实现。` }
    }

    // ── 2a. 无副作用工具：根本不用 Intent ──────────────────
    //
    // Intent 存在的唯一理由是「防止副作用执行两次」。
    // 没有副作用的工具重复执行完全无害，套上 Intent 反而有害：
    // 一次进程崩溃会让这个 Run 剩下的所有读操作永久失效——
    // 「安全」的代价不该是「系统不可用」。
    //
    // **判据是 sideEffect，不是 riskLevel。** 这两个维度不同：
    //   riskLevel  回答「要不要先问用户」
    //   sideEffect 回答「重复执行是否安全」
    //
    // 反例：一个只读 HTTP GET（riskLevel=read）可能计费、写对方日志、
    // 触发限流。用 riskLevel 判断会把它当成「重试无害」，那是误判。
    if (sideEffectOf(definition) === 'none') {
      return this.executeWithoutIntent(definition, impl, args, {
        runId, taskId, traceStep, signal,
      })
    }

    // ── 2b. 原子准备：Intent + Grant + 预算 + started ────────
    //
    // 这一步把「检查授权 → 扣减额度 → 标记开始」放进一个 SQLite 事务。
    // 任一步失败，整个事务回滚，**Grant 不会被消耗**。
    //
    // 旧实现是分开做的，有两个确定性缺陷：
    //   1. 预算不足时 Grant 已经扣了
    //   2. claim 与 startIntent 之间崩溃会留下「额度已扣、工具未执行」
    //
    // 边界：这个事务只覆盖进入 started **之前**。
    // 进入 started 后要调外部工具，SQLite 无法与之组成原子事务，
    // 那之后崩溃只能记 unknown。所以不是 exactly-once。
    const requestHash = hashArguments(args)
    const operationKey = `${runId}:${definition.id}:${requestHash}`

    const attempt = this.store.beginToolAttempt({
      runId,
      taskId,
      stepId,
      toolCallId,
      toolId: definition.id,
      toolName: definition.name,
      requestHash,
      operationKey,
      // Grant 的判据是 riskLevel，不是 sideEffect：
      //   riskLevel  → 要不要先问用户（决定是否需要 Grant）
      //   sideEffect → 重复执行是否安全（决定是否需要 Intent）
      // 一个 riskLevel=read、sideEffect=external 的工具需要 Intent
      // 但不需要用户逐个批准——它本来就在自动放行白名单里。
      requireGrant: definition.riskLevel !== 'read',
      // 预算预留：工具调用消耗 1 次 toolCalls + 1 步
      reserve: { steps: 1, toolCalls: 1 },
    })

    // ── 3. 已有 committed 结果：直接复用，不执行 ─────────────
    if (attempt.ok === 'replay') {
      const intent = attempt.intent!
      this.finishStep(traceStep, 'completed', {
        ok: !intent.resultIsError,
        replayedFromIntent: true,
        bytes: Buffer.byteLength(intent.resultContent ?? '', 'utf8'),
      }, { toolName: definition.name })
      this.emit(runId, 'tool.replayed', {
        tool: definition.name,
        intentId: intent.id,
        operationKey: intent.operationKey,
      })
      return {
        outcome: intent.resultIsError ? 'failed' : 'ok',
        content: intent.resultContent ?? '',
        fromIntent: true,
      }
    }

    // ── 4. Intent 处于不可执行状态 ───────────────────────────
    if (attempt.ok === 'blocked') {
      const intent = attempt.intent!
      const why = this.describeBlockedIntent(intent)
      this.finishStep(traceStep, 'unknown', {
        error: '这次调用没有可以执行的状态',
        intentStatus: intent.status,
        why,
      }, { toolName: definition.name })
      this.emit(runId, 'tool.intent_blocked', {
        tool: definition.name, intentId: intent.id, status: intent.status,
      })
      return { outcome: 'unknown', content: `结果未知：${why}`, reason: why }
    }

    // ── 5. 预算不足：事务已回滚，Grant 未被扣 ────────────────
    if (attempt.ok === 'budget_exceeded') {
      this.finishStep(traceStep, 'failed', {
        error: attempt.budgetError ?? '预算超限',
      }, { toolName })
      this.store.transitionRunStatus(runId, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
      // 预留失败：不执行工具、不消耗 Grant、Intent 留 prepared。
      // 抛 BudgetExceeded 让上层终止整个 Run。
      throw new BudgetExceeded(
        attempt.budgetDimension ?? 'toolCalls',
        0,
      )
    }

    // ── 6. 没有可用授权：Intent 仍是 prepared，可重新批准 ────
    if (attempt.ok === 'no_grant') {
      // 这里**不能**调用 failIntent：
      //   · 工具没执行，副作用一定没发生
      //   · failed 状态不允许回到可执行状态，会把调用永久锁死
      //   · 这不是「失败」，是「还没获得许可」
      this.finishStep(traceStep, 'failed', {
        error: '没有可用授权',
        hint: 'Grant 已用尽、已过期或已被撤销',
        intentStatus: 'prepared',
      }, { toolName: definition.name })
      this.emit(runId, 'tool.grant_unavailable', { tool: definition.name })
      return {
        outcome: 'failed',
        content:
          `错误：${definition.name} 的授权已用尽、已过期或已被撤销，本次没有执行。` +
          '如果仍需要这个操作，请重新请求，由用户再次批准。',
      }
    }

    // ── 7. 准备完成，Intent 已 started ───────────────────────
    const intent = attempt.intent!
    const reservationId = attempt.reservationId

    /**
     * 统一结算。
     *
     * 工具执行有七八条退出路径（成功/失败/超时/取消/异常/unknown），
     * 每条都手写 settle 一定会漏。所以用 try/finally 兜住：
     * 无论从哪条路出去，预留都会被结算或释放。
     *
     * 幂等由 settleBudget 保证（已结算的不会重复累加）。
     */
    let budgetSettled = false
    const settleToolBudget = (): void => {
      if (budgetSettled || !reservationId) return
      budgetSettled = true
      this.store.settleBudget(reservationId, { steps: 1, toolCalls: 1 }, { owner: `run:${runId}` })
    }
    const releaseToolBudget = (): void => {
      if (budgetSettled || !reservationId) return
      budgetSettled = true
      this.store.releaseBudget(reservationId, { owner: `run:${runId}` })
    }

    try {
    // ── 10. 执行 ───────────────────────────────────────────
    const started = Date.now()
    let result: Awaited<ReturnType<typeof runWithTimeout>>['result']
    let timedOut: boolean
    let lateResult: Promise<{ result?: { ok: boolean; content: string }; error?: string }> | undefined

    try {
      const r = await runWithTimeout(
        impl,
        args,
        { workspaceRoots: this.config.workspaceRoots, signal },
        definition.timeoutMs,
      )
      result = r.result
      timedOut = r.timedOut
      lateResult = r.lateResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const latency = Date.now() - started

      // 被用户取消：外部操作可能已经开始也可能没有。
      // 与超时同语义——记 unknown，不记 failed。
      if (signal.aborted) {
        this.store.markIntentUnknown(intent.id, '执行期间被取消，无法确认是否已生效')
        this.finishStep(traceStep, 'cancelled', { error: '被取消' }, {
          toolName: definition.name, toolLatencyMs: latency,
        })
        return { outcome: 'unknown', content: '结果未知：执行被取消。' }
      }

      // 写操作抛错：不知道副作用有没有发生。
      //
      // 为什么不记 failed：异常可能是「参数校验失败」（副作用没发生），
      // 也可能是「写了一半 IO 错误」（副作用部分发生）。
      // 仅凭异常类型分不开这两种，所以保守地记 unknown。
      //
      // 只读工具走不到这里——它们在 2a 就分流到 executeWithoutIntent 了。
      this.store.markIntentUnknown(
        intent.id,
        `工具在执行中抛出异常，无法确认副作用是否已发生：${message}`,
      )
      this.finishStep(traceStep, 'unknown', {
        error: '执行异常，副作用状态未知',
        detail: message,
        advice: this.reconcileAdvice(definition),
      }, { toolName: definition.name, toolLatencyMs: latency })
      // 工具**确实被调用了**（抛错前可能已产生副作用），
      // 所以消耗 1 次 toolCalls + 1 步，不是释放。
      settleToolBudget()
      this.emit(runId, 'tool.unknown', { tool: definition.name, reason: 'exception' })
      this.store.setRunStatus(runId, 'needs_reconciliation')
      return {
        outcome: 'unknown',
        content:
          `结果未知：${definition.name} 执行中抛出异常，无法确认操作是否已生效。` +
          `${this.reconcileAdvice(definition)}`,
        reason: message,
      }
    }

    const latency = Date.now() - started

    // ── 超时：unknown，不是 failed ──────────────────────────
    if (timedOut) {
      const advice = this.reconcileAdvice(definition)
      const reason = `${definition.name} 执行超时，无法确认操作是否已经生效。${advice}`
      this.store.markIntentUnknown(intent.id, reason)
      this.finishStep(traceStep, 'unknown',
        { error: '工具执行超时，无法确认是否已经生效', advice },
        { toolName: definition.name, toolLatencyMs: latency })
      // 超时：工具被调用了，只是结果未知。计量上算 1 次。
      settleToolBudget()
      this.emit(runId, 'tool.unknown', { tool: definition.name, reason: 'timeout' })
      this.store.setRunStatus(runId, 'needs_reconciliation')

      // ── 晚到结果：只记录，不改状态 ─────────────────────
      //
      // 超时那一刻我们已经宣布「不知道结果」，这个判断是对的，
      // 因为文件系统可能在之后任何时刻完成写入。
      //
      // 晚到的结果**不能**把 Intent 从 unknown 改回 committed：
      //   · 状态机不允许（unknown → committed 不存在）
      //   · 就算允许，也可能在我们判断之后再崩一次，仍然不确定
      //
      // 它唯一的用途是留个证据，供人工对账时参考。
      if (lateResult) {
        void lateResult.then((late) => {
          try {
            this.emit(runId, 'tool.late_result', {
              tool: definition.name,
              intentId: intent.id,
              operationKey: intent.operationKey,
              ok: late.result?.ok ?? false,
              error: late.error,
              note: '超时后才完成；不改变 Intent 状态，仅供对账参考',
            })
          } catch {
            /* 事件写入失败不影响主流程 */
          }
        })
      }

      return {
        outcome: 'unknown',
        content:
          `结果未知：${reason}\n在确认之前不要假设它成功，也不要盲目重试。`,
        reason,
      }
    }

    if (!result) {
      this.store.failIntent(intent.id, '工具没有返回结果')
      this.finishStep(traceStep, 'failed', { error: '工具没有返回结果' }, {
        toolName: definition.name, toolLatencyMs: latency,
      })
      return { outcome: 'failed', content: '错误：工具没有返回结果。' }
    }

    // ── 成功 / 工具明确报告失败 ────────────────────────────
    const clamped = clampToolOutput(result.content, definition.maxOutputBytes)
    const trace: StepTrace = { toolName: definition.name, toolLatencyMs: latency }
    if (clamped.truncated) {
      trace.truncation = {
        originalBytes: clamped.originalBytes,
        keptBytes: clamped.keptBytes,
        reason: `超过工具输出上限 ${definition.maxOutputBytes} 字节`,
      }
    }

    // 工具返回了结果 = 副作用已经发生（不管 ok 与否）。
    // 所以这里统一记 committed，用 resultIsError 区分成功失败。
    this.store.commitIntent(intent.id, {
      content: clamped.text,
      isError: !result.ok,
      resultHash: createHash('sha256').update(clamped.text, 'utf8').digest('hex'),
    })

    this.finishStep(traceStep, result.ok ? 'completed' : 'failed', {
      ok: result.ok,
      bytes: Buffer.byteLength(result.content, 'utf8'),
      truncated: clamped.truncated,
    }, trace)
    // 工具真实执行完毕（不管 ok 与否），消耗 1 次 toolCalls + 1 步
    settleToolBudget()
    this.emit(runId, 'tool.done', { tool: definition.name, ok: result.ok })
    return { outcome: result.ok ? 'ok' : 'failed', content: clamped.text }
    } finally {
      // 兜底：任何路径（超时/取消/异常/unknown）走到这里时，
      // 如果还没结算，释放预留——调用没有产生可计量的成功用量。
      //
      // 注意：超时和 unknown 的情况外部副作用可能已经发生，
      // 但 token/toolCalls 这些**可计量**的资源并没有确定消耗，
      // 所以释放是保守且正确的。
      releaseToolBudget()
    }
  }

  /** 把「为什么这个 Intent 不能继续执行」变成人话。 */
  /**
   * 只读工具的执行路径：不创建 Intent。
   *
   * 为什么单独一条：读操作没有外部副作用，
   * 「重复执行」在语义上就是安全的。给它套 Intent 的唯一后果
   * 是崩溃后把只读能力也锁死。
   *
   * 但仍然共享预算计数和 Step 记录——只读也要算步数、也要能追踪。
   */
  private async executeWithoutIntent(
    definition: ToolDefinition,
    impl: ToolImpl,
    args: Record<string, unknown>,
    ctx: {
      runId: string
      taskId: string
      traceStep: string
      signal: AbortSignal
    },
  ): Promise<{
    outcome: 'ok' | 'failed' | 'unknown'
    content: string
    reason?: string
  }> {
    const { runId, taskId, traceStep, signal } = ctx

    // ── 预算预留 ────────────────────────────────────────────
    //
    // 只读工具也要走 reservation，不能只做 checkBudget。
    //
    // 区别：checkBudget 是「查已用」，reservation 是「占额度」。
    // 两个并发的只读调用都查 usage=0 时都会通过——它们查的是
    // 一个还没被更新的值。预留把「将要占用」写进数据库，
    // 第二个调用才能看见第一个。
    //
    // 只读工具虽然没有副作用，但同样消耗 toolCalls/steps 预算，
    // 而且它可能是慢操作（大文件、网络读），并发时一样会超支。
    const reservation = this.store.reserveBudget({
      runId,
      taskId,
      purpose: 'tool-readonly',
      steps: 1,
      toolCalls: 1,
      owner: `run:${runId}`,
      ttlMs: 10 * 60_000,
    })

    if (!reservation.ok) {
      this.finishStep(traceStep, 'failed', {
        error: reservation.reason,
      }, { toolName: definition.name })
      this.store.transitionRunStatus(runId, ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'], 'expired', { endedAt: Date.now() })
      throw new BudgetExceeded(reservation.dimension, 0)
    }

    const reservationId = reservation.reservationId

    /**
     * 统一结算。与 invokeTool 的 settleToolBudget 语义一致：
     * 工具被调用了就结算，没调用就释放。
     */
    let budgetSettled = false
    const settleReadBudget = (): void => {
      if (budgetSettled) return
      budgetSettled = true
      this.store.settleBudget(reservationId, { steps: 1, toolCalls: 1 }, { owner: `run:${runId}` })
    }
    const releaseReadBudget = (): void => {
      if (budgetSettled) return
      budgetSettled = true
      this.store.releaseBudget(reservationId, { owner: `run:${runId}` })
    }

    const started = Date.now()
    try {
      const { result, timedOut, lateResult } = await runWithTimeout(
        impl, args,
        { workspaceRoots: this.config.workspaceRoots, signal },
        definition.timeoutMs,
      )
      const latency = Date.now() - started

      // 只读工具的晚到结果：只是丢弃，但要确保不会变成 unhandled rejection
      if (timedOut && lateResult) {
        void lateResult.catch(() => {
          /* 只读工具的晚到结果对状态没有影响，忽略即可 */
        })
      }

      // 只读工具超时：仍然记 unknown，不记 failed。
      //
      // 理由：超时的语义始终是「不知道发生了什么」，这一点与风险等级无关。
      // 读操作确实不改变世界，但「读到一半超时」和「确定没读到」
      // 在诊断上是不同的——把它们压成同一个 failed 会丢掉信息。
      //
      // 关键区别不在超时本身，而在**后续能不能重试**：
      // 只读的 Intent 不会被创建（2a 已分流），所以不存在
      // 「unknown 导致永久锁死」的问题。系统仍然是诚实的，
      // 但下次执行不会因为这条 unknown 而失败。
      if (timedOut) {
        const advice = this.reconcileAdvice(definition)
        this.finishStep(traceStep, 'unknown', {
          error: '只读操作超时，无法确认读取是否完成',
          advice,
          retryable: true,
        }, { toolName: definition.name, toolLatencyMs: latency })
        settleReadBudget()
        this.emit(runId, 'tool.unknown', { tool: definition.name, reason: 'timeout' })
        // 只读超时不把整个 Run 锁进 needs_reconciliation：
        // 没有副作用，重试是安全的，没必要让用户来处理。
        //
        // 但**对账建议必须原样带上**：不同工具的重试安全性不同
        // （idempotent / unsafeToRetry / 需要先用查询工具确认），
        // 模型需要靠这句话决定下一步怎么做。丢掉它就等于让模型瞎猜。
        return {
          outcome: 'unknown',
          content:
            `结果未知：${definition.name} 超时，无法确认读取是否完成。${advice}\n` +
            '在确认之前不要假设它成功，也不要盲目重试。',
          reason: `只读操作超时。${advice}`,
        }
      }

      if (!result) {
        this.finishStep(traceStep, 'failed', { error: '没有返回结果' }, {
          toolName: definition.name, toolLatencyMs: latency,
        })
        return { outcome: 'failed', content: '错误：工具没有返回结果。' }
      }

      const clamped = clampToolOutput(result.content, definition.maxOutputBytes)
      const trace: StepTrace = { toolName: definition.name, toolLatencyMs: latency }
      if (clamped.truncated) {
        trace.truncation = {
          originalBytes: clamped.originalBytes,
          keptBytes: clamped.keptBytes,
          reason: `超过工具输出上限 ${definition.maxOutputBytes} 字节`,
        }
      }
      this.finishStep(traceStep, result.ok ? 'completed' : 'failed', {
        ok: result.ok,
        bytes: Buffer.byteLength(result.content, 'utf8'),
        truncated: clamped.truncated,
      }, trace)
      settleReadBudget()
      this.emit(runId, 'tool.done', { tool: definition.name, ok: result.ok })
      return { outcome: result.ok ? 'ok' : 'failed', content: clamped.text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.finishStep(traceStep, 'failed', { error: message }, {
        toolName: definition.name, toolLatencyMs: Date.now() - started,
      })
      settleReadBudget()
      // 读工具出错回给模型，让它换个路径
      return { outcome: 'failed', content: `工具执行失败：${message}` }
    } finally {
      // 兜底：任何未显式结算的路径（取消、没有结果）都释放预留。
      // settleReadBudget/releaseReadBudget 都有幂等标记，
      // 已经结算过的不会被这里覆盖。
      releaseReadBudget()
    }
  }

  private describeBlockedIntent(intent: {
    status: string
    unknownReason?: string
    error?: string
    resolution?: string
  }): string {
    switch (intent.status) {
      case 'started':
        return (
          '这次调用已经在执行中（或上次执行中途崩溃）。' +
          '不能重复执行——可能产生第二次副作用。请先确认外部状态。'
        )
      case 'unknown':
        return (
          `上次执行结果未知：${intent.unknownReason ?? '未说明'}。` +
          '在人工确认之前不会重试。'
        )
      case 'failed':
        return (
          `上次执行失败（${intent.error ?? '未说明'}）。` +
          '失败不代表外部操作没有生效，不会自动重试。'
        )
      case 'reconciled':
        return `这次调用已经人工对账过：${intent.resolution ?? '未说明'}。不会重复执行。`
      default:
        return `Intent 状态是 ${intent.status}，不能执行。`
    }
  }

  /**
   * 拍快照并为每条改动的文件生成 Artifact。
   *
   * 快照失败不影响 Run 完成——但要记录事件，让用户知道「这次没有可复现证据」。
   * 静默失败会让审计环节拿到一个不存在的快照，那比没有快照更糟。
   */
  private async captureSnapshot(run: Run, kind: Snapshot['kind']): Promise<void> {
    const hook = this.config.snapshot
    if (!hook) return

    const startedAt = Date.now()
    try {
      const result = await hook.capture()

      const snapshot = this.store.createSnapshot({
        runId: run.id,
        taskId: run.taskId,
        kind,
        ref: result.ref,
        reproducible: true,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
      })

      // 为工作区里的每个文件生成 Artifact。
      //
      // 两个关键点：
      //   1. 哈希必须从**刚拍的快照**里算，不能从工作区算
      //      —— 工作区之后还会变，那时哈希与快照就对不上了
      //   2. 去重按 Task 级比对，不能只看当前 Run
      //      —— 返工是新的 Run，但内容没变的文件不该产生新版本
      const files = await this.listFilesForArtifacts()
      for (const relPath of files) {
        const content = await hook.readFileAt(result.ref, relPath)
        if (content === null) continue
        const hash = createHash('sha256').update(content, 'utf8').digest('hex')

        const parent = this.findLatestArtifactForPath(run.taskId, relPath)
        if (parent && parent.contentHash === hash) continue

        this.store.createArtifact({
          taskId: run.taskId,
          runId: run.id,
          type: 'file',
          path: relPath,
          contentHash: hash,
          sourceSnapshotId: snapshot.id,
          version: (parent?.version ?? 0) + 1,
          parentArtifactId: parent?.id,
          status: 'candidate',
        })
      }

      this.emit(run.id, 'snapshot.captured', {
        snapshotId: snapshot.id,
        ref: result.ref,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      // 快照失败要显式记录，不能假装成功
      this.emit(run.id, 'snapshot.failed', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
    }
  }

  /** 找出某个路径在 Task 下最新的 Artifact，用于建立版本链。 */
  private findLatestArtifactForPath(taskId: string, path: string): Artifact | undefined {
    const all = this.store.listTaskArtifacts(taskId).filter((a) => a.path === path)
    return all.sort((a, b) => b.version - a.version)[0]
  }

  /** 采集待生成 Artifact 的文件清单。 */
  private async listFilesForArtifacts(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const { join, relative } = await import('node:path')
    const skip = new Set(['node_modules', 'dist', 'build', '.git'])
    const root = this.config.workspaceRoots[0]
    if (!root) return []

    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) out.push(relative(root, full).replace(/\\/g, '/'))
      }
    }
    await walk(root)
    return out
  }

  /** 超时后给模型的建议，依据工具声明的对账策略。 */
  private reconcileAdvice(def: ToolDefinition): string {
    const { idempotent, unsafeToRetry, queryToolId } = def.reconcile
    if (queryToolId) return `建议先用 ${queryToolId} 查询外部真实状态，再决定是否重试。`
    if (unsafeToRetry) return '这个操作不安全重试，必须由人工确认。'
    if (idempotent) return '这个操作是幂等的，可以安全重试一次。'
    return '无法判断是否可以重试，建议由人工确认。'
  }

  private findUsableGrant(runId: string, toolId: string): Grant | undefined {
    const now = Date.now()
    return this.store
      .listGrants(runId)
      .find((g) => g.toolId === toolId && g.status === 'active' && g.expiresAt > now &&
        (g.constraints.maxCalls == null || g.usedCalls < g.constraints.maxCalls))
  }

  // ── 审批结果回填 ─────────────────────────────────────────

  /**
   * 执行状态门。
   *
   * 每种状态的合法入口不同，混用会绕过安全检查：
   *   queued / running      → 允许（首次执行或崩溃恢复）
   *   paused                → 必须走 resume()，不能直接 execute
   *   waiting_approval      → 必须先 approve/reject
   *   needs_reconciliation  → 必须先 reconcile
   *   终态                  → 禁止
   *
   * 「允许哪些起始状态」只从 state-machine.ts 的 RUN_EXECUTABLE_FROM 取，
   * 不在这里再写一份字面量。两处各写一份时，状态机加了新状态而这里忘了同步，
   * 就会出现「状态机说不能执行、执行门却放行」的分叉。
   */
  private checkExecuteGate(run: Run): {
    allowed: boolean
    reason: string
    resultStatus: ExecuteOutcome['status']
  } {
    // 先按统一表判断：结构上根本不允许进入 running 的状态，一律拒绝。
    const structurallyAllowed =
      RUN_EXECUTABLE_FROM.includes(run.status) && canTransition('run', run.status, 'running')
    if (!structurallyAllowed) {
      return this.explainRunGate(run)
    }

    // 结构允许后再查业务前置：上次异常退出留下的 unknown 必须先对账。
    if (this.store.hasUnresolvedUnknown(run.id)) {
      return {
        allowed: false,
        reason:
          '这个 Run 有未解决的 unknown 操作，必须先对账（POST /runs/:id/reconcile）。',
        resultStatus: 'needs_reconciliation',
      }
    }
    return { allowed: true, reason: '', resultStatus: 'failed' }
  }

  /** 被状态门拒绝时，给出可操作的说明（每种状态指向正确的入口）。 */
  private explainRunGate(run: Run): {
    allowed: boolean
    reason: string
    resultStatus: ExecuteOutcome['status']
  } {
    switch (run.status) {
      case 'paused':
        return {
          allowed: false,
          reason:
            '这个 Run 处于用户主动暂停状态，必须通过 resume（POST /runs/:id/resume）恢复，' +
            '不能直接 execute。',
          resultStatus: 'paused',
        }

      case 'waiting_approval':
        return {
          allowed: false,
          reason:
            '这个 Run 在等待审批，必须先 approve 或 reject。' +
            '直接 execute 会绕过审批。',
          resultStatus: 'paused',
        }

      case 'needs_reconciliation':
        return {
          allowed: false,
          reason:
            '这个 Run 有未解决的 unknown 操作，必须先对账' +
            '（POST /runs/:id/reconcile）。',
          resultStatus: 'needs_reconciliation',
        }

      case 'completed':
        return {
          allowed: false,
          reason: '这个 Run 已经完成，不能重复执行。如需重新执行请创建新的 Run。',
          resultStatus: 'completed',
        }

      case 'failed':
      case 'cancelled':
      case 'expired':
        return {
          allowed: false,
          reason: `这个 Run 已经处于终态 ${run.status}，不能重复执行。`,
          resultStatus: run.status,
        }

      case 'auditing':
        return {
          allowed: false,
          reason: '这个 Run 正在审计中，不能执行。',
          resultStatus: 'failed',
        }

      default:
        return {
          allowed: false,
          reason: `未知的 Run 状态：${String(run.status)}`,
          resultStatus: 'failed',
        }
    }
  }

  /**
   * 把超时未决的审批按 fail-closed 规则转为拒绝。
   *
   * 应该在服务启动时和每次 execute 前调用。
   * 返回被自动拒绝的审批，便于调用方通知用户。
   */
  expireStaleApprovals(): Approval[] {
    const expired = this.store.expireStaleApprovals()
    for (const approval of expired) {
      this.finishStep(approval.stepId, 'rejected', {
        reason: '审批超时，系统按 fail-closed 规则自动拒绝',
        autoExpired: true,
      })
      // 把超时也记进拒绝去重表，防止模型反复请求
      this.store.recordDenied({
        runId: approval.runId,
        toolId: approval.toolId,
        argumentHash: hashArguments(approval.arguments),
        reason: '审批超时自动拒绝',
        createdAt: Date.now(),
      })
      this.emit(approval.runId, 'approval.expired', { approvalId: approval.id })
      const run = this.store.getRun(approval.runId)
      if (run && run.status === 'waiting_approval') {
        this.store.setRunStatus(approval.runId, 'queued')
      }
    }
    return expired
  }

  /**
   * 解决一个 unknown 状态。
   *
   * unknown 不能自动消除——必须有人做出判断并留下依据。
   * 优先用对账工具查询，查不到再由用户裁决。
   */
  reconcile(input: {
    runId: string
    stepId: string
    resolution: ReconciliationRecord['resolution']
    evidence?: string
    /**
     * 谁做的裁决。
     *
     * **'system' 只能由内部代码路径产生**，不能来自 HTTP 请求体。
     * 外部调用方即使传了 'system'，也会被降级为 'user'——
     * 除非同时设置 `trusted: true`（只有服务端内部代码会这么做）。
     *
     * 为什么：'system' 表示「系统自动裁决」，在审计上是更强的声明。
     * 如果谁都能声称自己是 system，这个字段就失去意义。
     */
    decidedBy?: 'user' | 'reconciler' | 'system'
    /** 内部调用方标记。HTTP 层永远不传。 */
    trusted?: boolean
    /**
     * 这次裁决针对的是哪个外部调用。
     *
     * Run 里有多个 unknown Intent 时**必须**指定，否则无法确定
     * 「这条裁决说的是哪次副作用」。猜错比不裁决更糟——
     * 会把 A 的确认结果记到 B 头上。
     */
    intentId?: string
    /** 也可以用 toolCallId 指定（调用方通常只有这个）。 */
    toolCallId?: string
  }): ReconciliationRecord {
    const step = this.store.getStep(input.stepId)
    if (!step) throw new ReconcileError(`Step 不存在：${input.stepId}`, 'NOT_FOUND')

    // 归属校验：这个 Step 必须属于指定的 Run。
    //
    // 没有这一条，可以用 Run-A 的接口去裁决 Run-B 的 unknown Step，
    // 结果是 Run-B 的 Step 被标记为已解决，但状态更新作用在 Run-A 上。
    if (step.runId !== input.runId) {
      throw new ReconcileError(`Step ${input.stepId} 属于 Run ${step.runId}，不是 ${input.runId}`)
    }

    if (step.status !== 'unknown') {
      throw new ReconcileError(`只有 unknown 状态的 Step 需要裁决，当前是 ${step.status}`)
    }

    // ── 证据校验 ──────────────────────────────────────────
    //
    // unknown 的含义是「不知道外部发生了什么」。
    // 解除它必须靠**可核验的证据**，不能靠「用户点了确认」。
    //
    // 否则 reconcile 就变成一个「把不确定改成确定」的按钮，
    // 而它本来是系统诚实性的最后一道防线。
    //
    // 证据必须是 JSON，且包含 type / source / observed / actor：
    //   type      证据从哪类手段取得（external_query / manual_inspection / tool_log）
    //   source    具体来源（file_stat / git / db_query / ...）
    //   observed  观察到的结果（exists / not_found / partial / ...）
    //   actor     谁做的判断
    //
    // 并且 observed 必须与 resolution 自洽：
    //   confirmed_success → 必须观察到「存在」
    //   confirmed_failure → 必须观察到「不存在」
    // 自相矛盾的证据要拒绝——这正是「用户随手点一下」的典型形态。
    // 'system' 只能由内部路径声称。
    // 外部调用方传 'system' 会被降级为 'user'——这是有意的：
    // 没有 trusted 标记时，任何请求体都不能把自己伪装成系统自动裁决。
    //
    // 这个值必须在证据校验之前算好：人工复核路径要靠它判断
    // 「是不是真的由用户确认的」。
    const requestedBy = input.decidedBy ?? 'user'
    const effectiveDecidedBy =
      requestedBy === 'system' && !input.trusted ? 'user' : requestedBy

    const parsedEvidence = parseReconcileEvidence(input.evidence, input.resolution)

    // ── 证据必须能被服务端独立验证 ────────────────────────
    //
    // unknown 的含义是「不知道外部发生了什么」。解除它必须靠
    // **服务端自己能核对的**证据，而不是调用方的一句话。
    //
    // 分三类：
    //   · file_stat     → 服务端自己 stat/读文件，可验证
    //   · db_query/git  → 需要连外部系统，本进程无法验证
    //   · tool_log      → 调用方提供的日志，本质是自证
    //
    // 只有第一类能自动解除 unknown。后两类必须走人工复核——
    // 它们不是「更弱的证据」，而是「无法区分真假的说法」。
    const verifyResult = this.verifyReconcileEvidence(parsedEvidence)

    // ── 无法验证的证据：只能走人工复核 ────────────────────
    //
    // 「无法验证」不等于「证据是假的」，它意味着**服务端没法判断真假**。
    // 这类证据不能自动解除 unknown，但也不该完全禁止——
    // 人工核对确实是真实场景（比如操作发生在另一台机器上）。
    //
    // 所以分两种路径：
    //   · 已验证  → 正常解除
    //   · 未验证  → 必须显式声明是人工复核，且记进 evidence 里
    //
    // 「显式声明」的判据：type === 'manual_inspection' 且 decidedBy 是 user。
    // 这样事后能一眼看出「这条 unknown 是靠人的判断解除的，不是机器核对的」。
    // 两条免验证通道：
    //   · manual_review  → 用户明确确认（type=manual_inspection + decidedBy=user）
    //   · system trusted → 内部代码路径已经知道结果，不需要外部证据
    //
    // system 路径的可信度来自 `trusted: true`，它只能由内部调用设置。
    const isManualReview =
      parsedEvidence.type === 'manual_inspection' &&
      effectiveDecidedBy === 'user'
    const isTrustedSystem =
      effectiveDecidedBy === 'system' && input.trusted === true

    if (!verifyResult.verified && !isManualReview && !isTrustedSystem) {
      throw new InvalidReconcileEvidence(
        `证据无法被服务端独立验证：${verifyResult.reason}。` +
        '要解除 unknown，必须满足其一：' +
        '（1）用 file_stat 并给出服务端可检查的 path；' +
        '（2）声明 type=manual_inspection 且由用户明确确认（人工复核）。',
      )
    }


    // ── 先定位这次裁决针对的 Intent ──────────────────────
    //
    // 必须在创建记录**之前**定位：记录里要带上 intentId / toolCallId。
    // 上一版是先建记录、再补 Intent，结果记录里永远是空的。
    //
    // 怎么找：
    //   · 审批恢复路径：approval.toolCallId ↔ intent.toolCallId
    //   · 普通路径：Run 里只有一条 unknown Intent 时直接用它
    //
    // 不能按 stepId 匹配——审批恢复时 Step 是新
    // 建的，而 Intent 挂在原始审批的 stepId 上。
    const intents = this.store.listIntents(input.runId)
    const unknownIntents = intents.filter((i) => i.status === 'unknown')

    let intent: ToolIntent | undefined

    // ① 显式指定优先，且必须与 Step 一致
    if (input.intentId || input.toolCallId) {
      const target = input.intentId
        ? intents.find((i) => i.id === input.intentId)
        : intents.find((i) => i.toolCallId === input.toolCallId)

      if (!target) {
        throw new ReconcileError(
          `指定的 Intent 不存在于 Run ${input.runId}：` +
          `${input.intentId ?? input.toolCallId}`,
          'NOT_FOUND',
        )
      }
      if (target.status !== 'unknown') {
        throw new ReconcileError(
          `Intent ${target.id} 的状态是 ${target.status}，不是 unknown，不需要裁决`,
        )
      }
      if (target.runId !== input.runId) {
        throw new ReconcileError(
          `Intent ${target.id} 属于 Run ${target.runId}，不是 ${input.runId}`,
        )
      }
      // Step 与 Intent 必须对应同一件事。
      //
      // 审批恢复路径下 Step 是新建的、Intent 挂在原审批的 stepId 上，
      // 所以这里**不要求 stepId 相等**；但要求二者能被同一条审批链起来，
      // 或者 Intent 的 stepId 就是这个 Step。
      const linkedApproval = this.store
        .listApprovals()
        .find((a) => a.runId === input.runId && a.toolCallId === target.toolCallId)
      const stepMatches =
        target.stepId === input.stepId ||
        (linkedApproval !== undefined && linkedApproval.toolCallId === target.toolCallId)
      if (!stepMatches) {
        throw new ReconcileError(
          `Intent ${target.id} 绑定的是 Step ${target.stepId}，` +
          `与请求的 Step ${input.stepId} 不一致，且没有审批记录能把它们关联起来`,
        )
      }
      intent = target
    } else {
      // ② 没指定：只有唯一一个 unknown Intent 时才敢用
      //
      // 多个 unknown 时无法确定这条裁决说的是哪次副作用。
      // 猜错会把 A 的确认结果记到 B 头上——那是伪造证据。
      if (unknownIntents.length > 1) {
        throw new ReconcileError(
          `Run ${input.runId} 有 ${unknownIntents.length} 个未解决的 unknown Intent，` +
          '必须通过 intentId 或 toolCallId 指定这次裁决针对哪一个',
        )
      }
      if (unknownIntents.length === 1) {
        // ── 「唯一」不等于「就是这一条」────────────────────
        //
        // 旧实现只看数量就绑定，漏掉了归属：这条 Intent 可能属于
        // Run 里的**另一个 Step**。典型场景是
        //
        //   Step A：纯本地 unknown（无副作用，没有 Intent）
        //   Step B：unknown，挂着一条 unknown Intent
        //
        // 对账 A 时，B 的 Intent 会被当成「唯一的那一条」绑上来并
        // 标成 reconciled，而 B 的 Step 仍是 unknown。
        // 记录上写着「A 的裁决」，实际裁决的是 B 的外部调用——
        // 正是下面注释里禁止的「把 A 的确认结果记到 B 头上」。
        //
        // 归属判据与显式路径保持一致：Step 相同，或者二者能由
        // 同一条审批记录关联（审批恢复时 Step 是新建的）。
        const candidate = unknownIntents[0]!
        const linkedApproval = this.store
          .listApprovals()
          .find((a) => a.runId === input.runId && a.toolCallId === candidate.toolCallId)
        const stepMatches =
          candidate.stepId === input.stepId ||
          (linkedApproval !== undefined && linkedApproval.toolCallId === candidate.toolCallId)

        if (stepMatches) {
          intent = candidate
        }
        // 不匹配：这条裁决针对的是本地 Step，**不绑 Intent**。
        // 不能报错——本地 unknown 本来就合法地没有 Intent；
        // 也不能顺手改别人的 Intent。
      }
      // 0 个 unknown Intent：Step 可能是纯本地的 unknown（没有外部副作用），
      // 这时不绑 Intent 是合法的。
    }

    // ── 四处写入必须在同一事务 ────────────────────────────
    //
    // ReconciliationRecord / Step / Intent / Run 是一件事的四个侧面。
    // 分开写的话，进程在中间崩溃会留下：
    //   · 有裁决记录但 Step 还是 unknown（看起来没解决）
    //   · Step 已 completed 但 Intent 还 unknown（看起来还有副作用没确认）
    // 两种状态都会让后续的验收/执行判断基于错误的事实。
    const record = this.store.runInTransaction(() => {
      const rec = this.store.createReconciliation({
        runId: input.runId,
        stepId: input.stepId,
        // ★ 绑定到具体的外部调用，不只是执行轨迹
        intentId: intent?.id,
        toolCallId: intent?.toolCallId,
        unknownReason: extractUnknownReason(step.output),
        resolution: input.resolution,
        // 存规范化后的 JSON，而不是原始输入——
        // 保证数据库里的每条 evidence 都是可解析、可比对的结构。
        // 未经验证的人工复核要显式标注，事后能区分。
        evidence: JSON.stringify({
          ...parsedEvidence,
          serverVerified: verifyResult.verified,
          ...(verifyResult.verified ? {} : { manualReview: true }),
        }),
        decidedBy: effectiveDecidedBy,
      })

      // 裁决后 Step 的终态取决于裁决结果
      const finalStatus: StepStatus =
        input.resolution === 'confirmed_success' ? 'completed'
          : input.resolution === 'confirmed_failure' ? 'failed'
            : input.resolution === 'retried' ? 'skipped'
              : 'cancelled'
      this.store.updateStep(input.stepId, { status: finalStatus })

      // ── 同步裁决 Intent ────────────────────────────────
      //
      // Step 只是执行轨迹，Intent 才是「这次外部调用到底怎么样了」的记录。
      // 只改 Step 不改 Intent 会留下一个永久卡死的状态。
      //
      // 注意：reconciled **不等于**重试。
      // 它只是把「未知」变成「已知」，不会重新执行工具。
      if (intent) {
        this.store.reconcileIntent(
          intent.id,
          `${input.resolution}${input.evidence ? `：${input.evidence}` : ''}`,
        )
      }

      // 如果这个 Run 再没有未解决的 unknown，解除阻塞
      const run = this.store.getRun(input.runId)
      if (run && run.status === 'needs_reconciliation' &&
          !this.store.hasUnresolvedUnknown(input.runId)) {
        this.store.setRunStatus(input.runId, 'queued')
      }

      return rec
    })

    if (intent) {
      this.emit(input.runId, 'intent.reconciled', {
        intentId: intent.id,
        toolName: intent.toolName,
        resolution: input.resolution,
      })
    }

    this.emit(input.runId, 'reconciliation.resolved', {
      stepId: input.stepId,
      resolution: input.resolution,
      decidedBy: record.decidedBy,
    })
    return record
  }

  /**
   * 服务端独立验证 reconcile 证据。
   *
   * 只认能自己复核的来源。认不出的来源一律视为「无法验证」——
   * 这不是「证据弱一点」，而是「无法区分真假」。
   */
  private verifyReconcileEvidence(
    evidence: ReconcileEvidence,
  ): { verified: true } | { verified: false; reason: string } {
    if (!SERVER_VERIFIABLE_SOURCES.has(evidence.source)) {
      return {
        verified: false,
        reason:
          `source=${evidence.source} 需要连接外部系统，本进程无法独立复核`,
      }
    }

    // file_stat：必须给出具体路径，否则无从验证
    if (!evidence.path || !evidence.path.trim()) {
      return {
        verified: false,
        reason: 'file_stat 证据必须给出 path（服务端要按这个路径实际检查）',
      }
    }

    // 服务端自己看文件是否存在
    const exists = existsSync(evidence.path)
    const actual = exists ? 'exists' : 'not_found'

    // observed 必须与服务端观察一致。
    // 这一条直接挡住「声称文件存在，实际不存在」。
    if (evidence.observed === 'exists' && actual !== 'exists') {
      return {
        verified: false,
        reason: `证据声称文件存在，但服务端检查 ${evidence.path} 不存在`,
      }
    }
    if (evidence.observed === 'not_found' && actual === 'exists') {
      return {
        verified: false,
        reason: `证据声称文件不存在，但服务端检查 ${evidence.path} 存在`,
      }
    }

    // 如果给了 contentHash，也要核对
    if (evidence.contentHash && exists) {
      try {
        const content = readFileSync(evidence.path, 'utf8')
        const actualHash = createHash('sha256').update(content, 'utf8').digest('hex')
        if (actualHash !== evidence.contentHash) {
          return {
            verified: false,
            reason:
              `证据的 contentHash 与文件实际内容不一致` +
              `（声称 ${evidence.contentHash.slice(0, 12)}，实际 ${actualHash.slice(0, 12)}）`,
          }
        }
      } catch (err) {
        return {
          verified: false,
          reason: `读取 ${evidence.path} 失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    return { verified: true }
  }

  /** 用户主动暂停。与 waiting_approval 不同，可直接恢复。 */
  pause(runId: string): void {
    const run = this.store.getRun(runId)
    if (!run) throw new Error(`Run 不存在：${runId}`)
    if (run.status !== 'running') throw new Error(`只有 running 状态可以暂停，当前是 ${run.status}`)

    // CAS：如果这期间 Run 已经跑完了，暂停请求应该失败而不是把它改回 paused
    const ok = this.store.transitionRunStatus(runId, 'running', 'paused')
    if (!ok) {
      const current = this.store.getRun(runId)!
      throw new Error(
        `暂停失败：Run 状态已变为 ${current.status}（可能已经执行完成）`,
      )
    }
    this.emit(runId, 'run.paused_by_user', {})
  }

  /** 恢复用户主动暂停的 Run。waiting_approval 不能走这条路径。 */
  resume(runId: string): void {
    const run = this.store.getRun(runId)
    if (!run) throw new Error(`Run 不存在：${runId}`)
    if (run.status === 'waiting_approval') {
      throw new Error('这个 Run 在等审批，必须先批准或拒绝，不能直接恢复')
    }
    if (run.status !== 'paused') throw new Error(`只有 paused 状态可以恢复，当前是 ${run.status}`)

    // 用 CAS 迁移到 queued，而不是直接写 running。
    //
    // 语义上：resume 表示「解除暂停，允许再次执行」，
    // 真正开始执行是下一次 execute 的事。这样和状态门保持一致：
    // 只有 queued 可以 execute，running 表示正在执行。
    const ok = this.store.transitionRunStatus(runId, 'paused', 'queued')
    if (!ok) {
      const current = this.store.getRun(runId)!
      throw new Error(`恢复失败：Run 状态已被其他操作改为 ${current.status}`)
    }
    this.emit(runId, 'run.resumed', {})
  }

  /** 用户批准后调用：创建 Grant 并把 Run 从 waiting_approval 拉回 running。 */
  approve(approvalId: string, opts: { scope?: 'once' | 'run'; approver?: 'user' | 'system' } = {}): Grant {
    const approval = this.store.getApproval(approvalId)
    if (!approval) throw new Error(`审批不存在：${approvalId}`)

    const step = this.store.getStep(approval.stepId)
    const def = this.tools.listAll().find((d) => d.id === approval.toolId)
    if (!def) throw new Error(`工具不存在：${approval.toolId}`)

    // 原子抢占：pending → approved。
    //
    // 不能先判断 status !== 'pending' 再写——两个操作同时到达时
    // 都会通过判断。用条件 UPDATE 让数据库裁决。
    const won = this.store.transitionApproval(approvalId, 'approved', opts.approver)
    if (!won) {
      const current = this.store.getApproval(approvalId)!
      throw new Error(
        `审批已被处理：当前状态 ${current.status}` +
        (current.reason ? `（${current.reason}）` : ''),
      )
    }

    const maxCalls = opts.scope === 'run' ? 50 : 1
    const grant = this.store.createGrant({
      id: randomUUID(),
      runId: approval.runId,
      toolId: approval.toolId,
      constraints: { maxCalls },
      // 授权绑定到本次 Run，默认 1 小时过期
      expiresAt: Date.now() + 60 * 60 * 1000,
      status: 'active',
      approver: opts.approver,
    })

    if (step) this.finishStep(step.id, 'completed', { decision: 'approved', grantId: grant.id })
    this.store.setRunStatus(approval.runId, 'queued')
    this.emit(approval.runId, 'approval.approved', { approvalId, grantId: grant.id, scope: opts.scope ?? 'once' })
    return grant
  }

  /** 用户拒绝后调用：记录拒绝、标记 Step，Run 回到 queued 让模型收束。 */
  reject(approvalId: string, reason: string): void {
    const approval = this.store.getApproval(approvalId)
    if (!approval) throw new Error(`审批不存在：${approvalId}`)

    // 原子抢占：pending → rejected
    const won = this.store.transitionApproval(approvalId, 'rejected', reason)
    if (!won) {
      const current = this.store.getApproval(approvalId)!
      throw new Error(
        `审批已被处理：当前状态 ${current.status}` +
        (current.reason ? `（${current.reason}）` : ''),
      )
    }

    this.store.recordDenied({
      runId: approval.runId,
      toolId: approval.toolId,
      argumentHash: hashArguments(approval.arguments),
      reason,
      createdAt: Date.now(),
    })
    this.finishStep(approval.stepId, 'rejected', { reason })
    this.store.setRunStatus(approval.runId, 'queued')
    this.emit(approval.runId, 'approval.rejected', { approvalId, reason })
  }

  /**
   * 取消 Run。
   *
   * 必须用 CAS，不能用 setRunStatus 直接写。
   *
   * 两个方向都会出错：
   *   1. 取消覆盖终态：Run 已经 completed / failed / expired 之后来一个迟到的
   *      cancel 请求，直接写会把「完成」改成「取消」——事实被改写了。
   *   2. 终态覆盖取消：执行线程还在等模型响应时用户点了取消，
   *      写入 cancelled；模型晚到，执行线程写回 completed——
   *      用户点过的取消被静默忽略。
   *
   * 现在的语义：
   *   · 只允许从**非终态**进入 cancelled（CAS）
   *   · 已经是终态的 Run 返回它当前的终态，不修改
   *   · 执行线程的收尾写入同样走 CAS（见 finishRun），
   *     所以它写不回去——cancelled 是终态
   */
  cancel(runId: string, opts?: ExecuteOptions): ExecuteOutcome {
    const run = this.store.getRun(runId)
    if (!run) throw new Error(`Run 不存在：${runId}`)

    const cancelled = this.store.transitionRunStatus(
      runId,
      ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'],
      'cancelled',
      { endedAt: Date.now() },
    )

    if (!cancelled) {
      // 已经是终态：不覆盖，如实返回当前状态。
      const current = this.store.getRun(runId)!
      if (opts) this.notify(opts, runId)
      return outcomeForExisting(current)
    }

    this.emit(runId, 'run.cancelled', {})
    if (opts) this.notify(opts, runId)
    return { status: 'cancelled', run: this.store.getRun(runId)! }
  }

  // ── 内部辅助 ─────────────────────────────────────────────

  /**
   * 预算检查。同时检查 Run 级和 Task 级。
   *
   * 两种模式：
   *   · 计数型（steps / toolCalls）：检查「已用 + 本次」是否超出
   *   · 累计型（tokens / cost）：检查「已用」是否已达上限
   *
   * 为什么累计型用 `>=` 而不是 `>`：
   * 已达上限时再发起一次调用，必然超限。`>` 会放行这种情况。
   *
   * 为什么还需要「调用后 overshoot 检查」：
   * token 和 cost 只有模型返回后才知道真实值，调用前无法精确预判。
   * 所以调用前只能做「已用是否已达上限」这种保守检查，
   * 调用后必须再检查一次，超了就立即终止，不再发起下一次。
   */
  /**
   * 决定这次模型调用要预留多少 output token。
   *
   * 为什么需要它：固定 outputReserve 会让小预算永远跑不了。
   * 但也**不能**随便估小——估小了实际输出超了，就会在调用后才发现超支。
   *
   * 策略：
   *   1. Run 显式给了 maxOutputTokens → 用它（用户已经划定了输出上限）
   *   2. 否则用「剩余可用的 output 预算」和「默认上限」的较小值
   *   3. 剩余 <= 0 → 返回 null（调用方拒绝这次调用）
   *
   * 「剩余」怎么算：总量上限减去已用和已预留。
   * 注意这里用的是**最紧的那个上限**（total / output / cost 对应的 token 容量），
   * 保守方向永远是对的。
   */
  private resolveOutputEstimate(run: Run, estimatedInput: number): number | null {
    const b = run.budget

    // 1. 显式声明优先
    if (b.maxOutputTokens != null) {
      const remaining = b.maxOutputTokens - run.usage.outputTokens
      if (remaining <= 0) return null
      return Math.min(remaining, this.config.outputReserve)
    }

    // 2. 没有显式声明：用剩余总量预算作上限
    //
    // 要减去本次的 input 估算，否则
    //   maxTotalTokens=200, input≈20, output=200 → 合计 220 > 200 被拒，
    // 明明还有空间却跑不了。
    if (b.maxTotalTokens != null) {
      const usedTotal = run.usage.inputTokens + run.usage.outputTokens
      const remaining = b.maxTotalTokens - usedTotal - estimatedInput
      if (remaining <= 0) return null
      return Math.min(remaining, this.config.outputReserve)
    }

    // 3. 什么上限都没有：用默认值
    return this.config.outputReserve
  }

  private checkBudget(runId: string, dimension: 'steps' | 'toolCalls' | 'tokens' | 'cost', amount: number): void {
    const run = this.store.getRun(runId)
    if (!run) return

    // ── Task 级累计预算 ──────────────────────────────────
    const task = this.store.getTask(run.taskId)
    if (task?.budget && task.usage) {
      const tb = task.budget
      const tu = task.usage
      if (tb.maxCostUsd != null && tu.costUsd >= tb.maxCostUsd) {
        throw new BudgetExceeded('task.maxCostUsd', tb.maxCostUsd)
      }
      if (tb.maxSteps != null && tu.steps >= tb.maxSteps) {
        throw new BudgetExceeded('task.maxSteps', tb.maxSteps)
      }
      if (tb.maxDurationMs != null && Date.now() - tu.startedAt >= tb.maxDurationMs) {
        throw new BudgetExceeded('task.maxDurationMs', tb.maxDurationMs)
      }
    }

    const b: RunBudget = run.budget
    const usedTokens = run.usage.inputTokens + run.usage.outputTokens

    if (b.deadlineAt != null && Date.now() > b.deadlineAt) {
      throw new BudgetExceeded('deadlineAt', b.deadlineAt)
    }

    // ── 计数型：已用 + 本次 ──────────────────────────────
    if (dimension === 'steps' && b.maxSteps != null && run.usage.steps + amount > b.maxSteps) {
      throw new BudgetExceeded('maxSteps', b.maxSteps)
    }
    if (dimension === 'toolCalls' && b.maxToolCalls != null && run.usage.toolCalls + amount > b.maxToolCalls) {
      throw new BudgetExceeded('maxToolCalls', b.maxToolCalls)
    }

    // ── 累计型：已达上限即拦截（>=，不是 >） ──────────────
    if (b.maxTotalTokens != null && usedTokens >= b.maxTotalTokens) {
      throw new BudgetExceeded('maxTotalTokens', b.maxTotalTokens)
    }
    if (b.maxInputTokens != null && run.usage.inputTokens >= b.maxInputTokens) {
      throw new BudgetExceeded('maxInputTokens', b.maxInputTokens)
    }
    if (b.maxOutputTokens != null && run.usage.outputTokens >= b.maxOutputTokens) {
      throw new BudgetExceeded('maxOutputTokens', b.maxOutputTokens)
    }
    if (b.maxCostUsd != null && run.usage.costUsd >= b.maxCostUsd) {
      throw new BudgetExceeded('maxCostUsd', b.maxCostUsd)
    }
  }

  /**
   * 调用后的 overshoot 检查。
   *
   * 模型返回的真实用量可能超过预算——调用前无法预知。
   * 这时必须立即终止，不再发起下一次调用。
   *
   * 返回 overshoot 的维度，没有超限则返回 null。
   */
  private detectOvershoot(runId: string): { dimension: string; limit: number; actual: number } | null {
    const run = this.store.getRun(runId)
    if (!run) return null
    const b = run.budget
    const used = run.usage.inputTokens + run.usage.outputTokens

    if (b.maxTotalTokens != null && used > b.maxTotalTokens) {
      return { dimension: 'maxTotalTokens', limit: b.maxTotalTokens, actual: used }
    }
    if (b.maxInputTokens != null && run.usage.inputTokens > b.maxInputTokens) {
      return { dimension: 'maxInputTokens', limit: b.maxInputTokens, actual: run.usage.inputTokens }
    }
    if (b.maxOutputTokens != null && run.usage.outputTokens > b.maxOutputTokens) {
      return { dimension: 'maxOutputTokens', limit: b.maxOutputTokens, actual: run.usage.outputTokens }
    }
    if (b.maxCostUsd != null && run.usage.costUsd > b.maxCostUsd) {
      return { dimension: 'maxCostUsd', limit: b.maxCostUsd, actual: run.usage.costUsd }
    }
    // 成本未知时 costUsd 只是「已知部分之和」，用它判断「没超」是 fail-open。
    // 正常路径下走不到这里（价格未知 + 设了成本上限会在调用前被拒），
    // 但作为第二道防线必须保守：证明不了没超，就按超了处理。
    if (b.maxCostUsd != null && run.usage.costUnknown) {
      return { dimension: 'maxCostUsd', limit: b.maxCostUsd, actual: run.usage.costUsd }
    }
    return null
  }

  private toolSpecs() {
    return this.tools.specs()
  }

  private finishStep(id: string, status: StepStatus, output: unknown, trace: StepTrace = {}): void {
    this.store.updateStep(id, { status, output, trace })
  }

  /**
   * 收尾为失败。
   *
   * 用 CAS 而不是直接写：如果期间用户已经取消了这个 Run，
   * cancelled 是终态，这里就不能把它覆盖成 failed。
   * 覆盖会让「用户点了取消」这件事从记录里消失。
   */
  private fail(runId: string, error: string, opts?: ExecuteOptions): ExecuteOutcome {
    // 被接管后不允许再写任何状态——否则会覆盖新 owner 的 Run。
    if (opts?.leaseGuard && !opts.leaseGuard.check()) {
      return {
        status: 'lease_lost',
        reason: opts.leaseGuard.invalidReason ?? '租约已失效',
        run: this.store.getRun(runId)!,
      }
    }
    const won = this.store.transitionRunStatus(
      runId,
      ['queued', 'running', 'paused', 'waiting_approval', 'needs_reconciliation', 'auditing'],
      'failed',
      { endedAt: Date.now() },
    )
    if (!won) {
      // 状态已被别人改成终态（最可能是 cancel）：不覆盖，如实返回。
      const current = this.store.getRun(runId)!
      if (opts) this.notify(opts, runId)
      return outcomeForExisting(current, error)
    }
    this.emit(runId, 'run.failed', { error })
    if (opts) this.notify(opts, runId)
    return { status: 'failed', error, run: this.store.getRun(runId)! }
  }

  /**
   * 写一条领域事件。
   *
   * actor 固定为 'system'：执行内核是内部代码路径，不是用户、也不是模型。
   * correlationId 用 runId：一次 Run 的全部事件属于同一次操作，
   * 这比时间戳可靠（并发时时间戳会交错）。
   *
   * 不把 actor 做成参数：任何一处传错都会让审计把「内核自动做的」
   * 记成「用户做的」。这条路径不需要那种灵活性。
   */
  private emit(runId: string, kind: string, payload: unknown): void {
    this.store.appendEvent(runId, kind, payload, {
      actor: 'system',
      correlationId: runId,
    })
  }

  private notify(opts: ExecuteOptions, runId: string, step?: Step): void {
    const run = this.store.getRun(runId)
    if (run) opts.onStatusChange?.(run)
    if (step) opts.onStep?.(step)
  }
}
