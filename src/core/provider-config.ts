// 密钥与 provider 配置边界。
//
// 三条规则，任何一条破了都会让密钥泄露或权限被绕过：
//
// 1. **密钥不落库、不落日志、不回传。**
//    密钥只存在两个地方：
//      · 环境变量（`<PRESET>_API_KEY`）
//      · 本地密钥文件（0600 权限，同一 OS 用户可读）
//    数据库中只允许存 `hasKey: boolean`，绝不存密钥本身。
//    这不是「顺手做一下」：一旦落库，数据库备份、日志、错误堆栈
//    都会成为泄露渠道，而且用户无法通过改环境变量来轮换。
//
// 2. **请求体不能注入密钥覆盖服务端配置。**
//    客户端可以在单次请求里带 apiKey（用于临时试用），但它只能
//    **用于这一次调用**，不能写回配置、不能改变 provider 预设。
//
// 3. **配置只能改预设允许的字段。**
//    允许覆盖 baseUrl / pricing 之类；不允许覆盖 requiresKey 这类
//    「安全属性」——否则客户端可以把 requiresKey 改成 false，
//    让一个需要密钥的 provider 在无密钥状态下被使用。
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProviderConfig } from '../shared/types.js'
import { presetFor, providerFromPreset } from '../providers/registry.js'
import { DomainError } from './errors.js'
import { isPrivateHost } from './mcp.js'

/** 可以在 `PUT /providers/:id` 里改的字段。其余一律拒绝。 */
export const PROVIDER_OVERRIDABLE_FIELDS = [
  'baseUrl',
  'pricing',
  'includeUsage',
  'maxTokensParam',
  'modelFilter',
] as const

export type ProviderOverridableField = (typeof PROVIDER_OVERRIDABLE_FIELDS)[number]

/**
 * **不允许**通过 HTTP 覆盖的字段。
 *
 * 单独列出来是为了能给出明确错误（而不是笼统的「非法字段」），
 * 也为了让测试能穷举这些字段都改不动。
 */
export const PROVIDER_PROTECTED_FIELDS = [
  'requiresKey',
  'kind',
  'protocol',
  'apiKey',
] as const

/** 环境变量名：`openai` → `OPENAI_API_KEY`。 */
export function envKeyName(presetId: string): string {
  return `${presetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

/**
 * 密钥存储。
 *
 * 文件格式：JSON，`{ "<presetId>": "<key>" }`。
 * 权限在写入后立刻收紧（POSIX chmod 0600）。
 */
export class SecretStore {
  private cache: Map<string, string> | undefined

  constructor(private readonly file: string) {}

  private load(): Map<string, string> {
    if (this.cache) return this.cache
    const map = new Map<string, string>()
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string' && v.length > 0) map.set(k, v)
        }
      } catch {
        // 文件损坏：视为「没有任何密钥」，不抛错。
        // 抛错会让整个服务起不来，而密钥缺失是可以用 env 补上的降级状态。
      }
    }
    this.cache = map
    return map
  }

  /**
   * 取某个 provider 的密钥。
   *
   * 优先级：环境变量 > 文件。
   * 为什么环境变量优先：部署环境用 env 注入更常见，而且
   * 「改了 env 就该生效」比「文件里的旧值一直赢」更符合直觉。
   */
  get(presetId: string): string | undefined {
    const fromEnv = process.env[envKeyName(presetId)]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
    return this.load().get(presetId)
  }

  /** 是否已配置密钥（只回答「有没有」，不返回密钥）。 */
  has(presetId: string): boolean {
    return this.get(presetId) !== undefined
  }

  /** 写入密钥。只用于本机 CLI / 设置界面，不经 HTTP 暴露。 */
  set(presetId: string, key: string): void {
    if (!key.trim()) throw new Error('密钥不能为空')
    const map = this.load()
    map.set(presetId, key.trim())
    this.persist(map)
  }

  delete(presetId: string): void {
    const map = this.load()
    map.delete(presetId)
    this.persist(map)
  }

  private persist(map: Map<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const obj: Record<string, string> = {}
    for (const [k, v] of map) obj[k] = v
    writeFileSync(this.file, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Windows 上 chmod 是 no-op；真正的 ACL 收紧由 server 启动时统一做。
    }
    this.cache = map
  }

  /** 测试用：丢弃缓存，强制从磁盘重读。 */
  resetCache(): void {
    this.cache = undefined
  }
}

/** 校验一个 provider 覆盖请求是否合法。返回规范化后的覆盖对象。 */
/**
 * provider 端点安全校验（审计二轮 P1-3）。
 *
 * 为什么必须统一：baseUrl 可以被 PUT /providers/:id 覆盖。
 * 如果不校验，一次覆盖就能把**带 API key 的请求**发到：
 *   · 回环地址（本机其它服务）
 *   · 私网（内网管理接口）
 *   · link-local / 云元数据（169.254.169.254）
 * 那等同于「把凭据交给一个由用户可控的地址」。
 *
 * 规则与 MCP 的 endpoint policy 一致：
 *   · 只允许 http / https
 *   · 拒绝 URL 内凭据（会进日志）
 *   · 拒绝回环 / 私网 / link-local / 元数据地址
 *
 * 不提供 allowPrivateNetwork 开关：provider 场景下「本地模型」
 * 走 ollama / lmstudio 预设的默认 baseUrl（那是 127.0.0.1，
 * 但它的**预设**本身可信）。用户覆盖成别的内网地址一律拒绝。
 */
export function validateProviderEndpoint(rawUrl: string): { ok: boolean; reason?: string } {
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
    return { ok: false, reason: 'URL 不能包含用户名或密码，请通过 SecretStore 配置密钥' }
  }

  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason:
        `目标地址 ${url.hostname} 属于内网 / 回环 / 元数据地址。` +
        'provider 的 baseUrl 覆盖不允许指向这些地址——' +
        '那会把 API key 发给一个不该拿到的服务。',
    }
  }

  return { ok: true }
}

/**
 * 发请求前的最低可用性检查。
 *
 * requiresKey=true 且没有密钥时**本地拒绝**：
 * 让一个未认证请求发出去，只会换来 401 与一次计费/限流消耗，
 * 而且日志里会留下「我们发了一个注定失败的请求」。
 */
export function assertProviderUsable(config: ProviderConfig): void {
  if (config.requiresKey && !config.apiKey) {
    throw new DomainError(
      'UNAUTHORIZED',
      `服务商 ${config.id} 需要密钥，但当前没有配置。` +
      '请设置环境变量或通过 SecretStore 写入，不要发送未认证请求。',
      { details: { providerId: config.id } },
    )
  }
}

export function validateProviderOverrides(
  presetId: string,
  input: Record<string, unknown>,
): Partial<ProviderConfig> {
  const preset = presetFor(presetId)
  if (!preset) {
    throw new DomainError('NOT_FOUND', `未知服务商：${presetId}`)
  }

  const protectedHit = PROVIDER_PROTECTED_FIELDS.filter((f) => f in input)
  if (protectedHit.length > 0) {
    throw new DomainError(
      'INVALID_INPUT',
      `服务商配置不接受字段：${protectedHit.join(', ')}。` +
      '这些是安全属性，只能由服务端预设决定——' +
      '允许客户端覆盖等于允许它关闭密钥要求或改变协议。',
    )
  }

  const unknown = Object.keys(input).filter(
    (k) => !(PROVIDER_OVERRIDABLE_FIELDS as readonly string[]).includes(k),
  )
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_INPUT',
      `服务商配置不接受字段：${unknown.join(', ')}。可用：${PROVIDER_OVERRIDABLE_FIELDS.join(', ')}`,
    )
  }

  const out: Partial<ProviderConfig> = {}

  if ('baseUrl' in input) {
    const v = input.baseUrl
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) {
      throw new DomainError('INVALID_INPUT', 'baseUrl 必须是 http(s) 地址')
    }
    out.baseUrl = v
  }

  if ('includeUsage' in input) {
    if (typeof input.includeUsage !== 'boolean') {
      throw new DomainError('INVALID_INPUT', 'includeUsage 必须是布尔值')
    }
    out.includeUsage = input.includeUsage
  }

  if ('maxTokensParam' in input) {
    const v = input.maxTokensParam
    if (v !== 'none' && v !== 'max_tokens' && v !== 'max_completion_tokens') {
      throw new DomainError('INVALID_INPUT', 'maxTokensParam 只能是 none / max_tokens / max_completion_tokens')
    }
    out.maxTokensParam = v
  }

  if ('pricing' in input) {
    const v = input.pricing
    if (
      !v || typeof v !== 'object' ||
      typeof (v as Record<string, unknown>).input !== 'number' ||
      typeof (v as Record<string, unknown>).output !== 'number'
    ) {
      throw new DomainError('INVALID_INPUT', 'pricing 必须是 { input: number, output: number }')
    }
    const p = v as { input: number; output: number }
    if (!Number.isFinite(p.input) || !Number.isFinite(p.output) || p.input < 0 || p.output < 0) {
      throw new DomainError('INVALID_INPUT', 'pricing 必须是非负有限数')
    }
    out.pricing = { input: p.input, output: p.output }
  }

  if ('modelFilter' in input) {
    const v = input.modelFilter
    if (typeof v !== 'string') {
      throw new DomainError('INVALID_INPUT', 'modelFilter 必须是字符串')
    }
    // 正则必须是合法的，否则会在 /models 时抛错。
    try {
      new RegExp(v)
    } catch {
      throw new DomainError('INVALID_INPUT', `modelFilter 不是合法正则：${v}`)
    }
  }

  return out
}

/**
 * provider 配置注册表。
 *
 * 只保存**已允许覆盖**的字段，与预设合并后才交给适配器。
 * 密钥永远**不**进入这个表。
 */
export class ProviderConfigStore {
  private overrides = new Map<string, Partial<ProviderConfig>>()
  private loaded = false

  /**
   * @param persistPath 覆盖配置的持久化文件。省略则不持久化（测试 / 内存用途）。
   *
   * 为什么要持久化：用户把 baseUrl 改成代理地址、改价格，
   * 重启后丢失意味着「设置看起来生效过，但下次打开就没了」。
   * 那是最让人困惑的一类 bug。
   *
   * 注意：**不存密钥**。密钥只走 SecretStore。
   * 这个文件只装 validateProviderOverrides 允许的字段。
   */
  constructor(
    private readonly secrets: SecretStore,
    private readonly persistPath?: string,
  ) {}

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, unknown>
      for (const [id, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue
        // 落盘内容也走一次校验：文件可能被手工改坏。
        // 校验失败就丢掉这一项，不让整个服务起不来。
        try {
          const validated = validateProviderOverrides(id, value as Record<string, unknown>)
          this.overrides.set(id, validated)
        } catch {
          /* 跳过损坏项 */
        }
      }
    } catch {
      // 文件损坏：视为没有覆盖配置。不抛错——那会让服务完全起不来，
      // 而「配置丢了」是可以用默认值继续工作的降级状态。
    }
  }

  private persist(): void {
    if (!this.persistPath) return
    const obj: Record<string, unknown> = {}
    for (const [id, v] of this.overrides) obj[id] = v
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2), 'utf8')
    } catch {
      // 写失败不影响本次生效：内存里已经改了。
      // 只是下次重启会丢——比让请求失败更合理。
    }
  }

  setOverrides(presetId: string, input: Record<string, unknown>): void {
    this.ensureLoaded()
    const validated = validateProviderOverrides(presetId, input)

    // baseUrl 覆盖必须过端点策略（审计二轮 P1-3）：
    // 否则一次 PUT 就能把带 key 的请求指向内网。
    if (validated.baseUrl) {
      const check = validateProviderEndpoint(validated.baseUrl)
      if (!check.ok) {
        throw new DomainError('INVALID_INPUT', check.reason ?? 'baseUrl 不被允许')
      }
    }
    const merged = { ...(this.overrides.get(presetId) ?? {}), ...validated }
    this.overrides.set(presetId, merged)
    this.persist()
  }

  getOverrides(presetId: string): Partial<ProviderConfig> | undefined {
    this.ensureLoaded()
    return this.overrides.get(presetId)
  }

  clear(presetId: string): void {
    this.ensureLoaded()
    this.overrides.delete(presetId)
    this.persist()
  }

  /**
   * 解析出可用于一次调用的 provider 配置。
   *
   * @param requestKey 单次请求携带的密钥。只用于这次调用，不写回任何地方。
   */
  resolve(presetId: string, requestKey?: string): ProviderConfig {
    this.ensureLoaded()
    const preset = presetFor(presetId)
    if (!preset) throw new DomainError('NOT_FOUND', `未知服务商：${presetId}`)

    // 单次请求密钥 > 存储密钥。但**都**只是这次调用的输入。
    const key = requestKey ?? this.secrets.get(presetId)

    return providerFromPreset(presetId, key, this.overrides.get(presetId) ?? {})
  }

  /**
   * 对外展示的 provider 摘要。
   *
   * 关键：**没有 apiKey 字段**。客户端只需要知道「有没有配」。
   */
  describe(presetId: string): {
    id: string
    name: string
    protocol: string
    baseUrl: string
    requiresKey: boolean
    hasKey: boolean
    overrides: Partial<ProviderConfig>
  } {
    this.ensureLoaded()
    const preset = presetFor(presetId)
    if (!preset) throw new DomainError('NOT_FOUND', `未知服务商：${presetId}`)
    const overrides = this.overrides.get(presetId) ?? {}
    return {
      id: preset.id,
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: overrides.baseUrl ?? preset.baseUrl,
      requiresKey: preset.requiresKey,
      hasKey: this.secrets.has(presetId),
      overrides,
    }
  }
}

/** 为数据目录生成默认密钥文件路径。 */
export function defaultSecretsPath(dataDir: string): string {
  return join(dataDir, 'provider-secrets.json')
}

