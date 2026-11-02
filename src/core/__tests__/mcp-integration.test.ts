// MCP 真实联调（P1-12 收口）。
//
// 审计指出：MCP 只有「辅助函数测试」，没有真实协议调用。
// 这一组用一个**真实子进程 MCP server**（scripts/test-mcp-server.mjs）
// 验证完整链路：
//
//   客户端 connect（stdio 握手）
//     → tools/list 解析
//     → 能力映射（默认 external，双重确认才降级只读）
//     → tools/call 成功与失败
//     → 工具注册进 ToolRegistry，执行链真的能调到
//
// 这些是单元测试看不见的：握手顺序、单行 JSON 分帧、
// JSON-RPC 协议错误与工具错误的区分。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpClient, McpManager, type McpServerConfig } from '../mcp.js'
import { ToolRegistry, mcpToolImpl } from '../tools.js'
import { DomainError } from '../errors.js'

const SERVER = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'test-mcp-server.mjs')

function stdioConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'test',
    name: 'Test MCP',
    transport: { kind: 'stdio', command: process.execPath, args: [SERVER] },
    timeoutMs: 10_000,
    ...over,
  }
}

describe('MCP 真实协议联调（stdio）', () => {
  let client: McpClient | undefined

  afterEach(async () => {
    await client?.close()
    client = undefined
  })

  it('完成 initialize 握手并列出工具', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()

    const tools = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail_always', 'write_side_effect'])
    // 工具 id 带 server 前缀，避免跨 server 冲突
    expect(tools.every((t) => t.id.startsWith('test:'))).toBe(true)
    expect(tools.every((t) => t.source === 'mcp')).toBe(true)
    expect(tools.every((t) => t.serverId === 'test')).toBe(true)
  })

  it('调用真实工具并拿到内容', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()

    const result = await client.callTool('echo', { text: '你好' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('echo:你好')
  })

  it('工具级失败返回 isError 而不是抛协议错误', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()

    const result = await client.callTool('fail_always', {})
    // MCP 约定：应用错误是 isError: true，协议层仍成功
    expect(result.ok).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('boom')
  })

  it('批量调用不会因分帧问题错位', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()

    // 并发 5 个调用：验证「按行解析 + id 匹配」的正确性。
    // 若实现假设「一个 chunk = 一条消息」，这里会错位。
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => client!.callTool('echo', { text: String(i) })),
    )
    expect(results.map((r) => r.content)).toEqual(['echo:0', 'echo:1', 'echo:2', 'echo:3', 'echo:4'])
  })

  // ── 能力映射（安全关键）─────────────────────────────

  it('未在本地 allowlist 里的只读工具仍按 external 处理', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()
    const tools = await client.listTools()

    const echo = tools.find((t) => t.name === 'echo')!
    // server 声明 readOnlyHint，但本地没认可 → 仍需审批
    expect(echo.riskLevel).toBe('external')
    expect(echo.sideEffect).toBe('external')
  })

  it('server 声明 + 本地 allowlist 双重确认后才降级为只读', async () => {
    client = new McpClient(stdioConfig({ trustedReadOnlyTools: ['echo'] }))
    await client.connect()
    const tools = await client.listTools()

    const echo = tools.find((t) => t.name === 'echo')!
    expect(echo.riskLevel).toBe('read')
    expect(echo.sideEffect).toBe('none')
  })

  it('声明 destructiveHint 的工具即使进了 allowlist 也不降级', async () => {
    client = new McpClient(stdioConfig({ trustedReadOnlyTools: ['write_side_effect'] }))
    await client.connect()
    const tools = await client.listTools()

    const w = tools.find((t) => t.name === 'write_side_effect')!
    expect(w.riskLevel).toBe('external')
  })

  it('MCP 工具一律不可取消、不支持幂等键（无法验证）', async () => {
    client = new McpClient(stdioConfig())
    await client.connect()
    for (const t of await client.listTools()) {
      expect(t.cancellable).toBe(false)
      expect(t.supportsIdempotencyKey).toBe(false)
      expect(t.reconcile.unsafeToRetry).toBe(true)
    }
  })
})

describe('MCP 接入执行链', () => {
  it('桥接后的工具能被 ToolRegistry 注册并执行', async () => {
    const client = new McpClient(stdioConfig())
    await client.connect()

    try {
      const tools = await client.listTools()
      // 空注册表：只装 MCP 工具，避免内置工具干扰断言
      const registry = new ToolRegistry([])

      for (const def of tools) {
        registry.register(mcpToolImpl(def, (name, args) => client.callTool(name, args)))
      }

      // 注册成功（含能力声明校验）
      expect(registry.listAll().map((t) => t.name).sort()).toEqual([
        'echo',
        'fail_always',
        'write_side_effect',
      ])

      // 真正执行
      const echoImpl = registry.listAll().find((t) => t.name === 'echo')!
      expect(echoImpl.sideEffect).toBe('external')

      const ctx = {
        workspaceRoots: ['/tmp'],
        signal: new AbortController().signal,
      }
      const result = await registry.get('test:echo')!.run({ text: 'x' }, ctx)
      expect(result.ok).toBe(true)
      expect(result.content).toBe('echo:x')
    } finally {
      await client.close()
    }
  })

  it('工具执行失败被包装成 ok:false，而不是抛出', async () => {
    const client = new McpClient(stdioConfig())
    await client.connect()
    try {
      const tools = await client.listTools()
      const def = tools.find((t) => t.name === 'fail_always')!
      const registry = new ToolRegistry()
      registry.register(mcpToolImpl(def, (name, args) => client.callTool(name, args)))

      const result = await registry.get('test:fail_always')!.run({}, {
        workspaceRoots: ['/tmp'],
        signal: new AbortController().signal,
      })
      expect(result.ok).toBe(false)
      expect(result.isError).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('连接失败的工具调用返回明确错误（不挂死）', async () => {
    const client = new McpClient({
      id: 'dead',
      name: 'Dead',
      // 一个必然启动失败的命令
      transport: { kind: 'stdio', command: 'definitely-not-a-real-command-xyz' },
      timeoutMs: 3000,
    })

    await expect(client.connect()).rejects.toThrow()
    await client.close()
  })
})

describe('McpManager 联调', () => {
  it('connectAll 返回工具，且失败的 server 不影响其他', async () => {
    const good = stdioConfig()
    const bad: McpServerConfig = {
      id: 'broken',
      name: 'Broken',
      transport: { kind: 'stdio', command: 'definitely-not-a-real-command-xyz' },
      timeoutMs: 2000,
    }

    const manager = new McpManager([good, bad])
    try {
      const tools = await manager.connectAll()
      // 好的 server 的工具都拿到了
      expect(tools.length).toBe(3)
      expect(tools.every((t) => t.serverId === 'test')).toBe(true)

      // 坏的 server 被记录，但没有让整体失败
      const errors = manager.listErrors()
      expect(errors.some((e) => e.serverId === 'broken')).toBe(true)

      const servers = manager.listServers()
      expect(servers.find((s) => s.id === 'test')!.connected).toBe(true)
      expect(servers.find((s) => s.id === 'broken')!.connected).toBe(false)
    } finally {
      await manager.closeAll()
    }
  })

  it('子进程环境白名单生效：MCP server 拿不到宿主密钥', async () => {
    // 用一个会打印环境变量的 server 太复杂，这里直接验证 safeBaseEnv 契约
    // （真实隔离已在 capability-platform.test 覆盖）
    const { safeBaseEnv } = await import('../mcp.js')
    process.env.LEAKY_SECRET = 'should-not-pass'
    try {
      expect(safeBaseEnv().LEAKY_SECRET).toBeUndefined()
    } finally {
      delete process.env.LEAKY_SECRET
    }
  })
})

describe('MCP HTTP 传输（本地回环 + 显式放行）', () => {
  let dir: string
  let server: import('node:http').Server | undefined
  let port = 0

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-http-'))
    const { createServer } = await import('node:http')
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const msg = JSON.parse(body)
        let result: unknown = {}
        if (msg.method === 'initialize') {
          result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
        } else if (msg.method === 'tools/list') {
          result = {
            tools: [{ name: 'remote_echo', description: 'r', inputSchema: { type: 'object', properties: {} } }],
          }
        } else if (msg.method === 'tools/call') {
          result = { content: [{ type: 'text', text: 'remote-ok' }] }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>((r) => server!.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('未显式允许私网时拒绝连接回环地址', async () => {
    const client = new McpClient({
      id: 'http',
      name: 'HTTP',
      transport: { kind: 'http', url: `http://127.0.0.1:${port}/mcp` },
      timeoutMs: 5000,
    })
    // SSRF 防护：默认禁止回环
    await expect(client.connect()).rejects.toThrow(DomainError)
  })

  it('显式 allowPrivateNetwork 后能真实完成 HTTP 握手与调用', async () => {
    const client = new McpClient({
      id: 'http',
      name: 'HTTP',
      allowPrivateNetwork: true,
      transport: { kind: 'http', url: `http://127.0.0.1:${port}/mcp` },
      timeoutMs: 5000,
    })
    try {
      await client.connect()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['remote_echo'])
      const result = await client.callTool('remote_echo', {})
      expect(result.content).toBe('remote-ok')
    } finally {
      await client.close()
    }
  })
})
