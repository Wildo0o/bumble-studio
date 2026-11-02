// 知识库与项目记忆的持久化（挂到 Store 原型上）。
//
// 为什么用「挂原型」而不是改 store.ts 加几百行：
//   store.ts 已经 3000+ 行，再塞两块领域会让它更难审查。
//   而这些方法只依赖 `this.db`，挂原型与写在类里在类型上完全等价。
//
// 所有方法都是同步的（better-sqlite3），与 Store 的其它方法一致。
import type Database from 'better-sqlite3'
import type { KnowledgeDoc, KnowledgeScope, MemoryItem } from './knowledge.js'
import {
  contentHashOf,
  validateKnowledgeInput,
  validateMemoryInput,
} from './knowledge.js'
import { DomainError } from './errors.js'

/** Store 上需要暴露的知识库接口。 */
export interface KnowledgeStoreApi {
  createKnowledge(input: {
    scope: KnowledgeScope
    scopeId: string
    title: string
    content: string
    source: string
    tags: string[]
  }): KnowledgeDoc
  getKnowledge(id: string): KnowledgeDoc | undefined
  listKnowledge(scope: KnowledgeScope, scopeId: string): KnowledgeDoc[]
  updateKnowledge(id: string, input: Record<string, unknown>): KnowledgeDoc
  deleteKnowledge(id: string): void

  createMemory(input: {
    scope: KnowledgeScope
    scopeId: string
    statement: string
    evidence: string
    tags: string[]
    origin: MemoryItem['origin']
    taskId?: string
    runId?: string
  }): MemoryItem
  listMemory(scope: KnowledgeScope, scopeId: string): MemoryItem[]
  deleteMemory(id: string): void
}

interface KnowledgeRow {
  id: string
  scope: string
  scopeId: string
  title: string
  content: string
  source: string
  tags: string
  contentHash: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

interface MemoryRow {
  id: string
  scope: string
  scopeId: string
  statement: string
  evidence: string
  taskId: string | null
  runId: string | null
  origin: string
  tags: string
  createdAt: number
  deletedAt: number | null
}

function mapKnowledge(r: KnowledgeRow): KnowledgeDoc {
  const doc: KnowledgeDoc = {
    id: r.id,
    scope: r.scope as KnowledgeScope,
    scopeId: r.scopeId,
    title: r.title,
    content: r.content,
    source: r.source,
    tags: JSON.parse(r.tags) as string[],
    contentHash: r.contentHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
  if (r.deletedAt !== null) doc.deletedAt = r.deletedAt
  return doc
}

function mapMemory(r: MemoryRow): MemoryItem {
  const m: MemoryItem = {
    id: r.id,
    scope: r.scope as KnowledgeScope,
    scopeId: r.scopeId,
    statement: r.statement,
    evidence: r.evidence,
    origin: r.origin as MemoryItem['origin'],
    tags: JSON.parse(r.tags) as string[],
    createdAt: r.createdAt,
  }
  if (r.taskId) m.taskId = r.taskId
  if (r.runId) m.runId = r.runId
  if (r.deletedAt !== null) m.deletedAt = r.deletedAt
  return m
}

const KNOWLEDGE_COLUMNS =
  'id, scope, scope_id as scopeId, title, content, source, tags, content_hash as contentHash, created_at as createdAt, updated_at as updatedAt, deleted_at as deletedAt'

const MEMORY_COLUMNS =
  'id, scope, scope_id as scopeId, statement, evidence, task_id as taskId, run_id as runId, origin, tags, created_at as createdAt, deleted_at as deletedAt'

/**
 * 把知识库方法安装到 Store 类上。
 *
 * @param proto Store 的 prototype
 * @param makeId 生成 id（与 Store 内部一致使用 randomUUID）
 */
export function installKnowledgeStore(
  proto: Record<string, unknown>,
  makeId: () => string,
): void {
  /** 取内部 db。Store 把 db 声明为 private，这里通过已声明的访问器拿。 */
  const dbOf = (self: unknown): Database.Database =>
    (self as { db: Database.Database }).db

  proto.createKnowledge = function (this: unknown, input: {
    scope: KnowledgeScope
    scopeId: string
    title: string
    content: string
    source: string
    tags: string[]
  }): KnowledgeDoc {
    const db = dbOf(this)
    const validated = validateKnowledgeInput(input)
    const hash = contentHashOf(`${validated.title}\u0000${validated.content}`)
    const ts = Date.now()

    // 同作用域同内容已存在时返回已有条目（幂等），而不是报错。
    //
    // 为什么：重复导入同一份文档是常见操作（重新索引、多个 Task 引用
    // 同一规范）。报错会迫使调用方先查再写，而那仍有竞态。
    const existing = db
      .prepare(
        `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_doc
         WHERE scope = ? AND scope_id = ? AND content_hash = ? AND deleted_at IS NULL`,
      )
      .get(input.scope, input.scopeId, hash) as KnowledgeRow | undefined
    if (existing) return mapKnowledge(existing)

    const doc: KnowledgeDoc = {
      id: makeId(),
      scope: input.scope,
      scopeId: input.scopeId,
      title: validated.title,
      content: validated.content,
      source: validated.source,
      tags: validated.tags,
      contentHash: hash,
      createdAt: ts,
      updatedAt: ts,
    }
    db.prepare(
      `INSERT INTO knowledge_doc(id, scope, scope_id, title, content, source, tags, content_hash, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      doc.id,
      doc.scope,
      doc.scopeId,
      doc.title,
      doc.content,
      doc.source,
      JSON.stringify(doc.tags),
      doc.contentHash,
      doc.createdAt,
      doc.updatedAt,
    )
    return doc
  }

  proto.getKnowledge = function (this: unknown, id: string): KnowledgeDoc | undefined {
    const row = dbOf(this)
      .prepare(`SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_doc WHERE id = ?`)
      .get(id) as KnowledgeRow | undefined
    return row ? mapKnowledge(row) : undefined
  }

  proto.listKnowledge = function (
    this: unknown,
    scope: KnowledgeScope,
    scopeId: string,
  ): KnowledgeDoc[] {
    const rows = dbOf(this)
      .prepare(
        `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_doc
         WHERE scope = ? AND scope_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(scope, scopeId) as KnowledgeRow[]
    return rows.map(mapKnowledge)
  }

  proto.updateKnowledge = function (
    this: unknown,
    id: string,
    input: Record<string, unknown>,
  ): KnowledgeDoc {
    const db = dbOf(this)
    const current = (proto.getKnowledge as (this: unknown, id: string) => KnowledgeDoc | undefined).call(this, id)
    if (!current || current.deletedAt !== undefined) {
      throw new DomainError('NOT_FOUND', `知识条目不存在：${id}`)
    }
    const validated = validateKnowledgeInput({
      title: input.title ?? current.title,
      content: input.content ?? current.content,
      source: input.source ?? current.source,
      tags: input.tags ?? current.tags,
    })
    const hash = contentHashOf(`${validated.title}\u0000${validated.content}`)

    // 更新后不能与同作用域内的另一条重复
    const clash = db
      .prepare(
        `SELECT id FROM knowledge_doc
         WHERE scope = ? AND scope_id = ? AND content_hash = ? AND deleted_at IS NULL AND id <> ?`,
      )
      .get(current.scope, current.scopeId, hash, id) as { id: string } | undefined
    if (clash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        `同一作用域内已存在相同内容的知识条目：${clash.id}`,
      )
    }

    const updatedAt = Date.now()
    db.prepare(
      `UPDATE knowledge_doc
       SET title = ?, content = ?, source = ?, tags = ?, content_hash = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      validated.title,
      validated.content,
      validated.source,
      JSON.stringify(validated.tags),
      hash,
      updatedAt,
      id,
    )
    return {
      ...current,
      title: validated.title,
      content: validated.content,
      source: validated.source,
      tags: validated.tags,
      contentHash: hash,
      updatedAt,
    }
  }

  proto.deleteKnowledge = function (this: unknown, id: string): void {
    // 软删除：证据链可能还引用它，硬删会让「当时依据什么做的决定」无法回答。
    const res = dbOf(this)
      .prepare('UPDATE knowledge_doc SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id)
    if (res.changes === 0) throw new DomainError('NOT_FOUND', `知识条目不存在或已删除：${id}`)
  }

  proto.createMemory = function (this: unknown, input: {
    scope: KnowledgeScope
    scopeId: string
    statement: string
    evidence: string
    tags: string[]
    origin: MemoryItem['origin']
    taskId?: string
    runId?: string
  }): MemoryItem {
    const db = dbOf(this)
    const validated = validateMemoryInput(input)
    const item: MemoryItem = {
      id: makeId(),
      scope: input.scope,
      scopeId: input.scopeId,
      statement: validated.statement,
      evidence: validated.evidence,
      origin: validated.origin,
      tags: validated.tags,
      createdAt: Date.now(),
    }
    if (input.taskId) item.taskId = input.taskId
    if (input.runId) item.runId = input.runId

    db.prepare(
      `INSERT INTO memory_item(id, scope, scope_id, statement, evidence, task_id, run_id, origin, tags, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      item.id,
      item.scope,
      item.scopeId,
      item.statement,
      item.evidence,
      item.taskId ?? null,
      item.runId ?? null,
      item.origin,
      JSON.stringify(item.tags),
      item.createdAt,
    )
    return item
  }

  proto.listMemory = function (
    this: unknown,
    scope: KnowledgeScope,
    scopeId: string,
  ): MemoryItem[] {
    const rows = dbOf(this)
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memory_item
         WHERE scope = ? AND scope_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(scope, scopeId) as MemoryRow[]
    return rows.map(mapMemory)
  }

  proto.deleteMemory = function (this: unknown, id: string): void {
    const res = dbOf(this)
      .prepare('UPDATE memory_item SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id)
    if (res.changes === 0) throw new DomainError('NOT_FOUND', `记忆条目不存在或已删除：${id}`)
  }
}
