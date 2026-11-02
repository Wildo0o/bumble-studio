// 路由清单与真实 HTTP 认证。
//
// 这个文件的目的不是「再测一遍已经测过的」，而是两条别的测试给不了的性质：
//
//   1. 穷举：每一个已注册路由都必须无 token 返回 401（GET /health 除外）。
//      人工检查 36 个接口会漏，新增第 37 个时更不会有人想起来。
//   2. 自动发现：从源码解析路由，如果出现一条测试清单里没有的新路由，
//      测试直接失败 —— 逼迫作者去补断言，而不是默默漏掉。
//
// 所有请求都走真实 `server.listen(0)` + `fetch`，不直接调 handler。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'

const APP_SOURCE = resolve(import.meta.dirname, '..', 'app.ts')

interface RouteSpec {
  method: string
  path: string
  /** 路径参数用什么值替换 */
  sample: Record<string, string>
}

/**
 * 从 app.ts 源码里解析所有 route(...) 调用。
 *
 * 用源码而不是运行时反射：routes 数组是闭包内的局部变量，外部拿不到。
 * 解析失败时宁可报错也不要静默返回空列表——空列表会让「穷举测试」
 * 变成「什么都没测」还显示绿色。
 */
function parseRoutesFromSource(): Array<{ method: string; path: string; requiresAuth: boolean }> {
  const src = readFileSync(APP_SOURCE, 'utf8')
  const out: Array<{ method: string; path: string; requiresAuth: boolean }> = []

  // 匹配 route('METHOD', '/path', handler, { requiresAuth: false })
  // handler 是多行函数，所以只匹配到第三个参数之后的 `)` 附近。
  const re = /route\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const method = m[1]!
    const path = m[2]!
    // 从匹配位置往后看 400 字符，判断这条 route 是否带 requiresAuth: false
    const tail = src.slice(m.index, m.index + 600)
    // 只看到下一个 route( 之前
    const nextRoute = tail.indexOf('route(', 5)
    const segment = nextRoute > 0 ? tail.slice(0, nextRoute) : tail
    const requiresAuth = !/requiresAuth:\s*false/.test(segment)
    out.push({ method, path, requiresAuth })
  }

  if (out.length === 0) {
    throw new Error(`没能从 ${APP_SOURCE} 解析出任何路由——正则或源码结构变了`)
  }
  return out
}

/** 把 /tasks/:id 变成 /tasks/<sample> */
function materialize(path: string, sample: Record<string, string>): string {
  return path.replace(/:([a-zA-Z]+)/g, (_all, name: string) => {
    const v = sample[name]
    if (!v) throw new Error(`路由 ${path} 的 :${name} 没有提供样例值`)
    return v
  })
}

describe('路由清单', () => {
  let ctx: {
    dir: string
    ws: WorkstationServer
    base: string
    token: string
    workspace: string
    dataDir: string
  }

  const token = 'routes-test-token-0123456789'

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-routes-'))
    const workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const ws = await createWorkstationServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      workspace,
      snapshotDir: join(dir, 'snapshots'),
      auth: { token, source: 'env' },
    })
    const port = await ws.listen()
    ctx = { dir, ws, base: `http://127.0.0.1:${port}`, token, workspace, dataDir }
  })

  afterEach(async () => {
    await ctx.ws.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  })

  it('源码里有 83 条路由（数字变化时请同步更新本测试）', () => {
    const routes = parseRoutesFromSource()
    // 这条断言的作用是「路由数量变化时提醒人来看一眼」。
    // 如果只是加了一条路由，把数字改掉即可 —— 下面的穷举测试会自动覆盖它。
    //
    // 36 → 38：TaskContract 的 GET /tasks/:id/contract 和
    // PUT /tasks/:id/contract（v0.12）。
    // 38 → 40：foundation-contracts 的 GET /meta/contracts 与
    // GET /meta/errors（公共契约元数据，需认证）。
    expect(routes).toHaveLength(83)
  })

  it('只有 GET /health 是公开路由', () => {
    const routes = parseRoutesFromSource()
    const publicRoutes = routes.filter((r) => !r.requiresAuth)
    expect(publicRoutes).toEqual([
      { method: 'GET', path: '/health', requiresAuth: false },
    ])
  })

  it('每一条需要认证的路由，无 token 时都返回 401', async () => {
    const routes = parseRoutesFromSource().filter((r) => r.requiresAuth)
    expect(routes.length).toBeGreaterThan(30)

    const sample = {
      id: 'nonexistent-id',
      runId: 'nonexistent-run',
      taskId: 'nonexistent-task',
      model: 'nonexistent-model',
      artifactId: 'nonexistent-artifact',
    }

    const failures: string[] = []
    for (const r of routes) {
      const path = materialize(r.path, sample)
      const res = await fetch(ctx.base + path, {
        method: r.method,
        headers: r.method === 'GET' ? {} : { 'content-type': 'application/json' },
        body: r.method === 'GET' ? undefined : '{}',
      })
      if (res.status !== 401) {
        failures.push(`${r.method} ${r.path} → ${res.status}（应为 401）`)
      }
      await res.arrayBuffer()   // 释放连接
    }

    expect(failures, failures.join('\n')).toEqual([])
  })

  it('每一条需要认证的路由，错 token 时都返回 401', async () => {
    const routes = parseRoutesFromSource().filter((r) => r.requiresAuth)
    const sample = { id: 'x', runId: 'x', taskId: 'x', model: 'x', artifactId: 'x' }

    const failures: string[] = []
    for (const r of routes) {
      const path = materialize(r.path, sample)
      const res = await fetch(ctx.base + path, {
        method: r.method,
        headers: {
          authorization: 'Bearer wrong-token-0123456789abcdef',
          ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        body: r.method === 'GET' ? undefined : '{}',
      })
      if (res.status !== 401) {
        failures.push(`${r.method} ${r.path} → ${res.status}（应为 401）`)
      }
      await res.arrayBuffer()
    }

    expect(failures, failures.join('\n')).toEqual([])
  })

  it('认证通过后，不存在的资源返回 404 而不是 401', async () => {
    // 这条用来证明 401 不是「一律拒绝」伪装出来的：
    // 带对 token 时必须真的进到业务逻辑，并给出 404。
    const res = await fetch(ctx.base + '/tasks/nonexistent', {
      headers: { authorization: `Bearer ${ctx.token}` },
    })
    expect(res.status).toBe(404)
  })

  it('公开的 /health 只包含 ready / build / schemaVersion', async () => {
    const res = await fetch(ctx.base + '/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(['build', 'ready'])
    expect(body.ready).toBe(true)

    const build = body.build as Record<string, unknown>
    expect(Object.keys(build).sort()).toEqual(['commit', 'schemaVersion', 'version'])

    const raw = JSON.stringify(body)
    for (const leak of [ctx.workspace, ctx.dataDir, ctx.token, 'snapshot', 'workstation.db']) {
      expect(raw).not.toContain(leak.replace(/\\/g, '\\\\'))
    }
  })

  it('带正确 token、没有 Origin 的 CLI 请求能正常工作', async () => {
    const res = await fetch(ctx.base + '/sessions', {
      headers: { authorization: `Bearer ${ctx.token}` },
    })
    expect(res.status).toBe(200)
  })

  it('Origin 不能替代 token：合法 Origin 但无 token 仍然 401', async () => {
    const res = await fetch(ctx.base + '/sessions', {
      headers: { origin: `http://127.0.0.1:${new URL(ctx.base).port}` },
    })
    expect(res.status).toBe(401)
  })

  it('跨站 Origin 即使带正确 token 也被拒绝（403，先于认证）', async () => {
    const res = await fetch(ctx.base + '/sessions', {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: 'http://evil.example',
      },
    })
    expect(res.status).toBe(403)
  })

  it('token 不能放在 URL，即使同时提供了正确的头', async () => {
    const res = await fetch(`${ctx.base}/sessions?token=${ctx.token}`, {
      headers: { authorization: `Bearer ${ctx.token}` },
    })
    expect(res.status).toBe(400)
  })

  it('未认证的写操作不产生任何副作用', async () => {
    // 建一个真实会话/任务，但全部走未认证路径尝试篡改
    const create = await fetch(ctx.base + '/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'baseline' }),
    })
    const session = (await create.json()) as { id: string }

    const before = ctx.ws.store.listSessions().length

    for (const [method, path] of [
      ['POST', '/sessions'],
      ['POST', '/tasks'],
    ] as const) {
      const res = await fetch(ctx.base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x', sessionId: session.id, goal: 'x' }),
      })
      expect(res.status).toBe(401)
    }

    expect(ctx.ws.store.listSessions().length).toBe(before)
    expect(ctx.ws.store.listTasks().length).toBe(0)
  })
})
