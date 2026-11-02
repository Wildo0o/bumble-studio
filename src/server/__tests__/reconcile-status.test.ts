// reconcile 的 HTTP 状态码。
//
// 服务层把错误映射到状态码，但映射表是**按错误 code 或文案**匹配的。
// reconcile 抛的是普通 Error，所以只能走文案兜底——而文案里
// 没有兜底正则认得的词。
//
// 结果：明明是「请求有歧义，请指定 intentId」这种客户端问题，
// 却返回 500。调用方会以为服务端崩了，实际是它自己少传了参数。
//
// 这一层必须在真实 HTTP 上验证：Executor 单测只能证明「抛错了」，
// 证明不了「调用方收到什么」。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkstationServer, type WorkstationServer } from '../../server/app.js'
import { Store } from '../../core/store.js'

const TOKEN = 'reconcile-status-token-0123456789'

const EVIDENCE = JSON.stringify({
  type: 'manual_inspection', source: 'manual_review',
  observed: 'exists', actor: 'tester',
})

describe('reconcile 的 HTTP 状态码', () => {
  let dir: string
  let ws: WorkstationServer
  let base: string
  let store: Store

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-recstatus-'))
    const workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    ws = await createWorkstationServer({
      port: 0, host: '127.0.0.1', dataDir, workspace,
      snapshotDir: join(dir, 'snapshots'),
      auth: { token: TOKEN, source: 'env' },
    })
    base = `http://127.0.0.1:${await ws.listen()}`
    store = ws.store
  })

  afterAll(async () => {
    await ws.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  function makeRun() {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    return store.createRun({ taskId: task.id, role: 'producer', budget: {} })
  }

  function makeUnknownWithIntent(runId: string, index: number, suffix: string) {
    const step = store.createStep({
      runId, index, kind: 'tool', status: 'unknown',
      input: {}, output: { error: `步骤 ${suffix} 未知` },
    })
    const intent = store.getOrCreateIntent({
      runId, stepId: step.id, toolCallId: `call-${suffix}`,
      toolId: 'write_file', toolName: 'write_file',
      requestHash: `hash-${suffix}`, operationKey: `op-${suffix}`,
    }).intent
    store.startIntent(intent.id)
    store.markIntentUnknown(intent.id, '崩溃')
    return { step, intent }
  }

  it('多个 unknown 且没指定 intentId → 409（请求歧义，不是服务端故障）', async () => {
    const run = makeRun()
    const a = makeUnknownWithIntent(run.id, 0, 'a')
    makeUnknownWithIntent(run.id, 1, 'b')

    const res = await post(`/runs/${run.id}/reconcile`, {
      stepId: a.step.id,
      resolution: 'confirmed_success',
      evidence: EVIDENCE,
    })

    expect(res.status, `实际返回 ${res.status}：${JSON.stringify(res.body)}`).toBe(409)
    expect(String(res.body.error)).toMatch(/intentId|toolCallId/)
  })

  it('指定的 intentId 与 stepId 不匹配 → 409', async () => {
    const run = makeRun()
    const a = makeUnknownWithIntent(run.id, 0, 'a')
    const b = makeUnknownWithIntent(run.id, 1, 'b')

    const res = await post(`/runs/${run.id}/reconcile`, {
      stepId: a.step.id,
      intentId: b.intent.id,
      resolution: 'confirmed_success',
      evidence: EVIDENCE,
    })

    expect(res.status, `实际返回 ${res.status}：${JSON.stringify(res.body)}`).toBe(409)
  })

  it('重复 reconcile 已解决的 Step → 409', async () => {
    const run = makeRun()
    const a = makeUnknownWithIntent(run.id, 0, 'a')

    const first = await post(`/runs/${run.id}/reconcile`, {
      stepId: a.step.id, resolution: 'confirmed_success', evidence: EVIDENCE,
    })
    expect(first.status).toBe(200)

    const second = await post(`/runs/${run.id}/reconcile`, {
      stepId: a.step.id, resolution: 'confirmed_success', evidence: EVIDENCE,
    })
    expect(second.status, `实际返回 ${second.status}：${JSON.stringify(second.body)}`).toBe(409)
  })

  it('伪造 file_stat 证据（声称存在但文件不存在）→ 400', async () => {
    const run = makeRun()
    const a = makeUnknownWithIntent(run.id, 0, 'a')

    const res = await post(`/runs/${run.id}/reconcile`, {
      stepId: a.step.id,
      resolution: 'confirmed_success',
      evidence: JSON.stringify({
        type: 'external_query', source: 'file_stat',
        path: join(dir, 'definitely-not-here.txt'),
        observed: 'exists', actor: 'tester',
      }),
    })

    expect(res.status, `实际返回 ${res.status}：${JSON.stringify(res.body)}`).toBe(400)
    // 被拒绝之后 Step 必须还是 unknown——不能因为请求失败就顺手改状态
    expect(store.getStep(a.step.id)!.status).toBe('unknown')
  })
})
