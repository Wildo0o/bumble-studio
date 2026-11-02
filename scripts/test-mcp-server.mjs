#!/usr/bin/env node
// 最小 MCP server（stdio / JSON-RPC 2.0），仅用于联调测试。
//
// 为什么自己写一个而不是装官方 SDK：
//   · 目标不是「支持 MCP 全家桶」，而是**证明我们的客户端能和真实
//     协议实现通信**。用 SDK 会顺带把服务端的行为也测进来。
//   · 这个实现刻意只依赖协议本身，所以它一旦和我们的客户端对不上，
//     问题一定出在我们的客户端。
//
// 实现内容（MCP 2024-11-05 的最小子集）：
//   initialize   → 握手，返回 protocolVersion 与 capabilities
//   tools/list   → 返回两个工具：echo（只读）、write_side_effect（有副作用）
//   tools/call   → 执行工具，返回 content 数组
//   notifications/initialized → 无 id，忽略
//
// 行为要点（这些正是客户端需要正确处理的地方）：
//   · 响应必须**一行 JSON**（客户端按换行分隔解析）
//   · 未知方法返回 JSON-RPC error，而不是静默忽略
//   · 工具执行失败返回 isError: true 而不是抛协议错误

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line) handleLine(line)
  }
})

function send(obj) {
  // 必须单行：客户端按换行切分消息
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handleLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  // 通知（没有 id）不需要响应
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'notifications/initialized') return
    return
  }

  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
        },
      })
      return

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: '原样返回输入文本',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
              // 声明只读：客户端只有在本地 allowlist 也认可时才会降级为只读
              annotations: { readOnlyHint: true },
            },
            {
              name: 'write_side_effect',
              description: '一个会产生外部副作用的工具（测试用）',
              inputSchema: {
                type: 'object',
                properties: { target: { type: 'string' } },
                required: ['target'],
              },
              annotations: { destructiveHint: true },
            },
            {
              name: 'fail_always',
              description: '总是返回错误（测试错误传递）',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })
      return

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}

      if (name === 'echo') {
        const text = typeof args.text === 'string' ? args.text : ''
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `echo:${text}` }] },
        })
        return
      }

      if (name === 'write_side_effect') {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `wrote:${args.target ?? ''}` }] },
        })
        return
      }

      if (name === 'fail_always') {
        // 注意：工具失败是 **isError: true**，不是 JSON-RPC error。
        // 这是 MCP 的约定——协议错误和应用错误必须分开。
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'boom' }],
            isError: true,
          },
        })
        return
      }

      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        },
      })
      return
    }

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} })
      return

    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
  }
}

process.stdin.on('end', () => process.exit(0))
