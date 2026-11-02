// L2 Gate 阻断项 1：一次性 provider apiKey 不能丢。
//
// 缺陷：modelFrom 用请求体的 apiKey 解析出 provider（覆盖生效），
// 但路由只把 provider.id 传给 executeRun，executeRun 又用
// providerConfig.resolve(providerId) 重新解析一次——这次没有 requestKey，
// 于是重新构造出的 provider 少了密钥：
//   · requiresKey 的提供商会直接 401（用户明明传了 key）
//   · 或者以无认证状态发请求
//
// 三条约束同时要满足：
//   1. key 必须到达 adapter
//   2. key 不能落库（Run / Event / SecretStore）
//   3. key 不能出现在响应或事件里
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'
import { isolateProviderEnv } from '../../core/__tests__/test-env.js'
import type { ProviderAdapter, ChatRequest } from '../../providers/types.js'

const token = 'l2-gate-key-token-0123456789abcdef'
const ONE_SHOT_KEY = 'sk-one-shot-gate-key-do-not-persist'

describe('L2 Gate 1：一次性 apiKey', () => {
  let dir: string
  let ws: WorkstationServer | undefined
  let base: string
  let restoreEnv: () => void
  /** 记录 adapter 实际收到的 apiKey */
  const seenKeys: Array<string | undefined> = []

  beforeEach(async () => {
    restoreEnv = isolateProviderEnv()
    seenKeys.length = 0

    dir = mkdtempSync(join(tmpdir(), 'ws-gate1-'))
    mkdirSync(join(dir, 'w'), { recursive: true })
    mkdirSync(join(dir, 'd'), { recursive: true })

    // 注入一个会记录 apiKey 的 adapter。
    // 用 adapterResolver 而不是真的连网络：要验证的是「key 有没有传到这里」，
    // 不是「provider 服务能不能用」。
    const recordingAdapter: ProviderAdapter = {
      async stream(req: ChatRequest, handlers) {
        seenKeys.push(req.provider.apiKey)
        handlers.onText?.('ok')
        return { text: 'ok', toolCalls: [] }
      },
    }

    ws = await createWorkstationServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(dir, 'd'),
      workspace: join(dir, 'w'),
      snapshotDir: join(dir, 's'),
      auth: { token, source: 'env' },
      // 复用已有的 auditorAdapterResolver 注入点：
      // 它覆盖 provider → adapter 的构造，正好用来观察「key 有没有传进来」。
      auditorAdapterResolver: () => recordingAdapter,
    })
    const port = await ws.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await ws?.close().catch(() => undefined)
    ws = undefined
    restoreEnv()
    rmSync(dir, { recursive: true, force: true })
  })

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await res.text()
    return { status: res.status, json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, raw }
  }

  async function seedRun(): Promise<{ taskId: string; runId: string }> {
    const s = await api('POST', '/sessions', { title: 't' })
    const t = await api('POST', '/tasks', {
      sessionId: (s.json as { id: string }).id, goal: 'g',
    })
    const r = await api('POST', '/runs', {
      taskId: (t.json as { id: string }).id, role: 'producer',
    })
    return {
      taskId: (t.json as { id: string }).id,
      runId: (r.json as { id: string }).id,
    }
  }

  // ── 1. key 必须到达 adapter ───────────────────────────────
  it('POST /runs/:id/execute 的 apiKey 必须传到 provider adapter', async () => {
    const { runId } = await seedRun()

    const r = await api('POST', `/runs/${runId}/execute`, {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: ONE_SHOT_KEY,
      messages: [{ role: 'user', content: 'hi' }],
    })

    // 关键断言：adapter 真的看到了这个 key。
    // 之前这里永远传 undefined —— 于是 openai 这种 requiresKey 的
    // 提供商会 401，用户明明给了 key 却说没配。
    expect(r.status).toBe(200)
    expect(seenKeys.length).toBeGreaterThan(0)
    expect(seenKeys[0]).toBe(ONE_SHOT_KEY)
  })

  // ── 2. 不落库 ─────────────────────────────────────────────
  it('apiKey 不写入 Run / Event / SecretStore', async () => {
    const { runId } = await seedRun()

    await api('POST', `/runs/${runId}/execute`, {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: ONE_SHOT_KEY,
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Run 记录
    const run = await api('GET', `/runs/${runId}`)
    expect(run.raw).not.toContain(ONE_SHOT_KEY)

    // 事件
    const events = await api('GET', `/runs/${runId}/events`)
    if (events.status === 200) {
      expect(events.raw).not.toContain(ONE_SHOT_KEY)
    }

    // Run 历史消息
    const store = (ws as unknown as {
      store: {
        listRunMessagesWithMeta(id: string): unknown[]
        listEvents(id: string): unknown[]
      }
    }).store
    const dump = JSON.stringify([
      store.listRunMessagesWithMeta(runId),
      store.listEvents(runId),
    ])
    expect(dump).not.toContain(ONE_SHOT_KEY)
  })

  // ── 3. 不出现在响应里 ─────────────────────────────────────
  it('apiKey 不出现在 execute 响应中', async () => {
    const { runId } = await seedRun()

    const r = await api('POST', `/runs/${runId}/execute`, {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: ONE_SHOT_KEY,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(r.raw).not.toContain(ONE_SHOT_KEY)
  })

  // ── 4. 一次性：下一次请求不带 key 就不该有 key ─────────────
  it('一次性 key 不会粘到后续请求上', async () => {
    const a = await seedRun()
    await api('POST', `/runs/${a.runId}/execute`, {
      provider: 'openai', model: 'gpt-4o', apiKey: ONE_SHOT_KEY,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(seenKeys[0]).toBe(ONE_SHOT_KEY)

    // 第二个 Run，不带 key → adapter 拿到的必须是 undefined
    const b = await seedRun()
    await api('POST', `/runs/${b.runId}/execute`, {
      provider: 'openai', model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // 如果这里仍是 ONE_SHOT_KEY，说明 key 被写进了 SecretStore
    expect(seenKeys[1]).not.toBe(ONE_SHOT_KEY)
  })

  // ── 5. tick 明确禁止一次性 key ────────────────────────────
  it('runner/tick 带 apiKey → 400，并明确说明不支持', async () => {
    const { taskId, runId } = await seedRun()

    const r = await api('POST', '/runner/tick', {
      apiKey: ONE_SHOT_KEY,
      candidates: [{ taskId, runId, priority: 100, eligible: true }],
    })

    // 要么明确支持（key 传给 adapter），要么明确拒绝。
    // 不能静默忽略——那会让调用方以为 key 生效了。
    if (r.status === 400) {
      expect(String(r.json.error)).toContain('apiKey')
      // 拒绝时不能有任何副作用：Run 仍是 queued
      const after = await api('GET', `/runs/${runId}`)
      expect((after.json.run as { status: string }).status).toBe('queued')
      expect(seenKeys).toEqual([])
    } else {
      // 如果实现选择支持，key 必须真的到达 adapter
      expect(r.status).toBe(200)
      expect(seenKeys[0]).toBe(ONE_SHOT_KEY)
    }
  })
})
