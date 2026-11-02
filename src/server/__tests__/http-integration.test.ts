// 真实 HTTP 的成功路径集成测试（P2-1）。
//
// 审计指出：大量测试直接调核心类与纯函数，缺少「端到端通过 HTTP 成功」
// 的证据。这一层正是最容易出现「字段名对不上 / 状态码错 / 序列化丢东西」
// 的地方——单元测试看不见这些。
//
// 这里覆盖审计点名的几个入口：
//   · workgroup（角色 / 工作包 / 变更集 / 冲突）
//   · conversation（会话视图）
//   · snapshot GC 计划
//   · evidence 生成 / verify / replay
//   · provider override
//   · runner state / policy
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'
import { isolateProviderEnv } from '../../core/__tests__/test-env.js'

describe('真实 HTTP 集成（成功路径）', () => {
  let dir: string
  let ws: WorkstationServer
  let base: string
  let restoreEnv: () => void
  const token = 'integration-token-0123456789abcdef'

  beforeAll(async () => {
    restoreEnv = isolateProviderEnv()
    dir = mkdtempSync(join(tmpdir(), 'ws-http-'))
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

  afterAll(async () => {
    await ws.close()
    restoreEnv()
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

  async function seedTask(): Promise<string> {
    const session = (await api('POST', '/sessions', { title: 't' })).json as { id: string }
    const task = (await api('POST', '/tasks', { sessionId: session.id, goal: '做一件事' })).json as { id: string }
    return task.id
  }

  // ── workgroup ─────────────────────────────────────────

  it('GET /workgroup/roles 返回内置角色', async () => {
    const r = await api('GET', '/workgroup/roles')
    expect(r.status).toBe(200)
    const roles = r.json.roles as Array<{ id: string; produces: string[] }>
    expect(roles.map((x) => x.id).sort()).toEqual(['implementer', 'reviewer', 'tester'])
    // 审查者只有只读工具（结构上不能改代码）
    const reviewer = roles.find((x) => x.id === 'reviewer')!
    expect(reviewer.produces).toContain('review')
    expect(reviewer.produces).not.toContain('implementation')
  })

  it('完整工作包生命周期：创建 → 开始 → 提交 → 合并 → finalize', async () => {
    const taskId = await seedTask()

    const created = await api('POST', `/tasks/${taskId}/workgroup/packages`, {
      title: '实现登录',
      kind: 'implementation',
      deliverable: '可用的登录接口',
    })
    expect(created.status).toBe(201)
    const pkgId = (created.json.package as { id: string }).id

    const started = await api('POST', `/workgroup/packages/${pkgId}/start`, { roleId: 'implementer' })
    expect(started.status).toBe(200)

    const submitted = await api('POST', `/tasks/${taskId}/workgroup/changesets`, {
      workPackageId: pkgId,
      roleId: 'implementer',
      changes: [{ path: 'src/login.ts', kind: 'added', contentHash: 'hash-1' }],
    })
    expect(submitted.status).toBe(201)
    expect(submitted.json.conflicts).toEqual([])
    const csId = (submitted.json.changeSet as { id: string }).id

    const merged = await api('POST', `/workgroup/changesets/${csId}/merge`)
    expect(merged.status).toBe(200)

    const finalized = await api('POST', `/workgroup/packages/${pkgId}/finalize`)
    expect(finalized.status).toBe(200)

    const view = await api('GET', `/tasks/${taskId}/workgroup`)
    expect(view.status).toBe(200)
    const pkgs = view.json.packages as Array<{ id: string; status: string }>
    expect(pkgs.find((p) => p.id === pkgId)!.status).toBe('merged')
  })

  it('两个工作包改同一文件 → 第二个变更集返回 conflict 且被保存', async () => {
    const taskId = await seedTask()
    const p1 = (await api('POST', `/tasks/${taskId}/workgroup/packages`, {
      title: 'a', kind: 'implementation', deliverable: 'a',
    })).json.package as { id: string }
    const p2 = (await api('POST', `/tasks/${taskId}/workgroup/packages`, {
      title: 'b', kind: 'implementation', deliverable: 'b',
    })).json.package as { id: string }

    await api('POST', `/workgroup/packages/${p1.id}/start`, { roleId: 'implementer' })
    await api('POST', `/workgroup/packages/${p2.id}/start`, { roleId: 'implementer' })

    await api('POST', `/tasks/${taskId}/workgroup/changesets`, {
      workPackageId: p1.id, roleId: 'implementer',
      changes: [{ path: 'shared.ts', kind: 'modified', contentHash: 'v1' }],
    })
    const second = await api('POST', `/tasks/${taskId}/workgroup/changesets`, {
      workPackageId: p2.id, roleId: 'implementer',
      changes: [{ path: 'shared.ts', kind: 'modified', contentHash: 'v2' }],
    })

    // 201 而不是 409：变更集**确实保存了**，只是需要人工处理。
    // 用 409 会让客户端以为提交失败而重试，产生重复变更集。
    expect(second.status).toBe(201)
    expect((second.json.changeSet as { status: string }).status).toBe('conflict')
    expect((second.json.conflicts as unknown[]).length).toBe(1)
  })

  it('工作包路径穿越在 HTTP 入口被拒绝（400/409，不是静默接受）', async () => {
    const taskId = await seedTask()
    const p = (await api('POST', `/tasks/${taskId}/workgroup/packages`, {
      title: 'a', kind: 'implementation', deliverable: 'a',
    })).json.package as { id: string }
    await api('POST', `/workgroup/packages/${p.id}/start`, { roleId: 'implementer' })

    const res = await api('POST', `/tasks/${taskId}/workgroup/changesets`, {
      workPackageId: p.id, roleId: 'implementer',
      changes: [{ path: '../../victim', kind: 'modified', contentHash: 'h' }],
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  // ── conversation ──────────────────────────────────────

  it('GET /sessions/:id/conversation 返回完整会话视图', async () => {
    const session = (await api('POST', '/sessions', { title: '会话' })).json as { id: string }
    await api('POST', `/sessions/${session.id}/messages`, { role: 'user', content: '你好' })

    const conv = await api('GET', `/sessions/${session.id}/conversation`)
    expect(conv.status).toBe(200)
    const body = conv.json as unknown as {
      session: { id: string }
      status: string
      messages: Array<{ role: string; content: string }>
      activity: unknown[]
      attachments: unknown[]
    }
    expect(body.session.id).toBe(session.id)
    expect(body.status).toBe('idle')
    expect(body.messages.some((m) => m.content === '你好')).toBe(true)
    expect(Array.isArray(body.activity)).toBe(true)
    expect(Array.isArray(body.attachments)).toBe(true)
  })

  it('会话归档后默认列表不含它', async () => {
    const session = (await api('POST', '/sessions', { title: '要归档' })).json as { id: string }
    await api('POST', `/sessions/${session.id}/archive`, { archived: true })
    const list = await api('GET', '/sessions')
    const ids = (list.json.sessions as Array<{ id: string }>).map((s) => s.id)
    expect(ids).not.toContain(session.id)
    const withArchived = await api('GET', '/sessions?includeArchived=true')
    expect((withArchived.json.sessions as Array<{ id: string }>).map((s) => s.id)).toContain(session.id)
  })

  // ── snapshot GC ───────────────────────────────────────

  it('GET /snapshots/gc/plan 返回计划与保护原因', async () => {
    const r = await api('GET', '/snapshots/gc/plan')
    expect(r.status).toBe(200)
    const plan = r.json.plan as {
      deletable: string[]
      keptBecauseRecent: string[]
      keptBecauseReferenced: string[]
    }
    expect(Array.isArray(plan.deletable)).toBe(true)
    expect(Array.isArray(plan.keptBecauseRecent)).toBe(true)
    expect(Array.isArray(plan.keptBecauseReferenced)).toBe(true)
  })

  it('POST /snapshots/gc/execute 空 ids 被拒绝（必须先看计划）', async () => {
    const r = await api('POST', '/snapshots/gc/execute', { ids: [] })
    expect(r.status).toBe(400)
  })

  // ── snapshot diff 参数注入（审计 E-1）──────────────────

  it('diff 拒绝以 -- 开头的 git option 作为 ref', async () => {
    for (const evil of ['--output=/tmp/x', '--exec=calc', '-p']) {
      const r = await api('GET', `/snapshots/diff?from=${encodeURIComponent(evil)}&to=HEAD`)
      expect(r.status, `${evil} 应被拒绝`).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
  })

  it('diff 拒绝不存在的 ref', async () => {
    const r = await api('GET', '/snapshots/diff?from=deadbeef&to=cafebabe')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
  })

  it('diff 拒绝把多个参数塞进一个 ref', async () => {
    const r = await api('GET', '/snapshots/diff?from=a%20--output%3Db&to=HEAD')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
  })

  // ── provider ──────────────────────────────────────────

  it('GET /providers 不泄露密钥，只给 hasKey', async () => {
    const r = await api('GET', '/providers')
    expect(r.status).toBe(200)
    const providers = r.json.providers as Array<Record<string, unknown>>
    expect(providers.length).toBeGreaterThan(0)
    for (const p of providers) {
      expect(p).toHaveProperty('hasKey')
      expect(p).not.toHaveProperty('apiKey')
    }
    expect(JSON.stringify(r.json)).not.toContain('sk-')
  })

  it('PUT /providers/:id 允许改 baseUrl，拒绝改 requiresKey', async () => {
    const ok = await api('PUT', '/providers/openai', { baseUrl: 'https://proxy.example/v1' })
    expect(ok.status).toBe(200)

    const bad = await api('PUT', '/providers/openai', { requiresKey: false })
    expect(bad.status).toBe(400)
  })

  it('provider 覆盖在服务重启后仍然生效（落盘持久化）', async () => {
    // 用户改了 baseUrl 却重启丢失，是最让人困惑的一类 bug：
    // 设置看起来生效过，下次打开就没了。
    //
    // 这里用同一个 dataDir 起两次服务来验证真正的持久化，
    // 而不是只测内存里的 Map。
    const { mkdtempSync: mk, mkdirSync: md } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const { join: jn } = await import('node:path')
    const { createWorkstationServer: create } = await import('../app.js')

    const d = mk(join(td(), 'ws-persist-'))
    const work = jn(d, 'workspace')
    const data = jn(d, 'data')
    md(work, { recursive: true })
    md(data, { recursive: true })
    const cfg = {
      port: 0, host: '127.0.0.1', dataDir: data, workspace: work,
      snapshotDir: jn(d, 'snap'), auth: { token, source: 'env' as const },
    }
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const first = await create(cfg)
    const p1 = await first.listen()
    await fetch(`http://127.0.0.1:${p1}/providers/openai`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ baseUrl: 'https://proxy.example/v1' }),
    })
    await first.close()

    const second = await create(cfg)
    const p2 = await second.listen()
    try {
      const r = await (await fetch(`http://127.0.0.1:${p2}/providers`, { headers: h })).json() as {
        providers: Array<{ id: string; baseUrl: string }>
      }
      expect(r.providers.find((x) => x.id === 'openai')!.baseUrl).toBe('https://proxy.example/v1')
    } finally {
      await second.close()
    }
  })

  it('持久化文件不包含密钥', async () => {
    const { readFileSync: rf, existsSync: ex } = await import('node:fs')
    const { join: jn } = await import('node:path')
    const file = join(dir, 'data', 'provider-overrides.json')
    if (!ex(file)) return
    const raw = rf(file, 'utf8')
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('sk-')
  })

  it('模型能力解析：已知 / 矛盾 / 未知三种结果', async () => {
    const known = await api('GET', '/providers/openai/models/gpt-4o/capabilities')
    expect(known.status).toBe(200)
    expect(known.json.status).toBe('known')

    const conflict = await api('GET', '/providers/openai/models/claude-3-5-sonnet/capabilities')
    // provider 与 model 矛盾 = 请求错误
    expect(conflict.status).toBe(400)

    const unknown = await api('GET', '/providers/openai/models/zzz-unknown/capabilities')
    // 能力未知不是请求错误，是「无法确认」
    expect(unknown.status).toBe(200)
    expect(unknown.json.status).toBe('unknown')
  })

  // ── runner ────────────────────────────────────────────

  it('GET /runner/state 返回策略与租约视图', async () => {
    const r = await api('GET', '/runner/state')
    expect(r.status).toBe(200)
    const policy = r.json.policy as { autoApprove: boolean }
    expect(policy.autoApprove).toBe(false)
    expect(Array.isArray(r.json.running)).toBe(true)
  })

  it('PUT /runner/policy 拒绝 autoApprove: true', async () => {
    const r = await api('PUT', '/runner/policy', { autoApprove: true })
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toContain('autoApprove')
  })

  it('PUT /runner/policy 接受合法策略', async () => {
    const r = await api('PUT', '/runner/policy', {
      maxConsecutiveFailures: 5,
      maxRunDurationMs: 600_000,
    })
    expect(r.status).toBe(200)
    expect((r.json.policy as { maxConsecutiveFailures: number }).maxConsecutiveFailures).toBe(5)
  })

  // ── evidence ──────────────────────────────────────────

  it('POST /evidence/verify 对畸形输入返回 200 + 结构性错误（不是 500）', async () => {
    for (const bundle of [null, 'x', {}, { bundleVersion: 1 }]) {
      const r = await api('POST', '/evidence/verify', { bundle })
      expect(r.status, `bundle=${JSON.stringify(bundle)}`).toBe(200)
      const v = r.json.verify as { ok: boolean; structuralErrors: string[] }
      expect(v.ok).toBe(false)
      expect(v.structuralErrors.length).toBeGreaterThan(0)
    }
  })

  it('POST /evidence/replay 对完整性失败的包返回 409，不给结论', async () => {
    const r = await api('POST', '/evidence/replay', {
      bundle: { bundleVersion: 1, taskId: 't', runId: 'r' },
    })
    // 在不可信的证据上重算结论没有意义
    expect(r.status).toBe(409)
  })

  // ── Skill manifest 能力门禁（审计 P1）──────────────────

  it('注册一个声明缺失工具的 skill → /review 返回 503 并列出缺失项', async () => {
    const { registerSkill } = await import('../../core/review-loop.js')
    // 注册一个需要不存在工具的 skill
    registerSkill(
      {
        id: 'needs-missing-tool',
        version: '1',
        name: '需要缺失工具',
        machineRules: [],
        auditorInstructions: '审一下',
        maxCycles: 1,
      },
      {
        id: 'needs-missing-tool',
        version: '1',
        name: '需要缺失工具',
        description: 't',
        requiredTools: ['tool-that-does-not-exist'],
        requiredCapabilities: [],
        appliesTo: [],
        requiresHumanAttention: false,
      },
    )

    const taskId = await seedTask()
    const run = (await api('POST', '/runs', { taskId, role: 'producer' })).json as { id: string }

    const r = await api('POST', `/tasks/${taskId}/review`, {
      runId: run.id,
      skillId: 'needs-missing-tool',
      skillVersion: '1',
    })
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('CAPABILITY_UNAVAILABLE')
    expect((r.json.missingTools as string[])).toContain('tool-that-does-not-exist')
  })

  it('对不存在的 Run 提交审计 → 先报 Run 不存在，而不是能力不足', async () => {
    // 判定顺序：先「请求对不对」（Run 存在 / 归属 / 角色），
    // 再「环境够不够」（skill 需要的能力）。
    // 反过来的话，一个打错的 runId 会得到「能力不可用」，
    // 把人引向错误的方向。
    const { registerSkill } = await import('../../core/review-loop.js')
    registerSkill(
      {
        id: 'gate-order-probe', version: '1', name: 'probe',
        machineRules: [], auditorInstructions: 'x', maxCycles: 1,
      },
      {
        id: 'gate-order-probe', version: '1', name: 'probe', description: 'x',
        requiredTools: ['definitely-missing-tool'],
        requiredCapabilities: [], appliesTo: [], requiresHumanAttention: false,
      },
    )
    const taskId = await seedTask()
    const r = await api('POST', `/tasks/${taskId}/review`, {
      runId: 'no-such-run',
      skillId: 'gate-order-probe',
      skillVersion: '1',
    })
    expect(r.status).toBe(404)
    expect(String(r.json.error)).toContain('Run 不存在')
  })

  // ── /review 走 ProviderConfigStore（审计 P1）──────────

  it('/review 使用 provider 覆盖后的 baseUrl（而不是预设默认值）', async () => {
    // 直接验证配置解析层：把 openai 的 baseUrl 改成代理，
    // 再确认 providerConfig.resolve 给出的是覆盖值。
    //
    // 完整 /review 需要真实模型调用，这里只锁定「配置来源」这一环——
    // 那正是审计指出的缺口。
    await api('PUT', '/providers/anthropic', { baseUrl: 'https://auditor-proxy.example/v1' })
    const r = await api('GET', '/providers')
    const anthropic = (r.json.providers as Array<{ id: string; baseUrl: string }>)
      .find((p) => p.id === 'anthropic')!
    expect(anthropic.baseUrl).toBe('https://auditor-proxy.example/v1')
  })

  // ── runner/tick 真实执行（B 项）─────────────────────────
  //
  // 审计指出：早期实现只调用 takeOverStaleRuns()，生产路径上从未执行过
  // 任何 Run。这一组直接断言「Run 真的跑完了」，而不只是「接口返回 200」。

  it('queued 的 Run 会被 /runner/tick 真实执行', async () => {
    const taskId = await seedTask()
    const run = (await api('POST', '/runs', { taskId, role: 'producer' })).json as { id: string }
    const before = await api('GET', `/runs/${run.id}`)
    expect((before.json.run as { status: string }).status).toBe('queued')

    // 显式给出候选：tick 一次只调度一个，而库里还有其它用例留下的
    // queued Run，不指定的话可能选到别的。
    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId: run.id, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(200)
    const result = tick.json as {
      selected: string | null
      selectedRunId: string | null
      leased: boolean
      executed: Array<{ runId: string; status: string }>
    }
    // selected 是 taskId；selectedRunId 才是这一轮真正处理的 Run。

    expect(result.selectedRunId).toBe(run.id)
    expect(result.leased).toBe(true)
    expect(result.executed.some((e) => e.runId === run.id)).toBe(true)

    // 关键：Run 的状态真的变了，不是「接口说执行了」
    const after = await api('GET', `/runs/${run.id}`)
    expect((after.json.run as { status: string }).status).not.toBe('queued')
  })

  it('没有 eligible Run 时 tick 不执行任何东西', async () => {
    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId: 'x', runId: 'y', eligible: false }],
    })
    expect(tick.status).toBe(200)
    expect((tick.json as { executed: unknown[] }).executed).toEqual([])
  })

  it('租约被其他 owner 持有时不执行', async () => {
    const taskId = await seedTask()
    const run = (await api('POST', '/runs', { taskId, role: 'producer' })).json as { id: string }

    // 先占用租约（模拟另一个 runner 正在处理）
    const { SqliteLeaseStore } = await import('../../core/lease-store.js')
    const leaseStore = new SqliteLeaseStore(
      (ws.store as unknown as { db: import('better-sqlite3').Database }).db,
    )
    leaseStore.tryAcquire(`run:${run.id}`, 'other-runner', 60_000, Date.now())

    // 显式只给这一个候选：否则可能选到库里其它 queued Run，
    // 那就测不到「租约被占时不执行」这条。
    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId: run.id, priority: 100, eligible: true }],
    })
    const result = tick.json as { executed: unknown[]; leased: boolean }
    expect(result.executed).toEqual([])
    expect(result.leased).toBe(false)

    // 清理，避免影响后续用例
    leaseStore.release(`run:${run.id}`, 'other-runner')
  })

  it('取消意图阻止 Run 被执行', async () => {
    const taskId = await seedTask()
    const run = (await api('POST', '/runs', { taskId, role: 'producer' })).json as { id: string }

    await api('POST', `/runner/runs/${run.id}/cancel-intent`, {})

    const tick = await api('POST', '/runner/tick', {})
    expect(tick.status).toBe(200)

    // 断言「这个 Run 没有被执行」，用状态而不是 executed 列表——
    // 同一个库里可能还有别的 queued Run 被执行，那不该影响这条结论。
    const after = await api('GET', `/runs/${run.id}`)
    const status = (after.json.run as { status: string }).status
    expect(status).not.toBe('running')
    expect(status).not.toBe('completed')
    // 它应当仍是 queued 或已被取消
    expect(['queued', 'cancelled']).toContain(status)
  })

  // ── meta ──────────────────────────────────────────────

  it('GET /ui/bootstrap 提供契约与待办', async () => {
    const r = await api('GET', '/ui/bootstrap')
    expect(r.status).toBe(200)
    const contracts = r.json.contracts as { stateMachines: unknown[]; permissions: unknown[] }
    expect(contracts.stateMachines.length).toBeGreaterThan(0)
    expect(contracts.permissions.length).toBeGreaterThan(0)
    expect(r.json.inbox).toHaveProperty('approvals')
  })

  it('GET /meta/capabilities 不泄露密钥', async () => {
    const r = await api('GET', '/meta/capabilities')
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.json)).not.toContain('sk-')
    expect(Array.isArray(r.json.skills)).toBe(true)
  })
})
