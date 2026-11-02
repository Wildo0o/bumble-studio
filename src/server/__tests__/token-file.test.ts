// token 文件的访问控制。
//
// 这是认证方案的根基：如果 token 文件可被同机其他用户读取，
// 那么「其他 OS 用户」这一格防护就是假的，整个威胁模型要塌。
//
// 关键事实（实测，不是推测）：
//   Windows 上 writeFileSync(path, data, { mode: 0o600 }) **不改变 ACL**。
//   Node 的 mode 在 Windows 上只映射到「只读」标志位。
//   新建文件继承父目录 ACL，典型结果是：
//       BUILTIN\Users:(I)(RX)              ← 所有用户可读
//       NT AUTHORITY\Authenticated Users:(I)(M)
//
// 所以这条必须靠测试守住，不能只靠文档承诺。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { resolveToken, tokenFilePath } from '../auth.js'

const isWin = process.platform === 'win32'

/**
 * 读取文件的 ACL，返回「除当前用户外还能访问它的主体」。
 *
 * 只用于测试。生产代码用 protectTokenFile() 设置权限。
 */
function foreignPrincipals(file: string): string[] {
  if (!isWin) {
    // POSIX：用 stat 的 mode 位判断。组和其他人都不该有任何权限。
    const { statSync } = require('node:fs') as typeof import('node:fs')
    const mode = statSync(file).mode & 0o777
    const bad: string[] = []
    if (mode & 0o077) bad.push(`mode=${mode.toString(8)}`)
    return bad
  }

  const out = execFileSync('icacls', [file], {
    encoding: 'utf8',
    windowsHide: true,
  })

  const me = userInfo().username.toLowerCase()
  const lines = out.split(/\r?\n/).slice(1)   // 第一行是文件名
  const bad: string[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // 格式：PRINCIPAL:(I)(F)   或   PRINCIPAL:(F)
    const m = /^(.+?):(\([^)]*\))+$/.exec(line)
    if (!m) continue
    const principal = m[1]!.trim()

    // 描述符里没有权限字母（只有继承标记）说明已被移除
    const rights = (line.match(/\(([A-Z]+)\)/g) ?? []).join('')
    if (!/[RWXFD]/.test(rights)) continue

    // 当前用户、SYSTEM、Administrators 被视为可信：
    //   · 当前用户 —— 就是文件主人
    //   · SYSTEM / Administrators —— 它们本来就能绕过任何文件权限
    const p = principal.toLowerCase()
    const trusted =
      p === me ||
      p.endsWith(`\\${me}`) ||
      p === 'nt authority\\system' ||
      p === 'builtin\\administrators' ||
      p === 'nt authority\\system' ||
      p.includes('\\system')
    if (!trusted) bad.push(`${principal}${rights}`)
  }

  return bad
}

describe('token 文件的访问控制', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-tokenperm-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('生成的 token 文件不能被其他用户读取', () => {
    const { source } = resolveToken(dir, undefined)
    expect(source).toBe('generated')

    const file = tokenFilePath(dir)
    expect(existsSync(file)).toBe(true)

    const foreign = foreignPrincipals(file)
    expect(
      foreign,
      `token 文件存在其他可访问主体：${foreign.join(', ')}`,
    ).toEqual([])
  })

  it('已存在的 token 文件会被重新收紧权限', () => {
    // 模拟「上次用的是旧版本，文件权限很松」
    const first = resolveToken(dir, undefined)
    // 手动放开权限（模拟历史遗留）
    if (isWin) {
      execFileSync('icacls', [tokenFilePath(dir), '/grant', 'Users:(R)'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      const { chmodSync } = require('node:fs') as typeof import('node:fs')
      chmodSync(tokenFilePath(dir), 0o644)
    }

    // 再读一次：内容不变，但权限必须被收紧
    const second = resolveToken(dir, undefined)
    expect(second.source).toBe('file')
    expect(second.token).toBe(first.token)

    const foreign = foreignPrincipals(tokenFilePath(dir))
    expect(foreign, `重新读取后仍有其他主体：${foreign.join(', ')}`).toEqual([])
  })

  it('AUTH_TOKEN 环境变量模式下不创建 token 文件', () => {
    const { source } = resolveToken(dir, 'explicit-token-0123456789abcdef')
    expect(source).toBe('env')
    expect(existsSync(tokenFilePath(dir))).toBe(false)
  })
})
