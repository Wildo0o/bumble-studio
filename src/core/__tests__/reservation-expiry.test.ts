// 过期预留的释放与晚到结算。
//
// TASK 第 10 项：「过期的 reservation 是否仍然占用额度」——是，已实现。
// 但实现只做了一半：
//
//   · settleBudget 允许 expired → settled（晚到的调用真的花了钱）
//   · releaseBudget **只认** status='reserved'
//
// 结果是：一个已经过期、确认根本没发生的调用，永远释放不掉，
// 那笔额度就永久占着 Task 的预算。而 expireReservations 的文档
// 明确写着「释放只能通过 releaseBudget 或 settleBudget 两条明确路径」——
// 其中一条对过期记录根本不通。
//
// 这不是「保守」，是**无法收回的泄漏**：额度占用会一直累积到
// 后续调用全部被预算拒绝，而账上又没有任何真实花费。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'

describe('过期预留的两条出口', () => {
  let dir: string
  let store: Store
  let runId: string
  let taskId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-resvexp-'))
    store = new Store(join(dir, 't.db'))
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    taskId = task.id
    runId = store.createRun({ taskId, role: 'producer', budget: {} }).id
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function reserveExpired(owner: string, inputTokens = 100): string {
    const r = store.reserveBudget({
      runId, taskId, purpose: 'model',
      inputTokens, ttlMs: 1, owner,
    })
    if (!r.ok) throw new Error(`预留失败：${r.reason}`)
    store.expireReservations(Date.now() + 1000)
    const resv = store.getReservation(r.reservationId)!
    // 前提校验：确实已经过期
    expect(resv.status).toBe('expired')
    return r.reservationId
  }

  it('过期后确认调用没发生：同一 owner 可以 release，额度退回', () => {
    const id = reserveExpired('worker-1')
    expect(store.reservedBudget(taskId).inputTokens).toBe(100)

    const released = store.releaseBudget(id, { owner: 'worker-1' })

    expect(released, '过期的预留无法释放，额度永久泄漏').toBe(true)
    expect(store.getReservation(id)!.status).toBe('released')
    expect(store.reservedBudget(taskId).inputTokens).toBe(0)
    // 释放不是结算：不能凭空记一笔 usage
    expect(store.getRun(runId)!.usage.inputTokens).toBe(0)
  })

  it('过期后 release 仍然受 owner 约束：别人不能替你释放', () => {
    const id = reserveExpired('worker-1')

    const released = store.releaseBudget(id, { owner: 'worker-2' })

    expect(released, '不同 owner 竟然能释放').toBe(false)
    expect(store.getReservation(id)!.status).toBe('expired')
    expect(store.reservedBudget(taskId).inputTokens).toBe(100)
  })

  it('release 过的记录不能再被结算（不能复活成花费）', () => {
    const id = reserveExpired('worker-1')
    expect(store.releaseBudget(id, { owner: 'worker-1' })).toBe(true)

    // 晚到的结算：这次调用已被确认没发生，不能记账
    const settled = store.settleBudget(id, { inputTokens: 80 }, { owner: 'worker-1' })

    expect(settled, '已释放的预留被结算了').toBe(false)
    expect(store.getRun(runId)!.usage.inputTokens).toBe(0)
    expect(store.getReservation(id)!.status).toBe('released')
  })

  it('过期后晚到结算：同一 owner 仍然生效，且只记一次', () => {
    const id = reserveExpired('worker-1')

    expect(store.settleBudget(id, { inputTokens: 80 }, { owner: 'worker-1' })).toBe(true)
    // 重复结算幂等
    expect(store.settleBudget(id, { inputTokens: 80 }, { owner: 'worker-1' })).toBe(true)

    expect(store.getRun(runId)!.usage.inputTokens).toBe(80)
    expect(store.reservedBudget(taskId).inputTokens).toBe(0)
  })
})
