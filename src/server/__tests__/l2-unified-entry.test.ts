// L2 Task 2：统一执行入口。
//
// 手动 POST /runs/:id/execute 与 POST /runner/tick 必须共享
// provider 解析、requiresKey、Executor、cancel、shutdown 的核心路径。
//
// 「共享」的可验证形式：
//   · 两条路径对同一类错误给出**相同分类**的状态码
//   · 两条路径都能真正把 Run 跑到 completed
//   · 一条路径上的安全门在另一条上同样生效
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'

const token = 'l2-task2-token-0123456789abcdef'

describe('L2 Task 2：统一执行入口', () => {
  let dir: string
  let ws: WorkstationServer | undefined
  let base: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-l2t2-'))
    mkdirSync(join(dir, 'w'), { recursive: true })
    mkdirSync(join(dir, 'd'), { recursive: true })
    ws = await createWorkstationServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(dir, 'd'),
      workspace: join(dir, 'w'),
      snapshotDir: join(dir, 's'),
      auth: { token, source: 'env' },
    })
    const port = await ws.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await ws?.close().catch(() => undefined)
    ws = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
  }

  async function seedRun(): Promise<{ taskId: string; runId: string }> {
    const s = (await api('POST', '/sessions', { title: 't' })).json as { id: string }
    const t = (await api('POST', '/tasks', { sessionId: s.id, goal: '做一件事' })).json as { id: string }
    const r = (await api('POST', '/runs', { taskId: t.id, role: 'producer' })).json as { id: string }
    return { taskId: t.id, runId: r.id }
  }

  // ── 手动执行 happy path ──────────────────────────────────
  it('POST /runs/:id/execute 能把 queued Run 跑到 completed', async () => {
    const { runId } = await seedRun()

    const res = await api('POST', `/runs/${runId}/execute`, {
      provider: 'demo',
      model: 'demo',
      messages: [{ role: 'user', content: '说一句话' }],
    })
    console.log('DBG manual exec:', res.status, JSON.stringify(res.json).slice(0, 400))
    expect(res.status).toBe(200)
    expect((res.json as { status: string }).status).toBe('completed')

    // 最终状态，而不是只看 HTTP
    const after = await api('GET', `/runs/${runId}`)
    expect((after.json.run as { status: string }).status).toBe('completed')
  })

  // ── tick happy path ──────────────────────────────────────
  it('POST /runner/tick 能把 queued Run 跑到非 queued 状态', async () => {
    const { taskId, runId } = await seedRun()

    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(200)

    const executed = (tick.json as { executed: Array<{ runId: string; status: string }> }).executed
    expect(executed.some((e) => e.runId === runId)).toBe(true)

    const after = await api('GET', `/runs/${runId}`)
    const status = (after.json.run as { status: string }).status
    expect(status).not.toBe('queued')
    // demo provider 正常应完成
    expect(status).toBe('completed')
  })

  // ── 两条路径的错误分类一致 ───────────────────────────────
  it('未知 provider：手动执行与 tick 都给 404（不是 500）', async () => {
    const a = await seedRun()
    const manual = await api('POST', `/runs/${a.runId}/execute`, {
      provider: 'no-such-provider',
      model: 'demo',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(manual.status).toBe(404)

    const b = await seedRun()
    const tick = await api('POST', '/runner/tick', {
      provider: 'no-such-provider',
      candidates: [{ taskId: b.taskId, runId: b.runId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(404)
  })

  it('需要密钥但没配置：两条路径都给 401', async () => {
    // openai requiresKey=true，测试环境没有 key
    const a = await seedRun()
    const manual = await api('POST', `/runs/${a.runId}/execute`, {
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(manual.status).toBe(401)

    const b = await seedRun()
    const tick = await api('POST', '/runner/tick', {
      provider: 'openai',
      model: 'gpt-4o',
      candidates: [{ taskId: b.taskId, runId: b.runId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(401)
  })

  // ── 取消在两条路径上都生效 ───────────────────────────────
  it('已取消的 Run：手动执行与 tick 都不会让它跑起来', async () => {
    const a = await seedRun()
    await api('POST', `/runner/runs/${a.runId}/cancel-intent`, {})

    const manual = await api('POST', `/runs/${a.runId}/execute`, {
      provider: 'demo', model: 'demo',
      messages: [{ role: 'user', content: 'x' }],
    })
    // 拒绝执行（409 冲突或 404），关键是不能变成 completed
    const afterManual = await api('GET', `/runs/${a.runId}`)
    expect((afterManual.json.run as { status: string }).status).not.toBe('completed')
    expect(manual.status).toBeGreaterThanOrEqual(400)

    const b = await seedRun()
    await api('POST', `/runner/runs/${b.runId}/cancel-intent`, {})
    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId: b.taskId, runId: b.runId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(200)
    const afterTick = await api('GET', `/runs/${b.runId}`)
    expect((afterTick.json.run as { status: string }).status).toBe('cancelled')
  })

  // ── 重复执行被拒（并发保护一致）───────────────────────────
  it('已完成的 Run 再次手动执行不会成功', async () => {
    const { runId } = await seedRun()
    const first = await api('POST', `/runs/${runId}/execute`, {
      provider: 'demo', model: 'demo',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect((first.json as { status: string }).status).toBe('completed')

    const second = await api('POST', `/runs/${runId}/execute`, {
      provider: 'demo', model: 'demo',
      messages: [{ role: 'user', content: 'x' }],
    })
    // 不要求具体状态码，但不能再执行一遍
    expect((second.json as { status?: string }).status).not.toBe('completed')
  })
})
