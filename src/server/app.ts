// HTTP 服务层。这一层很薄：解析请求 → 调核心 → 返回 JSON。
// 业务逻辑一律不在这里，保证将来换成 Electron IPC 时可以直接复用核心。
//
// 本文件是工厂：每次 createWorkstationServer() 得到一套独立实例。
// 测试因此可以在同一进程里起多个互不干扰的服务，而不必 spawn 子进程。
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Store } from '../core/store.js'
import { RunExecutor, InvalidReconcileEvidence, InvalidExecuteRequest } from '../core/executor.js'
import { ToolRegistry } from '../core/tools.js'
import { SnapshotManager, isGitAvailable } from '../core/snapshot.js'
import { DomainError, codeOf, errorCodes, isDomainErrorCode, normalizeError, specFor, type DomainErrorCode } from '../core/errors.js'
import {
  assertPermission,
  externalUser,
  permissionActions,
  PERMISSION_CATALOG,
  type PermissionAction,
} from '../core/permissions.js'
import { EVENT_ACTORS, EVENT_CATALOG } from '../core/event-catalog.js'
import { machineSummary } from '../core/state-machine.js'
import { AcceptanceService } from '../core/acceptance.js'
import { ReviewLoop, registerSkill, getSkill, getSkillManifest } from '../core/review-loop.js'
import { recoverOnStartup } from '../core/recovery.js'
import { scanInvariants } from '../core/invariants.js'
import { knownSnapshotRefs, validateGitRef } from '../core/git-ref.js'
import {
  SecretStore,
  ProviderConfigStore,
  assertProviderUsable,
  defaultSecretsPath,
} from '../core/provider-config.js'
import { ImageCapabilityRegistry } from '../core/media.js'
import { McpManager, type McpServerConfig } from '../core/mcp.js'
import { mcpToolImpl } from '../core/tools.js'
import { validateImageRequest } from '../core/media.js'
import { assertRequirements } from '../core/capability-catalog.js'
import {
  DEFAULT_QUOTA,
  ResourceLock,
  checkDiskFree,
  checkQuota,
  formatBytes,
  planGc,
  type SnapshotQuota,
} from '../core/snapshot-lifecycle.js'
import { KnowledgeIndex, validateMemoryInput } from '../core/knowledge.js'
import { SqliteLeaseStore } from '../core/lease-store.js'
import { LeaseGuard } from '../core/lease-fencing.js'
import { newLeaseOwner } from '../core/runner.js'
import { StoreFailureCounter } from '../core/runner-loop.js'
import { resolveStaticAsset } from './static.js'
import {
  UnattendedRunner,
  type RunnerStore,
} from '../core/runner-loop.js'
import {
  evaluatePause,
  isLeaseSuspicious,
  validateUnattendedPolicy,
  DEFAULT_UNATTENDED_POLICY,
  type UnattendedPolicy,
} from '../core/runner.js'
import {
  WorkgroupCoordinator,
} from '../core/workgroup-coordinator.js'
import {
  buildBundleFromStore,
  inspectFromStore,
} from '../core/evidence-service.js'
import {
  replayBundle,
  validateHumanDecision,
  verifyBundle,
  type EvidenceBundle,
} from '../core/evidence.js'
import {
  readyPackages,
  validateChangeSetInput,
  validateGraph,
  validateWorkPackageInput,
  type RoleDefinition,
} from '../core/workgroup.js'
import {
  MAX_ATTACHMENT_BYTES,
  deriveConversationStatus,
  projectRunMessage,
  summarizeEvent,
  validateAttachmentMeta,
  type ActivityEntry,
  type ProjectedMessage,
} from '../core/conversation.js'
import {
  capabilitySnapshot,
  profiledProviderIds,
  resolveModelCapabilities,
} from '../core/capability-catalog.js'
import { listSkills } from '../core/review-loop.js'
import { newOpenAIImageAdapter } from '../providers/openai-image.js'
import { BUILTIN_RULES } from '../core/audit.js'
import type { AuditSkill } from '../shared/types.js'
import { providerFromPreset, presetFor, PRESETS } from '../providers/registry.js'
import type { ProviderAdapter } from '../providers/types.js'
import type { ChatMessage, ModelInfo } from '../shared/types.js'
import { isInsideGitRepo } from '../shared/net.js'
import {
  parseBearer,
  tokenMatches,
  isAllowedOrigin,
  defaultAllowedOrigins,
  type ResolvedToken,
} from './auth.js'

/** 请求体上限。控制面没有上传需求，1MiB 足够。 */
const MAX_BODY_BYTES = 1024 * 1024

export interface ServerConfig {
  port: number
  host: string
  dataDir: string
  workspace: string
  snapshotDir?: string
  /** 已解析好的 bearer token（含来源信息）。 */
  auth: ResolvedToken
  /** 允许的浏览器 Origin。默认按端口推导出 loopback 的三个变体。 */
  allowedOrigins?: string[]
  approvalTimeoutMs?: number
  maxCycles?: number
  /**
   * Auditor 的 adapter 解析器。默认走真实 provider registry。
   *
   * 存在的理由：集成测试不能真的打外部 API。
   * 注入点只影响「用哪个 adapter 发请求」，不影响契约读取、
   * binding 构造或 verdict 合并——那些仍然走完整生产路径。
   */
  auditorAdapterResolver?: (kind: 'openai' | 'anthropic' | 'demo') => ProviderAdapter
  /**
   * MCP server 配置。为空时不连接任何 MCP。
   *
   * 启动失败**不**阻止服务启动：MCP 是可选能力，
   * 一个写错配置的 server 不该让整个工作站不可用，
   * 它的工具只是不可用，错误在 /meta/capabilities 里可查。
   */
  mcpServers?: McpServerConfig[]
  /** 快照配额。默认见 snapshot-lifecycle 的 DEFAULT_QUOTA。 */
  snapshotQuota?: SnapshotQuota
  /** 桌面壳静态资源目录。默认是源码树里的 src/ui。 */
  uiDir?: string
}

/**
 * 内置角色。
 *
 * 角色定义的是**职责边界**，不是权限提升：
 *   · 任何角色都不能直接使用 external 风险级别的工具（需要用户审批）
 *   · reviewer 不产出实现代码——它只审
 *   · 这样「谁来检查」不会变成「谁来盖章」
 */
export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    id: 'implementer',
    name: '实现者',
    responsibility: '实现代码与文档改动，产出可以合并的变更集',
    allowedTools: ['read_file', 'list_dir', 'file_stat', 'search_files', 'write_file', 'append_file'],
    produces: ['implementation', 'documentation'],
  },
  {
    id: 'tester',
    name: '测试者',
    responsibility: '编写与运行测试，覆盖实现者交付的行为',
    allowedTools: ['read_file', 'list_dir', 'file_stat', 'search_files', 'write_file', 'append_file'],
    produces: ['test', 'analysis'],
  },
  {
    id: 'reviewer',
    name: '审查者',
    responsibility: '审查他人产出，只读不写',
    // 只有只读工具：审查者不该同时能改代码——那会让「审」和「改」
    // 变成同一个人，质量门失去意义。
    allowedTools: ['read_file', 'list_dir', 'file_stat', 'search_files'],
    produces: ['review', 'analysis'],
  },
]

export interface BuildIdentity {
  version: string
  commit: string
  schemaVersion: number
}

export interface WorkstationServer {
  server: Server
  store: Store
  executor: RunExecutor
  tools: ToolRegistry
  snapshot: SnapshotManager
  acceptance: AcceptanceService
  reviewLoop: ReviewLoop
  /** provider 配置（含覆盖与密钥可用性摘要，不含密钥本身）。 */
  providerConfig: ProviderConfigStore
  /** 图像生成能力注册表。 */
  images: ImageCapabilityRegistry
  /** MCP 管理器（未配置时为空管理器）。 */
  mcp: McpManager
  build: BuildIdentity
  /** 认证是否真的生效（永远为 true；保留字段是为了让测试显式断言）。 */
  authEnabled: boolean
  /** 实际监听端口（端口传 0 时由系统分配）。 */
  listen(): Promise<number>
  close(): Promise<void>
}

// ── 错误类型 ──────────────────────────────────────────────

/** 认证失败。必须映射到 401，不能被泛化成 500。 */
class AuthError extends Error {}
/** 请求本身不合法（未知字段、超限等）。→ 400 */
class BadRequestError extends Error {}

// ── 默认技能 ──────────────────────────────────────────────

const DEFAULT_SYSTEM = [
  '你是一个 AI 工作站的执行体。你的目标是完成用户给出的任务，而不是仅仅讨论它。',
  '',
  '工作方式：',
  '- 需要查看文件时，使用 list_dir 和 read_file，不要凭猜测假设文件内容。',
  '- 需要写文件时，使用 write_file。这个操作会请求用户授权，被拒绝时不要反复重试。',
  '- 工具返回「结果未知」时，说明操作可能已经生效也可能没有，不要假设成功，也不要盲目重试。',
  '- 完成任务后，用简短的文字说明你做了什么、结果如何。',
].join('\n')

// 注册内置技能。v1 只提供一个通用技能。
//
// 注意 machineRules 里必须有至少一条 strong 规则。
// 原因：按「模型 pass 只在机器规则明确通过时才生效」的规则，
// 如果全是 weak（只做形式检查），就永远无法自动放行——
// 那样系统在功能上是不可用的，只是一个永远 escalate 的看门人。
const DEFAULT_SKILL: AuditSkill = {
  id: 'general',
  version: '1',
  name: '通用任务',
  machineRules: [
    // weak：证明有东西
    BUILTIN_RULES.artifactNotEmpty,
    BUILTIN_RULES.artifactInSnapshot,
    // strong：证明内容不是占位符，且达到最低实质标准
    BUILTIN_RULES.minLength(20),
    // strong：产物必须可审计（path + sourceSnapshotId + contentHash）
    //
    // 放在 strong 里而不是 weak：证据不完整的产物，
    // 连「它对应哪个文件、内容有没有被改」都回答不了，
    // 不应该进入模型判断环节，更不应该被 accept。
    BUILTIN_RULES.artifactEvidenceComplete,
  ],
  auditorInstructions: [
    '你是一个严格的审计者，负责检查 AI 产出的结果是否真的完成了任务。',
    '',
    '注意：',
    '- 不要因为「格式正确」就给 pass ——格式正确不代表内容合格',
    '- 发现的问题要具体，指出位置和依据',
    '- 无法判断时给 escalate，不要猜',
    '- 如果产物里出现 TODO / 占位符 / 未完成标记，必须 reject',
  ].join('\n'),
  maxCycles: 3,
}

// ── 工具函数 ──────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  // 统一错误形状。
  //
  // 路由处理器有两种写法：`{ error: '文案' }`（就地判断）和抛出错误
  // （由外层 normalizeError 处理）。如果只统一后者，同一个 API 会
  // 出现「有时有 code、有时没有」——客户端无法依赖。
  //
  // 这里的规则：
  //   · error 已是结构化对象 → 原样输出（外层已补齐）
  //   · error 是字符串且状态码 >= 400 → 按状态码补 code / retryable / correlationId
  //   · 其余响应不动
  //
  // code 只从状态码推**类别**，不猜具体业务原因：400 就是 INVALID_INPUT，
  // 404 就是 NOT_FOUND。具体语义仍由消息表达，需要更精确的 code
  // 时应该抛 DomainError，而不是靠状态码反推。
  let payloadBody = body
  let correlationId: string | undefined
  const maybeErr = (body as { error?: unknown } | null)?.error
  if (status >= 400 && typeof maybeErr === 'string') {
    correlationId = randomUUID()
    const given = (body as { code?: unknown }).code
    const code = typeof given === 'string' && isDomainErrorCode(given)
      ? given
      : codeForStatus(status)
    // **保留调用方给的其它字段**（missingTools / missingCapabilities 等）。
    //
    // 早期这里是重建一个新对象，于是路由附带的诊断信息全被丢掉——
    // 客户端只看到「能力不可用」，不知道缺什么，只能盲猜。
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === 'error' || k === 'code' || k === 'retryable' || k === 'correlationId') continue
      rest[k] = v
    }
    payloadBody = {
      error: maybeErr,
      code,
      retryable: specFor(code).retryable,
      correlationId,
      ...rest,
    }
  } else if (status >= 400 && maybeErr && typeof maybeErr === 'object') {
    const id = (maybeErr as { correlationId?: unknown }).correlationId
    if (typeof id === 'string') correlationId = id
  }

  const payload = JSON.stringify(payloadBody, null, 2)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    // 控制面不是给人浏览的，禁止缓存
    'cache-control': 'no-store',
    // 明确不开放跨源读取
    'x-content-type-options': 'nosniff',
  }
  // 错误响应回传 correlationId 头：用户只贴 id 就能报问题，
  // 不必把可能含路径 / 内容的错误文案发出来。
  if (correlationId) headers['x-correlation-id'] = correlationId
  res.writeHead(status, headers)
  res.end(payload)
}

/** 状态码 → 通用错误码类别。只用于「就地返回字符串错误」的旧路径。 */
function codeForStatus(status: number): DomainErrorCode {
  switch (status) {
    case 400:
      return 'INVALID_INPUT'
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 409:
      return 'STATE_CONFLICT'
    case 413:
      return 'PAYLOAD_TOO_LARGE'
    case 429:
      return 'BUDGET_EXCEEDED'
    case 503:
      return 'CAPABILITY_UNAVAILABLE'
    default:
      return 'INTERNAL'
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new BadRequestError(`请求体超过上限 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestError('请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('请求体不是合法 JSON')
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestError(`缺少参数：${key}`)
  return v
}

/**
 * 拒绝未声明的字段。
 *
 * 为什么要这么严：`autoApprove` 原本就从请求体读。
 * 如果只是「不再读它」而不报错，客户端会以为它仍然生效，
 * 悄悄以为自己的写操作被放行了，实际却卡在审批——
 * 这种静默失效比报错危险得多。
 */
function onlyFields(body: Record<string, unknown>, allowed: string[], route: string): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    throw new BadRequestError(
      `${route} 不接受字段：${unknown.join(', ')}。` +
      '权限只能由服务端授权决定，不能通过请求体提升。',
    )
  }
}

/**
 * 按权限表要求调用者具备某个动作的权限。
 *
 * HTTP 层的调用者**永远是 user 且不可信**：没有字段能让它变成 system。
 * 所以这里实际是「这道门是否对用户开放」的声明式检查，
 * 而不是「根据请求内容决定权限」。将来加角色 / 总控时，
 * 只需要换这里的 principal 来源，路由不用改。
 *
 * 被拒时抛 DomainError(FORBIDDEN) → 403，附带 correlationId。
 */
function requirePermission(action: PermissionAction): void {
  assertPermission(externalUser(), action)
}

function modelFrom(
  body: Record<string, unknown>,
  providerConfig: ProviderConfigStore,
): { provider: ReturnType<typeof providerFromPreset>; model: ModelInfo } {
  const presetId = (body.provider as string) ?? 'openai'
  const modelId = requireString(body, 'model')

  // 未知服务商是**请求**的问题，不是服务端故障。
  //
  // 用 DomainError(NOT_FOUND) 而不是 BadRequestError（L2 Task 2）：
  // tick 路径通过 providerConfig.resolve 也抛 NOT_FOUND。
  // 两条路径对同一类错误必须给出**相同的分类**，否则客户端
  // 无法用一套分支同时处理手动执行与自动调度。
  if (!presetFor(presetId)) {
    throw new DomainError(
      'NOT_FOUND',
      `未知服务商：${presetId}。可用：${PRESETS.map((p) => p.id).join(' / ')}`,
    )
  }

  // ── 必须走 ProviderConfigStore，不能直接 providerFromPreset ──
  //
  // 直接调 preset 会让已经配置的覆盖（baseUrl / pricing / maxTokensParam）
  // 与实际发出的请求脱节：用户在设置里改了 baseUrl，
  // 执行链仍然打默认地址。那是「配置看起来生效了，其实没有」。
  //
  // 单次请求携带的 apiKey 只用于**这一次**调用：resolve() 不会把它写回任何地方。
  const requestKey = typeof body.apiKey === 'string' ? body.apiKey : undefined
  const provider = providerConfig.resolve(presetId, requestKey)

  return { provider, model: { id: modelId } }
}

/**
 * 把业务错误映射到 HTTP 状态码。
 *
 * 为什么不用「正则匹配错误消息」：
 * 那种做法太脆弱——改一句文案就换了状态码，而且区分不出 404 和 409。
 *
 * 这里的分类：
 *   401  未认证 / token 不对
 *   400  请求本身不合法
 *   404  资源不存在
 *   409  资源存在，但当前状态不允许这个操作
 *   500  其他（真正的服务端故障）
 */
/**
 * 把领域错误映射到 HTTP 状态码。
 *
 * **优先用错误对象上的 `code`**，正则匹配只是最后兜底。
 *
 * 为什么不用正则作为主路径：
 *   错误文案会改（措辞、翻译、补说明），每次改都要同步改正则，
 *   忘了就变成 500。而且「文案里恰好包含某个词」不等于
 *   「它属于那类错误」——这是猜，不是判断。
 */
function statusForError(err: unknown): number {
  // 统一表优先：core/errors.ts 是唯一权威。
  const code = codeOf(err)
  if (code) return specFor(code).httpStatus

  // 兜底：没有 code 的错误（来自 core 层的普通 Error，如 ReconcileError
  // 之外的遗留路径）。这一层仍然用文案判断，但它是**最后**一道，不是主路径。
  // 新代码应该抛 DomainError 或带 code 的错误，不要再往这里加正则。
  const message = err instanceof Error ? err.message : String(err)
  if (/不存在|not found/i.test(message)) return 404
  if (/只有.*可以|必须先|不能直接|不属于|属于 Task|属于 Run|与 Cycle|没有找到针对|还没有经过审计|不能验收|状态是/.test(message)) {
    return 409
  }
  return 500
}

/** 读取构建身份。失败时返回 'unknown'，绝不伪造。 */
function readBuildIdentity(repoRoot: string, schemaVersion: number): Omit<BuildIdentity, 'schemaVersion'> & { schemaVersion: number } {
  let version = 'unknown'
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string') version = pkg.version
  } catch {
    /* 读不到就记 unknown */
  }

  let commit = process.env.BUILD_COMMIT ?? 'unknown'
  if (!process.env.BUILD_COMMIT) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      /* 不是 git 仓库或没有 git：保持 unknown */
    }
  }
  return { version, commit, schemaVersion }
}

// ── 工厂 ──────────────────────────────────────────────────

export async function createWorkstationServer(config: ServerConfig): Promise<WorkstationServer> {
  const { dataDir, workspace, auth } = config

  // 桌面壳的静态资源目录。
  //
  // 默认按**模块位置**解析，而不是 process.cwd()：
  // 从任何目录启动服务都应该找到同一份 UI。
  // 打包场景由 config.uiDir 覆盖。
  const uiDir = config.uiDir ?? resolve(import.meta.dirname, '..', 'ui')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  const store = new Store(join(dataDir, 'workstation.db'))
  const tools = new ToolRegistry()

  const repoRoot = resolve(import.meta.dirname, '..', '..')
  const build = readBuildIdentity(repoRoot, store.schemaVersion)

  // 快照仓库目录不能落在任何 git 仓库内，否则会污染那个仓库。
  // 默认放到数据目录下，但如果它在 git 仓库内（常见的开发场景），
  // 就显式改到用户目录，避免在项目仓库里产生快照提交。
  const defaultSnapshotDir = join(dataDir, 'snapshots')
  const snapshotDir = config.snapshotDir
    ?? (isInsideGitRepo(defaultSnapshotDir)
      ? join(process.env.HOME ?? process.env.USERPROFILE ?? dataDir, '.ai-workstation', 'snapshots')
      : defaultSnapshotDir)

  if (config.snapshotDir === undefined && snapshotDir !== defaultSnapshotDir) {
    console.warn(
      `[提示] 数据目录位于 git 仓库内，快照目录已改到 ${snapshotDir}，` +
      '避免在项目仓库里产生快照提交。',
    )
  }

  const snapshot = new SnapshotManager(workspace, { repoDir: snapshotDir })

  const gitOk = await isGitAvailable()
  if (!gitOk) {
    console.warn('[警告] git 不可用，快照功能已禁用——本次运行产生的产物将没有可复现证据')
  }

  const executor = new RunExecutor(
    store,
    tools,
    {
      workspaceRoots: [workspace],
      contextBudget: 100_000,
      outputReserve: 8_000,
      maxToolRounds: 12,
      approvalTimeoutMs: config.approvalTimeoutMs ?? 5 * 60_000,
      // git 不可用时显式不提供快照钩子，而不是静默降级
      snapshot: gitOk ? snapshot : undefined,
    },
    // provider → adapter 的构造覆盖点。
    //
    // 与 /review 共用同一个配置（auditorAdapterResolver）：两者都只是
    // 「把这个 provider 换成那个 adapter 实现」，语义一致。
    // 集成测试靠它注入记录型 adapter，避免真的连网络。
    config.auditorAdapterResolver,
  )

  const acceptance = new AcceptanceService(store, {
    workspaceRoot: workspace,
    deliveryRoots: [workspace, join(dataDir, 'exports')],
    snapshotManager: snapshot,
  })

  const reviewLoop = new ReviewLoop(store, {
    maxCycles: config.maxCycles ?? 3,
    snapshotManager: snapshot,
    workspaceRoot: workspace,
  })

  registerSkill(DEFAULT_SKILL)

  // ── 能力平台 ────────────────────────────────────────────
  //   · secretStore  —— 密钥（只在内存 + 0600 文件里，不落库）
  //   · providerConfig —— 已校验的覆盖配置，密钥不进入它
  //   · images —— 图像能力注册表，只有「声明 + 适配器」同时存在才可用
  const secretStore = new SecretStore(defaultSecretsPath(dataDir))
  // 覆盖配置持久化到数据目录：用户改的 baseUrl / pricing 重启后仍在。
  // 密钥不进这个文件（只走 SecretStore）。
  const providerConfig = new ProviderConfigStore(
    secretStore,
    join(dataDir, 'provider-overrides.json'),
  )
  const images = new ImageCapabilityRegistry()

  // 图像能力：只对**明确支持**的 provider 注册。
  //
  // openai 走官方 /images/generations；其他 OpenAI 兼容端点默认不注册——
  // 它们的图像端点各不相同，猜一个大概率在运行时失败，
  // 而失败会消耗真实的配额。
  images.declare('openai')
  images.register(
    newOpenAIImageAdapter({
      providerId: 'openai',
      baseUrl: providerFromPreset('openai').baseUrl,
      supportsSize: true,
    }),
  )

  // MCP：连接失败不阻止启动，错误留待 /meta/capabilities 查询。
  const mcp = new McpManager(config.mcpServers ?? [])

  // 真正连接 MCP server 并注册它们的工具。
  //
  // 这一步是「接线」而不是「声明」：之前 MCP 只是被构造出来，
  // connectAll 从未被调用，于是 /meta/capabilities 里列着 MCP server，
  // 执行链却一个 MCP 工具都没有——那是典型的「有代码、没接线」。
  //
  // 刻意不 await：MCP server 可能启动很慢（要拉起子进程），
  // 阻塞服务启动会让「一个 MCP 配错」变成「整个工作站起不来」。
  // 连接成功后再注册工具；注册失败的 server 记录在 mcp.listErrors() 里。
  const mcpReady: Promise<void> = (async () => {
    if ((config.mcpServers ?? []).length === 0) return
    try {
      const mcpTools = await mcp.connectAll()
      for (const def of mcpTools) {
        const client = mcp.getClient(def.serverId ?? '')
        if (!client) continue
        try {
          tools.register(mcpToolImpl(def, (name, args) => client.callTool(name, args)))
        } catch (err) {
          // 工具 id 冲突 / 能力声明不合法：记录但继续，不让一个坏工具
          // 挡住其他工具。
          console.error(
            `[MCP] 注册工具 ${def.id} 失败：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } catch (err) {
      console.error(`[MCP] 连接失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })()
  void mcpReady

  // ── 工作区知识与快照生命周期 ────────────────────────────
  //
  // snapshotLock：capture / restore / destroy 三者互斥。
  //   锁按**工作区**而不是进程——同一工作区只能有一个写操作。
  //   不加锁时，恢复过程中的 capture 会记录下一个不一致的现场，
  //   而那份快照看起来完全正常。
  //
  // knowledgeIndex：检索索引，写入后重建。
  //   语料是一个工作区的知识条目，通常几十到几百条，
  //   重建成本远低于维护增量索引的正确性风险。
  const snapshotLock = new ResourceLock()
  const snapshotQuota: SnapshotQuota = config.snapshotQuota ?? DEFAULT_QUOTA
  const knowledgeIndex = new KnowledgeIndex()

  // 无人值守租约：跨进程可用，因此落在数据库而不是内存。
  // 本 server 实例的唯一租约身份（审计二轮 P0）。
  //
  // 必须是实例级的：同一进程可以跑多个 server（集成测试常见），
  // 用进程 id 当 owner 会让它们互相「认领」对方的租约。
  const instanceOwner = newLeaseOwner('http')

  const leaseStore = new SqliteLeaseStore((store as unknown as { db: import('better-sqlite3').Database }).db)

  // 无人值守策略。默认是保守的：3 次连续失败即停，单次最长 30 分钟。
  // 每次实例独立，不共享全局状态——测试因此可以起多个互不干扰的服务。
  let unattendedPolicy: UnattendedPolicy = DEFAULT_UNATTENDED_POLICY

  /** 当前快照用量（未软删除的）。 */
  function snapshotUsage(): { totalBytes: number; count: number } {
    let totalBytes = 0
    let count = 0
    for (const task of store.listTasks()) {
      for (const run of store.listRuns(task.id)) {
        for (const snap of store.listSnapshots(run.id)) {
          if (snap.deletedAt !== undefined) continue
          totalBytes += snap.totalBytes
          count++
        }
      }
    }
    return { totalBytes, count }
  }

  /** 重建知识索引。每次知识 / 记忆变更后调用。 */
  function reindexKnowledge(scope: 'workspace' | 'project' | 'task', scopeId: string): void {
    // 目前索引按工作区维度建立：跨作用域检索是常态
    // （做某个 Task 时既需要项目规范，也需要这个 Task 的临时结论）。
    const knowledge = [
      ...store.listKnowledge('workspace', workspace),
      ...(scope === 'workspace' && scopeId === workspace ? [] : store.listKnowledge(scope, scopeId)),
    ]
    const memory = [
      ...store.listMemory('workspace', workspace),
      ...(scope === 'workspace' && scopeId === workspace ? [] : store.listMemory(scope, scopeId)),
    ]
    knowledgeIndex.setKnowledge(knowledge)
    knowledgeIndex.setMemory(memory)
  }
  reindexKnowledge('workspace', workspace)

  /**
   * 解析作用域 id。
   *
   * workspace 作用域固定为工作区路径，不接受请求体指定——
   * 否则客户端可以把知识写进「任意一个工作区 id」，在别的实例里出现。
   * task 作用域必须指向真实存在的 Task：写进去的东西会进入那个任务的
   * 审计上下文，指向不存在的任务等于写入黑洞。
   */
  function resolveScopeId(
    scope: 'workspace' | 'project' | 'task',
    requested: string | null,
  ): string {
    if (scope === 'workspace') return workspace
    if (!requested || !requested.trim()) {
      throw new BadRequestError(`scope=${scope} 时必须提供 scopeId`)
    }
    if (scope === 'task' && !store.getTask(requested)) {
      throw new BadRequestError(`Task 不存在：${requested}`)
    }
    return requested
  }

  /** 知识条目的正文校验（在内容校验之外，只做字段形状）。 */
  function validateKnowledgeBody(body: Record<string, unknown>): {
    title: string
    content: string
    source: string
    tags: string[]
  } {
    return {
      title: typeof body.title === 'string' ? body.title : '',
      content: typeof body.content === 'string' ? body.content : '',
      source: typeof body.source === 'string' ? body.source : '',
      tags: Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string')
        : [],
    }
  }

  /** 当前全部未删除快照，转成 GC 候选。 */
  function collectGcCandidates(): Array<{
    id: string
    runId: string
    createdAt: number
    totalBytes: number
    deletedAt?: number
  }> {
    return store.listAllSnapshots().map((s) => ({
      id: s.id,
      runId: s.runId,
      createdAt: s.createdAt,
      totalBytes: s.totalBytes,
    }))
  }

  /**
   * 被引用中的快照 id。
   *
   * 「被引用」= 有产物把来源指向它。这类快照是证据链的一部分，
   * 无论多旧都不能删——删了之后「这个产物是怎么产生的」就无法回答。
   */
  function collectReferencedSnapshotIds(): Set<string> {
    const keep = new Set<string>()
    for (const artifact of store.listAllArtifacts()) {
      if (artifact.sourceSnapshotId) keep.add(artifact.sourceSnapshotId)
    }
    return keep
  }

  // ── 启动清理 ────────────────────────────────────────────
  // 上次进程异常退出时，可能有 Step 卡在 running、审批卡在 pending。
  // 状态必须诚实：不知道结果的一律标 unknown，超时的一律拒绝。
  //
  // 顺序很重要：**先扫 Intent，再扫 Step**。
  // Intent 是「外部副作用有没有发生」的一手证据，Step 只是执行轨迹。
  // 反过来的话，Step 被标 unknown 后 Intent 还停在 started，
  // 下次执行会看到 started 而拒绝——那个拒绝理由是对的，
  // 但不如直接说「上次崩溃了，不知道有没有生效」清楚。
  // 预算预留回收必须在最前面。
  //
  // 进程崩溃时，已经 reserve 但没 settle 的额度会一直占着。
  // 如果不回收，一次崩溃就能把整个 Task 的预算永久吃掉——
  // 之后任何调用都会因为「额度不足」被拒，而那个额度其实没人用。
  //
  // 只回收、不结算：我们不知道那次调用到底发生了没有。
  // 如果它实际消耗了 token，那部分没记进 usage——这是有意的保守：
  // 宁可少记，也不要凭猜测多记。
  const expiredReservations = store.expireReservations()
  if (expiredReservations.length > 0) {
    console.log(
      `[启动清理] ${expiredReservations.length} 个过期的预算预留已回收` +
      '（未计入 usage——无法确认那次调用是否发生）',
    )
  }

  // ── 启动恢复 ────────────────────────────────────────────
  //
  // 一次调用完成四件事，顺序不能拆：
  //   1. running Step  → unknown
  //   2. started Intent → unknown
  //   3. running Run   → queued（无 unknown）或 needs_reconciliation（有 unknown）
  //   4. 过期审批      → rejected（approver = system）
  //
  // 第 3 步是新增的：之前只清理 Step / Intent / 审批，Run 本身会永远停在
  // running。execute 的 CAS 只接受 queued，于是这个 Run 再也无法执行，
  // UI 也只能显示一个假的「执行中」。现在它会如实降级，并写事件说明原因。
  //
  // 用 internalSystem()：HTTP 层拿不到这个入口，所以客户端不能
  // 声称「我重启了服务」来重置状态。
  const recovery = recoverOnStartup(store)
  if (recovery.danglingSteps.length > 0) {
    console.log(`[启动清理] ${recovery.danglingSteps.length} 个悬挂 Step 已标记为 unknown`)
  }
  if (recovery.startedIntents.length > 0) {
    console.log(
      `[启动清理] ${recovery.startedIntents.length} 个未完成的工具调用已标记为 unknown` +
      '（外部副作用可能已发生，不会自动重试）',
    )
  }
  for (const r of recovery.staleRuns) {
    console.log(
      `[启动清理] Run ${r.runId} 上次未正常结束 → ${r.to}` +
      (r.to === 'needs_reconciliation' ? '（存在未确认的外部操作，需要先对账）' : ''),
    )
  }
  if (recovery.expiredApprovals.length > 0) {
    console.log(`[启动清理] ${recovery.expiredApprovals.length} 个超时审批已自动拒绝`)
  }

  // ── 启动不变式体检 ──────────────────────────────────────
  //
  // 只检查、不修复。
  //
  // 为什么不自动修：关系断裂（产物挂错 Task、事件序号有洞）意味着
  // 「有地方已经不对劲了」。自动改数据会把「数据坏了」这件事藏起来，
  // 而它恰恰是最需要人知道的。所以这里只打印，交给使用者决定。
  //
  // 为什么不阻止启动：这些问题不影响服务运行，阻止启动会让
  // 一个本来能用（只是数据有瑕疵）的工作站完全打不开。
  {
    const violations = scanInvariants(store)
    if (violations.length > 0) {
      console.warn(`[启动体检] 发现 ${violations.length} 处数据关系异常：`)
      // 只打印前 10 条，避免刷屏；总数已经给出。
      for (const v of violations.slice(0, 10)) {
        console.warn(`  · [${v.kind}] ${v.detail}`)
      }
      if (violations.length > 10) {
        console.warn(`  …还有 ${violations.length - 10} 条`)
      }
      console.warn('[启动体检] 这些异常不会被自动修复，请人工确认（GET /meta/invariants 可查）')
    }
  }

  // 运行中的 Run：id → AbortController。用于取消。每个实例一份。
  const running = new Map<string, AbortController>()

  /**
   * 在途执行的 Promise。
   *
   * 与 running（AbortController）分开：controller 只能「请求中止」，
   * 无法「等待结束」。close() 需要知道执行器真的收尾了才能关 store，
   * 否则它还在写的时候数据库已经关了。
   */
  const runningTasks = new Set<Promise<unknown>>()

  // Origins 必须按**实际监听端口**算，不能用 config.port。
  //
  // config.port 可能是 0（让操作系统分配端口，测试和 CLI 都常用）。
  // 按 0 算出来的白名单是 http://127.0.0.1:0，于是同源的合法请求
  // 反而会被 403 拒绝。listen() 之后会把它重写为真实端口。
  let allowedOrigins = config.allowedOrigins
    ?? defaultAllowedOrigins(config.port === 0 ? 80 : config.port)

  // ── 路由 ────────────────────────────────────────────────

  type Handler = (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
    params: string[],
  ) => Promise<void>

  interface RouteRecord {
    method: string
    parts: string[]
    handler: Handler
    /** false 表示公开接口。默认 true（必须认证）。 */
    requiresAuth: boolean
  }

  const routes: RouteRecord[] = []

  /**
   * 注册路由。
   *
   * `requiresAuth` 默认 true —— 默认安全，公开必须显式声明。
   * 反过来（默认公开、需要时加认证）迟早会漏掉一个。
   */
  function route(
    method: string,
    path: string,
    handler: Handler,
    opts: { requiresAuth?: boolean } = {},
  ): void {
    routes.push({
      method,
      parts: path.split('/').filter(Boolean),
      handler,
      requiresAuth: opts.requiresAuth ?? true,
    })
  }

  // ── 健康检查（唯一公开接口）──────────────────────────────
  //
  // 只返回就绪状态与构建身份。绝不返回 workspace 路径、数据目录、
  // 数据库路径、环境变量，更不返回 token。
  route('GET', '/health', async (_req, res) => {
    json(res, 200, {
      ready: true,
      build,
    })
  }, { requiresAuth: false })

  // ── 会话 ────────────────────────────────────────────────

  route('GET', '/sessions', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const includeArchived = url.searchParams.get('includeArchived') === 'true'
    json(res, 200, { sessions: store.listSessions({ includeArchived }) })
  })

  /** 归档 / 取消归档。归档不删除任何消息，只是从默认列表里收起来。 */
  route('POST', '/sessions/:id/archive', async (_req, res, body, params) => {
    const id = params[0]!
    if (!store.getSession(id)) {
      json(res, 404, { error: '会话不存在' })
      return
    }
    const archived = body.archived !== false
    store.archiveSession(id, archived)
    json(res, 200, { ok: true, archived })
  })

  /**
   * 会话视图：会话消息 + Run 投影 + 活动流 + 状态。
   *
   * 一次请求拿全，是因为 UI 需要它们**在同一个时间点**保持一致。
   * 分三次请求时，中间可能有一条新消息进来，
   * 于是状态栏说「等待审批」而消息列表里还没有审批提示。
   */
  route('GET', '/sessions/:id/conversation', async (_req, res, _body, params) => {
    const sessionId = params[0]!
    const session = store.getSession(sessionId)
    if (!session) {
      json(res, 404, { error: '会话不存在' })
      return
    }

    const tasks = store.listTasks(sessionId)
    const runs = tasks.flatMap((t) => store.listRuns(t.id))

    // 会话本身的消息（用户输入 / 助手回复）
    const messages: ProjectedMessage[] = store.listMessages(sessionId).map((m) => {
      const role: ProjectedMessage['role'] =
        m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system'
          ? m.role
          : 'assistant'
      const out: ProjectedMessage = {
        source: 'session',
        id: m.id,
        role,
        content: m.content,
        createdAt: m.createdAt,
      }
      return out
    })

    // Run 历史投影：让用户看到「它实际做了什么」，而不只是最终回复。
    for (const run of runs) {
      for (const m of store.listRunMessagesWithMeta(run.id)) {
        const projected = projectRunMessage(m.payload, {
          runId: run.id,
          seq: m.seq,
          createdAt: m.createdAt,
        })
        if (projected) messages.push(projected)
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

    // 活动流：所有 Run 的事件，翻译成人话。
    const activity: ActivityEntry[] = []
    for (const run of runs) {
      for (const e of store.listEvents(run.id)) {
        const { summary, refs } = summarizeEvent(e.kind, e.payload)
        activity.push({
          id: e.id,
          kind: e.kind,
          summary,
          refs: { ...refs, runId: run.id },
          occurredAt: e.occurredAt,
        })
      }
    }
    activity.sort((a, b) => b.id - a.id)
    const activityLimit = 200

    json(res, 200, {
      session,
      status: deriveConversationStatus(runs),
      messages,
      activity: activity.slice(0, activityLimit),
      activityTruncated: activity.length > activityLimit,
      attachments: store.listAttachments(sessionId),
      runs: runs.map((r) => ({ id: r.id, status: r.status, taskId: r.taskId })),
    })
  })

  route('POST', '/sessions', async (_req, res, body) => {
    const title = typeof body.title === 'string' && body.title.trim() ? body.title : '新会话'
    json(res, 201, store.createSession(title))
  })

  route('GET', '/sessions/:id/messages', async (_req, res, _body, params) => {
    json(res, 200, { messages: store.listMessages(params[0]!) })
  })

  /**
   * 追加一条会话消息。
   *
   * 只允许 user / assistant 两种角色：tool 与 system 消息由执行内核
   * 通过 run_message 产生，客户端写入这两种角色会让「对话」与
   * 「执行记录」混在一起，而投影逻辑依赖它们可区分。
   */
  route('POST', '/sessions/:id/messages', async (_req, res, body, params) => {
    const sessionId = params[0]!
    if (!store.getSession(sessionId)) {
      json(res, 404, { error: `会话不存在：${sessionId}` })
      return
    }
    const content = typeof body.content === 'string' ? body.content : ''
    if (!content.trim()) {
      json(res, 400, { error: '消息内容不能为空' })
      return
    }
    const role = body.role === 'assistant' ? 'assistant' : 'user'
    const message = store.appendMessage({
      id: randomUUID(),
      sessionId,
      role,
      content,
    })
    json(res, 201, { message })
  })

  // ── 公共契约元数据 ──────────────────────────────────────
  //
  // 让客户端（含将来的 desktop）能**编程地**发现契约，而不是读源码猜：
  //   · 错误码 → 状态码 / 是否可重试
  //   · 事件 kind 目录
  //   · 状态机迁移表
  //   · 权限动作表
  //
  // 不需要认证的说法不成立：这些定义虽不含用户数据，但**暴露了内部结构**
  // （有哪些状态、哪些权限动作、错到什么程度会被接受）。
  // 路由清单测试也把「只有 GET /health 公开」作为不变量，
  // 这里保持一致，不为一个元数据接口破例。
  // 客户端拿到 token 后即可读取——token 本来就在同一台机器上。

  route('GET', '/meta/contracts', async (_req, res) => {
    json(res, 200, {
      schemaVersion: store.schemaVersion,
      errors: errorCodes().map((code) => specFor(code)),
      events: EVENT_CATALOG.map((e) => ({
        kind: e.kind,
        aggregateType: e.aggregateType,
        emittedBy: e.emittedBy,
      })),
      eventActors: [...EVENT_ACTORS],
      stateMachines: machineSummary(),
      permissions: permissionActions().map((action) => ({
        action,
        allowed: PERMISSION_CATALOG[action].allowed,
        requiresTrusted: PERMISSION_CATALOG[action].requiresTrusted,
      })),
    })
  })

  /**
   * 数据关系体检（只读）。
   *
   * 与启动时打印的是同一份结果。做成接口是为了：
   *   · 使用者可以在不重启的情况下复查
   *   · 外部审计可以直接拿到机器可读的结论
   *
   * **不提供修复接口**：修复必须是人做决定的事。
   */
  route('GET', '/meta/invariants', async (_req, res) => {
    const violations = scanInvariants(store)
    json(res, 200, {
      ok: violations.length === 0,
      count: violations.length,
      violations,
    })
  })

  route('GET', '/meta/errors', async (_req, res) => {
    json(res, 200, { errors: errorCodes().map((code) => specFor(code)) })
  })

  // ── 知识库与项目记忆 ────────────────────────────────────

  /** 知识条目列表。scope=task 时 scopeId 必须是真实 Task。 */
  route('GET', '/knowledge', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const scope = (url.searchParams.get('scope') ?? 'workspace') as 'workspace' | 'project' | 'task'
    const scopeId = resolveScopeId(scope, url.searchParams.get('scopeId'))
    json(res, 200, { knowledge: store.listKnowledge(scope, scopeId) })
  })

  route('POST', '/knowledge', async (_req, res, body) => {
    const scope = (body.scope ?? 'workspace') as 'workspace' | 'project' | 'task'
    const scopeId = resolveScopeId(scope, typeof body.scopeId === 'string' ? body.scopeId : null)
    const doc = store.createKnowledge({
      scope,
      scopeId,
      ...validateKnowledgeBody(body),
    })
    reindexKnowledge(scope, scopeId)
    json(res, 201, { knowledge: doc })
  })

  route('PUT', '/knowledge/:id', async (_req, res, body, params) => {
    const doc = store.updateKnowledge(params[0]!, body)
    reindexKnowledge(doc.scope, doc.scopeId)
    json(res, 200, { knowledge: doc })
  })

  route('DELETE', '/knowledge/:id', async (_req, res, _body, params) => {
    const doc = store.getKnowledge(params[0]!)
    store.deleteKnowledge(params[0]!)
    if (doc) reindexKnowledge(doc.scope, doc.scopeId)
    json(res, 200, { ok: true })
  })

  route('GET', '/memory', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const scope = (url.searchParams.get('scope') ?? 'workspace') as 'workspace' | 'project' | 'task'
    const scopeId = resolveScopeId(scope, url.searchParams.get('scopeId'))
    json(res, 200, { memory: store.listMemory(scope, scopeId) })
  })

  route('POST', '/memory', async (_req, res, body) => {
    const scope = (body.scope ?? 'workspace') as 'workspace' | 'project' | 'task'
    const scopeId = resolveScopeId(scope, typeof body.scopeId === 'string' ? body.scopeId : null)
    const validated = validateMemoryInput(body)
    const item = store.createMemory({
      scope,
      scopeId,
      statement: validated.statement,
      evidence: validated.evidence,
      tags: validated.tags,
      // origin 描述「这条记忆怎么来的」，不是权限：
      // user = 用户写入，task = 任务结论，inference = 推断。
      // 它影响检索排序权重，所以只能从封闭集合里取，不能是任意字符串。
      origin: validated.origin,
    })
    reindexKnowledge(scope, scopeId)
    json(res, 201, { memory: item })
  })

  route('DELETE', '/memory/:id', async (_req, res, _body, params) => {
    store.deleteMemory(params[0]!)
    json(res, 200, { ok: true })
  })

  /**
   * 检索。
   *
   * 返回命中项与「为什么命中」（matchedTerms）——证据系统里，
   * 一个无法解释的检索结果和一个错误的结果一样糟。
   */
  route('GET', '/knowledge/search', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = url.searchParams.get('q') ?? ''
    if (!q.trim()) {
      json(res, 400, { error: '缺少查询词 q' })
      return
    }
    const limit = Number(url.searchParams.get('limit') ?? 10)
    const hits = knowledgeIndex.search(q, {
      limit: Number.isFinite(limit) ? limit : 10,
    })
    json(res, 200, { hits, sizes: knowledgeIndex.sizes })
  })

  // ── 快照 GC ─────────────────────────────────────────────

  /**
   * 计算 GC 计划（**不删除**）。
   *
   * 删除是不可逆的，所以分成「看计划」和「执行」两步。
   * 执行时必须把计划里的 id 原样传回来——由用户 / 上层确认，
   * 而不是让服务端在执行时重新计算（两次计算之间可能有新快照）。
   */
  route('GET', '/snapshots/gc/plan', async (_req, res) => {
    const candidates = collectGcCandidates()
    const policy = {
      olderThan: 7 * 24 * 60 * 60 * 1000,
      keepIds: collectReferencedSnapshotIds(),
      keepPerRun: 3,
    }
    json(res, 200, { plan: planGc(candidates, policy), policy: { ...policy, keepIds: [...policy.keepIds] } })
  })

  route('POST', '/snapshots/gc/execute', async (_req, res, body) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []
    if (ids.length === 0) {
      json(res, 400, { error: '需要给出要删除的 ids（先看 /snapshots/gc/plan）' })
      return
    }

    // ── GC 必须与 capture / restore 共用同一把锁（审计二轮 P1-8）──
    //
    // 不加锁的后果很具体：GC 正在删除快照对象时，一次 capture 可能
    // 拍到「一半对象已被回收」的仓库；或者 restore 正在读某个 ref
    // 而 GC 把它回收了。两者都会产生难以理解的失败。
    //
    // 立即失败而不是排队：快照操作本来就该串行，排队只会让连接挂起。
    let release: (() => void) | undefined
    try {
      release = snapshotLock.acquire(workspace, 'destroy', 'gc')
    } catch (err) {
      json(res, 409, {
        error: err instanceof DomainError ? err.message : '快照操作正在进行中，请稍后重试',
      })
      return
    }

    // 再校验一次：确认这些 id 当前仍然可删。
    //
    // 从计划到执行之间可能产生了新的引用（产物指向了它）。
    // 直接按 ids 删会让「刚被引用的证据」消失。
    const policy = {
      olderThan: 7 * 24 * 60 * 60 * 1000,
      keepIds: collectReferencedSnapshotIds(),
      keepPerRun: 3,
    }
    const plan = planGc(collectGcCandidates(), policy)
    const allowed = new Set(plan.deletable)
    const deletable = ids.filter((id) => allowed.has(id))
    const refused = ids.filter((id) => !allowed.has(id))

    for (const id of deletable) store.softDeleteSnapshot(id)

    // 软删记录之后**必须**真正回收 Git 对象，否则磁盘不会被释放。
    //
    // 快照是一条 commit 链：只要链上还有任一提交可达，整棵历史树都会被保留。
    // 所以不能只删数据库行，要把「仍然需要保留的快照」重新锚定，
    // 再让 git gc 回收其余对象。
    let reclaimed:
      | { before: { count: number; sizeKb: number }; after: { count: number; sizeKb: number } }
      | undefined
    if (deletable.length > 0) {
      try {
        // keep 列表 = 当前仍有效的快照 ref。
        // 不在这里做「哪些该留」的新判断——那是 planGc 的职责，
        // 重复判断会让两处结论不一致。
        const keep = store.listAllSnapshots().map((sn) => sn.ref)
        reclaimed = await snapshot.reclaimObjects(keep)
      } catch (err) {
        // 回收失败不回滚软删除：记录已标记，磁盘可以以后再收。
        // 但必须如实报告，不能让用户以为空间已经释放了。
        release?.()
        json(res, 200, {
          deleted: deletable,
          refused,
          reclaimError: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }

    release?.()
    json(res, 200, { deleted: deletable, refused, reclaimed })
  })

  // ── 能力平台 ────────────────────────────────────────────

  /**
   * 能力快照。
   *
   * 只报告**声明层面**的事实，不做探测：
   * 探活会把「网络抖动」混进「能力不足」，两者的处理方式不同。
   * 没有任何密钥值出现在这里——只有 hasKey 布尔。
   */
  route('GET', '/meta/capabilities', async (_req, res) => {
    const providerIds = profiledProviderIds()
    const snapshot = capabilitySnapshot(tools.listAll(), providerIds)
    json(res, 200, {
      ...snapshot,
      providers: snapshot.providers.map((p) => ({
        ...p,
        hasKey: providerConfig.describe(p.providerId).hasKey,
      })),
      images: images.describe(),
      mcp: {
        servers: mcp.listServers(),
        errors: mcp.listErrors(),
      },
      skills: listSkills(),
    })
  })

  /** 列出所有服务商（密钥以 hasKey 表示，不含值）。 */
  route('GET', '/providers', async (_req, res) => {
    json(res, 200, {
      providers: profiledProviderIds().map((id) => providerConfig.describe(id)),
    })
  })

  /**
   * 调整某个服务商的**非安全**配置。
   *
   * 不接受 requiresKey / kind / protocol / apiKey：
   * 允许客户端覆盖这些等于允许它关闭密钥要求或改变协议。
   */
  route('PUT', '/providers/:id', async (_req, res, body, params) => {
    const id = params[0]!
    providerConfig.setOverrides(id, body)
    json(res, 200, { provider: providerConfig.describe(id) })
  })

  /** 某个 provider + model 的能力解析（UI 用来决定哪些功能可用）。 */
  route('GET', '/providers/:id/models/:model/capabilities', async (_req, res, _body, params) => {
    const providerId = String(params[0] ?? '')
    // 路由参数已在分发阶段 decodeURIComponent 过，这里不再二次解码。
    const modelId = String(params[1] ?? '')
    const resolved = resolveModelCapabilities(providerId, modelId)
    if (resolved.status === 'rejected') {
      json(res, 400, { error: resolved.reason })
      return
    }
    if (resolved.status === 'unknown') {
      // 能力未知不是「请求错误」，是「无法确认」。
      // 用 200 + status 表达，避免客户端把 4xx 当成「参数写错了」。
      json(res, 200, { status: 'unknown', reason: resolved.reason })
      return
    }
    json(res, 200, { status: 'known', model: resolved.model })
  })

  /**
   * 图像生成。
   *
   * 这是有成本的操作（每次调用都计费），所以：
   *   · 张数由服务端夹紧上限（不让调用方决定消耗多少配额）
   *   · 只返回内联数据，不写磁盘（落盘走产物 / 快照层）
   *   · prompt 长度有上限
   */
  route('POST', '/images/generate', async (_req, res, body) => {
    requirePermission('run.execute')
    const providerId = requireString(body, 'provider')
    const request = validateImageRequest(body)
    images.get(providerId)

    // 必须走 providerConfig，而不是用构造时抓到的那份配置。
    //
    // 构造适配器时 baseUrl / apiKey 可能还没配置；用户后来在设置里改了
    // baseUrl（例如指向代理）或存了密钥，直接使用构造时的快照会
    // 让「配置看起来生效了，实际请求还打旧地址、还带着旧密钥」。
    const resolved = providerConfig.resolve(
      providerId,
      typeof body.apiKey === 'string' ? body.apiKey : undefined,
    )
    assertProviderUsable(resolved)
    const adapter = newOpenAIImageAdapter({
      providerId,
      baseUrl: resolved.baseUrl,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      supportsSize: true,
    })
    const generated = await adapter.generate(request)
    json(res, 200, { images: generated })
  })

  // ── 会话附件 ────────────────────────────────────────────
  //
  // 内容存磁盘（按哈希寻址），元信息存库。
  // 为什么不把内容塞进 SQLite：附件可能是几十 MB，
  // 混进数据库会让备份、迁移、以及「读一行消息」都变慢。

  route('GET', '/sessions/:id/attachments', async (_req, res, _body, params) => {
    json(res, 200, { attachments: store.listAttachments(params[0]!) })
  })

  route('POST', '/sessions/:id/attachments', async (_req, res, body, params) => {
    const sessionId = params[0]!
    if (!store.getSession(sessionId)) {
      json(res, 404, { error: '会话不存在' })
      return
    }

    // 内容以 base64 传入。
    const data = typeof body.data === 'string' ? body.data : ''
    if (!data) {
      json(res, 400, { error: '缺少附件内容 data（base64）' })
      return
    }
    // 先按 base64 长度粗略预检，避免把超大 payload 解码到内存里。
    // base64 膨胀约 4/3，留 8 字节余量避免边界误差。
    const estimatedBytes = Math.floor((data.length * 3) / 4)
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      json(res, 413, { error: `附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限` })
      return
    }

    const buffer = Buffer.from(data, 'base64')
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      json(res, 413, { error: `附件超过 ${MAX_ATTACHMENT_BYTES} 字节上限` })
      return
    }

    const meta = validateAttachmentMeta({
      name: body.name,
      mimeType: body.mimeType,
      bytes: buffer.length,
    })

    const hash = createHash('sha256').update(buffer).digest('hex')
    const dir = join(dataDir, 'attachments', sessionId)
    mkdirSync(dir, { recursive: true })
    // 存储路径由哈希决定，**不使用**用户提供的文件名：
    // 文件名可能含路径成分或保留字符，直接当路径用就是目录穿越。
    const storagePath = join(dir, hash)
    if (!existsSync(storagePath)) writeFileSync(storagePath, buffer)

    const record = store.createAttachment({
      sessionId,
      name: meta.name,
      mimeType: meta.mimeType,
      bytes: buffer.length,
      storagePath,
      contentHash: hash,
    })
    json(res, 201, { attachment: record })
  })

  route('DELETE', '/attachments/:id', async (_req, res, _body, params) => {
    const att = store.getAttachment(params[0]!)
    if (!att) {
      json(res, 404, { error: '附件不存在' })
      return
    }
    // 只软删除记录。磁盘上的内容按哈希寻址，可能被多条记录共享，
    // 真正的回收交给 GC——这里删文件会让另一个会话的附件一起消失。
    store.deleteAttachment(att.id)
    json(res, 200, { ok: true })
  })

  // ── 工作组 ──────────────────────────────────────────────
  //
  // 编排器是无状态的，每次请求新建：
  // 状态全在数据库里，编排器只负责「读 + CAS」。
  // 持有实例会让「两个总控」变成「两个内存副本」，而它们本应共享同一份状态。

  const workgroup = new WorkgroupCoordinator(store)

  // 内置角色在启动时写入（幂等 upsert）。
  //
  // 为什么内置而不是让用户先建：没有角色就没有工作包可以分配，
  // 空系统对用户毫无用处。upsert 而不是 insert，是为了让
  // 「升级后角色定义变了」能生效，而不是报冲突。
  for (const role of BUILTIN_ROLES) store.upsertRole(role)

  route('GET', '/workgroup/roles', async (_req, res) => {
    json(res, 200, { roles: store.listRoles() })
  })

  route('GET', '/tasks/:id/workgroup', async (_req, res, _body, params) => {
    const taskId = params[0]!
    if (!store.getTask(taskId)) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    const packages = store.listPackages(taskId)
    json(res, 200, {
      packages,
      changeSets: store.listChangeSets(taskId),
      // 当前可以开始的包：依赖已合并、状态允许。
      // UI 用它决定「哪些能点开始」。
      ready: readyPackages(packages).map((p) => p.id),
      graph: validateGraph(packages),
    })
  })

  route('POST', '/tasks/:id/workgroup/packages', async (_req, res, body, params) => {
    const taskId = params[0]!
    if (!store.getTask(taskId)) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    const input = validateWorkPackageInput(body)
    const pkg = workgroup.createPackage({
      taskId,
      id: randomUUID(),
      ...input,
    })
    json(res, 201, { package: pkg })
  })

  /** 把可以开始的包标记为 ready 并返回。 */
  route('POST', '/tasks/:id/workgroup/refresh', async (_req, res, _body, params) => {
    const ready = workgroup.refreshReadiness(params[0]!)
    json(res, 200, { ready })
  })

  route('POST', '/workgroup/packages/:id/start', async (_req, res, body, params) => {
    const result = workgroup.startPackage({
      packageId: params[0]!,
      roleId: requireString(body, 'roleId'),
    })
    if (!result.ok) {
      // 抢占是**冲突**而不是错误：说明有人先拿到了，用户应该刷新视图。
      json(res, 409, { error: result.reason, package: result.current })
      return
    }
    json(res, 200, { package: result.package })
  })

  route('POST', '/workgroup/packages/:id/finalize', async (_req, res, _body, params) => {
    const result = workgroup.finalizePackage(params[0]!)
    if (!result.ok) {
      json(res, 409, { error: result.reason })
      return
    }
    json(res, 200, { ok: true })
  })

  /**
   * 提交变更集。
   *
   * 冲突时返回 201 + status='conflict'，不是 409：
   * 变更集**确实保存了**，只是需要人工处理。
   * 用 409 会让客户端以为提交失败而重试，产生重复的变更集。
   */
  route('POST', '/tasks/:id/workgroup/changesets', async (_req, res, body, params) => {
    const taskId = params[0]!
    const changes = validateChangeSetInput(body)
    const result = workgroup.submitChangeSet({
      id: randomUUID(),
      taskId,
      workPackageId: requireString(body, 'workPackageId'),
      roleId: requireString(body, 'roleId'),
      changes,
      ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
    })
    json(res, 201, {
      changeSet: result.changeSet,
      conflicts: result.conflicts,
    })
  })

  route('POST', '/workgroup/changesets/:id/merge', async (_req, res, _body, params) => {
    const result = workgroup.mergeChangeSet(params[0]!)
    if (!result.ok) {
      json(res, 409, { error: result.reason })
      return
    }
    json(res, 200, { changeSet: result.changeSet })
  })

  // ── 证据包与离线校验 ────────────────────────────────────

  /**
   * 生成证据包。
   *
   * 纯读：不写任何状态。同一份数据在同一时刻生成的包应当完全一致
   * （generatedAt 除外），这是 verify 能成立的前提。
   */
  route('GET', '/tasks/:id/runs/:runId/artifacts/:artifactId/evidence', async (_req, res, _body, params) => {
    const [taskId, runId, artifactId] = params as [string, string, string]
    const bundle = buildBundleFromStore(store, { taskId, runId, artifactId })
    json(res, 200, { bundle })
  })

  /**
   * 校验证据包完整性（verify）。
   *
   * 客户端可以把包传回来自证；也可以请求服务端按当前数据重新生成再比。
   * 这里支持后者（`?regenerate=true`），因为前者的用途主要是离线场景。
   */
  route('POST', '/evidence/verify', async (_req, res, body) => {
    // 「没有传 bundle」和「传了一个不合法的 bundle」是两件事：
    //   · 完全没给 → 400（请求写错了）
    //   · 给了但不合法 → 200 + structuralErrors（这是 verify 的正常结果）
    //
    // 这里只拦「字段完全缺失」；`bundle: null` 和字符串都交给 verifyBundle
    // 判定，它会返回结构性错误而不是抛异常。
    if (!('bundle' in body)) {
      json(res, 400, { error: '缺少 bundle' })
      return
    }
    json(res, 200, { verify: verifyBundle(body.bundle as EvidenceBundle) })
  })

  /** 离线 replay：不依赖当前数据，只用包里的事实重算结论。 */
  route('POST', '/evidence/replay', async (_req, res, body) => {
    const bundle = body.bundle as EvidenceBundle | undefined
    if (!bundle) {
      json(res, 400, { error: '缺少 bundle' })
      return
    }
    const verify = verifyBundle(bundle)
    if (!verify.ok) {
      // 在完整性已经坏了的数据上重算结论没有意义——
      // 结果会被当成「根据证据得出的判断」，而证据本身不可信。
      json(res, 409, {
        error: '证据包完整性校验失败，拒绝 replay',
        verify,
      })
      return
    }
    json(res, 200, { replay: replayBundle(bundle), verify })
  })

  /** 一体化检查：重新生成 + verify + replay。 */
  route('GET', '/tasks/:id/runs/:runId/artifacts/:artifactId/evidence/inspect', async (_req, res, _body, params) => {
    const [taskId, runId, artifactId] = params as [string, string, string]
    const result = inspectFromStore(store, { taskId, runId, artifactId })
    json(res, 200, result)
  })

  /**
   * 人工裁决。
   *
   * 用于两类情况：审计转人工、replay 结论与当时不一致。
   * 必须给出 reason —— 例外必须能回答「为什么」。
   */
  route('POST', '/tasks/:id/decisions', async (_req, res, body, params) => {
    requirePermission('review.decide_escalation')
    const taskId = params[0]!
    if (!store.getTask(taskId)) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    const validated = validateHumanDecision(body)
    const artifactId = requireString(body, 'artifactId')
    const subjectRaw = body.subject as { kind?: unknown; ref?: unknown } | undefined
    const kind = subjectRaw?.kind === 'replay_mismatch' ? 'replay_mismatch' : 'escalated_audit'
    const ref = typeof subjectRaw?.ref === 'string' ? subjectRaw.ref : ''

    const decision = store.createHumanDecision({
      taskId,
      artifactId,
      actor: validated.actor,
      decision: validated.decision,
      reason: validated.reason,
      subject: { kind, ref },
    })
    json(res, 201, { decision })
  })

  route('GET', '/tasks/:id/decisions', async (_req, res, _body, params) => {
    json(res, 200, { decisions: store.listHumanDecisions(params[0]!) })
  })

  // ── 桌面壳引导 ──────────────────────────────────────────
  //
  // 一次请求给全 UI 需要的**结构性契约**：
  //   · 状态机迁移表（哪些状态能去哪）
  //   · 权限动作（谁可以做什么）
  //   · 错误码
  //   · 当前待办：待审批 / 待对账 / 待验收
  //
  // 为什么必须由服务端给：UI 不能自己实现状态机或权限判断。
  // 如果 UI 自己写「waiting_approval 之后应该显示什么」，
  // 后端改了状态机而 UI 没跟上，用户看到的就是错的。
  route('GET', '/ui/bootstrap', async (_req, res) => {
    // 待办汇总：跨会话收集需要人处理的事项。
    const approvals: Array<{
      approvalId: string
      runId: string
      taskId: string
      toolId: string
      createdAt: number
      expiresAt: number
    }> = []
    const reconciliations: Array<{ runId: string; taskId: string; reason: string }> = []
    const awaitingAcceptance: Array<{ taskId: string; sessionId: string; goal: string }> = []

    for (const task of store.listTasks()) {
      for (const run of store.listRuns(task.id)) {
        for (const a of store.listApprovals()) {
          if (a.runId !== run.id || a.status !== 'pending') continue
          approvals.push({
            approvalId: a.id,
            runId: run.id,
            taskId: task.id,
            toolId: a.toolId,
            createdAt: a.createdAt,
            expiresAt: a.expiresAt,
          })
        }
        if (run.status === 'needs_reconciliation') {
          reconciliations.push({
            runId: run.id,
            taskId: task.id,
            reason: '存在无法确认的外部操作，需要人工对账',
          })
        }
      }
      if (task.status === 'awaiting_acceptance') {
        awaitingAcceptance.push({ taskId: task.id, sessionId: task.sessionId, goal: task.goal })
      }
    }

    approvals.sort((a, b) => a.createdAt - b.createdAt)

    json(res, 200, {
      build,
      // 结构契约：UI 只渲染，不判断
      contracts: {
        schemaVersion: store.schemaVersion,
        stateMachines: machineSummary(),
        permissions: permissionActions().map((action) => ({
          action,
          allowed: PERMISSION_CATALOG[action].allowed,
          requiresTrusted: PERMISSION_CATALOG[action].requiresTrusted,
        })),
        errors: errorCodes().map((code) => specFor(code)),
      },
      // 需要人处理的事项
      inbox: {
        approvals,
        reconciliations,
        awaitingAcceptance,
        total: approvals.length + reconciliations.length + awaitingAcceptance.length,
      },
      policy: unattendedPolicy,
      capabilities: capabilitySnapshot(tools.listAll(), profiledProviderIds()).providers.map((p) => ({
        providerId: p.providerId,
        capabilities: p.capabilities,
        local: p.local,
        hasKey: (() => {
          try {
            return providerConfig.describe(p.providerId).hasKey
          } catch {
            return false
          }
        })(),
      })),
      skills: listSkills(),
      mcp: { servers: mcp.listServers(), errors: mcp.listErrors() },
      // UI 不该假设这些路径：它们只是「显示用」，不可用于拼接
      ui: {
        requiresApprovalForTools: tools
          .listAll()
          .filter((t) => t.riskLevel !== 'read')
          .map((t) => t.id),
      },
    })
  })

  // ── 无人值守运行器 ──────────────────────────────────────
  //
  // 这一组接口只做「观察 + 单次调度」，不自带定时器：
  // 定时器由外部（CLI / Electron 主进程 / systemd）驱动。
  // 放在服务进程里跑定时器会让「停掉服务」和「停掉调度」变成两件事，
  // 而用户期望它们是一件事。

  /** 当前租约与无人值守状态。 */
  route('GET', '/runner/state', async (_req, res) => {
    const now = Date.now()
    const runs = store.listRunsByStatus('running')
    json(res, 200, {
      policy: unattendedPolicy,
      running: runs.map((r) => {
        const lease = leaseStore.inspect(`run:${r.id}`)
        return {
          runId: r.id,
          taskId: r.taskId,
          startedAt: r.startedAt,
          lease,
          // 可疑 = 租约还有效但心跳太旧。此时**不接管**，
          // 因为接管会导致重复执行正在进行的工具调用。
          suspicious: lease ? isLeaseSuspicious(lease, now) : false,
        }
      }),
      queued: store.listRunsByStatus('queued').map((r) => ({ runId: r.id, taskId: r.taskId })),
    })
  })

  /** 更新无人值守策略。拒绝 autoApprove。 */
  route('PUT', '/runner/policy', async (_req, res, body) => {
    unattendedPolicy = validateUnattendedPolicy(body)
    json(res, 200, { policy: unattendedPolicy })
  })

  /**
   * 执行一次调度。
   *
   * 只做「选任务 + 抢租约 + 判定暂停」，**不真正执行 Run**。
   * 执行需要 provider 与工作区，那由调用方（CLI / 桌面壳）驱动，
   * 避免服务进程里出现一个不可见的后台执行者。
   */
  /**
   * 执行一个 Run（内部分配器共享）。
   *
   * 为什么抽成函数而不是在 /runner/tick 里复制一份：
   *   无人值守执行和手动执行必须是**同一条路径**。复制会出现
   *   「手动执行有审批门、自动执行没有」这类分歧，而那是最难发现的。
   *
   * 返回 outcome 或抛出：调用方决定如何映射成 HTTP 响应。
   */
  async function executeRun(
    runId: string,
    opts: {
      provider?: string
      model?: string
      system?: string
      messages?: ChatMessage[]
      signal?: AbortSignal
      /** 由调用方（如 runner.tick）已经持有的租约。省略时自行获取。 */
      lease?: import('../core/runner.js').Lease
      /**
       * **一次性** provider 密钥，来自请求体。
       *
       * 语义（L2 Gate 阻断项 1）：
       *   · 只用于这一次调用：传给 providerConfig.resolve 构造 adapter
       *   · **绝不**写回 SecretStore、Run、Event、日志或响应
       *   · 下一次请求不传就没有 —— 一次性就是一次性
       *
       * 为什么必须显式传：如果这里不接收它，modelFrom 解析出的
       * provider（带 key）会被丢弃，executeRun 用 providerId 重新
       * resolve 一次就得到没有 key 的配置——requiresKey 的提供商会 401，
       * 而用户明明传了 key。
       */
      requestKey?: string
    } = {},
  ): Promise<{
    status: string
    run: unknown
    text?: string
    error?: string
    reason?: string
    /** paused 时的待审批记录。UI 需要它来显示「等哪个工具」。 */
    approval?: unknown
  }> {
    const run = store.getRun(runId)
    if (!run) throw new DomainError('NOT_FOUND', `Run 不存在：${runId}`)

    if (running.has(runId)) {
      throw new DomainError('STATE_CONFLICT', '这个 Run 正在执行中')
    }

    // ── 取消意图与状态门（L2 Task 2）────────────────────────
    //
    // 这两条检查必须在**所有执行入口**上都生效。
    // 之前只有 tick 的候选构造阶段检查取消意图，手动 execute
    // 可以直接把一个已取消 / 已完成的 Run 重新跑起来——
    // 那就是「一条路径有安全门，另一条绕过」。
    if (store.hasCancelIntent(runId)) {
      throw new DomainError(
        'STATE_CONFLICT',
        '这个 Run 已被请求取消，不能执行。如需继续请先清除取消意图。',
      )
    }

    // 只有 queued / running（崩溃恢复）是合法执行起点。
    // 已完成 / 已失败 / 已取消的 Run 重新执行会覆盖既有结果。
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new DomainError(
        'STATE_CONFLICT',
        `Run 当前状态是 ${run.status}，只有 queued 或 running 可以执行`,
      )
    }

    // 能力：走 providerConfig（覆盖生效），与手动执行同一套。
    const providerId = opts.provider ?? 'demo'
    const modelId = opts.model ?? 'demo'
    // 单次请求密钥优先：它是这次调用的输入，不写回任何存储。
    const provider = providerConfig.resolve(providerId, opts.requestKey)
    // requiresKey 但没有密钥 → 本地拒绝，不发未认证请求（审计二轮 P1-4）
    assertProviderUsable(provider)
    const model = { id: modelId }

    const goal = store.getTask(run.taskId)?.goal ?? ''
    const system = opts.system ?? DEFAULT_SYSTEM
    const messages: ChatMessage[] = opts.messages ?? [{ role: 'user', content: goal }]

    // 能力门：与手动执行一致（fail-closed）。
    assertRequirements({
      providerId: provider.id,
      modelId: model.id,
      tools: tools.listAll(),
      requirement: { capabilities: tools.listAll().length > 0 ? ['text', 'tool_calling'] : ['text'] },
      what: '无人值守执行这个 Run',
    })

    executor.expireStaleApprovals()

    // ── 租约 + fencing ────────────────────────────────────
    //
    // 两种进入方式（审计二轮 P1-3）：
    //   · 直接 HTTP 执行：这里自己抢租约
    //   · 由 runner.tick 调用：租约**已经由 runner 抢到**，
    //     这里不能再抢一次——同一个 owner 重复抢会产生
    //     「已被其他执行者持有」的假冲突，把正常执行挡掉。
    //
    // 所以 executeRun 接受一个可选的 lease 参数：
    //   有 → 复用它（runner 抢的）
    //   无 → 自己抢（手动执行）
    // 两条路径共用同一个 LeaseGuard 与同一套 fencing 校验。
    const leaseKey = `run:${runId}`
    const lease = opts.lease ?? leaseStore.tryAcquire(leaseKey, instanceOwner, 60_000, Date.now())
    const ownsLease = opts.lease === undefined
    if (!lease) {
      throw new DomainError(
        'STATE_CONFLICT',
        '这个 Run 已被其他执行者持有租约，不能重复执行',
      )
    }
    const guard = new LeaseGuard(
      leaseStore,
      { key: leaseKey, owner: lease.owner, epoch: lease.epoch },
      60_000,
    )
    guard.start()

    /**
     * 是否已经进入「真正执行」。用于 finally 判断该不该释放租约。
     *
     * 为什么要区分（L2 Task 1）：
     *   · **执行前**失败（provider 解析、能力门、参数校验）——Run 没被
     *     动过，租约必须**立即释放**，否则它要白等一个 TTL 才能重试。
     *     这正是「执行前校验错误后 lease 能立即重试」的要求。
     *   · **执行中**抛错——执行器可能已经产生了外部副作用，
     *     不能立刻释放让别人接管并重复执行。让租约自然过期更安全。
     */
    let enteredExecution = false
    const releaseIfPreExecution = (): void => {
      if (enteredExecution) return
      guard.stop()
      leaseStore.release(leaseKey, lease.owner)
    }

    const controller = new AbortController()
    running.set(runId, controller)
    // 调用方给的 signal 也要能中断执行（HTTP 断连 / 外部取消）。
    //
    // 这条链路是「客户端断开 → 请求被取消 → 执行被中止」的关键：
    // 没有它，用户关掉页面后模型会继续跑完并计费。
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort)
    // 连接已经断开时立刻中止（signal 可能在注册前就已经 abort）
    if (opts.signal?.aborted) controller.abort()

    // 让 close() 能等待这次执行收尾，而不是在它还写库时就关掉 store。
    let releaseTask!: () => void
    const taskDone = new Promise<void>((r) => {
      releaseTask = r
    })
    runningTasks.add(taskDone)

    try {
      enteredExecution = true
      const outcome = await executor.execute({
        runId,
        provider,
        model,
        system,
        messages,
        signal: controller.signal,
        leaseGuard: guard,
      })
      return {
      status: outcome.status,
      run: store.getRun(runId),
      ...(outcome.status === 'completed' ? { text: outcome.text } : {}),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      ...(outcome.status === 'expired' ? { reason: outcome.reason } : {}),
      // paused 时要带 approval：调用方（UI / 测试）需要知道
      // 「在等哪个工具的授权」。旧路由有这个字段，统一入口不能丢。
      ...(outcome.status === 'paused' ? { approval: outcome.approval } : {}),
    }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      running.delete(runId)
      runningTasks.delete(taskDone)
      releaseTask()
      guard.stop()
      if (!enteredExecution) {
        // 执行前失败：Run 状态没被动过，租约必须立即还回去，
        // 否则要白等一个 TTL 才能重试。
        //
        // 注意：即使租约是 runner 传进来的也要释放——「执行前失败」
        // 意味着这次调度根本没开始，持有租约没有任何意义。
        leaseStore.release(leaseKey, lease.owner)
      } else if (ownsLease) {
        // 执行中抛错且租约是自己抢的：不释放，让它自然过期
        // （避免立即被接管导致重复执行）。
        // 正常返回时走到这里，释放是安全的。
        leaseStore.release(leaseKey, lease.owner)
      }
      void releaseIfPreExecution
    }
  }

  /**
   * 无人值守调度一次。
   *
   * ⚠️ 这个接口**真的会执行** Run，不是只做协调。
   *
   * 审计指出：早期实现只调用 takeOverStaleRuns() 然后返回
   * 「执行由调用方完成」——那是 no-op 接线，生产路径上从未执行过任何东西。
   *
   * 现在的语义：
   *   1. 找出 eligible 的 Run（queued / 需要恢复的 running）
   *   2. 抢租约（抢不到 = 别人在做，如实返回）
   *   3. 评估暂停条件（成立则不执行）
   *   4. **真实调用 executor** 并返回真实结果
   *   5. 按成功/失败更新连续失败计数
   */
  route('POST', '/runner/tick', async (req, res, body) => {
    // ── 明确拒绝一次性 apiKey（L2 Gate 阻断项 1）──────────────
    //
    // runner/tick 是**无人值守**入口：它一次可能执行多个 Run，
    // 而一次性 key 的语义是「只用于这一次调用」。两者放在一起会产生
    // 一个无法回答的问题：这个 key 属于这一批里的哪个 Run？
    //
    // 更重要的一条：静默忽略是**最坏的**选择——调用方会以为 key
    // 生效了，然后拿到一个莫名其妙的 401。所以这里明确拒绝并说明替代方案。
    if (body.apiKey !== undefined) {
      throw new DomainError(
        'INVALID_INPUT',
        'POST /runner/tick 不支持一次性 apiKey：它可能一次执行多个 Run，' +
        '无法确定 key 属于哪一个。请改为：' +
        '(1) 通过环境变量或 SecretStore 配置该服务商的密钥；或 ' +
        '(2) 用 POST /runs/:id/execute 并携带 apiKey 逐个执行。',
      )
    }

    const runner = new UnattendedRunner(
      store as unknown as RunnerStore,
      leaseStore,
      // 每次 tick 都是一个新的调度者身份：不同实例 / 不同 tick
      // 不能共享 owner，否则一个 tick 的租约会被另一个当成自己的。
      newLeaseOwner('tick'),
      unattendedPolicy,
      {
        // ── 失败计数必须持久化（审计二轮 P1-4）──────────────
        //
        // 每次 HTTP tick 都新建 runner，进程内的 Map 每次归零——
        // 「连续失败 3 次就停」这条策略在生产上永远不会触发。
        // 这里接到 Store（落 run 表），跨请求、跨重启都保留。
        failures: new StoreFailureCounter(store),
      },
    )

    // 构造候选：所有 queued 的 Run + 所有 running 但租约失联的 Run。
    //
    // 为什么不包含 waiting_approval / paused / needs_reconciliation：
    //   那三类都要人来推动（审批、resume、对账）。把它们列进候选
    //   会让 evaluatePause 每次都判定暂停，等于白白消耗一次调度。
    const candidates: Array<{ taskId: string; runId: string; priority: number; eligible: boolean }> = []
    for (const run of store.listRunsByStatus('queued')) {
      const task = store.getTask(run.taskId)
      if (!task) continue
      // 有取消意图的 Run 不进候选：它不该被重新执行。
      const eligible = !store.hasCancelIntent(run.id)
      candidates.push({ taskId: run.taskId, runId: run.id, priority: 0, eligible })
    }

    // 客户端可以指定 candidates（测试与脚本用），否则用上面的默认集合。
    const provided = Array.isArray(body.candidates)
      ? (body.candidates as Array<{ taskId?: unknown; runId?: unknown; priority?: unknown; eligible?: unknown }>)
          .filter((c) => typeof c.taskId === 'string' && typeof c.runId === 'string')
          .map((c) => ({
            taskId: c.taskId as string,
            runId: c.runId as string,
            priority: typeof c.priority === 'number' ? c.priority : 0,
            eligible: c.eligible !== false,
          }))
      : undefined

    // 执行参数：默认 demo provider（零密钥可跑），可以按需覆盖。
    const execOpts = {
      provider: typeof body.provider === 'string' ? body.provider : 'demo',
      model: typeof body.model === 'string' ? body.model : 'demo',
      ...(typeof body.system === 'string' ? { system: body.system } : {}),
    }

    const executed: Array<{ runId: string; status: string }> = []
    let tickResult
    try {
      tickResult = await runner.tick(
        async (taskId, runId, lease) => {
          const out = await executeRun(runId, {
            ...execOpts,
            // 复用 runner 抢到的租约：executeRun 不再自己抢，
            // 两条路径共用同一次租约与同一个 LeaseGuard（审计二轮 P1-3）。
            lease,
          })
          executed.push({ runId, status: out.status })
          // runner 只关心成败：completed / cancelled / paused 都算「正常收束」
          return out.status === 'failed' ? 'failed' : 'ok'
        },
        provided ?? candidates,
        {
          usage: (runId) => {
            const run = store.getRun(runId)
            const u = run?.usage
            return {
              totalTokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
              costUsd: u?.costUsd ?? 0,
              steps: u?.steps ?? 0,
            }
          },
        },
      )
    } catch (err) {
      // 执行抛错：把真实原因带回去，但调度本身不崩。
      //
      // ⚠️ 不能一律 500（L2 Task 4）：core 层抛出的是 DomainError，
      // 里面带着精确的 code（未知 provider = NOT_FOUND、
      // 状态冲突 = STATE_CONFLICT、能力缺失 = CAPABILITY_UNAVAILABLE）。
      // 这里用 statusForError 保留原始分类，只有真正未分类的异常才是 500。
      json(res, statusForError(err), {
        error: err instanceof Error ? err.message : String(err),
        executed,
        policy: unattendedPolicy,
      })
      return
    }

    json(res, 200, {
      // 真实调度结果。
      //
      // selected 是 taskId（历史字段，保留兼容）；
      // selectedRunId 是这一轮实际处理的 Run——调用方通常更关心它，
      // 因为「同一个 Task 可能有多个 Run」。
      selected: tickResult.selected ?? null,
      selectedRunId: executed.length > 0 ? executed[0]!.runId : null,
      leased: tickResult.leased,
      decision: tickResult.decision ?? null,
      executed,
      policy: unattendedPolicy,
    })
  })

  /**
   * 列出仍带取消意图的 Run。
   *
   * 取消意图会阻止 Run 被重新排队；终态后自动清理，
   * 所以这里列出的是「还在起作用」的那些。
   */
  route('GET', '/runner/cancel-intents', async (_req, res) => {
    json(res, 200, { intents: store.listCancelIntents() })
  })

  /** 清理已终态 Run 的取消意图（可重复调用，幂等）。 */
  route('POST', '/runner/cancel-intents/prune', async (_req, res) => {
    // 清理只删「已终态 Run」的取消意图——那些已经完成使命，
    // 删掉不会放行任何还在跑的 Run。所以这里用 run.cancel
    // 而不是 maintenance.recover：后者要求 trusted，HTTP 层永远拿不到。
    requirePermission('run.cancel')
    const removed = store.pruneCancelIntents()
    json(res, 200, { removed })
  })

  /** 请求取消：标记意图，下一次调度会按 user_cancelled 暂停。 */
  route('POST', '/runner/runs/:id/cancel-intent', async (_req, res, body, params) => {
    const runId = params[0]!
    const run = store.getRun(runId)
    if (!run) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }

    // ── 必须写持久化的取消意图（审计 D-1）─────────────────
    //
    // 早期实现只 append 一条 run.paused_by_user 事件就返回。
    // 事件是「历史事实」，不是「还在生效的约束」：
    //   · 新起的 runner 不会读事件来判断该不该执行
    //   · 进程重启后事件仍在，但没有任何代码据此阻止重跑
    //
    // 所以必须写 cancel_intent 表——runner、takeover、startup recovery
    // 都会读它。
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '用户请求取消'
    store.requestCancel(runId, 'user', reason)

    // 如果这个 Run 正在本进程执行，同时中断它。
    running.get(runId)?.abort()

    const decision = evaluatePause({
      run: { status: run.status },
      now: Date.now(),
      policy: unattendedPolicy,
      consecutiveFailures: 0,
      usage: { totalTokens: 0, costUsd: 0, steps: 0 },
      cancelRequested: true,
    })

    store.appendEvent(runId, 'run.paused_by_user', {
      reason: decision.reason,
      detail: decision.detail,
      viaRunner: true,
      persisted: true,
    }, { actor: 'user', correlationId: runId })

    // ── 返回真实状态，而不是无条件 ok（审计 D-6）────────
    //
    // 取消意图已经持久化了，但 Run **此刻**可能还是 running（执行中）。
    // 如实返回：intent='recorded'，当前 status 是快照。
    // 调用方据此知道「取消已登记，但尚未生效」，而不是以为已经停了。
    const current = store.getRun(runId)!
    const applied = ['cancelled', 'completed', 'failed', 'expired'].includes(current.status)
    json(res, 200, {
      ok: true,
      intent: 'recorded',
      // applied=true 表示 Run 已经处于终态；false 表示取消已登记待生效
      applied,
      decision,
      run: current,
    })
  })

  // ── 任务 ────────────────────────────────────────────────

  route('GET', '/tasks', async (_req, res) => {
    json(res, 200, { tasks: store.listTasks() })
  })

  route('POST', '/tasks', async (_req, res, body) => {
    const sessionId = requireString(body, 'sessionId')
    const goal = requireString(body, 'goal')
    if (!store.getSession(sessionId)) {
      json(res, 404, { error: `会话不存在：${sessionId}` })
      return
    }
    const budget = body.budget && typeof body.budget === 'object'
      ? (body.budget as { maxCostUsd?: number; maxDurationMs?: number; maxSteps?: number; maxCycles?: number })
      : undefined

    // 可选：创建时一并定义验收标准。
    // 不传也可以——任务仍可创建，但在定义契约之前 review 会 escalate。
    // 这是有意的：不允许「没有标准就审计通过」。
    const rawCriteria = body.acceptanceCriteria
    let acceptanceCriteria: string[] | undefined
    if (rawCriteria !== undefined) {
      if (!Array.isArray(rawCriteria) || rawCriteria.some((c) => typeof c !== 'string')) {
        json(res, 400, { error: 'acceptanceCriteria 必须是字符串数组' })
        return
      }
      acceptanceCriteria = rawCriteria as string[]
    }

    const task = store.createTask({ sessionId, goal, budget })

    // 契约与 Task 同时建立。actor 记 'user'——这是用户直接发起的请求，
    // 不是系统推导出来的。
    const contract = store.putTaskContract({
      taskId: task.id,
      goal,
      acceptanceCriteria: acceptanceCriteria ?? [],
      actor: 'user',
    })

    json(res, 201, { ...task, contract })
  })

  route('GET', '/tasks/:id', async (_req, res, _body, params) => {
    const task = store.getTask(params[0]!)
    if (!task) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    json(res, 200, { task, runs: store.listRuns(task.id) })
  })

  // ── 任务契约 ────────────────────────────────────────────
  //
  // 契约是审计的唯一标准，所以它的读写必须走独立、显式的入口。
  // 注意 POST /tasks 也接受 acceptanceCriteria，那是创建时的便捷路径；
  // 这里的 PUT 是修改路径，每次修改都会产生新版本。

  route('GET', '/tasks/:id/contract', async (_req, res, _body, params) => {
    const taskId = params[0]!
    if (!store.getTask(taskId)) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    const contract = store.getActiveTaskContract(taskId)
    if (!contract) {
      json(res, 404, { error: '这个任务还没有定义契约' })
      return
    }
    json(res, 200, { contract, history: store.listTaskContracts(taskId) })
  })

  route('PUT', '/tasks/:id/contract', async (_req, res, body, params) => {
    const taskId = params[0]!
    if (!store.getTask(taskId)) {
      json(res, 404, { error: '任务不存在' })
      return
    }

    // goal 可以省略（沿用当前契约），但契约不存在时必须给。
    const current = store.getActiveTaskContract(taskId)
    const goal = typeof body.goal === 'string'
      ? body.goal
      : current?.goal
    if (!goal) {
      json(res, 400, { error: '首次定义契约必须提供 goal' })
      return
    }

    let acceptanceCriteria: string[]
    if (body.acceptanceCriteria !== undefined) {
      if (!Array.isArray(body.acceptanceCriteria) ||
          body.acceptanceCriteria.some((c) => typeof c !== 'string')) {
        json(res, 400, { error: 'acceptanceCriteria 必须是字符串数组' })
        return
      }
      acceptanceCriteria = body.acceptanceCriteria as string[]
    } else {
      acceptanceCriteria = current?.acceptanceCriteria ?? []
    }

    // actor 由服务端决定，不接受请求体指定。
    // 允许调用方自称 'system' 就等于允许它伪造来源。
    const contract = store.putTaskContract({
      taskId,
      goal,
      acceptanceCriteria,
      actor: 'user',
    })

    json(res, 200, { contract, history: store.listTaskContracts(taskId) })
  })

  // ── Run ─────────────────────────────────────────────────

  route('POST', '/runs', async (_req, res, body) => {
    const taskId = requireString(body, 'taskId')
    const task = store.getTask(taskId)
    if (!task) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    const role = body.role === 'auditor' ? 'auditor' : 'producer'
    const run = store.createRun({
      taskId,
      role,
      budget: {
        maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : 30,
        maxToolCalls: typeof body.maxToolCalls === 'number' ? body.maxToolCalls : 20,
        maxCostUsd: typeof body.maxCostUsd === 'number' ? body.maxCostUsd : undefined,
        deadlineAt: typeof body.deadlineMinutes === 'number' ? Date.now() + body.deadlineMinutes * 60_000 : undefined,
      },
    })
    json(res, 201, run)
  })

  route('GET', '/runs/:id', async (_req, res, _body, params) => {
    const run = store.getRun(params[0]!)
    if (!run) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }
    json(res, 200, {
      run,
      steps: store.listSteps(run.id),
      approvals: store.listApprovals().filter((a) => a.runId === run.id),
      events: store.listEvents(run.id),
      artifacts: store.listArtifacts(run.id),
    })
  })

  route('POST', '/runs/:id/execute', async (_req, res, body, params) => {
    const runId = params[0]!
    const run = store.getRun(runId)
    if (!run) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }

    // 权限只能来自服务端，不能来自请求体。
    //
    // 曾经这里写的是：
    //   autoApprove: Array.isArray(body.autoApprove) ? body.autoApprove : []
    // 也就是说调用方在 body 里写 autoApprove:['write_file'] 就能跳过审批。
    // 现在字段被彻底删除：出现即 400，且 executor 不再接受这个选项。
    onlyFields(
      body,
      ['provider', 'model', 'apiKey', 'goal', 'system', 'messages'],
      'POST /runs/:id/execute',
    )

    if (running.has(runId)) {
      json(res, 409, { error: '这个 Run 正在执行中' })
      return
    }

    const { provider, model } = modelFrom(body, providerConfig)

    const goal = typeof body.goal === 'string' ? body.goal : store.getTask(run.taskId)?.goal ?? ''
    const system = typeof body.system === 'string' ? body.system : DEFAULT_SYSTEM

    // messages 必须真的是消息数组。
    //
    // 旧实现写的是 `Array.isArray(body.messages) ? body.messages : [...]`：
    // 传一个字符串会被静默替换成「用 goal 拼一条 user 消息」，
    // 客户端看到 200 就以为自己的 messages 生效了。静默改写的输入
    // 比报错更危险——它让调用方基于一个假的成功继续往下走。
    if (body.messages !== undefined && !Array.isArray(body.messages)) {
      throw new BadRequestError('messages 必须是数组')
    }
    const messages: ChatMessage[] = Array.isArray(body.messages)
      ? (body.messages as ChatMessage[])
      : [{ role: 'user', content: goal }]

    // ── 能力门 ────────────────────────────────────────────
    //
    // 之前 capability-catalog 只有定义与单元测试，没有任何执行路径使用它——
    // 于是「模型不支持工具调用」这类问题要到运行时才以奇怪的方式暴露。
    //
    // 这里做的是**结构性**检查，不是「探测 provider」：
    //   · 认不出模型族 → unknown，不通过（fail-closed）
    //   · 声明的能力不足以跑工具 → 不通过
    //   · 请求要求本地（requireLocal）但模型在云端 → 不通过
    //
    // 只检查**必需的**能力：text 是底线；只有在这个 Run 实际会用到工具时，
    // 才要求 tool_calling。过度要求会让一堆本来能跑的模型被挡在外面。
    const requirement: import('../core/capability-catalog.js').CapabilityRequirement = {
      capabilities: tools.listAll().length > 0 && body.disableTools !== true
        ? ['text', 'tool_calling']
        : ['text'],
      ...(body.requireLocal === true ? { requireLocal: true } : {}),
    }
    assertRequirements({
      providerId: provider.id,
      modelId: model.id,
      tools: tools.listAll(),
      requirement,
      what: '执行这个 Run',
    })
    // 每次执行前处理一次超时审批——不能等到下次重启
    executor.expireStaleApprovals()

    // 注意：不要再在这里 running.set(runId, ...)。
    // executeRun 内部已经注册了 controller 与 in-flight Promise，
    // 在外面重复注册会让 executeRun 的「已在执行」检查立刻失败。

    // ── 统一执行入口（L2 Task 2）────────────────────────────
    //
    // 手动执行之前有一段**独立**的执行逻辑：没有租约、没有 fencing、
    // 不检查取消意图、不检查状态门。于是：
    //   · 已取消的 Run 手动执行仍能跑完
    //   · 已完成的 Run 手动执行会再跑一遍
    //   · 并发手动执行没有互斥
    // 而 tick 路径有这些保护。「一条路径有门、另一条绕过」正是
    // 本任务要消除的分叉。
    //
    // 现在直接复用 executeRun：provider 解析、requiresKey、
    // 能力门、租约 + fencing、取消与状态门、shutdown 收尾
    // 全部同一条代码路径。
    // 把请求体的一次性 apiKey 一路传下去。
    //
    // modelFrom 已经用它解析过一次 provider（用于能力门与 requiresKey 检查），
    // 但真正的执行由 executeRun 重新构造 adapter —— 如果这里不传，
    // 那次解析就白做了，key 在传递链上丢失。
    const requestKey = typeof body.apiKey === 'string' ? body.apiKey : undefined

    const outcome = await executeRun(runId, {
      provider: provider.id,
      model: model.id,
      requestKey,
      system,
      messages,
      // 不传 HTTP request 的 signal。
      //
      // 为什么：IncomingMessage 的 'aborted' 在**响应发送之后**也会触发
      // （连接正常关闭时），执行器会把它当成「用户取消」立即中止——
      // 结果是每次手动执行都返回 cancelled，而且一 token 都没消耗。
      // 真正的取消通道是 /runs/:id/cancel 与 cancel-intent，它们会把
      // controller.abort() 打到 running 表里注册的那个 controller。
    })

    json(res, 200, {
      status: outcome.status,
      ...(outcome.text !== undefined ? { text: outcome.text } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      // paused 时把 approval 透传给客户端：UI 要靠它渲染「等哪个工具授权」。
      ...(outcome.status === 'paused' ? { approval: outcome.approval } : {}),
      run: store.getRun(runId),
      steps: store.listSteps(runId),
    })
  })

  /**
   * 取消 Run。
   *
   * 与 /runner/runs/:id/cancel-intent 的区别：
   *   · cancel-intent 只**登记意图**（可能还没生效，例如执行中）
   *   · 这个接口尝试**立即**把状态改成 cancelled
   *
   * 两者都写持久化取消意图，因为即使立即取消失败
   * （Run 已在执行且暂时无法打断），后续 takeover / 调度也不该重跑它。
   *
   * 响应如实反映结果（审计 D-5/D-6）：
   *   · 已取消 → ok:true, cancelled:true
   *   · Run 已是别的终态 → ok:true, cancelled:false + 当前状态
   *     （不覆盖终态，也不假装成功）
   */
  route('POST', '/runs/:id/cancel', async (_req, res, _body, params) => {
    const runId = params[0]!
    if (!store.getRun(runId)) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }

    // 先登记意图：即使下一步的同步取消失败，也不会被重跑。
    store.requestCancel(runId, 'user', '用户取消')

    const controller = running.get(runId)
    if (controller) controller.abort()

    const outcome = executor.cancel(runId)
    const current = store.getRun(runId)!
    json(res, 200, {
      ok: true,
      cancelled: current.status === 'cancelled' && outcome.status === 'cancelled',
      // outcome.status 是**真实**状态：可能是 cancelled，
      // 也可能是它本来就已完成/失败（那时不覆盖）。
      status: current.status,
      run: current,
    })
  })

  /** 用户主动暂停。与 waiting_approval 不同，可直接 resume。 */
  route('POST', '/runs/:id/pause', async (_req, res, _body, params) => {
    executor.pause(params[0]!)
    json(res, 200, { ok: true, run: store.getRun(params[0]!) })
  })

  /** 恢复用户主动暂停的 Run。waiting_approval 会被拒绝。 */
  route('POST', '/runs/:id/resume', async (_req, res, _body, params) => {
    executor.resume(params[0]!)
    json(res, 200, { ok: true, run: store.getRun(params[0]!) })
  })

  /** 解决 unknown 状态。必须提供依据。 */
  route('POST', '/runs/:id/reconcile', async (_req, res, body, params) => {
    const runId = params[0]!
    const stepId = requireString(body, 'stepId')
    const resolution = requireString(body, 'resolution')
    const allowed = ['confirmed_success', 'confirmed_failure', 'abandoned', 'retried']
    if (!allowed.includes(resolution)) {
      json(res, 400, { error: `resolution 必须是 ${allowed.join(' / ')} 之一` })
      return
    }

    try {
      const record = executor.reconcile({
        runId,
        stepId,
        resolution: resolution as 'confirmed_success' | 'confirmed_failure' | 'abandoned' | 'retried',
        evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
        // **HTTP 层不接受 'system'。**
        //
        // 'system' 表示「系统自动裁决」，在审计上是更强的声明。
        // 如果请求体写什么就信什么，这个字段就没有意义了。
        // 外部调用方最多能声称自己是 'reconciler' 或 'user'。
        decidedBy: body.decidedBy === 'reconciler' ? 'reconciler' : 'user',
        // 注意：不传 trusted。HTTP 层永远不是「内部代码路径」。
        //
        // 多个 unknown 时必须显式指定针对哪一个 Intent——
        // 猜错会把 A 的确认结果记到 B 头上。
        intentId: typeof body.intentId === 'string' ? body.intentId : undefined,
        toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : undefined,
      })
      json(res, 200, { ok: true, record, run: store.getRun(runId) })
    } catch (err) {
      // 证据不合法 = 请求不合法 → 400。
      // 用专门异常类型判断，不靠匹配错误文案。
      if (err instanceof InvalidReconcileEvidence) {
        json(res, 400, { error: err.message })
        return
      }
      // 状态/归属错误（Step 已解决、多个 unknown 无法确定目标、
      // Intent 与 Step 不符）不在这里单独处理：
      // `ReconcileError` 自带 `code`，外层通用处理器会通过
      // `statusForError` 读 code 映射成 409 / 404。
      //
      // 之前这些抛的是普通 Error，只能走文案正则兜底，
      // 而那些文案里没有兜底正则认得的词——于是本该 409 的
      // 请求歧义返回了 500。修的是**错误类型**，不是加一个分支：
      // 加分支会让同一套映射存在两份，以后改一处忘一处。
      throw err
    }
  })

  /** 查看这个 Run 的对账记录 */
  route('GET', '/runs/:id/reconciliations', async (_req, res, _body, params) => {
    json(res, 200, { reconciliations: store.listReconciliations(params[0]!) })
  })

  // ── 审批 ────────────────────────────────────────────────

  route('GET', '/approvals', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const status = url.searchParams.get('status') as 'pending' | 'approved' | 'rejected' | 'expired' | null
    json(res, 200, { approvals: store.listApprovals(status ?? undefined) })
  })

  route('POST', '/approvals/:id/approve', async (_req, res, body, params) => {
    requirePermission('approval.decide')
    // 审批者由服务端记录为 'user'：请求体里的 approver 不能代表「系统放行」。
    // 让客户端能指定 approver 等于允许它伪造一条系统级授权。
    if ('approver' in body) {
      throw new BadRequestError(
        '/approvals/:id/approve 不接受字段：approver。' +
        '审批者由服务端记录，不能通过请求体指定。',
      )
    }
    const scope = body.scope === 'run' ? 'run' : 'once'
    const grant = executor.approve(params[0]!, { scope, approver: 'user' })
    json(res, 200, { ok: true, grant })
  })

  route('POST', '/approvals/:id/reject', async (_req, res, body, params) => {
    requirePermission('approval.decide')
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason : '用户拒绝执行'
    executor.reject(params[0]!, reason)
    json(res, 200, { ok: true })
  })

  // ── 快照与产物 ──────────────────────────────────────────

  /** 手动拍一次快照。用于「用户在 Run 之间想留个存档」这类场景。 */
  route('POST', '/runs/:id/snapshot', async (_req, res, _body, params) => {
    const runId = params[0]!
    const run = store.getRun(runId)
    if (!run) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }
    if (!gitOk) {
      json(res, 503, { error: 'git 不可用，无法拍快照' })
      return
    }

    // 并发锁 + 配额。
    //
    // 两条都必须在这里检查，而不是只在下层：
    //   · 锁：capture 会改写影子仓库的 refs。并发时快照可能记录下
    //     一个「恢复了一半」的工作区，而那份快照看起来完全正常。
    //   · 配额：不拦的话，一个循环执行的 Run 能把磁盘写满。
    const release = snapshotLock.acquire(workspace, 'capture', `snapshot:${runId}`)
    try {
      const usage = snapshotUsage()
      // 预检（0 字节）只拦「数量已满 / 总量已超」的情况；
      // 单次大小由拍完之后的大小与磁盘余量共同把关。
      const decision = checkQuota(usage, 0, snapshotQuota)
      if (!decision.allowed) {
        json(res, 409, { error: decision.reason ?? '快照配额已满' })
        return
      }

      const result = await snapshot.capture()

      // 拍完才知道真实大小。
      //
      // 超配额时**不写入记录**：写进去再删会让「快照历史」里出现
      // 一条从未真正可用的记录，而证据链不应该包含这种东西。
      // 影子仓库里的 git 对象交给 GC 处理。
      const after = checkQuota(usage, result.totalBytes, snapshotQuota)
      if (!after.allowed) {
        json(res, 409, {
          error: `快照大小 ${formatBytes(result.totalBytes)} 超出配额：${after.reason ?? ''}`,
        })
        return
      }

      const free = await checkDiskFree(workspace, result.totalBytes, snapshotQuota.reservedFreeBytes)
      if (!free.ok) {
        json(res, 507, { error: free.reason ?? '磁盘空间不足' })
        return
      }

      const record = store.createSnapshot({
        runId,
        taskId: run.taskId,
        kind: 'workspace',
        ref: result.ref,
        reproducible: true,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
      })
      json(res, 201, { snapshot: record })
    } catch (err) {
      if (err instanceof DomainError) throw err
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    } finally {
      release()
    }
  })

  route('GET', '/runs/:id/snapshots', async (_req, res, _body, params) => {
    json(res, 200, { snapshots: store.listSnapshots(params[0]!) })
  })

  route('GET', '/tasks/:id/artifacts', async (_req, res, _body, params) => {
    json(res, 200, { artifacts: store.listTaskArtifacts(params[0]!) })
  })

  /** 两个快照之间的差异 */
  route('GET', '/snapshots/diff', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    if (!fromRaw || !toRaw) {
      json(res, 400, { error: '需要 from 和 to 两个快照 ref' })
      return
    }
    if (!gitOk) {
      json(res, 503, { error: 'git 不可用' })
      return
    }

    // ── 参数注入防护（审计 E-1）────────────────────────────
    //
    // 不能把任意字符串拼进 git 参数：
    //   · `--output=/x` 会被当成选项
    //   · `a --exec=b` 在部分子命令下会执行命令
    // 只接受完整 commit hash 或数据库里存在的 snapshot ref。
    const known = knownSnapshotRefs(store.listAllSnapshots({ includeDeleted: true }))
    const fromCheck = validateGitRef(fromRaw, known)
    if (!fromCheck.ok) {
      json(res, 400, { error: `from 参数不合法：${fromCheck.reason}` })
      return
    }
    const toCheck = validateGitRef(toRaw, known)
    if (!toCheck.ok) {
      json(res, 400, { error: `to 参数不合法：${toCheck.reason}` })
      return
    }

    try {
      const result = await snapshot.diff(fromCheck.ref, toCheck.ref)
      json(res, 200, result)
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  /** 把工作区恢复到某个快照。带事务保护。 */
  route('POST', '/snapshots/:id/restore', async (_req, res, _body, params) => {
    requirePermission('snapshot.restore')
    const snap = store.getSnapshot(params[0]!)
    if (!snap) {
      json(res, 404, { error: '快照不存在' })
      return
    }
    if (!gitOk) {
      json(res, 503, { error: 'git 不可用' })
      return
    }
    // 恢复必须独占工作区：它会在恢复前自动拍一个回滚点，
    // 并整体覆盖工作区。与 capture 并发时，回滚点可能就是错的。
    const release = snapshotLock.acquire(workspace, 'restore', `restore:${snap.id}`)
    try {
      const result = await snapshot.restore(snap.ref)
      // 恢复失败但已回滚时不是 500：工作区仍是安全的，
      // 需要的是「为什么没恢复成功」，不是「重试服务端错误」。
      json(res, result.ok ? 200 : result.rolledBack ? 409 : 500, result)
    } finally {
      release()
    }
  })

  /** 列出快照内的文件 */
  route('GET', '/snapshots/:id/files', async (_req, res, _body, params) => {
    const snap = store.getSnapshot(params[0]!)
    if (!snap) {
      json(res, 404, { error: '快照不存在' })
      return
    }
    const files = await snapshot.listFiles(snap.ref)
    json(res, 200, { files })
  })

  // ── 验收与交付 ──────────────────────────────────────────

  /** 用户接受候选产物。这是唯一能把 Task 变成 accepted 的路径。 */
  route('POST', '/tasks/:id/accept', async (_req, res, body, params) => {
    requirePermission('acceptance.accept')
    const taskId = params[0]!
    // 不可复现快照的人工放行必须显式给出 actor + reason。
    // 不接受「只有 actor 没有 reason」或反之。
    const override = body.override && typeof body.override === 'object'
      ? {
          actor: String((body.override as Record<string, unknown>).actor ?? ''),
          reason: String((body.override as Record<string, unknown>).reason ?? ''),
        }
      : undefined

    const record = await acceptance.accept({
      taskId,
      artifactId: requireString(body, 'artifactId'),
      runId: requireString(body, 'runId'),
      override,
    })
    json(res, 201, { acceptance: record, task: store.getTask(taskId) })
  })

  /** 要求返工。必须给出说明。 */
  route('POST', '/tasks/:id/request-revision', async (_req, res, body, params) => {
    requirePermission('acceptance.request_revision')
    const taskId = params[0]!
    const record = acceptance.requestRevision({
      taskId,
      artifactId: requireString(body, 'artifactId'),
      runId: requireString(body, 'runId'),
      note: requireString(body, 'note'),
    })
    json(res, 201, { acceptance: record, task: store.getTask(taskId) })
  })

  /** 拒绝并放弃。 */
  route('POST', '/tasks/:id/reject', async (_req, res, body, params) => {
    requirePermission('acceptance.reject')
    const taskId = params[0]!
    const record = acceptance.reject({
      taskId,
      artifactId: requireString(body, 'artifactId'),
      runId: requireString(body, 'runId'),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    })
    json(res, 201, { acceptance: record, task: store.getTask(taskId) })
  })

  route('GET', '/tasks/:id/acceptances', async (_req, res, _body, params) => {
    json(res, 200, { acceptances: store.listAcceptances(params[0]!) })
  })

  /** 应用产物到原工作区。失败不改变接受记录。 */
  route('POST', '/acceptances/:id/apply', async (_req, res, _body, params) => {
    requirePermission('delivery.apply')
    const delivery = await acceptance.apply(params[0]!)
    json(res, delivery.status === 'applied' ? 200 : 500, { delivery })
  })

  /** 导出产物到指定目录。失败不改变接受记录。 */
  route('POST', '/acceptances/:id/export', async (_req, res, body, params) => {
    requirePermission('delivery.export')
    const delivery = await acceptance.export(params[0]!, requireString(body, 'destination'))
    json(res, delivery.status === 'exported' ? 200 : 500, { delivery })
  })

  route('GET', '/tasks/:id/deliveries', async (_req, res, _body, params) => {
    json(res, 200, { deliveries: store.listDeliveries(params[0]!) })
  })

  // ── ReviewLoop ──────────────────────────────────────────

  /**
   * 对一个已完成的 Producer Run 发起审计。
   *
   * 前置：Run 必须已完成、有快照、有产物。
   * 审计只读快照，不读变化中的工作区。
   */
  route('POST', '/tasks/:id/review', async (_req, res, body, params) => {
    const taskId = params[0]!
    const producerRunId = requireString(body, 'runId')
    const skillId = typeof body.skillId === 'string' ? body.skillId : DEFAULT_SKILL.id
    const skillVersion = typeof body.skillVersion === 'string' ? body.skillVersion : DEFAULT_SKILL.version

    const skill = getSkill(skillId, skillVersion)
    if (!skill) {
      json(res, 404, { error: `技能不存在：${skillId}@${skillVersion}` })
      return
    }

    const run = store.getRun(producerRunId)
    if (!run) {
      json(res, 404, { error: 'Run 不存在' })
      return
    }

    // 归属校验：这个 Run 必须属于 URL 里的 Task。
    //
    // 没有这一条，可以提交 POST /tasks/task-A/review { runId: task-B 的 Run }，
    // 结果 Cycle.taskId = A 但 producerRunId / artifacts 都来自 B，
    // 污染两个 Task 的审计记录。
    if (run.taskId !== taskId) {
      json(res, 409, {
        error: `Run ${producerRunId} 属于 Task ${run.taskId}，不是 ${taskId}`,
      })
      return
    }

    // 只有 producer Run 可以被审计。
    // Auditor 是内嵌调用，不产生独立 Run；如果将来改成独立 Run，这条会挡住自我审计。
    if (run.role !== 'producer') {
      json(res, 409, {
        error: `只有 producer Run 可以审计，当前 role 是 ${run.role}`,
      })
      return
    }

    // ── Skill manifest 的能力门禁（审计 P1）─────────────────
    //
    // manifest 里的 requiredTools 之前只是声明，从来没有人校验。
    // 结果是「声明需要某工具的 skill 被派给没有它的环境，跑到一半才失败」。
    //
    // 放在**归属与角色校验之后**：先判「这个请求对不对」，再判「环境够不够」。
    // 反过来的话，对一个不存在的 Run 提交审计会先报「能力不足」，
    // 那个错误会把人引向错误的方向。
    const manifest = getSkillManifest(skillId, skillVersion)
    if (manifest && manifest.requiredTools.length > 0) {
      const available = new Set(tools.listAll().filter((t) => t.enabled).map((t) => t.id))
      const missing = manifest.requiredTools.filter((t) => !available.has(t))
      if (missing.length > 0) {
        json(res, 503, {
          error: `技能 ${skillId}@${skillVersion} 需要的工具当前不可用：${missing.join(', ')}`,
          code: 'CAPABILITY_UNAVAILABLE',
          retryable: true,
          missingTools: missing,
        })
        return
      }
    }

    if (run.status !== 'completed') {
      json(res, 409, { error: `只有 completed 的 Run 可以审计，当前是 ${run.status}` })
      return
    }

    // ── 以下全部是「创建 Cycle 之前」的前置检查 ────────────
    //
    // 顺序很重要：Cycle 一旦创建就消耗了 Task 的 cycles 额度。
    // 如果先建 Cycle 再检查，任何前置失败都会白吃一次额度——
    // 用户重试三次就把 maxCycles 用完了，而一次审计都没发生。
    //
    // 所以：**所有能提前判断的失败，都必须在 begin() 之前返回**。

    // 1. Task 状态：已验收的不能再审
    const task = store.getTask(taskId)
    if (!task) {
      json(res, 404, { error: '任务不存在' })
      return
    }
    if (task.status === 'accepted') {
      json(res, 409, {
        error:
          '这个 Task 已经验收通过（accepted），不能再发起审计。' +
          '如果确实需要重新审查，请新建一个 Task。',
      })
      return
    }

    // 2. Producer 模型身份：只信服务端记录，不信请求体
    //
    // 模型族隔离校验依赖这个身份。如果接受请求体的 producerModel，
    // 调用方可以把同族模型伪装成不同族，绕过隔离检查。
    const producerIdentity = run.modelIdentity
    if (!producerIdentity) {
      json(res, 409, {
        error:
          '这个 Run 没有记录模型身份，无法做族隔离校验。' +
          '请用当前版本重新执行一次（记录会在执行开始时写入）。',
      })
      return
    }

    // 3. 任务契约必须存在
    if (!store.getActiveTaskContract(taskId)) {
      json(res, 409, {
        error:
          '这个 Task 还没有任务契约，无法审计。' +
          '没有「任务要求完成什么」的定义，任何结论都只是对格式的认可。' +
          '请先调用 PUT /tasks/:id/contract 定义 goal 与 acceptanceCriteria。',
      })
      return
    }

    // 4. 产物必须存在且证据完整
    //
    // 与 ReviewLoop.audit 里的检查重复，但这里更早——
    // 目的是不让一次注定失败的审计消耗 Cycle 额度。
    const preflightArtifacts = store.listArtifacts(producerRunId)
    if (preflightArtifacts.length === 0) {
      json(res, 409, {
        error: '这个 Run 没有产物，无法审计。',
      })
      return
    }
    const incomplete = preflightArtifacts.filter(
      (a) => !a.path || !a.contentHash || !a.sourceSnapshotId,
    )
    if (incomplete.length > 0) {
      json(res, 409, {
        error:
          `有 ${incomplete.length} 个产物证据不完整（缺少 path / contentHash / sourceSnapshotId），无法审计。` +
          `涉及产物：${incomplete.map((a) => a.id).join(', ')}`,
      })
      return
    }

    // 5. 完成快照必须能唯一确定
    const snapshotIds = new Set(preflightArtifacts.map((a) => a.sourceSnapshotId))
    if (snapshotIds.size > 1) {
      json(res, 409, {
        error:
          '产物来自多个不同的快照，无法确定审计基准：' +
          [...snapshotIds].join(', '),
      })
      return
    }

    // 6. 那个快照必须真的存在
    //
    // 证据字段齐全不等于证据可用：sourceSnapshotId 可以指向一条
    // 已被删除、或从来没写进去的快照记录。这种情况下 ReviewLoop.audit
    // 会走 no_snapshot 分支写一条 escalate 审计——**Cycle 已经创建，
    // 额度已经扣掉**，而结论是「数据本身坏了」。
    //
    // 这不是「审计无法判断」，是「输入不成立」。必须在这里挡下。
    const [completionSnapshotId] = [...snapshotIds]
    if (completionSnapshotId && !store.getSnapshot(completionSnapshotId)) {
      json(res, 409, {
        error:
          `产物指向的快照 ${completionSnapshotId} 不存在，无法审计。` +
          '证据记录与快照数据不一致，请重新执行 Producer 生成新的产物与快照。',
      })
      return
    }

    // ── 前置全部通过，才创建 Cycle ────────────────────────
    const cycleOrLimit = reviewLoop.begin({ taskId, producerRunId, skill })
    if ('limitReached' in cycleOrLimit) {
      json(res, 429, { error: cycleOrLimit.reason, code: 'CYCLE_LIMIT' })
      return
    }
    const cycle = cycleOrLimit

    // ── Auditor 模型：可以由请求体指定，但族名由服务端计算 ──
    //
    // 允许调用方选择用哪个模型做审计（这是配置，不是身份声明），
    // 但 modelFamily 必须由服务端从 modelId 算出，
    // 不能让调用方直接声明"我这个模型属于另一个族"。
    const auditorModel = typeof body.auditorModel === 'string' ? body.auditorModel : 'claude-sonnet-5-5'
    const auditorPreset = typeof body.auditorProvider === 'string' ? body.auditorProvider : 'anthropic'

    // ── 走 ProviderConfigStore，而不是直接读请求体的 apiKey（审计 P1）──
    //
    // 之前审计调用直接用 body.apiKey 构造 provider，于是：
    //   · 用户在设置里改的 baseUrl 覆盖对审计不生效
    //   · SecretStore 里存的密钥也不会被用到
    // 结果是「设置看起来生效了，审计还在打默认地址」。
    const auditorConfig = providerConfig.resolve(
      auditorPreset,
      typeof body.apiKey === 'string' ? body.apiKey : undefined,
    )
    void auditorConfig

    const controller = new AbortController()
    try {
      const outcome = await reviewLoop.audit(cycle.id, {
        cycleId: cycle.id,
        // 用服务端记录的模型 id，不是请求体里的
        producerModel: producerIdentity.modelId,
        auditorModel,
        auditorProvider: auditorConfig,
        signal: controller.signal,
        adapterResolver: config.auditorAdapterResolver,
      })

      // verdict 决定 Task 的后续状态
      //
      // 关键：escalate 不能进 awaiting_acceptance。
      // escalate 的含义是「审计无法判断」——如果这时允许验收，
      // 用户会把「我不确定」当成「通过」，等于绕过了整个审计。
      // 正确做法：保持 revision_requested，要求先人工处理审计问题。
      // 审计期间 Task 可能已被用户验收（accepted）。这时不能回退——
      // 用户的决定优先于一次进行中的审计。
      const statusAfterAudit = store.getTask(taskId)?.status
      const canTransition = statusAfterAudit !== 'accepted'

      if (outcome.kind === 'passed') {
        // 审计通过仍不自动接受——必须用户确认
        if (canTransition) store.updateTaskStatus(taskId, 'awaiting_acceptance')
      } else if (outcome.kind === 'rejected') {
        if (canTransition) store.updateTaskStatus(taskId, 'revision_requested')
      } else {
        // escalate：转人工。Task 停在 revision_requested，
        // 不提供「接受」这个动作，避免把不确定当通过。
        if (canTransition) store.updateTaskStatus(taskId, 'revision_requested')
        store.appendEvent(producerRunId, 'review.escalated', {
          cycleId: cycle.id,
          reason: outcome.audit.result.escalateReason ?? 'uncertain',
          summary: outcome.reason,
        })
      }

      json(res, 200, {
        outcome: outcome.kind,
        cycle,
        audit: outcome.audit,
        ...(outcome.kind === 'rejected' ? {
          brief: outcome.brief,
          reworkPrompt: reviewLoop.buildReworkPrompt(outcome.brief),
        } : {}),
        ...(outcome.kind === 'escalated' ? { reason: outcome.reason } : {}),
        taskStatus: store.getTask(taskId)?.status,
      })
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  route('GET', '/tasks/:id/cycles', async (_req, res, _body, params) => {
    const taskId = params[0]!
    const cycles = store.listReviewCycles(taskId).map((c) => ({
      ...c,
      derivedStatus: reviewLoop.deriveStatus(c.id),
    }))
    json(res, 200, { cycles })
  })

  route('GET', '/tasks/:id/audits', async (_req, res, _body, params) => {
    json(res, 200, { audits: store.listAuditResults(params[0]!) })
  })

  route('GET', '/skills', async (_req, res) => {
    json(res, 200, {
      skills: [{
        id: DEFAULT_SKILL.id,
        version: DEFAULT_SKILL.version,
        name: DEFAULT_SKILL.name,
        maxCycles: DEFAULT_SKILL.maxCycles,
      }],
    })
  })

  // ── 工具 ────────────────────────────────────────────────

  route('GET', '/tools', async (_req, res) => {
    json(res, 200, { tools: tools.listAll() })
  })

  // ── 分发 ────────────────────────────────────────────────

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    // 1. Origin 校验先于一切。
    //
    // 浏览器发跨站请求一定带 Origin。只要带了就必须在允许列表里，
    // 否则直接拒绝——这样即使 token 因为某种原因泄露给网页，也发不出去。
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      json(res, 403, { error: '来源不被允许' })
      return
    }

    // 2. 不接受 URL 里的 token。
    //
    // 不是「读了但忽略」，而是明确报错：URL 会进访问日志、shell 历史、
    // 浏览器历史。让调用方越早知道这个限制越好。
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
      json(res, 400, {
        error: 'token 不能放在 URL 里，请使用 Authorization: Bearer <token>',
      })
      return
    }

    // 3. 不实现 CORS 预检：控制面只服务于本机客户端。
    if (method === 'OPTIONS') {
      json(res, 405, { error: '不支持预检请求' })
      return
    }

    // 4. 桌面壳静态资源。
    //
    // **不需要认证**：这些是 UI 本身的 HTML/CSS/JS，不含任何用户数据。
    // 但它们仍然经过 Origin 校验（第 1 步）——跨站页面拿不到这些文件。
    //
    // 页面本身拿到后，所有数据请求仍然需要 token。
    // 所以「公开静态资源」不会成为绕过认证的入口：
    // 打开一个空白壳和读取工作区是两件事。
    if (method === 'GET') {
      const asset = resolveStaticAsset(uiDir, url.pathname)
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.contentType,
          // 壳是单文件内联逻辑，缓存会让改动不生效。
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          // 不允许被 frame 嵌入：防止点击劫持
          'x-frame-options': 'DENY',
          'content-security-policy': [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
          ].join('; '),
        })
        res.end(asset.body)
        return
      }
    }

    for (const r of routes) {
      if (r.method !== method) continue
      if (r.parts.length !== parts.length) continue

      const params: string[] = []
      let matched = true
      for (let i = 0; i < r.parts.length; i++) {
        const spec = r.parts[i]!
        const actual = parts[i]!
        if (spec.startsWith(':')) params.push(decodeURIComponent(actual))
        else if (spec !== actual) {
          matched = false
          break
        }
      }
      if (!matched) continue

      // 4. 认证。放在路由匹配之后、读 body 之前——
      //    未认证的请求连请求体都不该被解析。
      if (r.requiresAuth) {
        const provided = parseBearer(req.headers.authorization)
        if (!provided) {
          throw new AuthError('需要 Authorization: Bearer <token>')
        }
        if (!tokenMatches(auth.token, provided)) {
          throw new AuthError('token 不正确')
        }
      }

      let body: Record<string, unknown> = {}
      if (method !== 'GET') {
        body = await readBody(req)
      }

      await r.handler(req, res, body, params)
      return
    }

    // 路由不存在时也要认证吗？
    //
    // 不需要——但也不能泄露「哪些接口存在」。
    // 404 本身不区分，且没有任何副作用。
    json(res, 404, { error: `没有这个接口：${method} ${url.pathname}` })
  }

  const server = createServer((req, res) => {
    dispatch(req, res).catch((err) => {
      if (err instanceof AuthError) {
        json(res, 401, { error: err.message })
        return
      }
      if (err instanceof BadRequestError) {
        json(res, 400, { error: err.message })
        return
      }
      // 统一错误体：code / message / retryable / correlationId。
      //
      // correlationId 同时写进响应头：用户报告问题时可以只贴这个 id，
      // 不必贴任何可能含路径或内容的错误文案。
      //
      // 没有 code 的错误会被归一化成 INTERNAL 并**隐藏真实 message**——
      // 底层库的报错里可能有路径、SQL 甚至凭据片段。
      const body = normalizeError(err)
      if (!codeOf(err)) {
        console.error(`[${body.correlationId}]`, err)
      }
      // 响应形状（兼容 + 结构化并存）：
      //   error   —— 保留为**字符串**。已有调用方（E2E 脚本、旧客户端）
      //              直接 `String(body.error)` 读文案，改成对象会让它们拿到
      //              `[object Object]`。这是公共契约，不能单方面改形状。
      //   code / retryable / correlationId —— 新增的机器可读字段。
      //              客户端要分支就用 code，不要解析 error 文案。
      const status = isDomainErrorCode(body.code) ? specFor(body.code).httpStatus : 500
      json(res, status, {
        error: body.message,
        code: body.code,
        retryable: body.retryable,
        ...(body.details === undefined ? {} : { details: body.details }),
        correlationId: body.correlationId,
      })
    })
  })

  return {
    server,
    store,
    executor,
    tools,
    snapshot,
    acceptance,
    reviewLoop,
    providerConfig,
    images,
    mcp,
    build,
    authEnabled: true,
    listen(): Promise<number> {
      return new Promise((resolvePort, reject) => {
        const onError = (err: Error): void => {
          server.off('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          server.off('error', onError)
          const addr = server.address()
          const realPort = typeof addr === 'object' && addr ? addr.port : config.port
          // 端口是 0 时到这一刻才知道真实端口，据此重建 Origin 白名单
          if (config.allowedOrigins === undefined) {
            allowedOrigins = defaultAllowedOrigins(realPort)
          }
          resolvePort(realPort)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
    },
    /**
     * 关闭服务。
     *
     * 顺序与等待（审计二轮 P1-6）：
     *   1. 中止所有执行中的 Run
     *   2. **等待执行器收尾**（否则 store.close() 会让它们的写入失败，
     *      留下「执行了一半、状态没落」的 Run）
     *   3. 等待 MCP 就绪并关闭所有 client / 子进程
     *   4. 关闭 HTTP 服务器
     *   5. 最后才关 store
     *
     * 旧实现是 abort → 立即 store.close()：执行器还在写时数据库已经关了，
     * 那些写入直接抛错。而且 MCP 子进程根本没被回收。
     */
    async close(): Promise<void> {
      // 1. 中止执行
      const aborted = [...running.values()]
      for (const c of aborted) c.abort()
      running.clear()

      // 2. 等执行器把状态落定。给一个上限，避免卡住不退。
      if (runningTasks.size > 0) {
        await Promise.race([
          Promise.allSettled([...runningTasks]),
          new Promise((r) => setTimeout(r, 10_000)),
        ])
      }

      // 3. MCP：先等连接尝试结束，再关闭所有 client
      await mcpReady.catch(() => undefined)
      await mcp.closeAll().catch(() => undefined)

      // 4. HTTP
      await new Promise<void>((ok) => {
        server.close(() => ok())
        // 已建立的 keep-alive 连接会阻止 close 回调，主动断开
        server.closeAllConnections?.()
      })

      // 5. 最后关 store：此时不应该再有写入者
      store.close()
    },
  }
}

export { DEFAULT_SKILL, DEFAULT_SYSTEM }
