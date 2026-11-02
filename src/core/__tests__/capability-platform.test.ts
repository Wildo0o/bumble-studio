// 能力平台（区块 2）的契约测试。
//
// 覆盖四块：
//   1. Skill 注册表 + manifest 校验
//   2. 能力目录（模型能力 / 工具能力 / 需求检查）
//   3. 密钥与 provider 配置边界
//   4. 本地模型与图像能力的 fail-closed 判定
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRegistry, type SkillManifest } from '../skill-registry.js'
import type { AuditSkill, ToolDefinition } from '../../shared/types.js'
import {
  assertRequirements,
  checkRequirements,
  capabilitySnapshot,
  modelSupports,
  profiledProviderIds,
  requirementForSkill,
  resolveModelCapabilities,
} from '../capability-catalog.js'
import { ToolRegistry } from '../tools.js'
import { DomainError } from '../errors.js'
import {
  PROVIDER_PROTECTED_FIELDS,
  ProviderConfigStore,
  SecretStore,
  envKeyName,
  validateProviderOverrides,
} from '../provider-config.js'
import {
  ImageCapabilityRegistry,
  assertLocalModel,
  clampImageCount,
  isLoopbackBaseUrl,
  isTrustedLocalModel,
  validateImageRequest,
} from '../media.js'
import { safeBaseEnv, isPrivateHost, validateMcpHttpEndpoint } from '../mcp.js'
import { isolateProviderEnv } from './test-env.js'

// ── 测试夹具 ──────────────────────────────────────────────

function makeSkill(id: string, version = '1'): AuditSkill {
  return {
    id,
    version,
    name: id,
    machineRules: [],
    auditorInstructions: '审一下',
    maxCycles: 2,
  }
}

function makeManifest(id: string, version = '1', over: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id,
    version,
    name: id,
    description: `${id} skill`,
    requiredTools: [],
    requiredCapabilities: [],
    appliesTo: [],
    requiresHumanAttention: false,
    ...over,
  }
}

function tool(over: Partial<ToolDefinition> & Pick<ToolDefinition, 'id'>): ToolDefinition {
  return {
    name: over.id,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    reconcile: { idempotent: true, unsafeToRetry: false },
    ...over,
  }
}

// ── 1. Skill 注册表 ───────────────────────────────────────

describe('Skill 注册表', () => {
  it('按 id@version 查找', () => {
    const r = new SkillRegistry()
    r.register(makeManifest('quality'), makeSkill('quality'))
    expect(r.get('quality', '1')?.skill.id).toBe('quality')
    expect(r.get('quality', '2')).toBeUndefined()
  })

  it('manifest 与 skill 的 id 不一致时拒绝注册', () => {
    const r = new SkillRegistry()
    expect(() => r.register(makeManifest('a'), makeSkill('b'))).toThrow(/id 不一致/)
  })

  it('manifest 与 skill 的 version 不一致时拒绝注册', () => {
    const r = new SkillRegistry()
    expect(() => r.register(makeManifest('a', '1'), makeSkill('a', '2'))).toThrow(/版本不一致/)
  })

  it('同 id@version 同内容重复注册是幂等的', () => {
    // 注册表是模块级单例，多个服务实例会重复注册同一个 Skill。
    // 抛错会让「新建一个服务」这种常规操作失败。
    const r = new SkillRegistry()
    r.register(makeManifest('q'), makeSkill('q'))
    expect(() => r.register(makeManifest('q'), makeSkill('q'))).not.toThrow()
    expect(r.size).toBe(1)
  })

  it('同 id@version 不同内容必须拒绝（否则审计无法复现）', () => {
    const r = new SkillRegistry()
    r.register(makeManifest('q'), makeSkill('q'))
    const different = { ...makeSkill('q'), auditorInstructions: '完全不同的指令' }
    expect(() => r.register(makeManifest('q'), different)).toThrow(/已被不同的定义注册/)
  })

  it('latest / versionsOf 按版本排序', () => {
    const r = new SkillRegistry()
    for (const v of ['1.0', '2.0', '1.10', '1.2']) {
      r.register(makeManifest('s', v), makeSkill('s', v))
    }
    expect(r.latest('s')?.manifest.version).toBe('2.0')
    expect(r.versionsOf('s').map((s) => s.manifest.version)).toEqual(['2.0', '1.10', '1.2', '1.0'])
  })

  it('缺少 id / version 时拒绝', () => {
    const r = new SkillRegistry()
    expect(() => r.register(makeManifest(''), makeSkill(''))).toThrow(/id/)
  })
})

// ── 2. 能力目录 ───────────────────────────────────────────

describe('能力目录', () => {
  it('已知 provider + 已知模型族 → 返回能力列表', () => {
    const r = resolveModelCapabilities('openai', 'gpt-4o')
    expect(r.status).toBe('known')
    if (r.status !== 'known') return
    expect(r.model.modelFamily).toBe('openai-gpt')
    expect(r.model.capabilities).toContain('text')
    expect(r.model.capabilities).toContain('vision')
    expect(r.model.local).toBe(false)
  })

  it('provider 与模型族矛盾 → rejected（不是 unknown）', () => {
    const r = resolveModelCapabilities('openai', 'claude-3-5-sonnet')
    // 「知道不对」必须与「不知道」区分开：
    //   rejected → 400（改参数能重试）
    //   unknown  → 503（能力无法确认）
    // 混为一谈会让参数写错的请求被当成瞬时故障而一直重试。
    expect(r.status).toBe('rejected')
    if (r.status === 'rejected') {
      expect(r.reason).toContain('openai')
    }
  })

  it('认不出的模型族 → unknown，不当成全能', () => {
    const r = resolveModelCapabilities('openai', 'totally-unknown-model')
    expect(r.status).toBe('unknown')
    expect(modelSupports('openai', 'totally-unknown-model', 'text')).toBe(false)
  })

  it('本地 provider 声明 local 能力', () => {
    const r = resolveModelCapabilities('ollama', 'llama3')
    expect(r.status).toBe('known')
    if (r.status === 'known') expect(r.model.local).toBe(true)
  })

  it('demo 的能力由代码静态确定（不需要模型族识别）', () => {
    // demo 是本地规则引擎，不是真实模型。它的能力写在 PROVIDER_CAPABILITIES 里，
    // 无法也不应该通过模型名去识别「族」。
    //
    // 早期实现走族识别 → unknown，结果所有用 demo 跑的执行都被能力门挡住。
    // 那是把「规则引擎」误当成「认不出的模型」。
    const r = resolveModelCapabilities('demo', 'demo')
    expect(r.status).toBe('known')
    if (r.status === 'known') {
      expect(r.model.modelFamily).toBe('demo-rule-engine')
      expect(r.model.local).toBe(true)
      // demo 确实不调外部工具，但执行内核会用同一套工具轮次跑它，
      // 所以 tool_calling 必须声明，否则「用 demo 跑一次」会被挡。
      expect(r.model.capabilities).toContain('text')
      expect(r.model.capabilities).toContain('tool_calling')
      // 它不是视觉 / 图像模型
      expect(r.model.capabilities).not.toContain('vision')
      expect(r.model.capabilities).not.toContain('image_generation')
    }
  })

  it('checkRequirements：工具缺失能精确指出', () => {
    const check = checkRequirements({
      providerId: 'openai',
      modelId: 'gpt-4o',
      tools: [tool({ id: 'read_file' })],
      requirement: { tools: ['read_file', 'write_file'] },
    })
    expect(check.ok).toBe(false)
    expect(check.missingTools).toEqual(['write_file'])
  })

  it('checkRequirements：只统计 enabled 的工具', () => {
    const check = checkRequirements({
      providerId: 'openai',
      modelId: 'gpt-4o',
      tools: [tool({ id: 'x', enabled: false })],
      requirement: { tools: ['x'] },
    })
    expect(check.missingTools).toEqual(['x'])
  })

  it('checkRequirements：缺少视觉能力能识别', () => {
    const check = checkRequirements({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      tools: [],
      requirement: { capabilities: ['vision'] },
    })
    expect(check.ok).toBe(false)
    expect(check.missingCapabilities).toContain('vision')
  })

  it('checkRequirements：要求本地但模型在云端 → localViolated', () => {
    const check = checkRequirements({
      providerId: 'openai',
      modelId: 'gpt-4o',
      tools: [],
      requirement: { requireLocal: true },
    })
    expect(check.localViolated).toBe(true)
    expect(check.ok).toBe(false)
  })

  it('checkRequirements：能力未知时一律不通过（fail-closed）', () => {
    const check = checkRequirements({
      providerId: 'openai',
      modelId: 'unknown-model',
      tools: [],
      requirement: { capabilities: ['text'] },
    })
    expect(check.ok).toBe(false)
    expect(check.unknownReason).toBeTruthy()
  })

  it('assertRequirements 抛 CAPABILITY_UNAVAILABLE 并列出缺项', () => {
    let caught: unknown
    try {
      assertRequirements({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        tools: [],
        requirement: { capabilities: ['vision'] },
      })
    } catch (e) {
      caught = e
    }
    const err = caught as DomainError
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('CAPABILITY_UNAVAILABLE')
    expect(err.httpStatus).toBe(503)
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('vision')
  })

  it('requirementForSkill 把 manifest 转成能力要求', () => {
    const req = requirementForSkill(makeManifest('s', '1', {
      requiredTools: ['a'],
      requiredCapabilities: ['vision'],
    }))
    expect(req).toEqual({ tools: ['a'], capabilities: ['vision'] })
  })

  it('capabilitySnapshot 不包含任何密钥字段', () => {
    const snap = capabilitySnapshot([tool({ id: 'x' })], profiledProviderIds())
    const raw = JSON.stringify(snap)
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('secret')
    expect(snap.providers.length).toBe(profiledProviderIds().length)
    // 每个有档案的 provider 都至少声明了 text
    for (const p of snap.providers) {
      if (p.hasProfile) expect(p.capabilities).toContain('text')
    }
  })
})

// ── 3. 内置工具能力声明 ───────────────────────────────────

describe('内置工具的能力声明', () => {
  it('新工具都显式声明 sideEffect 并通过注册校验', () => {
    const r = new ToolRegistry()
    const ids = r.listAll().map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining(['read_file', 'list_dir', 'write_file', 'file_stat', 'search_files', 'append_file']),
    )
    for (const t of r.listAll()) {
      expect(t.sideEffect, `${t.id} 必须显式声明 sideEffect`).toBeDefined()
      // read 级工具不能有副作用
      if (t.riskLevel === 'read') expect(t.sideEffect).toBe('none')
    }
  })

  it('append_file 是非幂等副作用工具：声明了 unsafeToRetry', () => {
    const r = new ToolRegistry()
    const append = r.listAll().find((t) => t.id === 'append_file')!
    expect(append.sideEffect).toBe('filesystem')
    expect(append.reconcile.idempotent).toBe(false)
    expect(append.reconcile.unsafeToRetry).toBe(true)
    expect(append.supportsIdempotencyKey).toBe(false)
  })

  it('只读工具都标记了 cancellable', () => {
    const r = new ToolRegistry()
    for (const t of r.listAll().filter((x) => x.riskLevel === 'read')) {
      expect(t.cancellable, `${t.id} 应可取消`).not.toBe(false)
    }
  })

  it('注册矛盾声明（read + 副作用）会被拒绝', () => {
    const r = new ToolRegistry([])
    expect(() =>
      r.register({
        definition: tool({ id: 'bad', riskLevel: 'read', sideEffect: 'filesystem' }),
        run: async () => ({ ok: true, content: '' }),
      }),
    ).toThrow(/矛盾/)
  })
})

// ── 4. 密钥与 provider 配置边界 ───────────────────────────

describe('密钥与 provider 配置边界', () => {
  let dir: string
  let store: SecretStore
  let restoreEnv: () => void

  beforeEach(() => {
    // 清掉真实的 provider 密钥环境变量。
    //
    // 不做这一步的话，开发者本机有 ANTHROPIC_API_KEY 时
    // `store.has('anthropic')` 会返回 true，测试失败——
    // 而那说明的是「这台机器配了密钥」，不是「代码错了」。
    // 这种失败比没有测试更糟：它教人忽略红色。
    restoreEnv = isolateProviderEnv()
    dir = mkdtempSync(join(tmpdir(), 'ws-secrets-'))
    store = new SecretStore(join(dir, 'secrets.json'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    restoreEnv()
  })

  it('env 变量名映射正确', () => {
    expect(envKeyName('openai')).toBe('OPENAI_API_KEY')
    expect(envKeyName('open-router')).toBe('OPEN_ROUTER_API_KEY')
  })

  it('写入后可读；has() 只回答有没有', () => {
    store.set('openai', 'sk-test-123')
    expect(store.get('openai')).toBe('sk-test-123')
    expect(store.has('openai')).toBe(true)
    expect(store.has('anthropic')).toBe(false)
  })

  it('密钥文件权限被收紧（POSIX）', () => {
    const file = join(dir, 'secrets.json')
    store.set('openai', 'k')
    expect(existsSync(file)).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('密钥文件内容不包含其他敏感信息，只存键值', () => {
    store.set('openai', 'k1')
    const raw = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>
    expect(raw).toEqual({ openai: 'k1' })
  })

  it('环境变量优先于文件', () => {
    store.set('openai', 'from-file')
    process.env.OPENAI_API_KEY = 'from-env'
    try {
      expect(store.get('openai')).toBe('from-env')
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })

  it('损坏的密钥文件被当成「没有密钥」，而不是让服务崩溃', () => {
    const file = join(dir, 'secrets.json')
    require('node:fs').writeFileSync(file, '{ not json', 'utf8')
    const s2 = new SecretStore(file)
    expect(s2.get('openai')).toBeUndefined()
  })

  it('受保护字段一律拒绝覆盖', () => {
    for (const field of PROVIDER_PROTECTED_FIELDS) {
      expect(() => validateProviderOverrides('openai', { [field]: 'x' })).toThrow(DomainError)
    }
  })

  it('允许覆盖 baseUrl / pricing 等非安全字段', () => {
    const out = validateProviderOverrides('openai', {
      baseUrl: 'https://proxy.example/v1',
      pricing: { input: 1, output: 2 },
    })
    expect(out.baseUrl).toBe('https://proxy.example/v1')
    expect(out.pricing).toEqual({ input: 1, output: 2 })
  })

  it('非法 baseUrl 被拒绝（必须是 http(s)）', () => {
    expect(() => validateProviderOverrides('openai', { baseUrl: 'file:///etc/passwd' })).toThrow(/http/)
  })

  it('非法正则 modelFilter 被拒绝', () => {
    expect(() => validateProviderOverrides('openai', { modelFilter: '(' })).toThrow(/正则/)
  })

  it('未知字段被拒绝（不能偷偷加参数）', () => {
    expect(() => validateProviderOverrides('openai', { apiEndpoint: 'x' })).toThrow(/不接受字段/)
  })

  it('未知 provider 返回 NOT_FOUND', () => {
    let caught: unknown
    try {
      validateProviderOverrides('nope', {})
    } catch (e) {
      caught = e
    }
    expect((caught as DomainError).code).toBe('NOT_FOUND')
  })

  it('describe 不返回密钥值，只返回 hasKey', () => {
    const cfg = new ProviderConfigStore(store)
    store.set('openai', 'sk-secret-value')
    const desc = cfg.describe('openai')
    expect(JSON.stringify(desc)).not.toContain('sk-secret-value')
    expect(desc.hasKey).toBe(true)
    expect(desc.requiresKey).toBe(true)
  })

  it('单次请求携带的密钥不写回存储', () => {
    const cfg = new ProviderConfigStore(store)
    const resolved = cfg.resolve('openai', 'sk-one-off')
    expect(resolved.apiKey).toBe('sk-one-off')
    // 存储里仍然没有
    expect(store.has('openai')).toBe(false)
  })
})

// ── 5. 本地模型与图像 ─────────────────────────────────────

describe('本地模型判定', () => {
  it('只认回环地址', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://localhost:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:8080')).toBe(true)
    expect(isLoopbackBaseUrl('http://192.168.1.10:11434/v1')).toBe(false)
    expect(isLoopbackBaseUrl('http://0.0.0.0:11434')).toBe(false)
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('预设本地 + 回环地址 → 本地', () => {
    expect(isTrustedLocalModel('ollama', 'http://127.0.0.1:11434/v1')).toBe(true)
  })

  it('预设本地但 baseUrl 指向远端 → 不是本地（用户覆盖了地址）', () => {
    expect(isTrustedLocalModel('ollama', 'https://evil.example/v1')).toBe(false)
  })

  it('云端 provider 即使 baseUrl 写回环也不是本地（可能是转发代理）', () => {
    expect(isTrustedLocalModel('openai', 'http://127.0.0.1:8080/v1')).toBe(false)
  })

  it('assertLocalModel 不满足时抛 CAPABILITY_UNAVAILABLE，不静默降级', () => {
    expect(() => assertLocalModel('openai', 'https://api.openai.com/v1')).toThrow(DomainError)
    expect(() => assertLocalModel('ollama', 'http://127.0.0.1:11434/v1')).not.toThrow()
  })
})

describe('图像能力', () => {
  it('只有声明 + 适配器同时存在才可用', () => {
    const r = new ImageCapabilityRegistry()
    r.declare('openai')
    expect(r.isAvailable('openai'), '只有声明没有实现时不可用').toBe(false)

    r.register({ providerId: 'openai', generate: async () => [] })
    expect(r.isAvailable('openai')).toBe(true)
  })

  it('只有实现没有声明也不可用', () => {
    const r = new ImageCapabilityRegistry()
    r.register({ providerId: 'x', generate: async () => [] })
    expect(r.isAvailable('x')).toBe(false)
    expect(r.available()).toEqual([])
    expect(() => r.get('x')).toThrow(DomainError)
  })

  it('张数由服务端夹紧', () => {
    expect(clampImageCount(undefined)).toBe(1)
    expect(clampImageCount(0)).toBe(1)
    expect(clampImageCount(99)).toBe(4)
    expect(clampImageCount(2)).toBe(2)
  })

  it('validateImageRequest 校验 prompt / size / n', () => {
    expect(validateImageRequest({ prompt: '画一只猫' })).toEqual({ prompt: '画一只猫' })
    expect(() => validateImageRequest({ prompt: '' })).toThrow(/非空/)
    expect(() => validateImageRequest({ prompt: 'x'.repeat(5000) })).toThrow(/上限/)
    expect(() => validateImageRequest({ prompt: 'a', size: 'big' })).toThrow(/1024x1024/)
    expect(() => validateImageRequest({ prompt: 'a', n: 0 })).toThrow(/>=\s*1/)
  })
})

// ── 6. MCP 环境隔离 ───────────────────────────────────────

describe('MCP HTTP SSRF 防护', () => {
  it('默认拒绝回环 / 私网 / 链路本地 / 元数据地址', () => {
    for (const url of [
      'http://127.0.0.1:8080/mcp',
      'http://localhost/mcp',
      'http://10.0.0.5/mcp',
      'http://192.168.1.1/mcp',
      'http://172.16.0.1/mcp',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/',
      'http://[::1]/mcp',
      'http://[fd00::1]/mcp',
      'http://100.64.0.1/mcp',
    ]) {
      const r = validateMcpHttpEndpoint(url)
      expect(r.ok, `${url} 应被拒绝`).toBe(false)
    }
  })

  it('公网地址放行', () => {
    for (const url of ['https://mcp.example.com/rpc', 'http://8.8.8.8:9000/mcp']) {
      expect(validateMcpHttpEndpoint(url).ok).toBe(true)
    }
  })

  it('显式允许私网时放行（本地 MCP server 场景）', () => {
    expect(validateMcpHttpEndpoint('http://127.0.0.1:9001/mcp', { allowPrivateNetwork: true }).ok).toBe(true)
  })

  it('拒绝非 http(s) 协议', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x/y', 'gopher://x:70/']) {
      expect(validateMcpHttpEndpoint(url).ok).toBe(false)
    }
  })

  it('拒绝 URL 里带凭据（会进日志）', () => {
    const r = validateMcpHttpEndpoint('https://user:pass@mcp.example.com/rpc')
    expect(r.ok).toBe(false)
  })

  it('isPrivateHost 对 IPv4-mapped IPv6 也生效', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:10.1.2.3')).toBe(true)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })
})

describe('MCP 子进程环境', () => {
  it('只透传启动所必需的环境变量，不继承 API 密钥', () => {
    process.env.MY_SECRET_API_KEY = 'should-not-leak'
    try {
      const env = safeBaseEnv()
      expect(env.MY_SECRET_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      // 至少要有 PATH 才能启动任何程序
      expect(env.PATH ?? env.Path).toBeTruthy()
    } finally {
      delete process.env.MY_SECRET_API_KEY
    }
  })
})
