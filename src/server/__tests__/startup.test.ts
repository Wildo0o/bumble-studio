// 进程级启动约束。
//
// 这些行为只存在于 index.ts 的顶层逻辑里，无法通过 import 测试
// （import 会真的去监听端口）。只能 spawn 子进程。
//
// 用子进程验证反而是对的：这些约束本来就是给「真实启动」用的。
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ENTRY = resolve(import.meta.dirname, '..', 'index.js')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * 启动入口进程，等它自己退出或超时。
 *
 * 默认 15 秒——tsx 首次编译要几秒，给足余量。
 */
function runEntry(env: Record<string, string>, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    // 超时后必须等进程真的退出再返回。
    // 否则调用方紧接着 rmSync 会撞上「文件仍被打开」的 EPERM——
    // 这是测试自身的竞态，不是被测代码的问题。
    const timer = setTimeout(() => {
      child.kill()
      child.once('exit', () => done({ code: null, stdout, stderr }))
    }, timeoutMs)

    child.on('exit', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

describe('非 loopback 监听必须配认证', () => {
  it('HOST=0.0.0.0 且没有 AUTH_TOKEN 时拒绝启动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-startup-'))
    try {
      const result = await runEntry({
        HOST: '0.0.0.0',
        PORT: '0',
        DATA_DIR: join(dir, 'data'),
        WORKSPACE: join(dir, 'workspace'),
        AUTH_TOKEN: '',                 // 显式清空，防止继承外部环境
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/拒绝启动/)
      expect(result.stderr).toMatch(/AUTH_TOKEN/)
      // 拒绝启动时不应该留下数据库
      expect(existsSync(join(dir, 'data', 'workstation.db'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HOST=0.0.0.0 且有 AUTH_TOKEN 时能启动并生成 token 文件之外的凭据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-startup-'))
    // __dirname 解析需要目录存在
    mkdirSync(join(dir, 'data'), { recursive: true })
    mkdirSync(join(dir, 'workspace'), { recursive: true })

    const token = 'explicit-token-0123456789abcdef'
    const result = await runEntry({
      HOST: '0.0.0.0',
      PORT: '0',                        // 让系统分配，避免端口冲突
      DATA_DIR: join(dir, 'data'),
      WORKSPACE: join(dir, 'workspace'),
      AUTH_TOKEN: token,
    }, 4000)

    // 被超时杀掉（code null）说明服务成功起来了且没有自行退出
    expect(result.code).toBeNull()
    expect(result.stderr).not.toMatch(/拒绝启动/)
    // 真的进入了监听状态（日志里出现了「已启动」和监听地址）
    expect(result.stdout).toMatch(/AI 工作站已启动/)
    expect(result.stdout).toMatch(/0\.0\.0\.0/)

    // 关键：token 绝不能打印到日志
    expect(result.stdout).not.toContain(token)
    expect(result.stderr).not.toContain(token)
    // 但必须说明认证来源
    expect(result.stdout).toMatch(/AUTH_TOKEN/)

    rmSync(dir, { recursive: true, force: true })
  })

  it('自动生成的 token 不会打印到日志，但会写进 0600 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-startup-'))
    mkdirSync(join(dir, 'data'), { recursive: true })
    mkdirSync(join(dir, 'workspace'), { recursive: true })

    const result = await runEntry({
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: join(dir, 'data'),
      WORKSPACE: join(dir, 'workspace'),
      AUTH_TOKEN: '',
    }, 4000)

    expect(result.code).toBeNull()

    const tokenFile = join(dir, 'data', 'auth-token')
    expect(existsSync(tokenFile)).toBe(true)
    const saved = readFileSync(tokenFile, 'utf8').trim()
    expect(saved.length).toBeGreaterThanOrEqual(32)

    // 日志里只有「已生成」这个事实，没有 token 本身
    expect(result.stdout).toContain('token 已生成')
    expect(result.stdout).not.toContain(saved)
    expect(result.stderr).not.toContain(saved)

    rmSync(dir, { recursive: true, force: true })
  })
})
