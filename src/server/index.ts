// 进程入口。只做三件事：读配置 → 建服务 → 监听。
// 所有可测试的逻辑都在 app.ts 里，这里的代码不参与单元测试。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createWorkstationServer } from './app.js'
import { resolveToken, isLoopbackHost } from './auth.js'

const PORT = Number(process.env.PORT ?? 4780)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.ai-workstation')
const WORKSPACE = process.env.WORKSPACE ?? join(DATA_DIR, 'workspace')

// ── 监听地址的安全约束 ───────────────────────────────────
//
// 默认只允许 loopback。要监听非 loopback 必须同时满足：
//   1. 显式设置 HOST；
//   2. 显式提供 AUTH_TOKEN。
//
// 为什么不允许「非 loopback + 自动生成的 token」：
// 自动生成的 token 存在本机文件里，用户根本不知道它是什么，
// 结果就是一个没有人能登录、但确实暴露在局域网上的服务。
// 更糟的是用户会以为「我能用就说明有认证」，而实际上他可能是
// 从别处抄来了 token 文件。这种模糊状态必须拒绝。
const envToken = process.env.AUTH_TOKEN
const loopback = isLoopbackHost(HOST)

if (!loopback && !envToken) {
  console.error(
    `[拒绝启动] HOST=${HOST} 不是 loopback 地址，但没有配置 AUTH_TOKEN。\n` +
    '  允许非本机访问时必须显式提供认证凭据。\n' +
    '  如果只是本机使用，请去掉 HOST 或设为 127.0.0.1。',
  )
  process.exit(1)
}

const auth = resolveToken(DATA_DIR, envToken)

const ws = await createWorkstationServer({
  port: PORT,
  host: HOST,
  dataDir: DATA_DIR,
  workspace: WORKSPACE,
  auth,
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 5 * 60_000),
  maxCycles: Number(process.env.MAX_CYCLES ?? 3),
})

const actualPort = await ws.listen()

console.log('AI 工作站已启动')
console.log(`  接口      http://${HOST}:${actualPort}`)
console.log(`  构建      ${ws.build.version} @ ${ws.build.commit.slice(0, 7)}`)
console.log(`  schema    v${ws.build.schemaVersion}`)
console.log(`  数据目录  ${DATA_DIR}`)
console.log(`  工作区    ${WORKSPACE}`)
if (auth.source === 'generated') {
  console.log(`  认证      token 已生成，保存在 ${join(DATA_DIR, 'auth-token')}`)
} else if (auth.source === 'file') {
  console.log(`  认证      使用已有的 token 文件`)
} else {
  console.log(`  认证      使用 AUTH_TOKEN 环境变量`)
}
// 绝不打印 token 本身——日志会被转发、截图、贴进 issue。

process.on('SIGINT', () => {
  void ws.close().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void ws.close().then(() => process.exit(0))
})

export { ws }
