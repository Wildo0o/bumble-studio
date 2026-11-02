// 第四组（审计二轮 P1）：Provider / MCP 安全。
//
// 三件事：
//   1. provider baseUrl override 必须走统一 endpoint policy
//      （否则可以把 API key 发到内网地址）
//   2. requiresKey=true 且没有 key 时必须在本地拒绝，不发未认证请求
//   3. MCP 失败路径不能留下 pending waiter（unhandled rejection）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderConfigStore, SecretStore } from '../provider-config.js'
import { validateProviderEndpoint, assertProviderUsable } from '../provider-config.js'
import { isPrivateHost } from '../mcp.js'
import { InMemoryLeaseStore } from '../runner.js'
import { isolateProviderEnv } from './test-env.js'

describe('provider 端点策略（审计二轮）', () => {
  let dir: string
  let restoreEnv: () => void

  beforeEach(() => {
    restoreEnv = isolateProviderEnv()
    dir = mkdtempSync(join(tmpdir(), 'ws-ep-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    restoreEnv()
  })

  it('拒绝把 baseUrl 覆盖成回环地址', () => {
    const r = validateProviderEndpoint('https://127.0.0.1:8080/v1')
    expect(r.ok).toBe(false)
  })

  it('拒绝私网地址', () => {
    for (const url of [
      'https://10.0.0.5/v1',
      'https://192.168.1.1/v1',
      'https://172.16.0.1/v1',
    ]) {
      expect(validateProviderEndpoint(url).ok, `${url} 应被拒绝`).toBe(false)
    }
  })

  it('拒绝 link-local / 云元数据地址', () => {
    expect(validateProviderEndpoint('https://169.254.169.254/latest').ok).toBe(false)
    expect(validateProviderEndpoint('https://metadata.google.internal/').ok).toBe(false)
  })

  it('允许公网 https 地址', () => {
    expect(validateProviderEndpoint('https://api.example.com/v1').ok).toBe(true)
  })

  it('拒绝非 http(s)', () => {
    expect(validateProviderEndpoint('file:///etc/passwd').ok).toBe(false)
  })

  it('URL 里带凭据被拒绝（会进日志）', () => {
    expect(validateProviderEndpoint('https://user:pw@api.example.com/v1').ok).toBe(false)
  })

  it('覆盖成内网地址在 setOverrides 阶段就被拒绝', () => {
    const secrets = new SecretStore(join(dir, 's.json'))
    const cfg = new ProviderConfigStore(secrets)
    expect(() => cfg.setOverrides('openai', { baseUrl: 'https://127.0.0.1:9000/v1' }))
      .toThrow()
  })

  it('requiresKey 但没 key → 本地拒绝，不发出请求', () => {
    const secrets = new SecretStore(join(dir, 's.json'))
    const cfg = new ProviderConfigStore(secrets)
    // openai requiresKey = true，且我们清空了环境变量与文件
    expect(() => assertProviderUsable(cfg.resolve('openai'))).toThrow(/密钥/)
  })

  it('有 key 时通过检查', () => {
    const secrets = new SecretStore(join(dir, 's.json'))
    secrets.set('openai', 'sk-test-key-value')
    const cfg = new ProviderConfigStore(secrets)
    expect(() => assertProviderUsable(cfg.resolve('openai'))).not.toThrow()
  })

  it('不需要 key 的 provider（demo）不要求密钥', () => {
    const secrets = new SecretStore(join(dir, 's.json'))
    const cfg = new ProviderConfigStore(secrets)
    expect(() => assertProviderUsable(cfg.resolve('demo'))).not.toThrow()
  })
})

describe('MCP 失败路径不留 pending（审计二轮）', () => {
  it('close 后 pending 全部 reject，不产生 unhandled rejection', async () => {
    const { McpClient } = await import('../mcp.js')
    const client = new McpClient({
      id: 'never',
      name: 'never',
      // 一个永远不响应的命令：connect 会挂住，正好用来验证 close 清理
      transport: { kind: 'stdio', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      timeoutMs: 60_000,
    })

    const pending = client.connect()
    // 不等它完成，直接关闭
    await new Promise((r) => setTimeout(r, 100))
    await client.close()

    // pending 必须被 reject（否则是 unhandled rejection）
    await expect(pending).rejects.toThrow()
  })

  it('isPrivateHost 覆盖常见内网形式', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', 'localhost', '::1', 'fd00::1']) {
      expect(isPrivateHost(h), `${h} 应判为私网`).toBe(true)
    }
    expect(isPrivateHost('api.example.com')).toBe(false)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
  })
})

describe('租约存储不受 provider 改动影响（回归）', () => {
  it('InMemoryLeaseStore 仍可用', () => {
    const s = new InMemoryLeaseStore()
    expect(s.tryAcquire('k', 'o', 1000, 0)).toBeDefined()
  })
})
