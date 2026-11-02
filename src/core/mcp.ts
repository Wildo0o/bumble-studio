// MCP（Model Context Protocol）客户端。
//
// 作用：把外部 MCP server 暴露的工具接进 ToolRegistry，让它们和内置工具
// 走同一套能力声明、审批、Intent 保护与对账。
//
// 设计取舍：
//
// 1. **只支持需要的传输**：stdio（本地子进程）与 http（已有端点）。
//    不实现动态传输发现——多一种传输就多一条攻击面，而收益有限。
//
// 2. **工具一律按外部副作用处理**。
//    MCP server 是外部进程，我们无法验证它是否真的只读。
//    因此：
//      · 不接受 server 自称的 sdk riskLevel
//      · 默认 sideEffect='external'，riskLevel='external'（需要审批）
//      · 只有 server 在 tools/list 里**显式**标注 `readOnlyHint: true`
//        且我们通过 allowlist 认可时，才降级为只读
//    这条是 fail-closed 的核心：不能因为 server 说「我很安全」就相信它。
//
// 3. **不自动重试**。
//    MCP 工具调用是外部副作用，超时后结果未知。声明 unsafeToRetry，
//    交给 Intent 对账处理，而不是自动重放。
//
// 4. **能力探测与调用分离**。
//    listTools 只读；callTool 可能改变外部状态。前者可以在启动时跑，
//    后者必须走审批。
import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolDefinition } from '../shared/types.js'
import type { ToolResult } from './tools.js'
import { DomainError } from './errors.js'

/**
 * HTTP 端点的 SSRF 策略。
 *
 * 威胁模型：MCP server 地址可以由配置或远程配置提供。不校验时，
 * 服务端会被指向：
 *   · 云元数据服务（169.254.169.254）→ 拿到实例凭据
 *   · 内网管理接口（10.x / 192.168.x / 127.0.0.1）→ 绕过网络边界
 *
 * 规则：
 *   · 只允许 http / https
 *   · 默认禁止回环 / 私网 / 链路本地 / 保留地址
 *   · 必须显式 `allowPrivateNetwork: true` 才放行（本地 MCP server 的合法场景）
 *   · 禁止 URL 里带凭据（user:pass@）——那会进日志
 *
 * DNS rebinding 的限制：这里校验的是主机名字符串。一个域名可以先解析到
 * 公网、再解析到 127.0.0.1。彻底防御需要连接层固定 IP，Node 的 fetch
 * 不支持自定义 lookup。缓解手段是禁用跨源重定向 + 显式开关。
 */
export interface HttpEndpointPolicy {
  allowPrivateNetwork?: boolean
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^127\./,                     // IPv4 回环
  /^10\./,                      // 私网 A
  /^192\.168\./,                // 私网 C
  /^172\.(1[6-9]|2\d|3[01])\./, // 私网 B
  /^169\.254\./,                // 链路本地（含云元数据 169.254.169.254）
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 运营商级 NAT
  /^0\./,
  /^255\./,
]

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
])

/** 判断一个主机名是否指向内网 / 本机。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (PRIVATE_HOSTNAMES.has(host)) return true

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true   // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true   // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    if (mapped) return isPrivateHost(mapped[1]!)
    return false
  }

  for (const re of PRIVATE_HOST_PATTERNS) if (re.test(host)) return true
  return false
}

/** 校验 MCP HTTP 端点。 */
export function validateMcpHttpEndpoint(
  rawUrl: string,
  policy: HttpEndpointPolicy = {},
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `不是合法 URL：${rawUrl}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http / https，实际是 ${url.protocol}` }
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'URL 不能包含用户名或密码，请使用 headers 传递凭据' }
  }

  if (!policy.allowPrivateNetwork && isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason:
        `目标地址 ${url.hostname} 属于内网 / 回环 / 元数据地址，默认禁止。` +
        '如果是本机 MCP server，请在配置里显式设置 allowPrivateNetwork: true。',
    }
  }

  return { ok: true, url }
}

/** MCP server 连接配置。 */
export interface McpServerConfig {
  id: string
  name: string
  /**
   * 是否允许这个 server 的连接地址指向内网 / 回环。
   *
   * 默认 false。本地 MCP server（stdio 或 http://127.0.0.1）必须显式打开，
   * 这是为了让「把请求发到内网」成为一个需要人写下来的决定，
   * 而不是一个 URL 碰巧带来的副作用。
   */
  allowPrivateNetwork?: boolean
  transport:
    | {
        kind: 'stdio'
        command: string
        args?: string[]
        /** 额外环境变量。**不允许**继承完整 process.env 之外的敏感项时使用。 */
        env?: Record<string, string>
      }
    | {
        kind: 'http'
        url: string
        /** 认证头。值来自密钥存储，不来自请求体。 */
        headers?: Record<string, string>
      }
  /**
   * 明确认可为只读的工具名。
   *
   * 为什么需要双重确认（server 声明 + 本地 allowlist）：
   * 只信 server 的 readOnlyHint 等于把「是否需要审批」的决定权交给
   * 被检查方。本地 allowlist 让「降低审批」这件事必须在配置里显式写出。
   */
  trustedReadOnlyTools?: string[]
  /** 单次调用超时 */
  timeoutMs?: number
}

/** MCP 工具描述（tools/list 的返回项）。 */
interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * MCP 客户端。
 *
 * 一个实例对应一个 server。生命周期由调用方管理（connect / close）。
 */
export class McpClient {
  private child?: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private stdoutBuffer = ''
  private closed = false
  private initialized = false

  constructor(private readonly config: McpServerConfig) {}

  get serverId(): string {
    return this.config.id
  }

  /** 建立连接并完成 initialize 握手。 */
  async connect(): Promise<void> {
    if (this.config.transport.kind === 'stdio') {
      await this.connectStdio()
    } else {
      await this.connectHttp()
    }
    this.initialized = true
  }

  private async connectStdio(): Promise<void> {
    const t = this.config.transport
    if (t.kind !== 'stdio') throw new Error('transport 类型不符')

    // 不继承敏感环境：默认只给 PATH 等运行所需项，再加显式声明的 env。
    // 继承完整 process.env 会把 API key 泄露给第三方 server。
    const child = spawn(t.command, t.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...safeBaseEnv(), ...(t.env ?? {}) },
      windowsHide: true,
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.setEncoding('utf8')
    // stderr 只留最后一段用于诊断，不写进日志正文（可能含路径或密钥）
    child.stderr?.on('data', () => { /* 丢弃 */ })

    child.on('error', (err) => {
      this.closed = true
      this.rejectAll(new Error(`MCP server ${this.config.id} 启动失败：${err.message}`))
    })
    child.on('exit', () => {
      this.closed = true
      this.rejectAll(new Error(`MCP server ${this.config.id} 已退出`))
    })

    // 走一次 JSON-RPC 来确认 pipe 可用，而不是「spawn 成功就算连上」。
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-workstation', version: '1.0.0' },
    })
    this.initialized = true
  }

  private async connectHttp(): Promise<void> {
    const t = this.config.transport
    if (t.kind !== 'http') throw new Error('transport 类型不符')

    // SSRF 校验必须在**任何请求发出之前**完成。
    // 放到第一次 request 里也行，但那样「连接」这个动作本身就
    // 可能已经被触发（比如某些实现会在 connect 时探活）。
    const check = validateMcpHttpEndpoint(t.url, {
      allowPrivateNetwork: this.config.allowPrivateNetwork === true,
    })
    if (!check.ok) {
      throw new DomainError('CAPABILITY_UNAVAILABLE', `MCP server ${this.config.id} 的地址被拒绝：${check.reason}`)
    }
    // http 传输用一次 requests 探活；具体调用走 callTool。
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-workstation', version: '1.0.0' },
    })
    this.initialized = true
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    // JSON-RPC over stdio 用换行分隔。不假设一条 chunk 等于一条消息。
    let idx: number
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1)
      if (!line) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line) as JsonRpcResponse
      } catch {
        // 非法 JSON：server 输出不规范。丢弃这一行，不破坏后续解析。
        continue
      }
      if (typeof msg.id !== 'number') continue
      const waiter = this.pending.get(msg.id)
      if (!waiter) continue
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`MCP 错误 ${msg.error.code}：${msg.error.message}`))
      else waiter.resolve(msg.result)
    }
  }

  /** 发一个 JSON-RPC 请求并等待响应。 */
  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error(`MCP server ${this.config.id} 已关闭`)

    const id = this.nextId++
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    if (this.config.transport.kind === 'stdio') {
      if (!this.child?.stdin?.writable) throw new Error('MCP stdio 管道不可写')
      this.child.stdin.write(payload + '\n')
    }

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new DomainError('CAPABILITY_UNAVAILABLE', `MCP server ${this.config.id} 在 ${timeoutMs}ms 内无响应`, {
            details: { serverId: this.config.id, method },
          }),
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })

    if (this.config.transport.kind === 'http') {
      // http 传输：POST 一个请求，读 JSON 响应。
      const t = this.config.transport
      // redirect: 'error' —— 不跟随重定向。
      //
      // 跟随重定向会让上面所有的主机名校验失效：一个公网地址
      // 302 到 http://169.254.169.254 就能绕过。
      // 需要重定向的场景应该由使用者在配置里写最终地址。
      const res = await fetch(t.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(t.headers ?? {}),
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      let msg: JsonRpcResponse | undefined
      try {
        msg = JSON.parse(text) as JsonRpcResponse
      } catch {
        msg = undefined
      }
      const waiter = this.pending.get(id)
      this.pending.delete(id)
      if (!waiter) throw new Error('MCP 响应没有对应的请求')
      if (!msg) waiter.reject(new Error(`MCP server ${this.config.id} 返回了非 JSON 响应`))
      else if (msg.error) waiter.reject(new Error(`MCP 错误 ${msg.error.code}：${msg.error.message}`))
      else waiter.resolve(msg.result)
    }

    return response
  }

  /** 列出 server 提供的工具，转换成项目内的 ToolDefinition。 */
  async listTools(): Promise<ToolDefinition[]> {
    if (!this.initialized) throw new Error('MCP 客户端未连接')
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDescriptor[] } | undefined
    const tools = result?.tools ?? []
    return tools.map((t) => this.toDefinition(t))
  }

  /**
   * 把一个 MCP 工具描述转换成本项目的 ToolDefinition。
   *
   * 能力映射规则（fail-closed）：
   *   · 默认 riskLevel='external'、sideEffect='external'（需要审批 + Intent 保护）
   *   · 只有 server 声明 readOnlyHint=true **并且** 本地 allowlist 认可，
   *     才降为 riskLevel='read'、sideEffect='none'
   *   · destructiveHint=true 时即使声明 readOnly 也不降级（两者矛盾时取严）
   */
  private toDefinition(t: McpToolDescriptor): ToolDefinition {
    const trusted = this.config.trustedReadOnlyTools ?? []
    const claimsReadOnly = t.annotations?.readOnlyHint === true
    const claimsDestructive = t.annotations?.destructiveHint === true
    const localApproves = trusted.includes(t.name)
    const isReadOnly = claimsReadOnly && localApproves && !claimsDestructive

    return {
      id: `${this.config.id}:${t.name}`,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      source: 'mcp',
      serverId: this.config.id,
      riskLevel: isReadOnly ? 'read' : 'external',
      sideEffect: isReadOnly ? 'none' : 'external',
      // MCP 工具是否幂等我们**无法验证**。不声明支持幂等键，
      // 让 Intent 对账把重试交给人工决定。
      supportsIdempotencyKey: false,
      // 不认为 MCP 调用能被 abort 打断：子进程可能已经发起外部请求。
      cancellable: false,
      enabled: true,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      reconcile: { idempotent: false, unsafeToRetry: true },
    }
  }

  /** 调用一个 MCP 工具。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.initialized) throw new Error('MCP 客户端未连接')
    const result = (await this.request('tools/call', { name, arguments: args })) as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined

    const parts = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')

    return {
      ok: result?.isError !== true,
      content: parts,
      raw: parts,
      isError: result?.isError === true,
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.rejectAll(new Error('MCP 客户端已关闭'))
    const child = this.child
    this.child = undefined
    if (child && !child.killed) {
      child.kill()
    }
    await Promise.resolve()
  }

  private rejectAll(err: Error): void {
    for (const [, w] of this.pending) w.reject(err)
    this.pending.clear()
  }
}

/**
 * 传给子进程的最小环境。
 *
 * 白名单而不是黑名单：黑名单永远会漏（新的 *_KEY 变量、代理凭据、云凭证）。
 * 这里只给「启动一个程序」所必需的部分。
 */
function safeBaseEnv(): Record<string, string> {
  const keys = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ]
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = process.env[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * MCP 服务器管理器。
 *
 * 负责：连接、列工具、把工具注册进 ToolRegistry、关闭。
 * 启动失败**不**让整个服务起不来——记录错误，该 server 的工具就是不可用。
 */
export class McpManager {
  private clients = new Map<string, McpClient>()
  private errors = new Map<string, string>()

  constructor(private readonly configs: McpServerConfig[] = []) {}

  /**
   * 连接所有配置的 server 并返回可用的工具定义。
   *
   * 单个 server 失败不影响其他 server：MCP 是可选能力，
   * 一个写错配置的 server 不该让整个工作站不可用。
   */
  async connectAll(): Promise<ToolDefinition[]> {
    const all: ToolDefinition[] = []
    for (const cfg of this.configs) {
      const client = new McpClient(cfg)
      try {
        await client.connect()
        const tools = await client.listTools()
        this.clients.set(cfg.id, client)
        this.errors.delete(cfg.id)
        all.push(...tools)
      } catch (err) {
        this.errors.set(cfg.id, err instanceof Error ? err.message : String(err))
        await client.close().catch(() => { /* 已失败，忽略 */ })
      }
    }
    return all
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId)
  }

  /** 启动失败的 server 及原因。用于 /meta 与 UI 提示。 */
  listErrors(): Array<{ serverId: string; error: string }> {
    return [...this.errors.entries()].map(([serverId, error]) => ({ serverId, error }))
  }

  listServers(): Array<{ id: string; name: string; transport: string; connected: boolean }> {
    return this.configs.map((c) => ({
      id: c.id,
      name: c.name,
      transport: c.transport.kind,
      connected: this.clients.has(c.id),
    }))
  }

  async closeAll(): Promise<void> {
    for (const [, client] of this.clients) await client.close().catch(() => { /* 忽略 */ })
    this.clients.clear()
  }
}

export { safeBaseEnv }
