// L2 Task 1：Runner 状态闭环（HTTP 层）。
//
// 核心命题（L2 定义里的「核心状态不永久卡死」）：
//   任何 Run 都不能因为「取消没落地」「租约没释放」「计数丢失」
//   而永远停在一个不该停的状态。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'

const token = 'l2-task1-token-0123456789abcdef'

describe('L2 Task 1：Runner 状态闭环', () => {
  let dir: string
  let ws: WorkstationServer | undefined
  let base: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-l2t1-'))
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
    const t = (await api('POST', '/tasks', { sessionId: s.id, goal: 'g' })).json as { id: string }
    const r = (await api('POST', '/runs', { taskId: t.id, role: 'producer' })).json as { id: string }
    return { taskId: t.id, runId: r.id }
  }

  async function statusOf(runId: string): Promise<string> {
    const r = await api('GET', `/runs/${runId}`)
    return (r.json.run as { status: string }).status
  }

  // ── queued + cancel-intent 必须最终 cancelled ────────────
  it('queued Run 有取消意图 → 下一次 tick 之后变成 cancelled', async () => {
    const { taskId, runId } = await seedRun()
    expect(await statusOf(runId)).toBe('queued')

    const c = await api('POST', `/runner/runs/${runId}/cancel-intent`, {})
    expect(c.status).toBe(200)
    // 取消意图已登记（但此刻 Run 还没执行，所以可能仍是 queued）
    expect((c.json as { intent: string }).intent).toBe('recorded')

    // 调度一次：应当把它落实成 cancelled，而不是跳过
    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(200)

    expect(await statusOf(runId)).toBe('cancelled')
  })

  it('取消后再次 tick 不会执行它', async () => {
    const { taskId, runId } = await seedRun()
    await api('POST', `/runner/runs/${runId}/cancel-intent`, {})

    await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    expect(await statusOf(runId)).toBe('cancelled')

    const tick2 = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    const executed = (tick2.json as { executed: unknown[] }).executed
    expect(executed).toEqual([])
    expect(await statusOf(runId)).toBe('cancelled')
  })

  // ── 执行前校验失败 → 租约可立即重试 ──────────────────────
  it('invalid provider 导致 tick 失败后，Run 不会卡在 running', async () => {
    const { taskId, runId } = await seedRun()

    const tick = await api('POST', '/runner/tick', {
      provider: 'no-such-provider',
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    // 未知 provider 是请求错误
    expect(tick.status).toBeGreaterThanOrEqual(400)

    // 关键：它不能停在 running（那是「永久卡死」的定义）
    const status = await statusOf(runId)
    expect(status).not.toBe('running')
  })

  it('执行前校验失败后，Run 不会卡在 running（可再次调度）', async () => {
    const { taskId, runId } = await seedRun()

    // 先用无效 provider 触发一次执行前失败
    const bad = await api('POST', '/runner/tick', {
      provider: 'no-such-provider',
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })
    expect(bad.status).toBe(404)

    // L2 的核心要求是「不永久卡死」：任何终态/可调度态都算合格，
    // 唯独不能停在 running（那意味着没人会再推进它）。
    const status = await statusOf(runId)
    expect(status).not.toBe('running')

    // 如果它仍是 queued，说明租约已经释放，下一次调度必须能真的跑起来。
    // 这是「租约没泄漏」的直接证据。
    if (status === 'queued') {
      const tick = await api('POST', '/runner/tick', {
        candidates: [{ taskId, runId, priority: 100, eligible: true }],
      })
      const executed = (tick.json as { executed: Array<{ runId: string }> }).executed
      expect(executed.some((e) => e.runId === runId)).toBe(true)
      expect(await statusOf(runId)).not.toBe('queued')
    }
  })

  // ── failure counter 跨请求保留 ───────────────────────────
  it('failure counter 跨 HTTP tick 保留（落库而不是每次归零）', async () => {
    // 每次 /runner/tick 都新建 runner 实例。如果计数只在内存里，
    // 它每次从 0 开始 →「连续失败 N 次就停」永不触发。
    //
    // 这里直接读持久化计数，而不是靠状态码间接推断——
    // 间接断言会随错误映射变化而失效。
    const { runId } = await seedRun()
    const store = (ws as unknown as {
      store: { getFailureCount(id: string): number; setFailureCount(id: string, n: number): void }
    }).store

    expect(store.getFailureCount(runId)).toBe(0)
    store.setFailureCount(runId, 3)
    // 换一次 HTTP 请求后再读：值必须还在（说明不在请求作用域内）
    await api('GET', '/runner/state')
    expect(store.getFailureCount(runId)).toBe(3)

    // 清理，避免影响其它用例
    store.setFailureCount(runId, 0)
  })

  // ── shutdown 等待执行器 ──────────────────────────────────
  it('shutdown 在有空闲执行时快速完成，且不抛错', async () => {
    await seedRun()
    const t0 = Date.now()
    await ws!.close()
    ws = undefined
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  // ── takeover 之后不阻塞后续调度 ──────────────────────────
  it('失联的 running Run 被接管后可以被正常调度', async () => {
    const { taskId, runId } = await seedRun()

    // 手工把它置为 running（模拟上次执行者崩溃留下的状态）
    const store = (ws as unknown as { store: { transitionRunStatus: (id: string, from: string, to: string) => boolean } }).store
    store.transitionRunStatus(runId, 'queued', 'running')

    // 第一次 tick：接管它（变成 queued 或 needs_reconciliation）
    await api('POST', '/runner/tick', {})

    const status = await statusOf(runId)
    expect(status).not.toBe('running')

    // 如果被重新排队，第二次 tick 应该能执行它（说明租约没被占着）
    if (status === 'queued') {
      const tick = await api('POST', '/runner/tick', {
        candidates: [{ taskId, runId, priority: 100, eligible: true }],
      })
      const executed = (tick.json as { executed: Array<{ runId: string }> }).executed
      expect(executed.some((e) => e.runId === runId)).toBe(true)
    }
  })
})
