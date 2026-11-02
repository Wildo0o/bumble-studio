// 领域事件存储。
//
// 事件是**事实记录**，不是 UI 缓存。三条契约：
//
//   1. `sequence` 对 (aggregateType, aggregateId) 唯一且连续，从 1 开始。
//      由「查询当前最大序号 + 插入」在**同一个事务**里完成。
//      better-sqlite3 是同步的，事务天然串行——这是一条真实存在的保证，
//      不是「通常够用」。唯一索引 idx_event_aggregate_seq 是最后一道防线：
//      即使有人绕过这里直接写 SQL，重复序号也会被数据库拒绝。
//
//   2. `correlationId` 把「同一次操作产生的事件」串起来。
//      一次 Run 的执行、一次审批恢复、一次验收，各自有稳定的关联 id。
//
//   3. `actor` 记录谁写的（user / system / coordinator / role / provider）。
//      它和业务上的「谁决定」不是一回事，但必须是服务端决定的，不是请求体声明的。
//
// kind 的合法性：
//   默认走目录校验（见 event-catalog.ts）。未定义的 kind 会被拒绝——
//   静默接受拼错的 kind，等于让 replay 在几个月后才失败。
//   迁移脚本需要写目录外的 kind 时，用 `allowUnknownKind`。
import type Database from 'better-sqlite3'
import type {
  DomainEvent,
  EventActor,
  EventAggregateType,
  EventAppendOptions,
} from '../shared/types.js'
import { eventKindDefinition } from './event-catalog.js'

export interface AppendEventArgs {
  /** 与这个事件相关的 Run。聚合不是 run 时也要给——用于按 run 检索。 */
  runId: string
  kind: string
  payload: unknown
  options?: EventAppendOptions
}

export interface ListEventArgs {
  /** 按关联 id 查询（一次操作的全部事件） */
  correlationId?: string
  /** 按聚合查询 */
  aggregateType?: EventAggregateType
  aggregateId?: string
  limit?: number
}

interface EventRow {
  id: number
  runId: string
  kind: string
  payload: string
  createdAt: number
  aggregateType: string
  aggregateId: string
  sequence: number
  actor: string
  correlationId: string
}

function mapEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    aggregateType: row.aggregateType as EventAggregateType,
    aggregateId: row.aggregateId,
    sequence: row.sequence,
    kind: row.kind,
    actor: row.actor as EventActor,
    payload: JSON.parse(row.payload) as unknown,
    occurredAt: row.createdAt,
    correlationId: row.correlationId,
  }
}

const MAX_LIST_LIMIT = 1000

/**
 * 推导事件的聚合 id。
 *
 * 规则见 append 里的注释。核心原则：
 *   **宁可用 payload 里的真实 id，也不要把 runId 硬塞给 task 聚合。**
 * 后者会让「按 Task 查事件」永远为空，而空结果不会报错——
 * 那是最难发现的错误。
 */
function resolveAggregateId(
  aggregateType: string,
  runId: string,
  payload: unknown,
): { id: string; inferred: boolean } {
  // run 聚合：runId 就是聚合 id，这是正确的映射。
  if (aggregateType === 'run') return { id: runId, inferred: false }

  const p = (payload ?? {}) as Record<string, unknown>

  // 各聚合类型在 payload 里的 id 字段名。
  const keyByType: Record<string, string> = {
    task: 'taskId',
    review: 'cycleId',
    artifact: 'artifactId',
    delivery: 'deliveryId',
    project: 'projectId',
    conversation: 'sessionId',
    job: 'jobId',
  }

  const key = keyByType[aggregateType]
  if (key) {
    const v = p[key]
    if (typeof v === 'string' && v) return { id: v, inferred: false }
  }

  // 找不到：退回到 run 聚合，并标记 inferred。
  //
  // 为什么不抛错：事件的「事实记录」属性比聚合归属更重要——
  // 因为一个字段缺失就丢掉整条事件，会丢失证据。
  // 标记出来让 invariant 扫描能报告「这条事件的聚合是推定的」。
  return { id: runId, inferred: true }
}

export class EventStore {
  constructor(private db: Database.Database) {}

  /**
   * 追加一个事件。
   *
   * 返回完整记录（含分配到的 sequence）。
   */
  append(args: AppendEventArgs): DomainEvent {
    const options = args.options ?? {}
    const def = eventKindDefinition(args.kind)
    if (!def) {
      throw new Error(
        `未定义的事件 kind：${args.kind}。` +
        '事件目录是公共契约（src/core/event-catalog.ts）——新事件必须先在目录里声明，' +
        '否则 replay 与 UI 活动流无法识别它。',
      )
    }

    // ── 聚合 id 的推导 ───────────────────────────────
    //
    // 不能一律退回 runId。
    //
    // 事件目录里 aggregateType 可能是 task / review / artifact / delivery，
    // 而调用点经常只给 runId。旧写法 `aggregateId = runId` 会产生
    // 「aggregateType=task、aggregateId=<runId>」这种错配：
    // 按 `listForAggregate('task', taskId)` 永远查不到，
    // 事件回放与 UI 活动流都会缺内容，invariant 扫描也看不出来。
    //
    // 正确做法：
    //   · 调用方显式给了 aggregateId → 用它
    //   · 没给，且 aggregateType 就是 run → 用 runId（最常见的正确情况）
    //   · 没给，且 aggregateType 是别的类型 → 从 payload 里找该类型的 id
    //   · 仍然找不到 → 记成 run 聚合（保证事件不丢），但打标记，
    //     让 invariant 扫描能发现「这条事件的聚合是推定的」
    const aggregateType = options.aggregateType ?? def.aggregateType
    const resolved: { id: string; inferred: boolean } = options.aggregateId
      ? { id: options.aggregateId, inferred: false }
      : resolveAggregateId(aggregateType, args.runId, args.payload)
    const aggregateId = resolved.id
    const actor = options.actor ?? 'system'
    const correlationId = options.correlationId ?? args.runId

    return this.db.transaction(() => {
      const maxRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS maxSeq FROM event WHERE aggregate_type = ? AND aggregate_id = ?',
        )
        .get(aggregateType, aggregateId) as { maxSeq: number }
      const sequence = Number(maxRow.maxSeq) + 1
      const occurredAt = Date.now()

      // 用 .run() 而不是 .get()：GET 在 INSERT 上能执行，但语义是「读一行」，
      // 用错方法不会报错却会让人误以为这是查询。这里是写入。
      this.db
        .prepare(
          `INSERT INTO event(run_id, kind, payload, created_at, aggregate_type, aggregate_id, sequence, actor, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.runId,
          args.kind,
          JSON.stringify(args.payload ?? null),
          occurredAt,
          aggregateType,
          aggregateId,
          sequence,
          actor,
          correlationId,
        )

      // last_insert_rowid() 用 Number() 归一：better-sqlite3 可能返回 bigint。
      const idRow = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }

      return {
        id: Number(idRow.id),
        aggregateType,
        aggregateId,
        aggregateIdInferred: resolved.inferred,
        sequence,
        kind: args.kind,
        actor,
        payload: args.payload ?? null,
        occurredAt,
        correlationId,
      }
    })()
  }

  /** 某个 Run 的全部事件，按写入顺序。 */
  listForRun(runId: string): DomainEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, run_id as runId, kind, payload, created_at as createdAt, aggregate_type as aggregateType, aggregate_id as aggregateId, sequence, actor, correlation_id as correlationId FROM event WHERE run_id = ? ORDER BY id ASC',
      )
      .all(runId) as EventRow[]
    return rows.map(mapEvent)
  }

  /** 按聚合查询，按 sequence 排序。 */
  listForAggregate(aggregateType: EventAggregateType, aggregateId: string): DomainEvent[] {
    const rows = this.db
      .prepare(
        'SELECT id, run_id as runId, kind, payload, created_at as createdAt, aggregate_type as aggregateType, aggregate_id as aggregateId, sequence, actor, correlation_id as correlationId FROM event WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY sequence ASC',
      )
      .all(aggregateType, aggregateId) as EventRow[]
    return rows.map(mapEvent)
  }

  /** 按关联 id 查询（一次操作的全部事件，跨聚合）。 */
  listByCorrelation(correlationId: string, limit = 200): DomainEvent[] {
    const capped = Math.max(1, Math.min(MAX_LIST_LIMIT, limit))
    const rows = this.db
      .prepare(
        'SELECT id, run_id as runId, kind, payload, created_at as createdAt, aggregate_type as aggregateType, aggregate_id as aggregateId, sequence, actor, correlation_id as correlationId FROM event WHERE correlation_id = ? ORDER BY id ASC LIMIT ?',
      )
      .all(correlationId, capped) as EventRow[]
    return rows.map(mapEvent)
  }

  /** 分页查询：id 游标（不含）。用于活动流与离线 replay。 */
  listSince(afterId: number, limit = 200): DomainEvent[] {
    const capped = Math.max(1, Math.min(MAX_LIST_LIMIT, limit))
    const rows = this.db
      .prepare(
        'SELECT id, run_id as runId, kind, payload, created_at as createdAt, aggregate_type as aggregateType, aggregate_id as aggregateId, sequence, actor, correlation_id as correlationId FROM event WHERE id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(afterId, capped) as EventRow[]
    return rows.map(mapEvent)
  }

  /**
   * 全部事件的**最小投影**（只含序号核对需要的字段）。
   *
   * 为什么单独一个方法：listSince 有 1000 条上限（分页用），
   * 用它做全量体检会被静默截断——那会让「序号有洞」这件事
   * 在大库上永远查不出来。
   *
   * 不解析 payload：体检只看结构，解析全部 payload 在百万条规模上
   * 是纯浪费。
   */
  listAllSequences(): Array<{ aggregateType: string; aggregateId: string; sequence: number; id: number }> {
    const rows = this.db
      .prepare(
        'SELECT id, aggregate_type as aggregateType, aggregate_id as aggregateId, sequence FROM event ORDER BY aggregate_type, aggregate_id, sequence',
      )
      .all() as Array<{ id: number; aggregateType: string; aggregateId: string; sequence: number }>
    return rows.map((r) => ({
      aggregateType: r.aggregateType,
      aggregateId: r.aggregateId,
      sequence: r.sequence,
      id: r.id,
    }))
  }

  /** 某个聚合当前的最大序号。没有事件时为 0。 */
  nextSequence(aggregateType: EventAggregateType, aggregateId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS maxSeq FROM event WHERE aggregate_type = ? AND aggregate_id = ?',
      )
      .get(aggregateType, aggregateId) as { maxSeq: number }
    return Number(row.maxSeq) + 1
  }
}

export { mapEvent, MAX_LIST_LIMIT }
export type { EventRow }
