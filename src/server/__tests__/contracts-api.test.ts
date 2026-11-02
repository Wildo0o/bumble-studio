// 公共契约的 HTTP 表现。
//
// 三件事必须在真实 HTTP 上验证（unit 测不到）：
//   1. 错误体同时提供 error 字符串（兼容）与 code / retryable（结构化）
//   2. correlationId 同时出现在响应体与响应头
//   3. /meta/* 暴露的契约与 core 层一致，且需要认证
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'
import { errorCodes, specFor } from '../../core/errors.js'
import { eventKinds } from '../../core/event-catalog.js'
import { machineSummary } from '../../core/state-machine.js'
import { permissionActions } from '../../core/permissions.js'

describe('契约的 HTTP 表现', () => {
  let dir: string
  let ws: WorkstationServer
  let base: string
  const token = 'contracts-test-token-0123456789'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-contracts-'))
    const workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    ws = await createWorkstationServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      workspace,
      snapshotDir: join(dir, 'snapshots'),
      auth: { token, source: 'env' },
    })
    const port = await ws.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await ws.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: res.headers,
    }
  }

  // ── 错误体形状 ─────────────────────────────────────────

  it('错误响应的 error 仍是字符串（兼容旧调用方）', async () => {
    const res = await api('GET', '/tasks/no-such-task')
    expect(res.status).toBe(404)
    expect(typeof res.json.error).toBe('string')
    expect(res.json.error).toContain('不存在')
  })

  it('错误响应同时给出可机器读取的 code 与 retryable', async () => {
    const res = await api('GET', '/tasks/no-such-task')
    expect(res.json.code).toBe('NOT_FOUND')
    expect(res.json.retryable).toBe(false)
  })

  it('correlationId 同时出现在响应体与 x-correlation-id 头', async () => {
    const res = await api('GET', '/tasks/no-such-task')
    const id = res.json.correlationId
    expect(typeof id).toBe('string')
    expect(id).toMatch(/\S/)
    expect(res.headers.get('x-correlation-id')).toBe(id)
  })

  it('不存在的对象与状态冲突使用不同的 code', async () => {
    const notFound = await api('GET', '/tasks/nope')
    expect(notFound.json.code).toBe('NOT_FOUND')

    // 对一个不存在的任务做验收：先要拿到 404
    const accept = await api('POST', '/tasks/nope/accept', { artifactId: 'a', runId: 'r' })
    expect([404, 409]).toContain(accept.status)
    expect(typeof accept.json.code).toBe('string')
  })

  // ── 元数据接口 ─────────────────────────────────────────

  it('/meta/contracts 需要认证', async () => {
    const res = await fetch(base + '/meta/contracts')
    expect(res.status).toBe(401)
  })

  it('/meta/contracts 与 core 层的契约一致', async () => {
    const res = await api('GET', '/meta/contracts')
    expect(res.status).toBe(200)

    const errors = res.json.errors as Array<{ code: string }>
    expect(errors.map((e) => e.code).sort()).toEqual([...errorCodes()].sort())

    const events = res.json.events as Array<{ kind: string }>
    expect(events.map((e) => e.kind).sort()).toEqual([...eventKinds()].sort())

    const machines = res.json.stateMachines as Array<{ kind: string }>
    expect(machines.map((m) => m.kind).sort()).toEqual(
      machineSummary().map((m) => m.kind).sort(),
    )

    const permissions = res.json.permissions as Array<{ action: string }>
    expect(permissions.map((p) => p.action).sort()).toEqual([...permissionActions()].sort())

    expect(typeof res.json.schemaVersion).toBe('number')
  })

  it('/meta/errors 与错误表一致', async () => {
    const res = await api('GET', '/meta/errors')
    expect(res.status).toBe(200)
    const errors = res.json.errors as Array<{ code: string; httpStatus: number; retryable: boolean }>
    expect(errors).toHaveLength(errorCodes().length)
    for (const e of errors) {
      const spec = specFor(e.code)
      expect(e.httpStatus).toBe(spec.httpStatus)
      expect(e.retryable).toBe(spec.retryable)
    }
  })

  it('/meta/* 不泄露实例信息（工作区路径 / token / 数据目录）', async () => {
    const res = await api('GET', '/meta/contracts')
    const raw = JSON.stringify(res.json)
    for (const leak of [dir, token, 'workstation.db', 'snapshots']) {
      expect(raw).not.toContain(leak.replace(/\\/g, '\\\\'))
    }
  })

  // ── 权限 ───────────────────────────────────────────────

  it('审批接口拒绝请求体里的 approver（不能伪造系统放行）', async () => {
    const res = await api('POST', '/approvals/whatever/approve', { approver: 'system' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toContain('approver')
  })

  it('验收接口对不存在/不可验收的对象给出领域错误码而不是 500', async () => {
    const session = (await api('POST', '/sessions', { title: 't' })).json as { id: string }
    const task = (await api('POST', '/tasks', {
      sessionId: session.id, goal: '做一件小事',
    })).json as { id: string }

    const res = await api('POST', `/tasks/${task.id}/accept`, { artifactId: 'x', runId: 'y' })
    // 产物不存在 → 404 NOT_FOUND。关键不是具体是 404 还是 409，
    // 而是「这是一个有分类的领域错误，不是 500」。
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(typeof res.json.code).toBe('string')
    expect(res.json.retryable).toBe(false)
    expect(typeof res.json.correlationId).toBe('string')
  })
})
