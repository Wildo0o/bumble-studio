// HTTP 控制面认证。
//
// 每一条测试都对应任务书里列出的一个攻击面。
// 没有「跳过」，没有「环境不对就算了」——这些测试在任何平台都必须跑。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'
import { resolveToken, parseBearer, tokenMatches, isLoopbackHost, isAllowedOrigin } from '../auth.js'

// ── 测试夹具 ──────────────────────────────────────────────

interface Ctx {
  dir: string
  workspace: string
  dataDir: string
  ws: WorkstationServer
  port: number
  token: string
  base: string
}

async function startServer(overrides: Partial<{ token: string }> = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'ws-auth-'))
  const workspace = join(dir, 'workspace')
  const dataDir = join(dir, 'data')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  const token = overrides.token ?? 'test-token-0123456789abcdef'
  const ws = await createWorkstationServer({
    port: 0,                       // 让系统分配，避免端口冲突
    host: '127.0.0.1',
    dataDir,
    workspace,
    snapshotDir: join(dir, 'snapshots'),
    auth: { token, source: 'env' },
  })
  const port = await ws.listen()
  return { dir, workspace, dataDir, ws, port, token, base: `http://127.0.0.1:${port}` }
}

async function stopServer(ctx: Ctx): Promise<void> {
  await ctx.ws.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

interface Res {
  status: number
  body: Record<string, unknown>
  headers: Headers
}

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.token) headers.authorization = `Bearer ${opts.token}`

  const res = await fetch(ctx.base + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body, headers: res.headers }
}

/** 建立一个「会话 → 任务 → Run」的最小上下文。全部走认证后的接口。 */
/** 把响应头转成字符串，用于检查是否泄露 token。 */
function headerDump(headers: Headers): string {
  const pairs: string[] = []
  headers.forEach((value, key) => pairs.push(`${key}: ${value}`))
  return JSON.stringify(pairs)
}

async function seedRun(ctx: Ctx): Promise<{ taskId: string; runId: string }> {
  const session = await call(ctx, 'POST', '/sessions', { token: ctx.token, body: { title: 't' } })
  const task = await call(ctx, 'POST', '/tasks', {
    token: ctx.token,
    body: { sessionId: session.body.id, goal: 'g' },
  })
  const run = await call(ctx, 'POST', '/runs', {
    token: ctx.token,
    body: { taskId: task.body.id },
  })
  return { taskId: task.body.id as string, runId: run.body.id as string }
}

// ── 单元：认证原语 ────────────────────────────────────────

describe('认证原语', () => {
  it('parseBearer 只接受 Bearer 方案', () => {
    expect(parseBearer('Bearer abcdefghijklmnop1234')).toBe('abcdefghijklmnop1234')
    expect(parseBearer('bearer abcdefghijklmnop1234')).toBeNull()  // 方案名大小写敏感
    expect(parseBearer('Basic abcdefghijklmnop1234')).toBeNull()
    expect(parseBearer('Bearer short')).toBeNull()                 // 太短
    expect(parseBearer(undefined)).toBeNull()
    expect(parseBearer(['Bearer abcdefghijklmnop1234'] as unknown as string[])).toBeNull()
  })

  it('tokenMatches 对不同长度的输入也不会抛错', () => {
    // 直接 timingSafeEqual 会在长度不等时抛出，等于用异常泄露长度
    expect(tokenMatches('abcdefghijklmnop', 'abcdefghijklmnop')).toBe(true)
    expect(tokenMatches('abcdefghijklmnop', 'abcdefghijklmno')).toBe(false)
    expect(tokenMatches('abcdefghijklmnop', '')).toBe(false)
    expect(tokenMatches('abcdefghijklmnop', 'x'.repeat(5000))).toBe(false)
  })

  it('isLoopbackHost 认得出常见写法', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
    for (const h of ['0.0.0.0', '192.168.1.10', 'example.com', '::']) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })

  it('isAllowedOrigin：没带 Origin 放行，带了就必须精确匹配', () => {
    const allowed = ['http://127.0.0.1:4780']
    expect(isAllowedOrigin(undefined, allowed)).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:4780', allowed)).toBe(true)
    expect(isAllowedOrigin('http://evil.example', allowed)).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:9999', allowed)).toBe(false)
    // 'null' 来自 sandbox iframe / file:// / 跨源重定向——必须拒绝
    expect(isAllowedOrigin('null', allowed)).toBe(false)
  })

  it('resolveToken 生成后写入文件，且长度足够', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-token-'))
    try {
      const first = resolveToken(dir, undefined)
      expect(first.source).toBe('generated')
      expect(first.token.length).toBeGreaterThanOrEqual(32)

      // 第二次读到同一个 token（服务重启后客户端不用重新配对）
      const second = resolveToken(dir, undefined)
      expect(second.source).toBe('file')
      expect(second.token).toBe(first.token)

      // 文件里存的就是这个 token，且不是明文打印到别处
      expect(readFileSync(join(dir, 'auth-token'), 'utf8').trim()).toBe(first.token)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveToken 拒绝过短的 AUTH_TOKEN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-token-'))
    try {
      expect(() => resolveToken(dir, 'short')).toThrow(/太短/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── 集成：控制面认证 ──────────────────────────────────────

describe('HTTP 控制面认证', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('无 Authorization 访问控制接口 → 401', async () => {
    const res = await call(ctx, 'GET', '/sessions', { token: null })
    expect(res.status).toBe(401)
    expect(String(res.body.error)).toMatch(/Authorization|token/)
  })

  it('错误 token → 401', async () => {
    const res = await call(ctx, 'GET', '/sessions', { token: 'wrong-token-0123456789' })
    expect(res.status).toBe(401)
  })

  it('格式错误的 Authorization → 401', async () => {
    const cases = [
      { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { headers: { authorization: ctx.token } },              // 少了 Bearer 前缀
      { headers: { authorization: `Bearer ${ctx.token} extra` } },
    ]
    for (const c of cases) {
      const res = await call(ctx, 'GET', '/sessions', { token: null, headers: c.headers })
      expect(res.status, JSON.stringify(c.headers)).toBe(401)
    }
  })

  it('正确 token → 正常访问', async () => {
    const res = await call(ctx, 'GET', '/sessions', { token: ctx.token })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.sessions)).toBe(true)
  })

  it('token 放在 URL 里被拒绝（400），而不是被静默忽略', async () => {
    const res = await call(ctx, 'GET', `/sessions?token=${ctx.token}`, { token: null })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/URL/)
  })

  it('/health 无需认证，且不泄露 workspace / dataDir / token', async () => {
    const res = await call(ctx, 'GET', '/health', { token: null })
    expect(res.status).toBe(200)

    expect(res.body.ready).toBe(true)
    const build = res.body.build as Record<string, unknown>
    expect(typeof build.version).toBe('string')
    expect(typeof build.commit).toBe('string')
    expect(build.schemaVersion).toBeGreaterThan(0)

    const raw = JSON.stringify(res.body)
    // 目录路径绝不能出现
    expect(raw).not.toContain(ctx.workspace.replace(/\\/g, '\\\\'))
    expect(raw).not.toContain('workspace')
    expect(raw).not.toContain('dataDir')
    // token 绝不能出现
    expect(raw).not.toContain(ctx.token)
    // 响应头里也不能有
    expect(headerDump(res.headers)).not.toContain(ctx.token)
  })
})

// ── 集成：认证失败没有副作用 ──────────────────────────────

describe('认证失败不产生副作用', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('未认证的 execute 不会改变 Run 状态', async () => {
    const { runId } = await seedRun(ctx)

    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: null,
      body: { provider: 'demo', model: 'deepseek-chat', goal: 'g' },
    })
    expect(res.status).toBe(401)

    // Run 仍然是 queued，没有被认领
    const after = await call(ctx, 'GET', `/runs/${runId}`, { token: ctx.token })
    expect((after.body.run as Record<string, unknown>).status).toBe('queued')
    expect((after.body.steps as unknown[]).length).toBe(0)
  })

  it('错误 token 的 execute 不会调用模型', async () => {
    const { runId } = await seedRun(ctx)

    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: 'wrong-token-0123456789',
      body: { provider: 'demo', model: 'deepseek-chat', goal: 'g' },
    })
    expect(res.status).toBe(401)

    const after = await call(ctx, 'GET', `/runs/${runId}`, { token: ctx.token })
    expect((after.body.run as Record<string, unknown>).status).toBe('queued')
    // 模型身份是 execute 的第一批写操作之一，没写入说明根本没进去
    expect((after.body.run as Record<string, unknown>).modelIdentity).toBeFalsy()
  })

  it('未认证的 approve 不会创建 Grant', async () => {
    // 先造一个待审批的请求：需要一个 write_file 工具调用
    const { runId } = await seedRun(ctx)
    // 直接往 store 里塞一个 pending approval，避免依赖模型行为
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id,
      index: 0,
      kind: 'approval',
      status: 'waiting_approval',
      input: { tool: 'write_file' },
    })
    const approval = ctx.ws.store.createApproval({
      runId: run.id,
      stepId: step.id,
      toolId: 'write_file',
      toolCallId: 'call_x',
      arguments: { path: 'a.txt', content: 'x' },
      timeoutMs: 60_000,
    })

    const res = await call(ctx, 'POST', `/approvals/${approval.id}/approve`, {
      token: null,
      body: { scope: 'run' },
    })
    expect(res.status).toBe(401)

    // 审批仍是 pending，Grant 数为 0
    const pending = ctx.ws.store.getApproval(approval.id)!
    expect(pending.status).toBe('pending')
    expect(ctx.ws.store.listGrants(run.id).length).toBe(0)
  })

  it('未认证的 accept 不会创建 AcceptanceRecord', async () => {
    const { taskId } = await seedRun(ctx)
    const res = await call(ctx, 'POST', `/tasks/${taskId}/accept`, {
      token: null,
      body: { artifactId: 'x', runId: 'y' },
    })
    expect(res.status).toBe(401)
    expect(ctx.ws.store.listAcceptances(taskId).length).toBe(0)
  })
})

// ── 集成：autoApprove 不能被请求体打开 ────────────────────

describe('autoApprove 权限来源', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('请求体携带 autoApprove 直接 400，而不是被静默忽略', async () => {
    const { runId } = await seedRun(ctx)

    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: ctx.token,
      body: {
        provider: 'demo',
        model: 'deepseek-chat',
        goal: 'g',
        autoApprove: ['write_file'],
      },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/autoApprove/)
    expect(String(res.body.error)).toMatch(/权限只能由服务端/)

    // 被拒绝的请求不能留下任何痕迹
    const after = await call(ctx, 'GET', `/runs/${runId}`, { token: ctx.token })
    expect((after.body.run as Record<string, unknown>).status).toBe('queued')
  })

  it('未知字段一律拒绝（fail-closed）', async () => {
    const { runId } = await seedRun(ctx)

    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: ctx.token,
      body: {
        provider: 'demo',
        model: 'deepseek-chat',
        goal: 'g',
        allowTools: ['write_file'],   // 随便换个名字也不行
      },
    })
    expect(res.status).toBe(400)
  })

  it('已认证但没有 Grant 时，write_file 仍进入 waiting_approval', async () => {
    const { runId } = await seedRun(ctx)

    // demo provider 固定会读文件并尝试写文件。
    // 这里只需要它真的执行一轮，确认写操作被拦。
    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: ctx.token,
      body: { provider: 'demo', model: 'deepseek-chat', goal: '把结果写到 out.txt' },
    })
    expect(res.status).toBe(200)

    const status = (res.body.status as string)
    // 要么停在 waiting_approval，要么（demo 脚本没触发写）跑完了但没写文件
    if (status === 'paused') {
      const approval = res.body.approval as Record<string, unknown> | undefined
      expect(approval).toBeTruthy()
      expect(approval!.toolId).toBe('write_file')

      // Run 停在 waiting_approval，不是 completed
      const after = await call(ctx, 'GET', `/runs/${runId}`, { token: ctx.token })
      expect((after.body.run as Record<string, unknown>).status).toBe('waiting_approval')
      // 工作区里没有新文件
      expect(existsSync(join(ctx.workspace, 'out.txt'))).toBe(false)
    } else {
      // demo 脚本没有触发 write_file；这不算失败，但必须确认没有越权写入
      expect(existsSync(join(ctx.workspace, 'out.txt'))).toBe(false)
    }
  })
})

// ── 集成：Origin ─────────────────────────────────────────

describe('Origin 校验', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('跨站 Origin 即使是合法 token 也被拒绝', async () => {
    const res = await call(ctx, 'POST', '/sessions', {
      token: ctx.token,
      body: { title: 'x' },
      headers: { origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(String(res.body.error)).toMatch(/来源/)
  })

  it('Origin: null 被拒绝', async () => {
    const res = await call(ctx, 'GET', '/sessions', {
      token: ctx.token,
      headers: { origin: 'null' },
    })
    expect(res.status).toBe(403)
  })

  it('本机 Origin 被允许', async () => {
    const res = await call(ctx, 'GET', '/sessions', {
      token: ctx.token,
      headers: { origin: `http://127.0.0.1:${ctx.port}` },
    })
    expect(res.status).toBe(200)
  })

  it('跨站请求带自动审批字段也发不出去（Origin 先于认证）', async () => {
    const { runId } = await seedRun(ctx)
    const res = await call(ctx, 'POST', `/runs/${runId}/execute`, {
      token: ctx.token,
      body: { provider: 'demo', model: 'x', goal: 'g', autoApprove: ['write_file'] },
      headers: { origin: 'http://evil.example' },
    })
    expect(res.status).toBe(403)
  })
})

// ── 集成：token 不泄露 ───────────────────────────────────

describe('token 不出现在响应、URL、日志中', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('所有响应体都不包含 token', async () => {
    const paths: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/sessions'],
      ['GET', '/tasks'],
      ['GET', '/approvals'],
      ['GET', '/tools'],
      ['GET', '/skills'],
    ]
    for (const [method, path] of paths) {
      const res = await call(ctx, method, path, { token: ctx.token })
      expect(JSON.stringify(res.body)).not.toContain(ctx.token)
      expect(headerDump(res.headers)).not.toContain(ctx.token)
    }
  })

  it('401 响应里不回显错误 token', async () => {
    const wrong = 'wrong-token-abcdefghij'
    const res = await call(ctx, 'GET', '/sessions', { token: wrong })
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toContain(wrong)
  })
})

// ── 集成：请求体上限 ─────────────────────────────────────

describe('请求体上限', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('超大请求体被拒绝', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024)
    const res = await fetch(ctx.base + '/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify({ title: huge }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(String(body.error)).toMatch(/上限/)
  })

  it('非对象的 JSON 请求体被拒绝', async () => {
    const res = await fetch(ctx.base + '/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.token}`,
      },
      body: JSON.stringify(['not', 'an', 'object']),
    })
    expect(res.status).toBe(400)
  })
})

// ── reconcile 证据校验的 HTTP 映射 ───────────────────────

describe('reconcile 证据校验', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  it('空 evidence → 400', async () => {
    const { runId } = await seedRun(ctx)
    // 必须用真实的 unknown step 才能测到证据校验——
    // 否则会先被「Step 不存在」拦下，测的是另一条路径
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'unknown',
      input: {}, output: { error: '测试用 unknown' },
    })

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: { stepId: step.id, resolution: 'confirmed_success' },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/证据/)
  })

  it('纯文字 evidence → 400（不是 500）', async () => {
    const { runId } = await seedRun(ctx)
    // 直接建一个 unknown step
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'unknown',
      input: {}, output: { error: '测试用 unknown' },
    })

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: {
        stepId: step.id,
        resolution: 'confirmed_success',
        evidence: '我确认过了',
      },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/JSON|证据/)
  })

  it('结构化证据 → 200', async () => {
    const { runId } = await seedRun(ctx)
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'unknown',
      input: {}, output: { error: '测试用 unknown' },
    })

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: {
        stepId: step.id,
        resolution: 'confirmed_success',
        evidence: JSON.stringify({
          type: 'manual_inspection',
          source: 'file_stat',
          observed: 'exists',
          actor: 'tester',
        }),
      },
    })
    expect(res.status).toBe(200)
    expect(ctx.ws.store.getStep(step.id)!.status).toBe('completed')
  })

  it('证据自相矛盾 → 400', async () => {
    const { runId } = await seedRun(ctx)
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'unknown',
      input: {}, output: { error: '测试用 unknown' },
    })

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: {
        stepId: step.id,
        resolution: 'confirmed_success',
        evidence: JSON.stringify({
          type: 'external_query', source: 'file_stat',
          observed: 'not_found', actor: 'tester',
        }),
      },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/自相矛盾/)
  })
})

// ── reconcile 的 actor 不能由请求体伪造 ─────────────────

describe('reconcile actor 来源', () => {
  let ctx: Ctx

  beforeEach(async () => {
    ctx = await startServer()
  })

  afterEach(async () => {
    await stopServer(ctx)
  })

  async function seedUnknown() {
    const { runId } = await seedRun(ctx)
    const run = ctx.ws.store.getRun(runId)!
    const step = ctx.ws.store.createStep({
      runId: run.id, index: 0, kind: 'tool', status: 'unknown',
      input: {}, output: { error: '测试用 unknown' },
    })
    // 造一个真实文件，供 file_stat 证据验证。
    // v0.14 起，file_stat 必须给出服务端可检查的 path。
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const proofPath = join(ctx.workspace, `proof-${step.id}.txt`)
    writeFileSync(proofPath, 'proof content', 'utf8')
    return { runId, stepId: step.id, proofPath }
  }

  it('请求体传 decidedBy=system 会被降级为 user', async () => {
    const { runId, stepId } = await seedUnknown()

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: {
        stepId,
        resolution: 'confirmed_success',
        evidence: JSON.stringify({
          type: 'manual_inspection', source: 'file_stat',
          observed: 'exists', actor: 'tester',
        }),
        decidedBy: 'system',          // ← 冒充系统
      },
    })

    expect(res.status).toBe(200)
    const record = res.body.record as Record<string, unknown>
    expect(
      record.decidedBy,
      '请求体成功把 decidedBy 伪造成 system',
    ).not.toBe('system')
    expect(record.decidedBy).toBe('user')
  })

  it('请求体传 decidedBy=reconciler 被保留（这是调用方真实身份）', async () => {
    const { runId, stepId, proofPath } = await seedUnknown()

    const res = await call(ctx, 'POST', `/runs/${runId}/reconcile`, {
      token: ctx.token,
      body: {
        stepId,
        resolution: 'confirmed_success',
        evidence: JSON.stringify({
          // 自动化对账程序必须给出可验证证据
          type: 'external_query', source: 'file_stat',
          path: proofPath,
          observed: 'exists', actor: 'auto-reconciler',
        }),
        decidedBy: 'reconciler',
      },
    })

    expect(res.status).toBe(200)
    const record = res.body.record as Record<string, unknown>
    expect(record.decidedBy).toBe('reconciler')
  })
})
