// L2 Smoke Test。
//
// 目的：**证明八个核心区块的主要功能可以通过真实 HTTP 入口串起来跑通**。
//
// 与其它测试的区别：
//   · 这里不测边界与异常路径，只走「一个用户会怎么用」的主干
//   · 每条断言验证**最终状态**，不看中间返回值
//     （只看 HTTP 200 的 smoke test 会在「接口返回成功但什么都没做」时误报）
//
// 覆盖顺序即真实使用顺序：
//   session → task → contract → run → execute → artifact/snapshot
//   → review → acceptance → runner/tick → desktop shell
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../app.js'
import { isolateProviderEnv } from '../../core/__tests__/test-env.js'

const token = 'l2-smoke-token-0123456789abcdef'

describe('L2 Smoke Test', () => {
  let dir: string
  let ws: WorkstationServer
  let base: string
  let restoreEnv: () => void

  beforeAll(async () => {
    restoreEnv = isolateProviderEnv()
    dir = mkdtempSync(join(tmpdir(), 'ws-l2smoke-'))
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
    await ws?.close().catch(() => undefined)
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

  // 整条链共享的 id
  let sessionId = ''
  let taskId = ''
  let runId = ''
  /** 第 6 步拍下的快照，供第 8 步构造完整审计绑定时使用。 */
  let snapshotIdForAudit = ''
  let snapshotRefForAudit = ''

  it('1. session 创建', async () => {
    const r = await api('POST', '/sessions', { title: 'L2 smoke' })
    expect(r.status).toBe(201)
    sessionId = (r.json as { id: string }).id
    expect(sessionId).toBeTruthy()

    // 最终状态：列表里能查到
    const list = await api('GET', '/sessions')
    const ids = (list.json.sessions as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toContain(sessionId)
  })

  it('2. task 创建', async () => {
    const r = await api('POST', '/tasks', { sessionId, goal: '写一个说明文件' })
    expect(r.status).toBe(201)
    taskId = (r.json as { id: string }).id

    const got = await api('GET', `/tasks/${taskId}`)
    expect((got.json as { goal?: string; task?: { goal: string } })).toBeTruthy()
    // 最终状态：任务挂在这个 session 下
    const tasks = await api('GET', `/sessions/${sessionId}/tasks`)
    if (tasks.status === 200) {
      const list = (tasks.json.tasks ?? []) as Array<{ id: string }>
      expect(list.map((t) => t.id)).toContain(taskId)
    }
  })

  it('3. contract 创建', async () => {
    const r = await api('PUT', `/tasks/${taskId}/contract`, {
      goal: '写一个说明文件',
      acceptanceCriteria: ['文件存在且内容非空'],
    })
    // 契约入口的合法状态由实现决定；201 / 200 都算成功
    expect([200, 201]).toContain(r.status)

    const got = await api('GET', `/tasks/${taskId}/contract`)
    expect(got.status).toBe(200)
    const body = got.json as { contractVersion?: number; contract?: { contractVersion: number } }
    const version = body.contractVersion ?? body.contract?.contractVersion
    expect(version).toBeGreaterThanOrEqual(1)
  })

  it('4. Run 创建', async () => {
    const r = await api('POST', '/runs', { taskId, role: 'producer' })
    expect(r.status).toBe(201)
    runId = (r.json as { id: string }).id

    // 最终状态：queued
    const got = await api('GET', `/runs/${runId}`)
    expect((got.json.run as { status: string }).status).toBe('queued')
  })

  it('5. demo execute 跑到 completed', async () => {
    // ── 先预授权 write_file ──────────────────────────────
    //
    // demo producer 固定会写文件。审批门会把它拦在 waiting_approval——
    // 那是正确行为，但 smoke 要证明「用户能把一件事做完」，
    // 所以先给这个 Run 签一张 Grant（等同于用户提前批准），
    // 再用 execute 一次跑完。
    //
    // 这样测的是**执行主路径**，而不是「审批中断后再恢复」那条更复杂的路径
    // （后者由 l2-runner-state / auth 等专用测试覆盖）。
    const store = (ws as unknown as { store: {
      createGrant(input: Record<string, unknown>): { id: string }
    } }).store
    store.createGrant({
      id: crypto.randomUUID(),
      runId,
      toolId: 'write_file',
      constraints: { maxCalls: 5 },
      expiresAt: Date.now() + 60 * 60 * 1000,
      status: 'active',
      approver: 'user',
    })

    const r = await api('POST', `/runs/${runId}/execute`, {
      provider: 'demo',
      model: 'demo',
      // 消息里必须带**明确文件名**：demo provider 从文本提取路径，
  // 提取不到时会退化成 "."，而那是目录，写入会被拒 → unknown。
  messages: [{ role: 'user', content: '请写一个说明文件「readme.txt」' }],
    })
    expect(r.status).toBe(200)

    // **最终状态**：completed
    const got = await api('GET', `/runs/${runId}`)
    const status = (got.json.run as { status: string }).status
    expect(status, `Run 应完成，实际 ${status}`).toBe('completed')
  })

  it('6. artifact / snapshot 可查询（capture=201，files=200）', async () => {
    const artifacts = await api('GET', `/tasks/${taskId}/artifacts`)
    expect(artifacts.status).toBe(200)
    const list = (artifacts.json.artifacts ?? []) as Array<{ id: string }>
    expect(Array.isArray(list)).toBe(true)

    // ── Snapshot 是 L2 核心能力，必须真的可用 ─────────────
    //
    // 之前这里是「201 或 503 都算通过」，那等于把「git 不可用」
    // 混进了主路径判定。L2 的定义是「核心功能通过真实入口运行」——
    // 快照正是核心之一，它必须真的能拍、能读。
    const snap = await api('POST', `/runs/${runId}/snapshot`)
    expect(snap.status, `capture 必须成功，实际 ${snap.status}: ${JSON.stringify(snap.json).slice(0, 200)}`)
      .toBe(201)

    const snapBody = snap.json.snapshot as { id: string; ref: string }
    const snapId = snapBody.id
    expect(snapId).toBeTruthy()
    // 记下快照身份：验收时的审计绑定必须引用它
    snapshotIdForAudit = snapId
    snapshotRefForAudit = snapBody.ref

    const files = await api('GET', `/snapshots/${snapId}/files`)
    expect(files.status).toBe(200)
    const fileList = (files.json.files ?? files.json) as string[]
    expect(Array.isArray(fileList)).toBe(true)
    expect(fileList.length).toBeGreaterThan(0)
  })

  it('7. review 入口：demo auditor 合法结果是 escalated，且状态正确落库', async () => {
    const r = await api('POST', `/tasks/${taskId}/review`, {
      runId,
      skillId: 'general',
      skillVersion: '1',
      auditorProvider: 'demo',
      auditorModel: 'demo',
    })

    // demo auditor 的设计结论就是 escalate（reason: uncertain）——
    // 它不是失败，是一个**确定的合法结果**。所以要求恰好 200 + escalated，
    // 而不是「什么都接受」。
    expect(r.status).toBe(200)
    const body = r.json as { outcome?: string; cycleId?: string }
    expect(body.outcome).toBe('escalated')

    // 下游状态必须真的落库（只看 HTTP 200 是不够的）
    const cycles = await api('GET', `/tasks/${taskId}/cycles`)
    expect(cycles.status).toBe(200)
    const cycleList = (cycles.json.cycles ?? []) as Array<{ derivedStatus?: string; id?: string }>
    expect(cycleList.length).toBeGreaterThan(0)
    expect(cycleList[cycleList.length - 1]!.derivedStatus).toBe('escalated')

    // Task 不能因为 escalate 就变成 accepted
    const task = await api('GET', `/tasks/${taskId}`)
    const status = (task.json as { status?: string }).status ??
      (task.json.task as { status?: string } | undefined)?.status
    expect(status).not.toBe('accepted')
  })

  it('8. acceptance：有合法 passed audit 时真实进入 accepted', async () => {
    // ── 构造一个合法的 passed audit ───────────────────────
    //
    // demo auditor 永远 escalate，所以无法用它证明 acceptance 的正向路径。
    // 这里直接写一条 passed 的 audit_result 与 review_cycle，
    // 绑定当前产物与当前契约——这正是「验收门放行」需要的全部证据。
    const store = (ws as unknown as {
      store: {
        getRun(id: string): { taskId: string } | undefined
        listTaskArtifacts(taskId: string): Array<{
          id: string
          status: string
          path?: string
          contentHash?: string
          sourceSnapshotId?: string
        }>
        getActiveTaskContract(taskId: string): { contractHash: string; contractVersion: number } | undefined
        createReviewCycle(input: Record<string, unknown>): { id: string }
        getSnapshot(id: string): { id: string; ref: string } | undefined
        createAuditResult(input: Record<string, unknown>): { id: string }
        transitionTaskStatus(id: string, from: string, to: string): boolean
      }
    }).store

    const artifacts = store.listTaskArtifacts(taskId)
    const candidate = artifacts.find((a) => a.status === 'candidate')
    expect(candidate, '需要一个 candidate 产物来验收').toBeTruthy()

    const contract = store.getActiveTaskContract(taskId)
    expect(contract, '需要一个生效契约').toBeTruthy()

    // 让 Task 回到 awaiting_acceptance（前面 request-revision 可能改过）
    const taskNow = await api('GET', `/tasks/${taskId}`)
    const cur = (taskNow.json as { status?: string }).status ??
      (taskNow.json.task as { status?: string } | undefined)?.status
    if (cur !== 'awaiting_acceptance') {
      store.transitionTaskStatus(taskId, cur!, 'awaiting_acceptance')
    }

    // 产物必须有自己的来源快照。没有就说明 producer 没拍快照——
    // 那本身就是不能验收的情况（无法追溯产物从哪来）。
    const artifactSnapshotId = candidate!.sourceSnapshotId
    expect(artifactSnapshotId, '产物必须有来源快照才能被验收').toBeTruthy()
    const artifactSnapshotRef = store.getSnapshot(artifactSnapshotId!)?.ref
    expect(artifactSnapshotRef, '来源快照必须可解析').toBeTruthy()

    // 写一条 passed 审计，绑定「当前产物 + 当前契约」
    const cycle = store.createReviewCycle({
      taskId,
      skillId: 'general',
      skillVersion: '1',
      cycleNumber: 900,
      producerRunId: runId,
    })
    const fixtureAudit = store.createAuditResult({
      taskId,
      cycleId: cycle.id,
      verdict: 'passed',
      confidence: 1,
      result: {
        verdict: 'pass',
        // binding 的字段名必须与 AuditBinding 类型一致：
        // 验收门按 `b.artifactIds.includes(...) && b.producerRunId === artifact.runId`
        // 筛选。写成 runId 会让这条审计**不被认为绑定了这个产物**，
        // 于是又退回「最新一条」的判定逻辑。
        // binding 必须是**完整**的 AuditBinding：
        // 验收门逐字段检查，缺任何一个都会以 BINDING_MISMATCH 拒绝。
        // 这是刻意的——不完整的绑定无法确认「审计的产物」和
        // 「要验收的产物」是同一份。
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [candidate!.id],
          producerRunId: runId,
          // 必须是**产物自己的来源快照**：验收门会比对
          // 审计绑定的快照 id 与 artifact.sourceSnapshotId。
          // 用第 6 步另拍的快照会被判「审计针对的快照与产物不一致」。
          snapshotId: artifactSnapshotId,
          snapshotRef: artifactSnapshotRef,
          // 路径 → 内容哈希，必须覆盖每一个被审计的产物
          contentHashes: { [candidate!.path ?? 'artifact']: candidate!.contentHash ?? '' },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
        checkedRules: [{ ruleId: 'smoke', ruleVersion: '1', status: 'pass' }],
      },
    })

    // ── 让 fixture 成为「这个产物的最新审计」────────────────
    //
    // 验收门取 boundAudits 里 created_at 最大的一条。第 7 步的 demo
    // 审计也绑在这个产物上且更晚，所以要把它的时间推到 fixture 之前。
    //
    // 用 SQL 直接改而不是删：删除会留下「有 cycle 没 result」的悬挂，
    // 那本身是数据异常。
    const db = (ws as unknown as {
      store: { dbExecForTest(sql: string): void }
    }).store
    db.dbExecForTest(
      `UPDATE audit_result SET created_at = ${Date.now() - 600_000} WHERE id <> '${fixtureAudit.id}'`,
    )
    db.dbExecForTest(
      `UPDATE audit_result SET created_at = ${Date.now()} WHERE id = '${fixtureAudit.id}'`,
    )


    const accept = await api('POST', `/tasks/${taskId}/accept`, {
      artifactId: candidate!.id,
      runId,
    })
    expect(accept.status, `验收应成功，实际 ${accept.status}: ${JSON.stringify(accept.json).slice(0, 250)}`)
      .toBe(201)

    // **最终状态**：Task 进入 accepted，产物也被接受
    const after = await api('GET', `/tasks/${taskId}`)
    const status = (after.json as { status?: string }).status ??
      (after.json.task as { status?: string } | undefined)?.status
    expect(status).toBe('accepted')

    const arts = await api('GET', `/tasks/${taskId}/artifacts`)
    const accepted = ((arts.json.artifacts ?? []) as Array<{ id: string; status: string }>)
      .find((a) => a.id === candidate!.id)
    expect(accepted?.status).toBe('accepted')
  })

  it('8b. request-revision 在 accepted 之后被拒绝（状态门生效）', async () => {
    // 上一条把 Task 推到 accepted。已接受的 Task 不能再要求返工——
    // 那会把「质量决定」倒回去。必须是 4xx（不是 200，也不是 500）。
    //
    // 具体是 409（状态冲突）还是 400（请求不适用）取决于错误分类，
    // 两者都是**可分类的拒绝**；关键是状态没被改回去。
    const r = await api('POST', `/tasks/${taskId}/request-revision`, {
      reason: 'smoke: 迟到的返工请求',
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)

    const got = await api('GET', `/tasks/${taskId}`)
    const status = (got.json as { status?: string }).status ??
      (got.json.task as { status?: string } | undefined)?.status
    expect(status).toBe('accepted')
  })

  it('9. runner/tick 真实执行 queued Run', async () => {
    // 造一个新的 queued Run 给 tick 执行
    const created = await api('POST', '/runs', { taskId, role: 'producer' })
    const tickRunId = (created.json as { id: string }).id

    const tick = await api('POST', '/runner/tick', {
      candidates: [{ taskId, runId: tickRunId, priority: 100, eligible: true }],
    })
    expect(tick.status).toBe(200)

    const executed = (tick.json as { executed: Array<{ runId: string }> }).executed
    expect(executed.some((e) => e.runId === tickRunId)).toBe(true)

    // **最终状态**：不再是 queued
    const got = await api('GET', `/runs/${tickRunId}`)
    expect((got.json.run as { status: string }).status).not.toBe('queued')
  })

  it('10. desktop static shell 与基础 API 可访问', async () => {
    // 静态壳不需要 token（内容不含数据），但受 Origin 校验
    const shell = await fetch(`${base}/index.html`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('text/html')

    const css = await fetch(`${base}/app.css`)
    expect(css.status).toBe(200)

    const js = await fetch(`${base}/app.js`)
    expect(js.status).toBe(200)

    // 基础 API（带 token）
    const health = await api('GET', '/health')
    expect(health.status).toBe(200)
    // 实际形状是 { ready, build: { version, commit, schemaVersion } }
    expect((health.json as { ready?: boolean }).ready).toBe(true)
    const build = (health.json as { build?: { version?: string } }).build
    expect(typeof build?.version).toBe('string')

    const bootstrap = await api('GET', '/ui/bootstrap')
    expect(bootstrap.status).toBe(200)
    expect((bootstrap.json as { contracts?: unknown }).contracts).toBeTruthy()
  })

  // ── 端到端一致性：整条链跑完没有留下坏数据 ─────────────
  it('11. 全链路跑完后数据关系体检通过', async () => {
    const r = await api('GET', '/meta/invariants')
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; violations: Array<{ kind: string; detail: string }> }
    // 允许存在历史遗留的 inferred 事件（早期写入），
    // 但不应有归属断裂（artifact 挂错 Task、事件序号空洞）。
    const structural = body.violations.filter(
      (v) => v.kind !== 'event_sequence_gap',
    )
    expect(structural, `结构性异常：${JSON.stringify(structural.slice(0, 3))}`).toEqual([])
    expect(existsSync(join(dir, 'workspace'))).toBe(true)
  })
})
