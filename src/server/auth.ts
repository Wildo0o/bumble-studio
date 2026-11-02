// HTTP 控制面的认证。
//
// 威胁模型（必须写下来，否则「有认证」会被误读成「安全」）：
//
//   1. 浏览器里的恶意页面 —— 目标是让用户浏览器替它发控制请求（CSRF）。
//      防线：bearer token 不在 cookie 里，浏览器无法自动携带；再加 Origin 校验。
//   2. 同机的其他进程 —— 目标是直接调 127.0.0.1 上的接口。
//      防线：token 存在 0600 文件里，只有同一用户能读。
//      **localhost 不是认证机制**：任何本机进程都能连 127.0.0.1。
//      本模型只假设「同一 OS 用户下的进程是可信的」。
//   3. 局域网/互联网 —— 默认只监听 loopback，非 loopback 必须显式配置 token。
//
// 明确不在威胁模型内：
//   - 以同一 OS 用户身份运行的恶意程序（它能读 token 文件，认证挡不住）
//   - 内存转储、调试器附加
//   - 物理接触
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'

/** 生成 256 位随机 token（base64url，43 字符）。 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 恒定时间比较。
 *
 * 为什么先哈希：`timingSafeEqual` 要求两个 Buffer 等长，
 * 长度不等会直接抛错——那就等于用异常泄露了「长度对不对」。
 * 先各自 sha256（永远 32 字节），长度信息被抹掉。
 */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * 从 Authorization 头解析 bearer token。
 *
 * 只接受 `Bearer <token>`，大小写不敏感地匹配方案名。
 * 不接受 query string、cookie、自定义头——只留一条路径，减少绕过面。
 */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ ]+([A-Za-z0-9_\-.~+/=]{16,})$/.exec(header.trim())
  return m ? m[1]! : null
}

/** token 文件路径。放在数据目录下。 */
export function tokenFilePath(dataDir: string): string {
  return join(dataDir, 'auth-token')
}

/**
 * 把 token 文件的访问权限收紧到「只有当前用户」。
 *
 * 为什么不能用 `writeFileSync(..., { mode: 0o600 })`：
 *
 *   **Windows 上 mode 只映射到「只读」标志位，不改写 ACL。**
 *   新建文件继承父目录的 ACL，典型结果是
 *       BUILTIN\Users:(I)(RX)               ← 所有用户可读
 *       NT AUTHORITY\Authenticated Users:(I)(M)
 *   也就是说 0o600 在 Windows 上**完全没有效果**，
 *   而同机任何用户都能读走 token —— 认证的实际强度取决于这个文件。
 *
 * 所以必须：
 *   1. 移除继承（/inheritance:r），否则父目录的宽松 ACL 会继续生效
 *   2. 只授予当前用户完全控制
 *   3. SYSTEM / Administrators 保留（它们本来就能绕过任何文件权限）
 *
 * POSIX 上 chmod 0600 就够了。
 *
 * 失败时**抛错**而不是吞掉：一个「以为受保护、实际没有」的 token 文件
 * 比一个明确报错的服务危险得多。
 */
export function protectTokenFile(file: string): void {
  if (process.platform !== 'win32') {
    chmodSync(file, 0o600)
    // 校验真的生效了——某些文件系统（FAT、部分网络挂载）会忽略 chmod
    const mode = statSync(file).mode & 0o777
    if (mode & 0o077) {
      throw new Error(`token 文件权限收紧失败：mode 仍是 ${mode.toString(8)}`)
    }
    return
  }

  // Windows：用 icacls 重写 ACL
  let account = userInfo().username
  // 域账户需要 DOMAIN\user 形式；userInfo 只给用户名
  if (!account.includes('\\')) {
    account = `${process.env.USERDOMAIN ?? ''}\\${account}`.replace(/^\\/, '')
  }

  try {
    execFileSync('icacls', [
      file,
      '/inheritance:r',                 // 断开继承，否则父目录权限继续生效
      '/grant:r', `${account}:(F)`,     // 当前用户完全控制
      '/grant:r', 'SYSTEM:(F)',
      '/grant:r', 'Administrators:(F)',
    ], { windowsHide: true, stdio: 'ignore' })
  } catch (err) {
    throw new Error(
      `无法收紧 token 文件权限（${file}）：${(err as Error).message}。` +
      '拒绝以「看似受保护、实际可被其他用户读取」的状态继续运行。',
    )
  }

  // 校验：不能再有任何可读主体残留
  const out = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
  const leaked = out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const rights = (l.match(/\(([A-Z]+)\)/g) ?? []).join('')
      return /[RWXFD]/.test(rights)
    })
    .filter((l) => {
      const p = l.split(':')[0]!.toLowerCase()
      return !(
        p === account.toLowerCase() ||
        p.endsWith(`\\${userInfo().username.toLowerCase()}`) ||
        p === 'nt authority\\system' ||
        p === 'builtin\\administrators'
      )
    })

  if (leaked.length > 0) {
    throw new Error(
      `token 文件仍对其他主体可访问：${leaked.join(' | ')}`,
    )
  }
}

export interface ResolvedToken {
  token: string
  /** 来源，用于日志和 /health 之外的诊断（不泄露 token 本身） */
  source: 'env' | 'file' | 'generated'
}

/**
 * 决定本次实例使用的 token。
 *
 * 优先级：AUTH_TOKEN 环境变量 → 已有的 token 文件 → 新生成。
 *
 * 为什么要持久化到文件：服务重启后 token 不变，
 * 否则每次重启所有客户端都要重新配对。文件权限压到 0600。
 */
export function resolveToken(dataDir: string, envToken: string | undefined): ResolvedToken {
  if (envToken) {
    if (envToken.length < 16) {
      throw new Error('AUTH_TOKEN 太短（少于 16 字符），拒绝启动')
    }
    return { token: envToken, source: 'env' }
  }

  const file = tokenFilePath(dataDir)
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim()
    if (saved.length >= 16) {
      // 已存在的文件也要重新收紧：可能是上一版（未正确设置 ACL）留下的，
      // 也可能被别的工具改松了。每次启动都校正一次。
      protectTokenFile(file)
      return { token: saved, source: 'file' }
    }
    // 文件存在但内容无效：重新生成，不静默沿用坏值
  }

  const token = generateToken()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, token + '\n')
  protectTokenFile(file)
  return { token, source: 'generated' }
}

/** 是否 loopback 监听地址。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/**
 * Origin 校验。
 *
 * 规则：只要请求带了 Origin 头，就必须精确匹配允许列表；否则拒绝。
 *
 * 为什么「没带 Origin 就放行」是安全的：
 * 浏览器发起跨站请求时一定会带 Origin（fetch / 表单 / img 都带）。
 * 不带 Origin 的只可能是非浏览器客户端（curl、脚本），
 * 而它们本来就要过 token 这一关。
 */
export function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true
  // 'null' 来自 sandbox iframe、file:// 页面、跨源重定向——一律拒绝
  if (origin === 'null') return false
  return allowed.includes(origin)
}

/** 某个监听地址下，浏览器可能发来的合法 Origin。 */
export function defaultAllowedOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]
}
