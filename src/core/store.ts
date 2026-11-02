// SQLite 持久化层。单写者：所有写入都经这里，调用方不得直接持有 db 句柄。
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type {
  AcceptanceRecord,
  Approval,
  Artifact,
  ArtifactStatus,
  AuditResult,
  DeliveryRecord,
  DeniedRequest,
  Grant,
  ReconciliationRecord,
  ReviewCycle,
  ModelIdentity,
  Run,
  RunBudget,
  RunRole,
  RunStatus,
  RunUsage,
  Snapshot,
  Step,
  StepKind,
  StepStatus,
  StepTrace,
  StoredAuditResult,
  Task,
  TaskBudget,
  TaskStatus,
  TaskUsage,
  ToolIntent,
  ToolIntentStatus,
  BudgetReservation,
  TaskContract,
  DomainContract,
  DomainContractScope,
  DomainEvent,
  EventAppendOptions,
  EventAggregateType,
} from '../shared/types.js'
import { buildContractContent } from './task-contract.js'
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  pendingMigrations,
  type MigrationContext,
} from './migrations.js'
import { EventStore } from './store-events.js'
import { installKnowledgeStore } from './store-knowledge.js'
import { installWorkgroupStore, type WorkgroupStoreApi } from './store-workgroup.js'
import { SqliteLeaseStore } from './lease-store.js'
import type { Lease } from './runner.js'
import type { KnowledgeStoreApi } from './store-knowledge.js'
import type { Attachment } from './conversation.js'
import type { HumanDecision } from './evidence.js'

export { SCHEMA_VERSION, MIGRATIONS }


/**
 * 契约大小上限。
 *
 * 这些值不是「性能优化」，是**安全边界**：
 * 契约会被原样拼进 Auditor 的 system 消息。
 * 没有上限时，一个超长的 goal 可以把真正的判定规则挤出上下文，
 * 或者让一次审计消耗掉整个预算。
 */
export const MAX_CONTRACT_GOAL_CHARS = 4000
export const MAX_ACCEPTANCE_CRITERIA = 50
export const MAX_CRITERION_CHARS = 500

const SCHEMA_TABLES = `

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL,
  budget     TEXT,
  usage      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  parent_run_id TEXT,
  role          TEXT NOT NULL,
  status        TEXT NOT NULL,
  budget        TEXT NOT NULL,
  grant_ids     TEXT NOT NULL,
  usage         TEXT NOT NULL,
  -- 实际使用的模型身份。执行时写入，之后不可改。
  -- 审计的模型族隔离校验读这里，不读请求体。
  model_identity TEXT,
  started_at    INTEGER,
  ended_at      INTEGER
);

-- Run 的工作历史。必须持久化，否则 Run 暂停/恢复后模型看不到自己的上一步。
CREATE TABLE IF NOT EXISTS run_message (
  run_id     TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS step (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  attempt_of  TEXT,
  trace       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 副作用调用的持久记录。见 ToolIntent 类型注释。
--
-- 为什么 (run_id, step_id, tool_call_id) 唯一：
-- 同一个 toolCallId 只可能对应一次调用。如果出现第二条，
-- 说明执行路径有 bug（比如恢复时用了新的 stepId），
-- 唯一约束会在写入时就把它拦下来，而不是等到重复副作用发生之后。
CREATE TABLE IF NOT EXISTS tool_intent (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step_id         TEXT NOT NULL,
  tool_call_id    TEXT NOT NULL,
  tool_id         TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  operation_key   TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  result_hash     TEXT,
  result_content  TEXT,
  result_is_error INTEGER,
  error           TEXT,
  unknown_reason  TEXT,
  resolution      TEXT,
  -- 同一 Run 内 toolCallId 必须全局唯一：一个 toolCallId 只代表一次调用。
  -- 如果模型重复发同一个 id，那是模型的 bug，系统必须拒绝而不是执行两次。
  UNIQUE (run_id, tool_call_id)
);
-- operation_key 用于识别「同一操作的重试」。

CREATE TABLE IF NOT EXISTS grant (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  tool_id     TEXT NOT NULL,
  scope       TEXT,
  constraints TEXT NOT NULL,
  -- max_calls 从 constraints JSON 里提出来单独存一列。
  -- 原因：原子认领要求「检查额度 + 递增」在同一个 UPDATE 里完成，
  -- 而 SQLite 无法直接比较 JSON 字段。
  max_calls   INTEGER,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  approver    TEXT,
  used_calls  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approval (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step_id         TEXT NOT NULL,
  tool_id         TEXT NOT NULL,
  tool_call_id    TEXT NOT NULL DEFAULT '',
  arguments       TEXT NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,
  decided_at      INTEGER,
  expires_at      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  result_consumed INTEGER NOT NULL DEFAULT 0
);

-- unknown 的解决记录。没有这张表，「未解决」和「已解决」无法区分。
-- 预算预留。见 BudgetReservation 类型注释。
--
-- 单独一张表而不是往 run/task 上加字段，原因：
--   · 一次调用一个预留，需要能独立结算/释放
--   · 并发时要在事务内汇总所有未结算预留，用表更直接
CREATE TABLE IF NOT EXISTS budget_reservation (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  -- 预留的估算值
  steps         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  -- 实际用量（只在 status='settled' 时有意义）
  actual_steps         INTEGER NOT NULL DEFAULT 0,
  actual_tool_calls    INTEGER NOT NULL DEFAULT 0,
  actual_input_tokens  INTEGER NOT NULL DEFAULT 0,
  actual_output_tokens INTEGER NOT NULL DEFAULT 0,
  actual_cost_usd      REAL NOT NULL DEFAULT 0,
  purpose       TEXT NOT NULL,
  -- reserved / settled / released / expired
  -- 三者的区别在审计上必须能分开：
  --   settled  = 调用发生了，实际用量已计入
  --   released = 调用没发生，额度全额退回
  --   expired  = 进程崩溃，不知道调用有没有发生
  status        TEXT NOT NULL DEFAULT 'reserved',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  settled_at    INTEGER
);

CREATE TABLE IF NOT EXISTS reconciliation (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  step_id        TEXT NOT NULL,
  -- 绑定到具体的 ToolIntent：Step 只是执行轨迹，Intent 才是
  -- 「这次外部调用怎么样」的记录。审批恢复时 Step 每次新建，
  -- 而 Intent 跨恢复稳定。
  intent_id      TEXT,
  tool_call_id   TEXT,
  unknown_reason TEXT NOT NULL,
  resolution     TEXT NOT NULL,
  evidence       TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     INTEGER NOT NULL
);

-- 快照。审计只读快照，不读变化中的目录。
-- 审计循环。不存独立 status，由关联对象推导。
CREATE TABLE IF NOT EXISTS review_cycle (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  skill_id        TEXT NOT NULL,
  skill_version   TEXT NOT NULL,
  cycle_number    INTEGER NOT NULL,
  producer_run_id TEXT NOT NULL,
  auditor_run_id  TEXT,
  audit_result_id TEXT,
  created_at      INTEGER NOT NULL,
  -- 同一 Task 下 cycle_number 唯一。
  -- 没有这条约束，并发请求会创建出两个 #2，maxCycles 被超发。
  UNIQUE(task_id, cycle_number)
);

-- 审计结果。完整 JSON 存一份，便于回放与用例 D 的复现。
CREATE TABLE IF NOT EXISTS audit_result (
  id         TEXT PRIMARY KEY,
  cycle_id   TEXT NOT NULL REFERENCES review_cycle(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  confidence REAL,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  task_id                TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  ref                    TEXT NOT NULL,
  reproducible           INTEGER NOT NULL DEFAULT 1,
  not_reproducible_reason TEXT,
  file_count             INTEGER NOT NULL DEFAULT 0,
  total_bytes            INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL
);

-- 用户对产物质量的决定
CREATE TABLE IF NOT EXISTS acceptance (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  artifact_id   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  status        TEXT NOT NULL,
  revision_note TEXT,
  override_actor  TEXT,
  override_reason TEXT,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL,
  -- 谁做的质量决定（user / system）。服务端决定，不接受请求体指定。
  decided_by    TEXT NOT NULL DEFAULT 'user'
);

-- 交付动作。与 acceptance 分开：交付失败不抹掉接受证据。
CREATE TABLE IF NOT EXISTS delivery (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  acceptance_id TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL,
  error         TEXT,
  destination   TEXT,
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  actor         TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS denied (
  run_id        TEXT NOT NULL,
  tool_id       TEXT NOT NULL,
  argument_hash TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (run_id, tool_id, argument_hash)
);

CREATE TABLE IF NOT EXISTS artifact (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  run_id             TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,
  path               TEXT,
  content_hash       TEXT,
  source_snapshot_id TEXT,
  version            INTEGER NOT NULL,
  parent_artifact_id TEXT,
  status             TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);

-- 任务契约的版本历史。
--
-- 为什么不直接在 task 表加 goal/criteria 两列：
--   1. 审计结果要绑定「当时审的是哪一版契约」，
--      只存当前值的话，契约一改旧审计就无从核对；
--   2. 旧版本不能被静默覆盖——出了问题要能回答「改之前是什么」。
--
-- 每个 Task 同时只有一条 status='active'，由部分唯一索引强制。
CREATE TABLE IF NOT EXISTS task_contract (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  goal             TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  canonical        TEXT NOT NULL,
  contract_hash    TEXT NOT NULL,
  status           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (task_id, contract_version)
);

-- 通用版本化契约（权限策略、项目策略、无人值守策略……）。
--
-- 与 task_contract 的区别：task_contract 带领域字段（goal / criteria）；
-- 这张表只存规范化 JSON + hash，适用于「字段各不相同的策略对象」。
-- 语义一致：追加新版本、旧版本 superseded、每个 scope+scope_id 一条 active。
CREATE TABLE IF NOT EXISTS domain_contract (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  status          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  superseded_at   INTEGER,
  UNIQUE (scope, scope_id, version)
);

-- 领域事件。
--
-- run_id 保留为「这个事件与哪个 Run 相关」的便捷索引；
-- aggregate_type / aggregate_id 才是聚合根（v10 起）。
-- sequence 由 EventStore 在事务内原子分配，由唯一索引强制。
CREATE TABLE IF NOT EXISTS event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL DEFAULT 'run',
  aggregate_id   TEXT NOT NULL DEFAULT '',
  sequence       INTEGER NOT NULL DEFAULT 0,
  actor          TEXT NOT NULL DEFAULT 'system',
  correlation_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_event_run ON event(run_id, id);
`

// 索引单独一段，在**迁移之后**执行。
//
// 为什么必须分开：旧库可能缺少新列（例如 v9 的 event 没有 correlation_id），
// 在缺列的表上建索引会直接失败，导致整个 Store 打不开。
// 顺序：建表（IF NOT EXISTS，旧库上是 no-op）→ 迁移补列 → 建索引。
const SCHEMA_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_task ON run(task_id);
CREATE INDEX IF NOT EXISTS idx_step_run ON step(run_id, idx);
CREATE INDEX IF NOT EXISTS idx_intent_run ON tool_intent(run_id);
CREATE INDEX IF NOT EXISTS idx_intent_status ON tool_intent(status);
CREATE INDEX IF NOT EXISTS idx_intent_opkey ON tool_intent(run_id, operation_key);
CREATE INDEX IF NOT EXISTS idx_resv_run ON budget_reservation(run_id, status);
CREATE INDEX IF NOT EXISTS idx_resv_task ON budget_reservation(task_id, status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_run ON reconciliation(run_id);
CREATE INDEX IF NOT EXISTS idx_cycle_task ON review_cycle(task_id, cycle_number);
CREATE INDEX IF NOT EXISTS idx_snapshot_run ON snapshot(run_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_task ON acceptance(task_id);
CREATE INDEX IF NOT EXISTS idx_delivery_task ON delivery(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval(status);
CREATE INDEX IF NOT EXISTS idx_artifact_task ON artifact(task_id);
CREATE INDEX IF NOT EXISTS idx_contract_task ON task_contract(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_active
  ON task_contract(task_id) WHERE status = 'active';

-- ── 事件 ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_event_correlation ON event(correlation_id, id);
-- 聚合内序号唯一。索引负责「不许重复」，迁移负责「有这个列」——
-- 两件事分开，旧库上才能分别诊断失败原因。
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_aggregate_seq
  ON event(aggregate_type, aggregate_id, sequence);

-- ── 通用版本化契约 ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_domain_contract_scope ON domain_contract(scope, scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_contract_active
  ON domain_contract(scope, scope_id) WHERE status = 'active';

-- ── 产物 ────────────────────────────────────────────────
-- 同一 Run 同一路径最多一份**候选**。返工产生的旧候选是 superseded，
-- 不受约束；两份同时可接受的候选会让验收对象不确定。
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_run_path_candidate
  ON artifact(run_id, path) WHERE path IS NOT NULL AND status = 'candidate';
`

const SCHEMA = SCHEMA_TABLES + SCHEMA_INDEXES

export interface StoredMessage {
  id: string
  sessionId: string
  role: string
  content: string
  toolCalls?: unknown
  toolCallId?: string
  createdAt: number
}

function now(): number {
  return Date.now()
}

export class Store {
  private db: Database.Database
  private writeQueue: Array<() => void> = []
  private writing = false
  /** 租约存储（惰性构造，与 db 同一连接）。 */
  private leaseStoreCache?: SqliteLeaseStore

  /** 事件写入 / 读取。必须与 db 同一连接：序号分配依赖同一事务。 */
  private events: EventStore

  constructor(file: string) {
    this.db = new Database(file)
    this.events = new EventStore(this.db)

    // ── 建库顺序（三步都必须保留，顺序不能改）──────────────
    //
    //   1. SCHEMA_TABLES：全新库先把表建出来，否则迁移无从下手；
    //      旧库上是 CREATE TABLE IF NOT EXISTS，等同 no-op。
    //   2. migrate()：给旧库补列 / 回填 / 重建旧约束。包在一个事务里。
    //   3. SCHEMA_INDEXES：索引可能引用新列，必须在迁移之后建。
    //
    // 把索引放在第 1 步会让旧库直接打不开——
    // 这是真实翻过的车：v9 的 event 没有 correlation_id，
    // 而 SCHEMA 里有一条 idx_event_correlation，建索引时抛错，
    // 整个 Store 构造失败。
    this.db.exec(SCHEMA_TABLES)
    this.migrate()
    this.db.exec(SCHEMA_INDEXES)
  }

  /** 当前 schema 版本。用于 /health 和诊断，不泄露任何数据。 */
  get schemaVersion(): number {
    return SCHEMA_VERSION
  }

  /**
   * schema 升级：只做「修改已有表」的部分（加列、回填、重建旧约束）。
   *
   * 建表与建索引由构造函数负责，且分别在本方法前后各跑一次：
   * 全新库需要先有表才谈得上迁移，旧库需要跑了迁移才能建引用新列的索引。
   *
   * 整个升级在一个事务里：中途失败回滚到升级前，
   * 不会留下「升了一半」的库（那种库打开后行为无法预测）。
   *
   * 版本号只在所有迁移成功后才写。手工改过 meta 的库也能安全升级：
   * 每个迁移自己检测列是否存在，不依赖版本号完全正确。
   */
  private migrate(): void {
    const self = this
    const raw = this.getMeta('schema_version')
    const current = Number(raw ?? 0)
    const pending = pendingMigrations(Number.isFinite(current) ? current : 0)

    if (pending.length > 0) {
      const ctx: MigrationContext = {
        exec(sql) {
          self.db.exec(sql)
        },
        hasColumn: (t, c) => self.hasColumn(t, c),
        hasTable: (t) => self.hasTable(t),
        tableSql: (t) => self.tableSql(t),
        queryOne: <T>(sql: string, ...params: unknown[]) =>
          self.db.prepare(sql).get(...params) as T | undefined,
      }
      this.db.transaction(() => {
        for (const m of pending) m.up(ctx)
        self.setMeta('schema_version', String(SCHEMA_VERSION))
      })()
    } else {
      this.setMeta('schema_version', String(SCHEMA_VERSION))
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some((r) => r.name === column)
  }

  /** 表是否存在。用于迁移判断，不用于生产查询。 */
  hasTable(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined
    return row !== undefined
  }

  /** 表的原始 CREATE SQL。用于识别旧约束形态。 */
  tableSql(table: string): string | undefined {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined
    return row?.sql ?? undefined
  }

  /**
   * 在单个事务里执行一组写入。
   *
   * 用途：多个 Store 方法需要**一起**生效或一起回滚时。
   * 比如 reconcile 要同时写 ReconciliationRecord / Step / Intent / Run 状态，
   * 分开写会在崩溃时留下互相矛盾的事实。
   *
   * better-sqlite3 的事务是同步的，所以回调必须是同步函数——
   * 异步回调会在 await 处丢失事务边界。这里用类型强制这一点。
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * 关闭数据库。
   *
   * 幂等：重复调用是 no-op。
   *
   * 为什么要幂等：`server.close()` 可能被多次调用（测试的 afterEach、
   * 进程退出钩子、用户的 Ctrl-C 路径），而 better-sqlite3 在已关闭的
   * 连接上再次 close 会抛错——那会把「正常关闭」变成一次异常退出。
   */
  private closed = false
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /**
   * 仅供测试使用：直接执行 SQL。
   *
   * 生产代码不得调用——它会绕过所有约束。
   * 存在的理由：模拟「时间流逝」这类无法通过公开 API 构造的场景
   * （比如把审批的过期时间推到过去）。
   */
  dbExecForTest(sql: string): void {
    this.db.exec(sql)
  }

  // ── meta ───────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ── session / message ──────────────────────────────────

  createSession(title: string, id = randomUUID()): { id: string; title: string; createdAt: number } {
    const createdAt = now()
    this.db.prepare('INSERT INTO session(id, title, created_at) VALUES (?, ?, ?)').run(id, title, createdAt)
    return { id, title, createdAt }
  }

  getSession(id: string): { id: string; title: string; createdAt: number } | undefined {
    const row = this.db.prepare('SELECT id, title, created_at as createdAt FROM session WHERE id = ?').get(id)
    return row as { id: string; title: string; createdAt: number } | undefined
  }

  /**
   * 会话列表。
   *
   * 默认**不包含**已归档会话：归档的语义就是「从默认视图里收起来」，
   * 但仍可显式取回（includeArchived）。
   *
   * 按 updated_at 排序而不是 created_at：用户找的是「最近聊过的」，
   * 一个昨天创建、今天还在继续的会话语义上比今天新建的更重要。
   */
  listSessions(opts: { includeArchived?: boolean } = {}): Array<{
    id: string
    title: string
    createdAt: number
    updatedAt: number
    archivedAt?: number
  }> {
    const where = opts.includeArchived ? '' : 'WHERE archived_at IS NULL'
    const rows = this.db
      .prepare(
        `SELECT id, title, created_at as createdAt,
                COALESCE(updated_at, created_at) as updatedAt,
                archived_at as archivedAt
         FROM session ${where}
         ORDER BY COALESCE(updated_at, created_at) DESC`,
      )
      .all() as Array<{
      id: string
      title: string
      createdAt: number
      updatedAt: number
      archivedAt: number | null
    }>
    return rows.map((r) => {
      const out: {
        id: string
        title: string
        createdAt: number
        updatedAt: number
        archivedAt?: number
      } = {
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
      if (r.archivedAt !== null) out.archivedAt = r.archivedAt
      return out
    })
  }

  /** 归档 / 取消归档一个会话。不删除任何消息。 */
  archiveSession(id: string, archived: boolean): void {
    this.db
      .prepare('UPDATE session SET archived_at = ? WHERE id = ?')
      .run(archived ? now() : null, id)
  }

  /** 更新会话的最近活动时间。消息写入后调用，用于会话排序。 */
  touchSession(id: string): void {
    this.db.prepare('UPDATE session SET updated_at = ? WHERE id = ?').run(now(), id)
  }

  appendMessage(m: Omit<StoredMessage, 'createdAt'> & { createdAt?: number }): StoredMessage {
    const createdAt = m.createdAt ?? now()
    this.db
      .prepare('INSERT INTO message(id, session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.sessionId, m.role, m.content, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, createdAt)
    // 同步会话的最近活动时间：会话列表按它排序。
    // 放在同一条 INSERT 之后而不是事务里，是因为这里只影响排序，
    // 落后一次更新不会造成数据不一致。
    this.touchSession(m.sessionId)
    return { ...m, createdAt }
  }

  listMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT id, session_id as sessionId, role, content, tool_calls as toolCalls, tool_call_id as toolCallId, created_at as createdAt FROM message WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as Array<StoredMessage & { toolCalls: string | null }>
    return rows.map((r) => ({ ...r, toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined }))
  }

  // ── task ───────────────────────────────────────────────

  createTask(input: { sessionId: string; goal: string; budget?: TaskBudget; id?: string }): Task {
    const task: Task = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      goal: input.goal,
      status: 'ready',
      budget: input.budget,
      usage: { costUsd: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cycles: 0, startedAt: now() },
      createdAt: now(),
      updatedAt: now(),
    }
    this.db
      .prepare('INSERT INTO task(id, session_id, goal, status, budget, usage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        task.id,
        task.sessionId,
        task.goal,
        task.status,
        task.budget ? JSON.stringify(task.budget) : null,
        JSON.stringify(task.usage),
        task.createdAt,
        task.updatedAt,
      )
    return task
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      sessionId: row.sessionId as string,
      goal: row.goal as string,
      status: row.status as TaskStatus,
      budget: row.budget ? (JSON.parse(row.budget as string) as TaskBudget) : undefined,
      usage: row.usage ? (JSON.parse(row.usage as string) as TaskUsage) : undefined,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    }
  }

  private static readonly TASK_COLUMNS =
    'id, session_id as sessionId, goal, status, budget, usage, created_at as createdAt, updated_at as updatedAt'

  getTask(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT ${Store.TASK_COLUMNS} FROM task WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.mapTask(row) : undefined
  }

  listTasks(sessionId?: string): Task[] {
    const sql = `SELECT ${Store.TASK_COLUMNS} FROM task` +
      (sessionId ? ' WHERE session_id = ?' : '') +
      ' ORDER BY created_at DESC'
    const rows = (sessionId ? this.db.prepare(sql).all(sessionId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapTask(r))
  }

  /**
   * CAS 地迁移 Task 状态。
   *
   * 用于验收这种「只能发生一次」的转换：两个并发 accept 都读到
   * awaiting_acceptance，只有第一个能把它改成 accepted。
   */
  transitionTaskStatus(id: string, from: TaskStatus | TaskStatus[], to: TaskStatus): boolean {
    const fromList = Array.isArray(from) ? from : [from]
    const placeholders = fromList.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE task SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, now(), id, ...fromList)
    return result.changes > 0
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
  }

  // ── task contract ──────────────────────────────────────

  private static readonly CONTRACT_COLUMNS =
    'id, task_id as taskId, goal, acceptance_criteria as acceptanceCriteria, ' +
    'contract_version as contractVersion, canonical, contract_hash as contractHash, ' +
    'status, actor, created_at as createdAt, updated_at as updatedAt'

  private mapContract(row: Record<string, unknown>): TaskContract {
    return {
      id: row.id as string,
      taskId: row.taskId as string,
      goal: row.goal as string,
      acceptanceCriteria: JSON.parse(row.acceptanceCriteria as string) as string[],
      contractVersion: row.contractVersion as number,
      canonical: row.canonical as string,
      contractHash: row.contractHash as string,
      status: row.status as TaskContract['status'],
      actor: row.actor as string,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
    }
  }

  /**
   * 创建或更新任务契约。
   *
   * 语义是「追加新版本」而不是「覆盖」：
   *   · 没有 active 契约 → version 1
   *   · 已有 active 契约 → 旧版标 superseded，新版 version+1
   *
   * 整段在一个事务里，部分唯一索引 idx_contract_active 保证
   * 任何时刻一个 Task 最多一条 active。
   *
   * 内容完全相同时**不产生新版本**（返回现有版本）。
   * 理由：重复 PUT 同样的内容不该让所有旧审计失效。
   * 但 actor 也算进 hash —— 换个人重新确认同一份契约，是新版本。
   */
  putTaskContract(input: {
    taskId: string
    goal: string
    acceptanceCriteria: string[]
    actor: string
  }): TaskContract {
    if (!input.goal.trim()) {
      throw new Error('任务契约的 goal 不能为空——空目标无法用于审计')
    }
    // 长度限制：契约会被拼进 Auditor 的 system 消息。
    // 不限制的话，一个 10MB 的 goal 就能把 prompt 撑爆，
    // 或者把真正的指令挤出模型的有效上下文。
    if (input.goal.length > MAX_CONTRACT_GOAL_CHARS) {
      throw new Error(
        `任务契约的 goal 过长（${input.goal.length} 字符，上限 ${MAX_CONTRACT_GOAL_CHARS}）。` +
        '目标应该是简洁的说明，不是一整篇文档。',
      )
    }
    if (input.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
      throw new Error(
        `验收标准条数过多（${input.acceptanceCriteria.length}，上限 ${MAX_ACCEPTANCE_CRITERIA}）`,
      )
    }
    if (input.acceptanceCriteria.some((c) => !c.trim())) {
      throw new Error('验收标准不能包含空字符串')
    }
    if (input.acceptanceCriteria.some((c) => c.length > MAX_CRITERION_CHARS)) {
      throw new Error(
        `验收标准单条过长（上限 ${MAX_CRITERION_CHARS} 字符）`,
      )
    }

    const tx = this.db.transaction((): TaskContract => {
      const task = this.getTask(input.taskId)
      if (!task) throw new Error(`task not found: ${input.taskId}`)

      const current = this.getActiveTaskContract(input.taskId)

      // 内容完全一致 → 幂等返回，不制造新版本。
      //
      // 必须在「算新版本号」之前比较：hash 里包含 contractVersion，
      // 先 +1 再比就永远不相等，重复 PUT 同样的内容会让所有旧审计失效。
      if (
        current &&
        current.goal === input.goal &&
        current.actor === input.actor &&
        JSON.stringify(current.acceptanceCriteria) === JSON.stringify(input.acceptanceCriteria)
      ) {
        return current
      }

      const version = (current?.contractVersion ?? 0) + 1
      const { canonical, contractHash } = buildContractContent({
        taskId: input.taskId,
        goal: input.goal,
        acceptanceCriteria: input.acceptanceCriteria,
        contractVersion: version,
        actor: input.actor,
      })

      if (current) {
        this.db
          .prepare(
            "UPDATE task_contract SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'",
          )
          .run(now(), current.id)
      }

      const ts = now()
      const record: TaskContract = {
        id: randomUUID(),
        taskId: input.taskId,
        goal: input.goal,
        acceptanceCriteria: input.acceptanceCriteria,
        contractVersion: version,
        canonical,
        contractHash,
        status: 'active',
        actor: input.actor,
        createdAt: ts,
        updatedAt: ts,
      }

      this.db
        .prepare(
          `INSERT INTO task_contract(
             id, task_id, goal, acceptance_criteria, contract_version,
             canonical, contract_hash, status, actor, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.taskId,
          record.goal,
          JSON.stringify(record.acceptanceCriteria),
          record.contractVersion,
          record.canonical,
          record.contractHash,
          record.status,
          record.actor,
          record.createdAt,
          record.updatedAt,
        )

      // ── 单一权威源：契约是权威，Task.goal 是投影 ─────────
      //
      // 两份独立的 goal 必然分叉：
      //   · PUT /tasks/:id/contract 只改契约，Task.goal 还是旧的
      //   · GET /tasks/:id 返回旧 goal，Auditor 用新 goal
      //   · 用户看到的和审计用的不是同一句话
      //
      // 所以契约一变，Task.goal 同步写。审计永远读契约（权威），
      // Task.goal 只是给展示用的投影，不是第二份事实。
      this.db
        .prepare('UPDATE task SET goal = ?, updated_at = ? WHERE id = ?')
        .run(record.goal, ts, record.taskId)

      return record
    })

    return tx()
  }

  /** 当前生效的契约。没有则 undefined —— 调用方必须 fail-closed。 */
  getActiveTaskContract(taskId: string): TaskContract | undefined {
    const row = this.db
      .prepare(
        `SELECT ${Store.CONTRACT_COLUMNS} FROM task_contract
         WHERE task_id = ? AND status = 'active'`,
      )
      .get(taskId) as Record<string, unknown> | undefined
    return row ? this.mapContract(row) : undefined
  }

  /** 全部历史版本，新的在前。 */
  listTaskContracts(taskId: string): TaskContract[] {
    const rows = this.db
      .prepare(
        `SELECT ${Store.CONTRACT_COLUMNS} FROM task_contract
         WHERE task_id = ? ORDER BY contract_version DESC`,
      )
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapContract(r))
  }

  /** 累加 Task 级用量。ReviewLoop 多轮返工共用，不每轮重置。 */
  addTaskUsage(id: string, delta: Partial<TaskUsage>): TaskUsage {
    const task = this.getTask(id)
    if (!task) throw new Error(`task not found: ${id}`)
    const base: TaskUsage = task.usage ?? {
      costUsd: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cycles: 0, startedAt: now(),
    }
    const usage: TaskUsage = {
      costUsd: base.costUsd + (delta.costUsd ?? 0),
      steps: base.steps + (delta.steps ?? 0),
      toolCalls: base.toolCalls + (delta.toolCalls ?? 0),
      inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
      cycles: base.cycles + (delta.cycles ?? 0),
      startedAt: base.startedAt,
    }
    if (base.costUnknown || delta.costUnknown) usage.costUnknown = true
    this.db.prepare('UPDATE task SET usage = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(usage), now(), id)
    return usage
  }

  // ── run ────────────────────────────────────────────────

  createRun(input: { taskId: string; role: RunRole; budget: RunBudget; parentRunId?: string; id?: string }): Run {
    const run: Run = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      parentRunId: input.parentRunId,
      role: input.role,
      status: 'queued',
      budget: input.budget,
      grantIds: [],
      usage: { inputTokens: 0, outputTokens: 0, steps: 0, toolCalls: 0, costUsd: 0 },
    }
    this.db
      .prepare('INSERT INTO run(id, task_id, parent_run_id, role, status, budget, grant_ids, usage, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)')
      .run(run.id, run.taskId, run.parentRunId ?? null, run.role, run.status, JSON.stringify(run.budget), JSON.stringify(run.grantIds), JSON.stringify(run.usage))
    return run
  }

  private static readonly RUN_COLUMNS =
    'id, task_id as taskId, parent_run_id as parentRunId, role, status, budget, grant_ids as grantIds, usage, model_identity as modelIdentity, started_at as startedAt, ended_at as endedAt'

  private mapRun(row: Record<string, unknown>): Run {
    return {
      id: row.id as string,
      taskId: row.taskId as string,
      parentRunId: (row.parentRunId as string | null) ?? undefined,
      role: row.role as Run['role'],
      status: row.status as RunStatus,
      budget: JSON.parse(row.budget as string) as RunBudget,
      grantIds: JSON.parse(row.grantIds as string) as string[],
      usage: JSON.parse(row.usage as string) as RunUsage,
      modelIdentity: row.modelIdentity
        ? (JSON.parse(row.modelIdentity as string) as ModelIdentity)
        : undefined,
      startedAt: (row.startedAt as number | null) ?? undefined,
      endedAt: (row.endedAt as number | null) ?? undefined,
    }
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.RUN_COLUMNS} FROM run WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.mapRun(row) : undefined
  }

  listRuns(taskId: string): Run[] {
    const rows = this.db
      .prepare(`SELECT ${Store.RUN_COLUMNS} FROM run WHERE task_id = ? ORDER BY rowid ASC`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRun(r))
  }

  /** 全部产物（跨 Task）。只给不变式体检使用。 */
  listAllArtifacts(): Artifact[] {
    const rows = this.db
      .prepare(`SELECT ${Store.ARTIFACT_COLUMNS} FROM artifact ORDER BY rowid ASC`)
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapArtifact(r))
  }

  /** 全部 Run（跨 Task）。只给不变式体检与启动恢复使用。 */
  listAllRuns(): Run[] {
    const rows = this.db
      .prepare(`SELECT ${Store.RUN_COLUMNS} FROM run ORDER BY rowid ASC`)
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRun(r))
  }

  /**
   * 按状态列出全部 Run（跨 Task）。
   *
   * 只给启动恢复用。业务代码不该「扫全表的 running」——
   * 那会跨 Task 边界，也缺乏越权判断的依据。
   */
  listRunsByStatus(status: RunStatus): Run[] {
    const rows = this.db
      .prepare(`SELECT ${Store.RUN_COLUMNS} FROM run WHERE status = ? ORDER BY rowid ASC`)
      .all(status) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapRun(r))
  }

  /**
   * 记录 Run 实际使用的模型身份。
   *
   * 只写一次：已经有身份就不覆盖。
   * 理由：返工或重入时不能改变"这个 Run 到底是谁跑的"，
   * 否则审计的模型族隔离校验可以被人为改写。
   */
  recordModelIdentity(runId: string, identity: ModelIdentity): void {
    this.db
      .prepare('UPDATE run SET model_identity = ? WHERE id = ? AND model_identity IS NULL')
      .run(JSON.stringify(identity), runId)
  }

  setRunStatus(id: string, status: RunStatus, patch: { startedAt?: number; endedAt?: number } = {}): void {
    this.db
      .prepare('UPDATE run SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at) WHERE id = ?')
      .run(status, patch.startedAt ?? null, patch.endedAt ?? null, id)
  }

  /**
   * 比较并交换（CAS）地迁移 Run 状态。
   *
   * 为什么必须有这个：
   *   「读状态 → 判断 → 写状态」在多线程/多进程下不是原子的。
   *   两个 execute 同时读到 queued，都会通过判断，都会开始执行。
   *
   * 用条件 UPDATE 让数据库来做这件事：只有当前状态还在期望值上，
   * 更新才会生效。返回 false 表示别人先改了。
   *
   * @returns 是否抢到了这次状态迁移
   */
  // ── 带 epoch 的条件写（审计二轮 P0）────────────────────
  //
  // 为什么不能只判 status：接管发生后，旧 owner 与状态之间
  // 没有必然矛盾——它可能仍然看到 running，于是 CAS 通过。
  // 真正的判据是「我还持有这一代租约吗」，也就是 lease_epoch。
  //
  // 所有关键写入都走这几个方法，不再绕过去直接 UPDATE。

  /**
   * 认领一个 Run 到指定 epoch。
   *
   * 执行开始前调用：把当前租约 epoch 写进去。
   * 同时校验「状态允许开始」，避免认领一个已完成的 Run。
   */
  claimRunForEpoch(
    id: string,
    from: RunStatus | RunStatus[],
    epoch: number,
    patch: { startedAt?: number } = {},
  ): boolean {
    const fromList = Array.isArray(from) ? from : [from]
    const placeholders = fromList.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE run
         SET status = 'running', started_at = COALESCE(?, started_at), lease_epoch = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(patch.startedAt ?? null, epoch, id, ...fromList)
    return result.changes > 0
  }

  /**
   * 带 epoch 条件的 Run 状态迁移。
   *
   * epoch 不匹配 → 0 行受影响 → 返回 false。
   * 这就是 fencing：旧 owner 的写入必然失败。
   */
  transitionRunStatusFenced(
    id: string,
    from: RunStatus | RunStatus[],
    to: RunStatus,
    epoch: number,
    patch: { startedAt?: number; endedAt?: number } = {},
  ): boolean {
    const fromList = Array.isArray(from) ? from : [from]
    const placeholders = fromList.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE run
         SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), lease_epoch = ?
         WHERE id = ? AND status IN (${placeholders}) AND lease_epoch = ?`,
      )
      .run(to, patch.startedAt ?? null, patch.endedAt ?? null, epoch, id, ...fromList, epoch)
    return result.changes > 0
  }

  /**
   * 接管时把 Run 的 lease_epoch 换成新的一代。
   *
   * 这是 fencing 链条上最关键的一步：
   *   · 旧 owner 的写入要求 epoch = 旧值 → 换过之后必然失败
   *   · 新 owner 的写入要求 epoch = 新值 → 只有换过之后才生效
   *
   * 用条件写实现（WHERE lease_epoch = @old），保证两个 runner
   * 同时接管时只有一个真正完成转移，另一个拿到 changes=0。
   *
   * @param replacingEpoch 期望替换掉的旧 epoch。省略时无条件替换
   *                       （只在首次认领等已知安全的路径使用）。
   */
  adoptRunEpoch(runId: string, newEpoch: number, replacingEpoch?: number): boolean {
    const res = replacingEpoch === undefined
      ? this.db.prepare('UPDATE run SET lease_epoch = ? WHERE id = ? AND lease_epoch <> ?')
          .run(newEpoch, runId, newEpoch)
      : this.db.prepare('UPDATE run SET lease_epoch = ? WHERE id = ? AND lease_epoch = ?')
          .run(newEpoch, runId, replacingEpoch)
    return res.changes > 0
  }

  /** Step 状态写入，带 epoch 条件。 */
  updateStepStatusFenced(id: string, status: string, epoch: number, patch: Record<string, unknown> = {}): boolean {
    const sets = ['status = ?', 'lease_epoch = ?']
    const params: unknown[] = [status, epoch]
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`)
      params.push(v)
    }
    params.push(id, epoch)
    const res = this.db
      .prepare(`UPDATE step SET ${sets.join(', ')} WHERE id = ? AND lease_epoch = ?`)
      .run(...params)
    return res.changes > 0
  }

  /** 追加 Run 历史消息，带 epoch 条件写入（写入时附带并校验 epoch）。 */
  appendRunMessageFenced(runId: string, payload: unknown, epoch: number): boolean {
    // 先确认这个 Run 仍属于这一代
    const owner = this.db
      .prepare('SELECT lease_epoch AS e FROM run WHERE id = ?')
      .get(runId) as { e: number } | undefined
    if (!owner || owner.e !== epoch) return false
    const seqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_message WHERE run_id = ?')
      .get(runId) as { next: number }
    this.db
      .prepare('INSERT INTO run_message(run_id, seq, payload, created_at, lease_epoch) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seqRow.next, JSON.stringify(payload), now(), epoch)
    return true
  }

  transitionRunStatus(
    id: string,
    from: RunStatus | RunStatus[],
    to: RunStatus,
    patch: { startedAt?: number; endedAt?: number } = {},
  ): boolean {
    const fromList = Array.isArray(from) ? from : [from]
    const placeholders = fromList.map(() => '?').join(', ')
    const result = this.db
      .prepare(
        `UPDATE run
         SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at)
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, patch.startedAt ?? null, patch.endedAt ?? null, id, ...fromList)
    return result.changes > 0
  }

  addRunUsage(id: string, delta: Partial<RunUsage>): RunUsage {
    const run = this.getRun(id)
    if (!run) throw new Error(`run not found: ${id}`)
    const usage: RunUsage = {
      inputTokens: run.usage.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: run.usage.outputTokens + (delta.outputTokens ?? 0),
      steps: run.usage.steps + (delta.steps ?? 0),
      toolCalls: run.usage.toolCalls + (delta.toolCalls ?? 0),
      costUsd: run.usage.costUsd + (delta.costUsd ?? 0),
    }
    // 成本未知是「一旦发生就永久成立」的事实：后面再精确的调用
    // 也不能把前面那笔未知成本变成已知。
    if (run.usage.costUnknown || delta.costUnknown) usage.costUnknown = true
    this.db.prepare('UPDATE run SET usage = ? WHERE id = ?').run(JSON.stringify(usage), id)
    return usage
  }

  addGrantToRun(runId: string, grantId: string): void {
    const run = this.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    if (run.grantIds.includes(grantId)) return
    const ids = [...run.grantIds, grantId]
    this.db.prepare('UPDATE run SET grant_ids = ? WHERE id = ?').run(JSON.stringify(ids), runId)
  }

  // ── run 工作历史 ───────────────────────────────────────

  appendRunMessage(runId: string, message: unknown): void {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM run_message WHERE run_id = ?')
      .get(runId) as { maxSeq: number }
    this.db
      .prepare('INSERT INTO run_message(run_id, seq, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(runId, row.maxSeq + 1, JSON.stringify(message), now())
  }

  listRunMessages<T = unknown>(runId: string): T[] {
    const rows = this.db
      .prepare('SELECT payload FROM run_message WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<{ payload: string }>
    return rows.map((r) => JSON.parse(r.payload) as T)
  }

  /**
   * 带序号与时间戳的 Run 历史。
   *
   * 会话投影需要 seq（作为稳定 id）与 created_at（排序），
   * 只拿 payload 的 listRunMessages 拿不到这两样。
   */
  listRunMessagesWithMeta<T = unknown>(
    runId: string,
  ): Array<{ seq: number; payload: T; createdAt: number }> {
    const rows = this.db
      .prepare('SELECT seq, payload, created_at as createdAt FROM run_message WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as Array<{ seq: number; payload: string; createdAt: number }>
    return rows.map((r) => ({
      seq: r.seq,
      payload: JSON.parse(r.payload) as T,
      createdAt: r.createdAt,
    }))
  }

  // ── 会话附件 ────────────────────────────────────────────

  createAttachment(input: {
    sessionId: string
    name: string
    mimeType: string
    bytes: number
    storagePath: string
    contentHash: string
  }): Attachment {
    const record: Attachment = {
      id: randomUUID(),
      sessionId: input.sessionId,
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.bytes,
      storagePath: input.storagePath,
      contentHash: input.contentHash,
      createdAt: now(),
    }
    this.db
      .prepare(
        'INSERT INTO attachment(id, session_id, name, mime_type, bytes, storage_path, content_hash, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(
        record.id,
        record.sessionId,
        record.name,
        record.mimeType,
        record.bytes,
        record.storagePath,
        record.contentHash,
        record.createdAt,
      )
    return record
  }

  getAttachment(id: string): Attachment | undefined {
    const row = this.db
      .prepare(
        'SELECT id, session_id as sessionId, name, mime_type as mimeType, bytes, storage_path as storagePath, content_hash as contentHash, created_at as createdAt, deleted_at as deletedAt FROM attachment WHERE id = ?',
      )
      .get(id) as (Attachment & { deletedAt: number | null }) | undefined
    if (!row) return undefined
    const out: Attachment = { ...row }
    delete (out as { deletedAt?: number | null }).deletedAt
    if (row.deletedAt !== null) out.deletedAt = row.deletedAt
    return out
  }

  listAttachments(sessionId: string): Attachment[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id as sessionId, name, mime_type as mimeType, bytes, storage_path as storagePath, content_hash as contentHash, created_at as createdAt FROM attachment WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at ASC',
      )
      .all(sessionId) as Attachment[]
    return rows
  }

  deleteAttachment(id: string): void {
    this.db
      .prepare('UPDATE attachment SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now(), id)
  }

  // ── step ───────────────────────────────────────────────

  createStep(input: {
    runId: string
    index: number
    kind: StepKind
    status: StepStatus
    input?: unknown
    output?: unknown
    attemptOf?: string
    id?: string
  }): Step {
    const step: Step = {
      id: input.id ?? randomUUID(),
      runId: input.runId,
      index: input.index,
      kind: input.kind,
      status: input.status,
      input: input.input,
      retryCount: 0,
      attemptOf: input.attemptOf,
      trace: {},
      createdAt: now(),
    }
    this.db
      .prepare('INSERT INTO step(id, run_id, idx, kind, status, input, output, retry_count, attempt_of, trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(
        step.id,
        step.runId,
        step.index,
        step.kind,
        step.status,
        input.input === undefined ? null : JSON.stringify(input.input),
        input.output === undefined ? null : JSON.stringify(input.output),
        step.attemptOf ?? null,
        JSON.stringify(step.trace),
        step.createdAt,
      )
    return step
  }

  getStep(id: string): Step | undefined {
    const row = this.db
      .prepare('SELECT id, run_id as runId, idx as "index", kind, status, input, output, retry_count as retryCount, attempt_of as attemptOf, trace, created_at as createdAt FROM step WHERE id = ?')
      .get(id) as (Omit<Step, 'input' | 'output' | 'trace'> & { input: string | null; output: string | null; trace: string }) | undefined
    return row
      ? {
          ...row,
          input: row.input ? JSON.parse(row.input) : undefined,
          output: row.output ? JSON.parse(row.output) : undefined,
          trace: JSON.parse(row.trace) as StepTrace,
        }
      : undefined
  }

  listSteps(runId: string): Step[] {
    const rows = this.db
      .prepare('SELECT id, run_id as runId, idx as "index", kind, status, input, output, retry_count as retryCount, attempt_of as attemptOf, trace, created_at as createdAt FROM step WHERE run_id = ? ORDER BY idx ASC, rowid ASC')
      .all(runId) as Array<Omit<Step, 'input' | 'output' | 'trace'> & { input: string | null; output: string | null; trace: string }>
    return rows.map((r) => ({
      ...r,
      input: r.input ? JSON.parse(r.input) : undefined,
      output: r.output ? JSON.parse(r.output) : undefined,
      trace: JSON.parse(r.trace) as StepTrace,
    }))
  }

  updateStep(id: string, patch: { status?: StepStatus; output?: unknown; trace?: StepTrace }): void {
    const step = this.getStep(id)
    if (!step) throw new Error(`step not found: ${id}`)
    this.db
      .prepare('UPDATE step SET status = ?, output = ?, trace = ? WHERE id = ?')
      .run(
        patch.status ?? step.status,
        patch.output === undefined ? (step.output === undefined ? null : JSON.stringify(step.output)) : JSON.stringify(patch.output),
        JSON.stringify(patch.trace ?? step.trace),
        id,
      )
  }

  // ── grant ──────────────────────────────────────────────

  createGrant(input: Omit<Grant, 'usedCalls'> & { usedCalls?: number }): Grant {
    const grant: Grant = { ...input, usedCalls: input.usedCalls ?? 0 }
    this.db
      .prepare('INSERT INTO grant(id, run_id, tool_id, scope, constraints, max_calls, expires_at, status, approver, used_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        grant.id,
        grant.runId,
        grant.toolId,
        grant.scope === undefined ? null : JSON.stringify(grant.scope),
        JSON.stringify(grant.constraints),
        grant.constraints.maxCalls ?? null,
        grant.expiresAt,
        grant.status,
        grant.approver ?? null,
        grant.usedCalls,
      )
    this.addGrantToRun(grant.runId, grant.id)
    return grant
  }

  listGrants(runId: string): Grant[] {
    const rows = this.db
      .prepare('SELECT id, run_id as runId, tool_id as toolId, scope, constraints, expires_at as expiresAt, status, approver, used_calls as usedCalls FROM grant WHERE run_id = ?')
      .all(runId) as Array<Omit<Grant, 'scope' | 'constraints'> & { scope: string | null; constraints: string }>
    return rows.map((r) => ({
      ...r,
      scope: r.scope ? JSON.parse(r.scope) : undefined,
      constraints: JSON.parse(r.constraints),
    }))
  }

  incrementGrantUsage(id: string): void {
    this.db.prepare('UPDATE grant SET used_calls = used_calls + 1 WHERE id = ?').run(id)
  }

  /**
   * 原子地认领一次 Grant 使用额度。
   *
   * scope=once 靠这个实现真正的"只允许一次"：
   * 递增和额度检查在同一个 UPDATE 里完成，
   * 两个并发请求只有一个能成功。
   *
   * 非原子的话（先查 used_calls、再 +1），
   * 两个请求都读到 used_calls=0，都通过检查，
   * 都执行工具，结果被用了两次。
   *
   * @returns 是否成功认领
   */
  claimGrantUsage(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE grant
         SET used_calls = used_calls + 1
         WHERE id = ?
           AND status = 'active'
           AND expires_at > ?
           AND (max_calls IS NULL OR used_calls < max_calls)`,
      )
      .run(id, now())
    return result.changes > 0
  }

  revokeGrant(id: string): void {
    this.db.prepare('UPDATE grant SET status = ? WHERE id = ?').run('revoked', id)
  }

  // ── approval ───────────────────────────────────────────

  createApproval(input: {
    runId: string
    stepId: string
    toolId: string
    toolCallId: string
    arguments: unknown
    /** 超时时间（毫秒）。超时后自动转为 rejected。 */
    timeoutMs?: number
    id?: string
  }): Approval {
    const createdAt = now()
    const approval: Approval = {
      id: input.id ?? randomUUID(),
      runId: input.runId,
      stepId: input.stepId,
      toolId: input.toolId,
      toolCallId: input.toolCallId,
      arguments: input.arguments,
      status: 'pending',
      createdAt,
      // 默认 5 分钟。超时 fail-closed——不能永久挂在 paused。
      expiresAt: createdAt + (input.timeoutMs ?? 5 * 60_000),
      resultConsumed: false,
    }
    this.db
      .prepare('INSERT INTO approval(id, run_id, step_id, tool_id, tool_call_id, arguments, status, expires_at, created_at, result_consumed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(
        approval.id,
        approval.runId,
        approval.stepId,
        approval.toolId,
        approval.toolCallId,
        JSON.stringify(approval.arguments),
        approval.status,
        approval.expiresAt,
        approval.createdAt,
      )
    return approval
  }

  private mapApproval(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      runId: row.runId as string,
      stepId: row.stepId as string,
      toolId: row.toolId as string,
      toolCallId: (row.toolCallId as string) ?? '',
      arguments: JSON.parse(row.arguments as string),
      status: row.status as Approval['status'],
      reason: (row.reason as string | null) ?? undefined,
      decidedAt: (row.decidedAt as number | null) ?? undefined,
      createdAt: row.createdAt as number,
      expiresAt: (row.expiresAt as number) || 0,
      resultConsumed: Boolean(row.resultConsumed),
      approver: (row.approver as 'user' | 'system' | null) ?? 'user',
    }
  }

  private static readonly APPROVAL_COLUMNS =
    'id, run_id as runId, step_id as stepId, tool_id as toolId, tool_call_id as toolCallId, arguments, status, reason, decided_at as decidedAt, expires_at as expiresAt, created_at as createdAt, result_consumed as resultConsumed, approver'

  getApproval(id: string): Approval | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.APPROVAL_COLUMNS} FROM approval WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.mapApproval(row) : undefined
  }

  listApprovals(status?: Approval['status']): Approval[] {
    const sql = `SELECT ${Store.APPROVAL_COLUMNS} FROM approval` +
      (status ? ' WHERE status = ?' : '') +
      ' ORDER BY created_at ASC'
    const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapApproval(r))
  }

  /** 找出这个 Run 里已决定但结果还没回填进历史的审批。恢复执行时优先处理它们。 */
  pendingResolutions(runId: string): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT ${Store.APPROVAL_COLUMNS} FROM approval
         WHERE run_id = ? AND status IN ('approved','rejected') AND result_consumed = 0
         ORDER BY created_at ASC`,
      )
      .all(runId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapApproval(r))
  }

  markApprovalConsumed(id: string): void {
    this.db.prepare('UPDATE approval SET result_consumed = 1 WHERE id = ?').run(id)
  }

  /**
   * 把超时未决的审批标记为 rejected。
   *
   * fail-closed：超时 = 拒绝，不是"继续等待"也不是"默认通过"。
   * 返回被处理的审批，供调用方把拒绝结果回填进 Run 历史。
   */
  expireStaleApprovals(at = now()): Approval[] {
    const stale = this.db
      .prepare(
        `SELECT ${Store.APPROVAL_COLUMNS} FROM approval
         WHERE status = 'pending' AND expires_at > 0 AND expires_at <= ?`,
      )
      .all(at) as Array<Record<string, unknown>>

    const result = stale.map((r) => this.mapApproval(r))
    for (const a of result) {
      // approver = 'system'：这条拒绝是内核按 fail-closed 做的，不是用户点的。
      // 审计必须能区分「用户拒绝了」和「没人管所以超时」。
      this.decideApproval(
        a.id,
        'rejected',
        '审批超时，系统按 fail-closed 规则自动拒绝',
        'system',
      )
    }
    return result
  }

  // ── budget reservation ─────────────────────────────────

  private static readonly RESV_COLUMNS =
    'id, run_id as runId, task_id as taskId, steps, tool_calls as toolCalls, ' +
    'input_tokens as inputTokens, output_tokens as outputTokens, ' +
    'cost_usd as costUsd, actual_steps as actualSteps, ' +
    'actual_tool_calls as actualToolCalls, actual_input_tokens as actualInputTokens, ' +
    'actual_output_tokens as actualOutputTokens, actual_cost_usd as actualCostUsd, ' +
    'actual_cost_known as actualCostKnown, ' +
    'purpose, owner, status, created_at as createdAt, ' +
    'expires_at as expiresAt, settled_at as settledAt'

  private mapReservation(row: Record<string, unknown>): BudgetReservation {
    return {
      id: row.id as string,
      runId: row.runId as string,
      taskId: row.taskId as string,
      steps: row.steps as number,
      toolCalls: row.toolCalls as number,
      inputTokens: row.inputTokens as number,
      outputTokens: row.outputTokens as number,
      costUsd: row.costUsd as number,
      actualSteps: row.actualSteps as number,
      actualToolCalls: row.actualToolCalls as number,
      actualInputTokens: row.actualInputTokens as number,
      actualOutputTokens: row.actualOutputTokens as number,
      actualCostUsd: row.actualCostUsd as number,
      actualCostKnown: row.actualCostKnown === 1,
      purpose: row.purpose as string,
      owner: (row.owner as string | null) ?? undefined,
      status: row.status as BudgetReservation['status'],
      createdAt: row.createdAt as number,
      expiresAt: row.expiresAt as number,
      settledAt: (row.settledAt as number | null) ?? undefined,
    }
  }

  /** 某个 Run 的全部预留记录，按创建顺序。用于诊断与测试。 */
  listReservationsForRun(runId: string): BudgetReservation[] {
    const rows = this.db
      .prepare(
        `SELECT ${Store.RESV_COLUMNS} FROM budget_reservation
         WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(runId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapReservation(r))
  }

  /** 按 id 取一条预留记录，用于诊断与测试。 */
  getReservation(id: string): BudgetReservation | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.RESV_COLUMNS} FROM budget_reservation WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.mapReservation(row) : undefined
  }

  /**
   * 汇总某个 Run / Task 当前**未结算**的预留。
   *
   * **过期的也要算**——这是 v0.13 的关键修正。
   *
   * 旧实现用 `expires_at > now` 过滤，理由是「过期说明进程崩了，
   * 那个额度不该被永久占用」。问题是：
   *
   *   · 过期只说明「超过 TTL 还没结算」，**不说明调用没发生**
   *   · 那个调用可能还在飞行中，token 已经在烧
   *   · 把它从「已占用」里去掉，新调用就会看到虚假的空闲额度
   *   · 等旧调用真的结算，usage 突然增加——总额早已超支
   *
   * 正确语义：**status='reserved' 就一直占用额度**，不管过期与否。
   * 释放只能通过两条明确路径：
   *   · releaseBudget（确认调用没发生）
   *   · settleBudget（确认调用发生，转入 usage）
   *
   * `expireReservations` 仍然有用，但它的作用从「释放额度」变成
   * 「标记出需要人工/自动对账的悬挂调用」——状态改成 expired，
   * 记录保留，额度继续占着，直到有人明确裁决。
   *
   * 这就是 unknown 语义在预算上的对应物：不知道有没有花，
   * 就不能当作没花。
   */
  reservedBudget(taskId: string, runId?: string, at = now()): {
    steps: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    costUsd: number
  } {
    // `at` 参数保留是为了测试可以指定时间点；语义上不再用它过滤。
    void at
    const sql = `SELECT
        COALESCE(SUM(steps), 0) as steps,
        COALESCE(SUM(tool_calls), 0) as toolCalls,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cost_usd), 0) as costUsd
      FROM budget_reservation
      WHERE task_id = ? AND status IN ('reserved', 'expired')` +
      (runId ? ' AND run_id = ?' : '')
    const row = (runId
      ? this.db.prepare(sql).get(taskId, runId)
      : this.db.prepare(sql).get(taskId)) as Record<string, number>
    return {
      steps: row.steps ?? 0,
      toolCalls: row.toolCalls ?? 0,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      costUsd: row.costUsd ?? 0,
    }
  }

  /**
   * 调用前预留预算。**判定与写入在同一个事务里。**
   *
   * 判定式：`usage + reserved + estimate <= limit`
   *
   * 三个数各自的含义：
   *   usage     已经真实发生的（结算过的）
   *   reserved  已预留但还没结算的（正在飞行的调用）
   *   estimate  这次准备占用的
   *
   * 为什么必须带 reserved：两个并发 Run 都看到 usage=0 时，
   * 第一个的预留还没结算，第二个必须能看到它，否则双双放行。
   *
   * @returns ok=false 时**不得发起调用**
   */
  reserveBudget(input: {
    runId: string
    taskId: string
    purpose?: string
    steps?: number
    toolCalls?: number
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
    ttlMs?: number
    /**
     * 谁占用了这笔额度。
     *
     * 用于「别人不能替你结算」——没有 owner 时，
     * 任何进程都能结算任何一条 reservation。
     */
    owner?: string
    /** 测试用：把「现在」推到某个时间点。生产代码不传。 */
    at?: number
  }): { ok: true; reservationId: string } | { ok: false; reason: string; dimension: string } {
    const want = {
      steps: input.steps ?? 0,
      toolCalls: input.toolCalls ?? 0,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      costUsd: input.costUsd ?? 0,
    }

    const tx = this.db.transaction((): { ok: true; reservationId: string } | { ok: false; reason: string; dimension: string } => {
      const run = this.getRun(input.runId)
      if (!run) return { ok: false, reason: `Run 不存在：${input.runId}`, dimension: 'run' }
      const task = this.getTask(input.taskId)
      if (!task) return { ok: false, reason: `Task 不存在：${input.taskId}`, dimension: 'task' }

      // 事务内重新读取，确保拿到最新状态
      const reserved = this.reservedBudget(input.taskId, undefined, input.at)

      // ── deadline（绝对时间，不参与累加）──────────────────
      if (run.budget.deadlineAt != null && Date.now() > run.budget.deadlineAt) {
        return { ok: false, reason: '已超过 Run 的截止时间（deadlineAt）', dimension: 'deadlineAt' }
      }
      if (task.budget?.maxDurationMs != null && task.usage) {
        const elapsed = Date.now() - task.usage.startedAt
        if (elapsed >= task.budget.maxDurationMs) {
          return { ok: false, reason: '已超过 Task 的最大时长（maxDurationMs）', dimension: 'task.maxDurationMs' }
        }
      }

      // ── Run 级 ─────────────────────────────────────────
      const b = run.budget
      const u = run.usage

      if (b.maxSteps != null && u.steps + reserved.steps + want.steps > b.maxSteps) {
        return {
          ok: false, dimension: 'maxSteps',
          reason: `Run 的 steps 预算不足：已用 ${u.steps} + 已预留 ${reserved.steps} + 本次 ${want.steps} > 上限 ${b.maxSteps}`,
        }
      }
      if (b.maxToolCalls != null && u.toolCalls + reserved.toolCalls + want.toolCalls > b.maxToolCalls) {
        return {
          ok: false, dimension: 'maxToolCalls',
          reason: `Run 的 toolCalls 预算不足：已用 ${u.toolCalls} + 已预留 ${reserved.toolCalls} + 本次 ${want.toolCalls} > 上限 ${b.maxToolCalls}`,
        }
      }
      if (b.maxInputTokens != null && u.inputTokens + reserved.inputTokens + want.inputTokens > b.maxInputTokens) {
        return {
          ok: false, dimension: 'maxInputTokens',
          reason: `Run 的 inputTokens 预算不足：已用 ${u.inputTokens} + 已预留 ${reserved.inputTokens} + 本次 ${want.inputTokens} > 上限 ${b.maxInputTokens}`,
        }
      }
      if (b.maxOutputTokens != null && u.outputTokens + reserved.outputTokens + want.outputTokens > b.maxOutputTokens) {
        return {
          ok: false, dimension: 'maxOutputTokens',
          reason: `Run 的 outputTokens 预算不足：已用 ${u.outputTokens} + 已预留 ${reserved.outputTokens} + 本次 ${want.outputTokens} > 上限 ${b.maxOutputTokens}`,
        }
      }
      if (b.maxTotalTokens != null) {
        const usedTotal = u.inputTokens + u.outputTokens
        const resvTotal = reserved.inputTokens + reserved.outputTokens
        const wantTotal = want.inputTokens + want.outputTokens
        if (usedTotal + resvTotal + wantTotal > b.maxTotalTokens) {
          return {
            ok: false, dimension: 'maxTotalTokens',
            reason: `Run 的 totalTokens 预算不足：已用 ${usedTotal} + 已预留 ${resvTotal} + 本次 ${wantTotal} > 上限 ${b.maxTotalTokens}`,
          }
        }
      }
      if (b.maxCostUsd != null && u.costUsd + reserved.costUsd + want.costUsd > b.maxCostUsd) {
        return {
          ok: false, dimension: 'maxCostUsd',
          reason: `Run 的成本预算不足：已用 ${u.costUsd.toFixed(4)} + 已预留 ${reserved.costUsd.toFixed(4)} + 本次 ${want.costUsd.toFixed(4)} > 上限 ${b.maxCostUsd}`,
        }
      }

      // ── Task 级（跨 Run 累计）──────────────────────────
      const tb = task.budget
      const tu = task.usage
      if (tb && tu) {
        if (tb.maxSteps != null && tu.steps + reserved.steps + want.steps > tb.maxSteps) {
          return {
            ok: false, dimension: 'task.maxSteps',
            reason: `Task 的 steps 预算不足：已用 ${tu.steps} + 已预留 ${reserved.steps} + 本次 ${want.steps} > 上限 ${tb.maxSteps}`,
          }
        }
        if (tb.maxCostUsd != null && tu.costUsd + reserved.costUsd + want.costUsd > tb.maxCostUsd) {
          return {
            ok: false, dimension: 'task.maxCostUsd',
            reason: `Task 的成本预算不足：已用 ${tu.costUsd.toFixed(4)} + 已预留 ${reserved.costUsd.toFixed(4)} + 本次 ${want.costUsd.toFixed(4)} > 上限 ${tb.maxCostUsd}`,
          }
        }
      }

      // ── 写入预留 ───────────────────────────────────────
      const id = randomUUID()
      const ts = input.at ?? now()
      this.db
        .prepare(
          `INSERT INTO budget_reservation(
             id, run_id, task_id, steps, tool_calls, input_tokens, output_tokens,
             cost_usd, purpose, owner, status, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          id, input.runId, input.taskId,
          want.steps, want.toolCalls, want.inputTokens, want.outputTokens,
          want.costUsd, input.purpose ?? 'unspecified', input.owner ?? null,
          ts, ts + (input.ttlMs ?? 5 * 60_000),
        )

      return { ok: true, reservationId: id }
    })

    return tx()
  }

  /**
   * 结算：按实际用量累加 usage，并释放预留。
   *
   * **幂等**：已经结算过的预留直接返回，不会重复累加。
   * 这一点很重要——调用方可能在 try 和 finally 里各调一次。
   *
   * 实际用量超过预留是正常的（估算不可能精确），
   * 超出的部分照样计入 usage；下一次预留会看到它。
   */
  settleBudget(
    reservationId: string,
    actual: {
      steps?: number
      toolCalls?: number
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
      /**
       * 成本是否是精确值。默认 true（调用方给了确切金额）。
       *
       * 价格未知时必须显式传 false —— 否则 `costUsd ?? 0` 会把
       * 「不知道花了多少」写成「花了 0 元」，事后看起来像精确记账。
       */
      costKnown?: boolean
    },
    opts: { owner?: string } = {},
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db
        .prepare(`SELECT ${Store.RESV_COLUMNS} FROM budget_reservation WHERE id = ?`)
        .get(reservationId) as Record<string, unknown> | undefined
      if (!row) return false

      const resv = this.mapReservation(row)

      // owner 校验：别人不能替你结算。
      //
      // 为什么要这一条：没有 owner 时，worker-2 可以结算 worker-1
      // 还在飞行中的调用，把 usage 记到自己头上（或反过来），
      // 事后完全无法区分。owner 让「谁花的钱」有据可查。
      //
      // 规则：
      //   · reservation 有 owner，调用方必须提供同一个 owner
      //   · reservation 没有 owner（旧数据），允许任何调用方结算
      if (resv.owner && opts.owner !== resv.owner) {
        return false
      }

      // 幂等与晚到结算的区分：
      //
      //   settled   → 已经结算过，重复调用直接返回（幂等）
      //   released  → 已确认调用没发生，不能再「复活」成结算
      //   expired   → **可以**被晚到的结算覆盖
      //   reserved  → 正常路径
      //
      // 为什么 expired 必须可结算：
      //   过期只说明「超过 TTL 还没结算」，不说明调用没发生。
      //   一个慢请求可能在第 11 分钟才返回（TTL 是 10 分钟），
      //   这时它真的花了 token。拒绝结算会让这笔花费从账上消失——
      //   比记错更糟，因为它连痕迹都没有。
      //
      //   状态从 expired → settled 是**信息增加**（从「不知道」变成「知道了」），
      //   不是掩盖问题。
      if (resv.status === 'settled') return true
      // released = 已确认这次调用**没有发生**。晚到的「结果」不能把它
      // 复活成一笔花费——那会把一次没发生的调用记进 usage。
      //
      // 返回 false 而不是 true：调用方需要知道「这次结算没有记账」。
      // 返回 true 等于声称「用量已记录」，而实际上什么都没写。
      if (resv.status === 'released') return false

      const costKnown = actual.costKnown ?? true
      const delta = {
        steps: actual.steps ?? 0,
        toolCalls: actual.toolCalls ?? 0,
        inputTokens: actual.inputTokens ?? 0,
        outputTokens: actual.outputTokens ?? 0,
        costUsd: actual.costUsd ?? 0,
        ...(costKnown ? {} : { costUnknown: true }),
      }

      this.addRunUsage(resv.runId, delta)
      this.addTaskUsage(resv.taskId, delta)

      this.db
        .prepare(
          `UPDATE budget_reservation
           SET status = 'settled', settled_at = ?,
               actual_steps = ?, actual_tool_calls = ?,
               actual_input_tokens = ?, actual_output_tokens = ?,
               actual_cost_usd = ?, actual_cost_known = ?
           WHERE id = ? AND status IN ('reserved', 'expired')`,
        )
        .run(
          now(), delta.steps, delta.toolCalls,
          delta.inputTokens, delta.outputTokens, delta.costUsd,
          costKnown ? 1 : 0,
          reservationId,
        )

      return true
    })

    return tx()
  }

  /**
   * 释放预留（确认调用没发生）。不累加 usage。幂等。
   *
   * 这是**唯一**能把额度退回的路径。
   * `expireReservations` 只标记状态，不释放额度——
   * 过期不等于没发生。
   *
   * **expired 也能释放。**
   *
   * 旧实现只认 `status='reserved'`，于是过期记录只能走 settle 一条路。
   * 但「确认没发生」恰恰是最常见的过期结局：进程崩了、请求根本没发出去。
   * 那条记录既不会被结算（没有用量），也释放不掉（状态不匹配），
   * 它占的额度就永久留在 Task 预算里——expireReservations 的文档
   * 写着「两条明确出口」，其中一条对过期记录根本不通。
   *
   * 这与 settle 的语义是对称的：过期只说明「超过 TTL 没结算」，
   * 既不能当作没发生（所以不自动释放），也不能当作发生了（所以不自动结算）。
   * 它等着有人给出结论，而两个结论都必须可达。
   */
  releaseBudget(reservationId: string, opts: { owner?: string } = {}): boolean {
    const resv = this.getReservation(reservationId)
    if (!resv) return false
    if (resv.owner && opts.owner !== resv.owner) return false

    // 幂等：已经释放过，重复调用不算失败
    if (resv.status === 'released') return true
    // 已经结算过的不能释放——用量已经记进 usage，退回额度等于账实不符
    if (resv.status === 'settled') return false

    const r = this.db
      .prepare(
        "UPDATE budget_reservation SET status = 'released', settled_at = ? WHERE id = ? AND status IN ('reserved', 'expired')",
      )
      .run(now(), reservationId)
    return r.changes > 0
  }

  /**
   * 回收过期预留。
   *
   * 进程崩溃时，已经 reserve 但没 settle 的记录会一直挂着。
   * 如果不回收，Task 的额度会被永久吃掉——一个崩溃就能让整个 Task 死掉。
   *
   * **只回收，不结算**：我们不知道那次调用到底发生了没有。
   * 如果它实际消耗了 token，那部分没有记进 usage——这是有意的保守：
   * 宁可少记，也不要凭猜测多记。
   */
  expireReservations(at = now()): BudgetReservation[] {
    const rows = this.db
      .prepare(`SELECT ${Store.RESV_COLUMNS} FROM budget_reservation
                WHERE status = 'reserved' AND expires_at <= ?`)
      .all(at) as Array<Record<string, unknown>>
    const expired = rows.map((r) => this.mapReservation(r))
    for (const e of expired) {
      this.db
        .prepare(
          "UPDATE budget_reservation SET status = 'expired', settled_at = ? WHERE id = ? AND status = 'reserved'",
        )
        .run(now(), e.id)
    }
    return expired
  }

  // ── tool_intent ────────────────────────────────────────

  private static readonly INTENT_COLUMNS =
    'id, run_id as runId, step_id as stepId, tool_call_id as toolCallId, ' +
    'tool_id as toolId, tool_name as toolName, request_hash as requestHash, ' +
    'operation_key as operationKey, status, created_at as createdAt, ' +
    'updated_at as updatedAt, started_at as startedAt, completed_at as completedAt, ' +
    'result_hash as resultHash, result_content as resultContent, ' +
    'result_is_error as resultIsError, error, unknown_reason as unknownReason, resolution'

  private mapIntent(row: Record<string, unknown>): ToolIntent {
    return {
      id: row.id as string,
      runId: row.runId as string,
      stepId: row.stepId as string,
      toolCallId: row.toolCallId as string,
      toolId: row.toolId as string,
      toolName: row.toolName as string,
      requestHash: row.requestHash as string,
      operationKey: row.operationKey as string,
      status: row.status as ToolIntentStatus,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
      startedAt: (row.startedAt as number | null) ?? undefined,
      completedAt: (row.completedAt as number | null) ?? undefined,
      resultHash: (row.resultHash as string | null) ?? undefined,
      resultContent: (row.resultContent as string | null) ?? undefined,
      resultIsError: row.resultIsError == null ? undefined : Boolean(row.resultIsError),
      error: (row.error as string | null) ?? undefined,
      unknownReason: (row.unknownReason as string | null) ?? undefined,
      resolution: (row.resolution as string | null) ?? undefined,
    }
  }

  /**
   * 取或建 Intent，一步完成。
   *
   * 用 SQLite 的 UPSERT + 唯一约束，而不是「先查再插」：
   * 两个并发执行同时走到这里时，先查后插会让两个都认为自己是第一个，
   * 于是同一个 toolCallId 产生两条记录、两次副作用。
   *
   * 返回的 `created` 告诉调用方这次是不是它建的——
   * 只有建成功的那一方才有资格启动执行。
   */
  /**
   * 取或建 Intent。
   *
   * **键是 `(run_id, tool_call_id)`，不含 step_id。**
   *
   * 为什么：`toolCallId` 来自模型的一次 tool_call，它标识「这一次调用」。
   * 同一次调用不该因为换了 step 就变成两次操作——
   * 旧约束 `(run_id, step_id, tool_call_id)` 挡不住这种情况，
   * 会允许同一个 toolCallId 在 step A 和 step B 各产生一条 Intent，
   * 结果是同一个逻辑操作执行两次副作用。
   *
   * 三种情形：
   *   1. 不存在 → 新建（created=true）
   *   2. 已存在且 requestHash 相同 → 复用（created=false）
   *   3. 已存在但 requestHash 不同 → **抛错**
   *
   * 第三种是模型或调用方的 bug：同一个 tool_call id 配了不同参数。
   * 不能静默复用（那会执行错的参数），也不能新建（那会执行两次）。
   * 必须让调用方知道出问题了。
   */
  getOrCreateIntent(input: {
    runId: string
    stepId: string
    toolCallId: string
    toolId: string
    toolName: string
    requestHash: string
    operationKey: string
  }): { intent: ToolIntent; created: boolean } {
    const id = randomUUID()
    const ts = now()

    // DO NOTHING：如果已存在，不覆盖任何字段（尤其不能把 committed 改回 prepared）
    const result = this.db
      .prepare(
        `INSERT INTO tool_intent(
           id, run_id, step_id, tool_call_id, tool_id, tool_name,
           request_hash, operation_key, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
         ON CONFLICT(run_id, tool_call_id) DO NOTHING`,
      )
      .run(id, input.runId, input.stepId, input.toolCallId, input.toolId,
        input.toolName, input.requestHash, input.operationKey, ts, ts)

    const row = this.db
      .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent
                WHERE run_id = ? AND tool_call_id = ?`)
      .get(input.runId, input.toolCallId) as Record<string, unknown> | undefined

    if (!row) {
      throw new Error(
        `tool_intent 写入后读不回来（run=${input.runId} call=${input.toolCallId}）`,
      )
    }

    const intent = this.mapIntent(row)

    // 复用前校验：同一个 toolCallId 必须是同一个请求
    if (!result.changes && intent.requestHash !== input.requestHash) {
      throw new Error(
        `toolCallId 冲突：Run ${input.runId} 里已经有一条 Intent（id=${intent.id}），` +
        `但这次的 requestHash 不同（已有 ${intent.requestHash.slice(0, 12)}…，` +
        `本次 ${input.requestHash.slice(0, 12)}…）。` +
        '同一个 toolCallId 不能对应两次不同的操作。',
      )
    }

    return { intent, created: result.changes > 0 }
  }

  /** 按新键 (run_id, tool_call_id) 查。step_id 只作为记录，不参与定位。 */
  getIntent(runId: string, _stepId: string, toolCallId: string): ToolIntent | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent
                WHERE run_id = ? AND tool_call_id = ?`)
      .get(runId, toolCallId) as Record<string, unknown> | undefined
    return row ? this.mapIntent(row) : undefined
  }

  listIntents(runId: string): ToolIntent[] {
    const rows = this.db
      .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent
                WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapIntent(r))
  }

  /**
   * prepared → started。**只有 prepared 能成功。**
   *
   * 返回 false 意味着这次调用已经在别处开始过（或已完成）——
   * 调用方必须停下来，不能继续执行工具。
   */
  startIntent(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tool_intent
         SET status = 'started', started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'prepared'`,
      )
      .run(now(), now(), id)
    return result.changes > 0
  }

  /** started → committed。带上结果，供崩溃后重放时直接返回。 */
  commitIntent(id: string, result: {
    content: string
    isError: boolean
    resultHash: string
  }): boolean {
    const r = this.db
      .prepare(
        `UPDATE tool_intent
         SET status = 'committed', completed_at = ?, updated_at = ?,
             result_content = ?, result_is_error = ?, result_hash = ?
         WHERE id = ? AND status = 'started'`,
      )
      .run(now(), now(), result.content, result.isError ? 1 : 0,
        result.resultHash, id)
    return r.changes > 0
  }

  /** started → failed。确定没生效的情况（比如参数校验失败、路径越权）。 */
  failIntent(id: string, error: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE tool_intent
         SET status = 'failed', completed_at = ?, updated_at = ?, error = ?
         WHERE id = ? AND status = 'started'`,
      )
      .run(now(), now(), error, id)
    return r.changes > 0
  }

  /**
   * started → unknown。**不知道外部操作有没有发生。**
   *
   * 这是超时和崩溃的归宿。不能记成 failed——failed 会让后续重试变得合法，
   * 而这里的问题恰恰是「重试可能造成第二次副作用」。
   */
  markIntentUnknown(id: string, reason: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE tool_intent
         SET status = 'unknown', updated_at = ?, unknown_reason = ?
         WHERE id = ? AND status = 'started'`,
      )
      .run(now(), reason, id)
    return r.changes > 0
  }

  /** unknown → reconciled。只记结论，不重新执行。 */
  reconcileIntent(id: string, resolution: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE tool_intent
         SET status = 'reconciled', updated_at = ?, resolution = ?
         WHERE id = ? AND status = 'unknown'`,
      )
      .run(now(), resolution, id)
    return r.changes > 0
  }

  /**
   * 进程启动时调用：把所有卡在 `started` 的 Intent 标成 unknown。
   *
   * `started` 意味着「已经开始执行，但没有记录结果」——进程死了。
   * 外部副作用可能已经发生，所以只能记 unknown。
   * 这条是崩溃恢复的核心：下次执行看到 unknown 就不会自动重试。
   */
  /**
   * 一次工具尝试的原子准备。
   *
   * **这是本批要闭合的核心缺陷。**
   *
   * 旧顺序（`claim Grant → checkBudget → startIntent`）有两个确定性漏洞：
   *
   *   1. 预算不足时 checkBudget 抛错，但 Grant 已经被扣了。
   *      工具没执行、额度却没了。
   *   2. 进程在 claim 和 startIntent 之间崩溃，同样留下
   *      「额度已扣、工具未执行」。
   *
   * 现在把「检查授权 → 扣减额度 → 标记 started」放进一个 SQLite 事务。
   * 任一步失败 → 整个事务回滚 → **Grant 不消耗、Intent 留在 prepared**。
   *
   * 边界（必须说清楚）：
   *   这个事务只覆盖**进入 started 之前**的准备工作。
   *   进入 started 之后就要调用外部工具了，而 SQLite 事务
   *   无法和文件系统/网络组成原子事务。那之后崩溃仍然只能记 unknown。
   *   所以这里**不是** exactly-once，只是「准备阶段要么全做要么全不做」。
   *
   * @returns
   *   - `{ ok: 'replay', intent }`       已有 committed 结果，直接复用
   *   - `{ ok: 'started', intent }`      准备完成，可以执行工具
   *   - `{ ok: 'no_grant' }`             没有可用授权（事务已回滚）
   *   - `{ ok: 'blocked', intent }`      Intent 处于不可执行状态
   */
  beginToolAttempt(input: {
    runId: string
    taskId: string
    stepId: string
    toolCallId: string
    toolId: string
    toolName: string
    requestHash: string
    operationKey: string
    /** 是否需要 Grant。sideEffect !== 'none' 且 riskLevel !== 'read' 时为 true */
    requireGrant: boolean
    /**
     * 这次工具调用要预留的额度。
     *
     * 预留与 Grant 认领、Intent 启动在**同一个事务**里完成——
     * 预算不足时不会扣 Grant，也不会把 Intent 推进到 started。
     *
     * 不传表示不做预算控制（只读工具、测试场景）。
     */
    reserve?: { steps?: number; toolCalls?: number }
  }): {
    ok: 'replay' | 'started' | 'no_grant' | 'blocked' | 'budget_exceeded'
    intent?: ToolIntent
    budgetError?: string
    budgetDimension?: string
    /** 预算预留 id。ok='started' 时存在，调用方负责 settle/release。 */
    reservationId?: string
  } {
    const tx = this.db.transaction((): {
      ok: 'replay' | 'started' | 'no_grant' | 'blocked' | 'budget_exceeded'
      intent?: ToolIntent
      budgetError?: string
      budgetDimension?: string
      reservationId?: string
    } => {
      // ① 读或建 Intent（事务内，唯一约束保证不会重复）
      const { intent } = this.getOrCreateIntent({
        runId: input.runId,
        stepId: input.stepId,
        toolCallId: input.toolCallId,
        toolId: input.toolId,
        toolName: input.toolName,
        requestHash: input.requestHash,
        operationKey: input.operationKey,
      })

      // ② committed → 直接复用，**不再 claim Grant**
      //
      // 这是崩溃恢复的关键：文件已经写过，Grant 可能已经用完了。
      // 如果先 claim 再检查 Intent，会因为没有额度而拒绝一个
      // 根本不该再执行的调用，还报「未授权」——完全误导。
      if (intent.status === 'committed') {
        return { ok: 'replay', intent }
      }

      // ③ started / unknown / failed / reconciled → 拒绝
      if (intent.status !== 'prepared') {
        return { ok: 'blocked', intent }
      }

      // ④ 预算预留（在 claim 之前）
      //
      // 预算明显不足时不该先扣授权。放在事务里还有一个好处：
      // 预留失败时，下面的 claim 和 startIntent 都不会执行。
      //
      // reserveBudget 内部也是事务，better-sqlite3 会自动用 SAVEPOINT
      // 嵌套——所以这里是安全的。
      let reservationId: string | undefined
      if (input.reserve) {
        const r = this.reserveBudget({
          runId: input.runId,
          taskId: input.taskId,
          purpose: 'tool',
          steps: input.reserve.steps ?? 0,
          toolCalls: input.reserve.toolCalls ?? 0,
          ttlMs: 10 * 60_000,
        })
        if (!r.ok) {
          return {
            ok: 'budget_exceeded',
            budgetError: r.reason,
            budgetDimension: r.dimension,
            intent,
          }
        }
        reservationId = r.reservationId
      }

      // ⑤ 原子占用 Grant
      if (input.requireGrant) {
        const now = Date.now()
        const row = this.db
          .prepare(
            `SELECT id FROM grant
             WHERE run_id = ? AND tool_id = ? AND status = 'active' AND expires_at > ?
               AND (max_calls IS NULL OR used_calls < max_calls)
             ORDER BY expires_at ASC LIMIT 1`,
          )
          .get(input.runId, input.toolId, now) as { id: string } | undefined

        if (!row) return { ok: 'no_grant' }

        const claimed = this.db
          .prepare(
            `UPDATE grant SET used_calls = used_calls + 1
             WHERE id = ? AND status = 'active' AND expires_at > ?
               AND (max_calls IS NULL OR used_calls < max_calls)`,
          )
          .run(row.id, now)

        if (claimed.changes === 0) return { ok: 'no_grant' }
      }

      // ⑥ prepared → started（同一事务内）
      const started = this.db
        .prepare(
          `UPDATE tool_intent
           SET status = 'started', started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'prepared'`,
        )
        .run(now(), now(), intent.id)

      if (started.changes === 0) {
        // 理论上不会发生（事务内串行），但保守处理：
        // 抛错让整个事务回滚，Grant 的扣减也会被撤销
        throw new Error('Intent 状态在事务内被意外修改')
      }

      const after = this.db
        .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent WHERE id = ?`)
        .get(intent.id) as Record<string, unknown>

      return { ok: 'started', intent: this.mapIntent(after), reservationId }
    })

    return tx()
  }

  sweepStartedIntents(): ToolIntent[] {
    const rows = this.db
      .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent WHERE status = 'started'`)
      .all() as Array<Record<string, unknown>>
    const intents = rows.map((r) => this.mapIntent(r))
    for (const it of intents) {
      this.markIntentUnknown(it.id, '进程异常终止，无法确认这个操作是否已生效')
    }
    return intents
  }

  /**
   * 把**指定 Run** 停在 running 的 Step 标成 unknown。
   *
   * 与 sweepDanglingSteps 的区别：那个扫全表，只适合启动清理
   * （此时确定没有任何执行者还活着）。运行期的崩溃接管必须按 Run 限定——
   * 全局清扫会把其他健康执行者正在进行的 Step 一起标成 unknown，
   * 让它们看起来像崩过。
   */
  sweepStepsForRun(runId: string): Array<{ stepId: string; runId: string }> {
    // 先读出来再更新：调用方需要具体 id 才能写精准的事件与报告。
    // 只返回数量会让「哪一步被标成 unknown」无从追溯。
    const rows = this.db
      .prepare("SELECT id FROM step WHERE run_id = ? AND status = 'running'")
      .all(runId) as Array<{ id: string }>
    if (rows.length === 0) return []
    this.db
      .prepare("UPDATE step SET status = 'unknown' WHERE run_id = ? AND status = 'running'")
      .run(runId)
    return rows.map((r) => ({ stepId: r.id, runId }))
  }

  /** 把**指定 Run** 停在 started 的 ToolIntent 标成 unknown。 */
  sweepIntentsForRun(runId: string): number {
    const rows = this.db
      .prepare(`SELECT ${Store.INTENT_COLUMNS} FROM tool_intent WHERE run_id = ? AND status = 'started'`)
      .all(runId) as Array<Record<string, unknown>>
    for (const r of rows) {
      this.markIntentUnknown(
        (r as { id: string }).id,
        '执行者失联，无法确认这个操作是否已生效',
      )
    }
    return rows.length
  }

  /**
   * 这个 Run 是否还有未解决的 unknown。
   *
   * **两个来源都要查**：
   *   · unknown Step    → 执行轨迹说「不知道这一步做完没有」
   *   · unknown Intent  → 副作用记录说「不知道这个外部调用生效没有」
   *
   * 只查 Step 会漏掉一种情况：Step 因为某种原因被标成了 completed/failed，
   * 但对应的 Intent 还停在 unknown——那意味着**外部操作是否发生仍然未知**。
   * 这时如果判定「没有未解决的 unknown」，Run 就能进入 completed，
   * 等于把一个真实的不确定性藏了起来。
   */
  hasUnresolvedUnknown(runId: string): boolean {
    const unknownSteps = this.db
      .prepare("SELECT id FROM step WHERE run_id = ? AND status = 'unknown'")
      .all(runId) as Array<{ id: string }>

    const resolvedSteps = new Set(
      (this.db.prepare('SELECT step_id as stepId FROM reconciliation WHERE run_id = ?').all(runId) as Array<{ stepId: string }>)
        .map((r) => r.stepId),
    )
    if (unknownSteps.some((s) => !resolvedSteps.has(s.id))) return true

    // Intent 侧：unknown 状态的 Intent 本身就是「未解决」
    // （reconcile 会把 Intent 改成 reconciled，所以查 status 就够了）
    const unknownIntents = this.db
      .prepare("SELECT id FROM tool_intent WHERE run_id = ? AND status = 'unknown'")
      .all(runId) as Array<{ id: string }>
    return unknownIntents.length > 0
  }

  /** 启动时清理：把悬挂的 running Step 标记为 unknown。 */
  sweepDanglingSteps(): Array<{ stepId: string; runId: string }> {
    const rows = this.db
      .prepare("SELECT id as stepId, run_id as runId FROM step WHERE status = 'running'")
      .all() as Array<{ stepId: string; runId: string }>

    for (const r of rows) {
      this.updateStep(r.stepId, {
        status: 'unknown',
        output: { error: '进程异常终止，无法确认这个步骤是否已完成', swept: true },
      })
    }
    return rows
  }

  // ── 对账 ───────────────────────────────────────────────

  createReconciliation(input: Omit<ReconciliationRecord, 'id' | 'decidedAt'> & { id?: string }): ReconciliationRecord {
    const record: ReconciliationRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      decidedAt: now(),
    }
    this.db
      .prepare('INSERT INTO reconciliation(id, run_id, step_id, intent_id, tool_call_id, unknown_reason, resolution, evidence, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.runId,
        record.stepId,
        record.intentId ?? null,
        record.toolCallId ?? null,
        record.unknownReason,
        record.resolution,
        record.evidence ?? null,
        record.decidedBy,
        record.decidedAt,
      )
    return record
  }

  listReconciliations(runId: string): ReconciliationRecord[] {
    return this.db
      .prepare('SELECT id, run_id as runId, step_id as stepId, intent_id as intentId, tool_call_id as toolCallId, unknown_reason as unknownReason, resolution, evidence, decided_by as decidedBy, decided_at as decidedAt FROM reconciliation WHERE run_id = ? ORDER BY decided_at ASC')
      .all(runId) as ReconciliationRecord[]
  }

  // ── ReviewLoop ─────────────────────────────────────────

  /**
   * 原子地创建一个 ReviewCycle。
   *
   * 为什么必须在一个事务里：
   *   读现有 Cycle 数 → 检查上限 → INSERT → 累加 cycles
   * 如果分开做，两个并发请求会同时读到 cycles=1，都通过检查，
   * 都创建 #2，maxCycles 被超发，cycleNumber 也重复。
   *
   * better-sqlite3 的 transaction() 是同步的，天然串行。
   *
   * 返回 null 表示已达上限（不是错误，是正常拒绝）。
   */
  createReviewCycleAtomic(input: {
    taskId: string
    skillId: string
    skillVersion: string
    producerRunId: string
    skillMaxCycles: number
  }): { ok: true; cycle: ReviewCycle } | { ok: false; reason: string } {
    const tx = this.db.transaction(() => {
      // 在事务内重新读取，确保拿到最新状态
      const existing = this.db
        .prepare('SELECT COUNT(*) as n FROM review_cycle WHERE task_id = ?')
        .get(input.taskId) as { n: number }
      const nextNumber = existing.n + 1

      if (nextNumber > input.skillMaxCycles) {
        return {
          ok: false as const,
          reason: `已达到技能规定的最大循环次数 ${input.skillMaxCycles}，不再自动返工，需要人工介入`,
        }
      }

      const taskRow = this.db
        .prepare('SELECT budget, usage FROM task WHERE id = ?')
        .get(input.taskId) as { budget: string | null; usage: string | null } | undefined
      if (!taskRow) return { ok: false as const, reason: `Task 不存在：${input.taskId}` }

      const budget = taskRow.budget ? (JSON.parse(taskRow.budget) as TaskBudget) : undefined
      if (budget?.maxCycles != null) {
        const usage = taskRow.usage ? (JSON.parse(taskRow.usage) as TaskUsage) : undefined
        const used = usage?.cycles ?? existing.n
        if (used >= budget.maxCycles) {
          return {
            ok: false as const,
            reason: `已达到任务预算规定的最大循环次数 ${budget.maxCycles}（已用 ${used}），需要人工介入`,
          }
        }
      }

      const cycle = this.createReviewCycle({
        taskId: input.taskId,
        skillId: input.skillId,
        skillVersion: input.skillVersion,
        cycleNumber: nextNumber,
        producerRunId: input.producerRunId,
      })

      this.addTaskUsage(input.taskId, { cycles: 1 })

      return { ok: true as const, cycle }
    })

    return tx()
  }

  createReviewCycle(input: Omit<ReviewCycle, 'id' | 'createdAt'> & { id?: string }): ReviewCycle {
    const cycle: ReviewCycle = { ...input, id: input.id ?? randomUUID(), createdAt: now() }
    this.db
      .prepare('INSERT INTO review_cycle(id, task_id, skill_id, skill_version, cycle_number, producer_run_id, auditor_run_id, audit_result_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        cycle.id,
        cycle.taskId,
        cycle.skillId,
        cycle.skillVersion,
        cycle.cycleNumber,
        cycle.producerRunId,
        cycle.auditorRunId ?? null,
        cycle.auditResultId ?? null,
        cycle.createdAt,
      )
    return cycle
  }

  getReviewCycle(id: string): ReviewCycle | undefined {
    return this.db
      .prepare('SELECT id, task_id as taskId, skill_id as skillId, skill_version as skillVersion, cycle_number as cycleNumber, producer_run_id as producerRunId, auditor_run_id as auditorRunId, audit_result_id as auditResultId, created_at as createdAt FROM review_cycle WHERE id = ?')
      .get(id) as ReviewCycle | undefined
  }

  listReviewCycles(taskId: string): ReviewCycle[] {
    return this.db
      .prepare('SELECT id, task_id as taskId, skill_id as skillId, skill_version as skillVersion, cycle_number as cycleNumber, producer_run_id as producerRunId, auditor_run_id as auditorRunId, audit_result_id as auditResultId, created_at as createdAt FROM review_cycle WHERE task_id = ? ORDER BY cycle_number ASC')
      .all(taskId) as ReviewCycle[]
  }

  /** 这个 Task 最近一轮的审计结果，用于回归检测。 */
  latestAuditResult(taskId: string): StoredAuditResult | undefined {
    const row = this.db
      .prepare('SELECT id, cycle_id as cycleId, task_id as taskId, verdict, confidence, result, created_at as createdAt FROM audit_result WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as Record<string, unknown> | undefined
    return row ? this.mapAuditResult(row) : undefined
  }

  private mapAuditResult(row: Record<string, unknown>): StoredAuditResult {
    return {
      id: row.id as string,
      cycleId: row.cycleId as string,
      taskId: row.taskId as string,
      verdict: row.verdict as AuditResult['verdict'],
      confidence: (row.confidence as number | null) ?? undefined,
      result: JSON.parse(row.result as string) as AuditResult,
      createdAt: row.createdAt as number,
    }
  }

  createAuditResult(input: {
    cycleId: string
    taskId: string
    result: AuditResult
    id?: string
  }): StoredAuditResult {
    const record: StoredAuditResult = {
      id: input.id ?? randomUUID(),
      cycleId: input.cycleId,
      taskId: input.taskId,
      verdict: input.result.verdict,
      confidence: input.result.confidence,
      result: input.result,
      createdAt: now(),
    }
    // 两条写入必须在同一事务里。
    //
    // 分开写会在崩溃时留下「有审计记录但 Cycle 不知道」或
    // 「Cycle 指向一个不存在的审计」——后者会让验收门读到 undefined，
    // 然后要么崩要么当成「没有审计」。
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO audit_result(id, cycle_id, task_id, verdict, confidence, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          record.id,
          record.cycleId,
          record.taskId,
          record.verdict,
          record.confidence ?? null,
          JSON.stringify(record.result),
          record.createdAt,
        )
      this.db.prepare('UPDATE review_cycle SET audit_result_id = ? WHERE id = ?').run(record.id, input.cycleId)
    })()

    return record
  }

  listAuditResults(taskId: string): StoredAuditResult[] {
    const rows = this.db
      .prepare('SELECT id, cycle_id as cycleId, task_id as taskId, verdict, confidence, result, created_at as createdAt FROM audit_result WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapAuditResult(r))
  }

  // ── 快照 ───────────────────────────────────────────────

  createSnapshot(input: Omit<Snapshot, 'id' | 'createdAt'> & { id?: string }): Snapshot {
    const snapshot: Snapshot = { ...input, id: input.id ?? randomUUID(), createdAt: now() }
    this.db
      .prepare('INSERT INTO snapshot(id, run_id, task_id, kind, ref, reproducible, not_reproducible_reason, file_count, total_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        snapshot.id,
        snapshot.runId,
        snapshot.taskId,
        snapshot.kind,
        snapshot.ref,
        snapshot.reproducible ? 1 : 0,
        snapshot.notReproducibleReason ?? null,
        snapshot.fileCount,
        snapshot.totalBytes,
        snapshot.createdAt,
      )
    return snapshot
  }

  /**
   * 取一个快照。
   *
   * 默认**不返回已软删除的**（审计二轮 P1-6）：
   * 软删除的语义是「对使用者不可见」。如果 restore / apply / export
   * 还能通过 id 拿到它，删除就没有任何效果——用户以为清掉了，
   * 实际仍能被写回工作区。
   *
   * 需要历史记录时用 includeDeleted（GC / 审计）。
   */
  getSnapshot(id: string, opts: { includeDeleted?: boolean } = {}): Snapshot | undefined {
    const cond = opts.includeDeleted ? '' : ' AND deleted_at IS NULL'
    const row = this.db
      .prepare(`SELECT id, run_id as runId, task_id as taskId, kind, ref, reproducible, not_reproducible_reason as notReproducibleReason, file_count as fileCount, total_bytes as totalBytes, created_at as createdAt, deleted_at as deletedAt FROM snapshot WHERE id = ?${cond}`)
      .get(id) as (Omit<Snapshot, 'reproducible'> & { reproducible: number; deletedAt: number | null }) | undefined
    if (!row) return undefined
    const snap: Snapshot = { ...row, reproducible: Boolean(row.reproducible) }
    delete (snap as { deletedAt?: number | null }).deletedAt
    if (row.deletedAt !== null) snap.deletedAt = row.deletedAt
    return snap
  }

  /** 某个 Run 的快照。默认排除已软删除的（理由同 getSnapshot）。 */
  listSnapshots(runId: string, opts: { includeDeleted?: boolean } = {}): Snapshot[] {
    const cond = opts.includeDeleted ? '' : ' AND deleted_at IS NULL'
    const rows = this.db
      .prepare(`SELECT id, run_id as runId, task_id as taskId, kind, ref, reproducible, not_reproducible_reason as notReproducibleReason, file_count as fileCount, total_bytes as totalBytes, created_at as createdAt FROM snapshot WHERE run_id = ?${cond} ORDER BY created_at ASC`)
      .all(runId) as Array<Omit<Snapshot, 'reproducible'> & { reproducible: number }>
    return rows.map((r) => ({ ...r, reproducible: Boolean(r.reproducible) }))
  }

  /**
   * 按 id 游标列出全部快照（跨 Run）。
   *
   * 只给 GC 与生命周期统计使用：业务查询必须按 Run / Task 走，
   * 否则容易在跨边界的地方漏掉归属判断。
   */
  listAllSnapshots(opts: { includeDeleted?: boolean } = {}): Snapshot[] {
    const cols =
      'id, run_id as runId, task_id as taskId, kind, ref, reproducible, ' +
      'not_reproducible_reason as notReproducibleReason, file_count as fileCount, ' +
      'total_bytes as totalBytes, created_at as createdAt, deleted_at as deletedAt'
    const sql = opts.includeDeleted
      ? `SELECT ${cols} FROM snapshot ORDER BY created_at ASC`
      : `SELECT ${cols} FROM snapshot WHERE deleted_at IS NULL ORDER BY created_at ASC`
    const rows = this.db.prepare(sql).all() as Array<
      Omit<Snapshot, 'reproducible'> & { reproducible: number; deletedAt: number | null }
    >
    return rows.map((r) => {
      const snap: Snapshot = { ...r, reproducible: Boolean(r.reproducible) }
      delete (snap as { deletedAt?: number | null }).deletedAt
      if (r.deletedAt !== null) snap.deletedAt = r.deletedAt
      return snap
    })
  }

  /**
   * 软删除一个快照。
   *
   * 不删除影子仓库里的 git 对象：那一步是不可逆的，
   * 且可能仍有别的记录（审计证据）引用同一个 ref。
   * 真正的对象回收交给独立的 GC 动作。
   */
  softDeleteSnapshot(id: string): void {
    this.db
      .prepare('UPDATE snapshot SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id)
  }

  // ── 连续失败计数（runner 用）────────────────────────────
  //
  // 存在 meta 表里而不是 run 表：它是「调度器的观察」，
  // 不是 Run 的业务属性，不应该混进领域状态。
  //
  // 为什么要持久化：HTTP 的 /runner/tick 每次请求都新建 runner，
  // 进程内的计数器每次归零 → 「连续失败 3 次就停」永远不触发。

  getFailureCount(runId: string): number {
    const v = this.getMeta(`failures:${runId}`)
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }

  setFailureCount(runId: string, count: number): void {
    this.setMeta(`failures:${runId}`, String(Math.max(0, Math.trunc(count))))
  }

  // ── 租约（启动恢复与 runner 共用）──────────────────────
  //
  // Store 暴露这几个薄包装，是为了让 recovery.ts 不需要知道
  // 租约表的细节，也让「谁在什么时候持有租约」只有一套实现。

  private leaseStore(): SqliteLeaseStore {
    // 惰性构造：同一个 db，不会有第二份状态。
    this.leaseStoreCache ??= new SqliteLeaseStore(this.db)
    return this.leaseStoreCache
  }

  inspectLease(key: string): Lease | undefined {
    return this.leaseStore().inspect(key)
  }

  tryClaimLease(key: string, owner: string, ttlMs: number, now = Date.now()): Lease | undefined {
    return this.leaseStore().tryAcquire(key, owner, ttlMs, now)
  }

  releaseLease(key: string, owner: string): boolean {
    return this.leaseStore().release(key, owner)
  }

  /** 只从指定状态出发的 Run 状态写入。与 transitionRunStatus 同义，语义更明确。 */
  casRunStatus(id: string, from: RunStatus, to: RunStatus, patch: { endedAt?: number } = {}): boolean {
    return this.transitionRunStatus(id, from, to, patch)
  }

  // ── 取消意图 ────────────────────────────────────────────
  //
  // 取消是用户的决定，必须跨进程持久化。
  // 只存在 runner 的内存里时，重启后交给下一个 runner 的
  // 就是一个「没有人取消过」的 Run。

  requestCancel(runId: string, requestedBy = 'user', reason = '用户请求取消'): void {
    this.db
      .prepare(
        `INSERT INTO cancel_intent(run_id, requested_at, requested_by, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(runId, now(), requestedBy, reason)
  }

  hasCancelIntent(runId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 as x FROM cancel_intent WHERE run_id = ?')
      .get(runId) as { x: number } | undefined
    return row !== undefined
  }

  clearCancelIntent(runId: string): void {
    this.db.prepare('DELETE FROM cancel_intent WHERE run_id = ?').run(runId)
  }

  /**
   * 列出仍带取消意图的 Run。
   *
   * 用途：终态清理与审计。取消意图本身不消耗资源，
   * 但「哪些 Run 被取消过」是一个需要能查的事实。
   */
  listCancelIntents(): Array<{ runId: string; requestedAt: number; requestedBy: string; reason: string }> {
    const rows = this.db
      .prepare(
        'SELECT run_id as runId, requested_at as requestedAt, requested_by as requestedBy, reason FROM cancel_intent ORDER BY requested_at ASC',
      )
      .all() as Array<{
      runId: string
      requestedAt: number
      requestedBy: string
      reason: string
    }>
    return rows
  }

  /**
   * 清理「已经终态且取消意图已完成使命」的记录。
   *
   * 为什么需要清理：取消意图的作用是「阻止这个 Run 被重新排队」。
   * 一旦 Run 已经是 cancelled（或别的终态），这个作用已经实现——
   * 继续留着只会让表无限增长，并让「哪些还在等取消」变得不可判断。
   *
   * **只删终态的**：非终态 Run 的取消意图仍然有防护价值。
   */
  pruneCancelIntents(): number {
    const terminal = "('completed', 'failed', 'cancelled', 'expired')"
    const res = this.db
      .prepare(
        `DELETE FROM cancel_intent
         WHERE run_id IN (SELECT id FROM run WHERE status IN ${terminal})`,
      )
      .run()
    return res.changes
  }

  // ── 人工裁决 ────────────────────────────────────────────
  //
  // 只写不删：裁决是证据的一部分。撤销一个裁决应当再写一条相反的裁决，
  // 而不是删掉原来那条——否则「当时为什么放行」就消失了。

  createHumanDecision(input: {
    taskId: string
    artifactId: string
    actor: string
    decision: 'approve' | 'reject'
    reason: string
    subject: { kind: 'escalated_audit' | 'replay_mismatch'; ref: string }
  }): HumanDecision {
    const record: HumanDecision = {
      id: randomUUID(),
      taskId: input.taskId,
      artifactId: input.artifactId,
      actor: input.actor,
      decision: input.decision,
      reason: input.reason,
      subject: input.subject,
      createdAt: now(),
    }
    this.db
      .prepare(
        'INSERT INTO human_decision(id, task_id, artifact_id, actor, decision, reason, subject_kind, subject_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.taskId,
        record.artifactId,
        record.actor,
        record.decision,
        record.reason,
        record.subject.kind,
        record.subject.ref,
        record.createdAt,
      )
    return record
  }

  listHumanDecisions(taskId: string): HumanDecision[] {
    const rows = this.db
      .prepare(
        'SELECT id, task_id as taskId, artifact_id as artifactId, actor, decision, reason, subject_kind as subjectKind, subject_ref as subjectRef, created_at as createdAt FROM human_decision WHERE task_id = ? ORDER BY created_at ASC',
      )
      .all(taskId) as Array<{
      id: string
      taskId: string
      artifactId: string
      actor: string
      decision: string
      reason: string
      subjectKind: string
      subjectRef: string
      createdAt: number
    }>
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      artifactId: r.artifactId,
      actor: r.actor,
      decision: r.decision as 'approve' | 'reject',
      reason: r.reason,
      subject: {
        kind: r.subjectKind as 'escalated_audit' | 'replay_mismatch',
        ref: r.subjectRef,
      },
      createdAt: r.createdAt,
    }))
  }

  // ── 验收 ───────────────────────────────────────────────

  createAcceptance(input: Omit<AcceptanceRecord, 'id' | 'createdAt'> & { id?: string }): AcceptanceRecord {
    // 操作者默认 user：现有调用点都在用户路径上。
    // 声称 system 是更强的声明，必须由调用点显式传入。
    const record: AcceptanceRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now(),
      decidedBy: input.decidedBy ?? 'user',
    }
    this.db
      .prepare('INSERT INTO acceptance(id, task_id, artifact_id, run_id, status, revision_note, override_actor, override_reason, decided_at, created_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.taskId,
        record.artifactId,
        record.runId,
        record.status,
        record.revisionNote ?? null,
        record.overrideActor ?? null,
        record.overrideReason ?? null,
        record.decidedAt ?? null,
        record.createdAt,
        record.decidedBy,
      )
    return record
  }

  getAcceptance(id: string): AcceptanceRecord | undefined {
    return this.db
      .prepare('SELECT id, task_id as taskId, artifact_id as artifactId, run_id as runId, status, revision_note as revisionNote, override_actor as overrideActor, override_reason as overrideReason, decided_at as decidedAt, created_at as createdAt, decided_by as decidedBy FROM acceptance WHERE id = ?')
      .get(id) as AcceptanceRecord | undefined
  }

  listAcceptances(taskId: string): AcceptanceRecord[] {
    return this.db
      .prepare('SELECT id, task_id as taskId, artifact_id as artifactId, run_id as runId, status, revision_note as revisionNote, override_actor as overrideActor, override_reason as overrideReason, decided_at as decidedAt, created_at as createdAt, decided_by as decidedBy FROM acceptance WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as AcceptanceRecord[]
  }

  decideAcceptance(id: string, status: AcceptanceRecord['status'], note?: string): void {
    this.db.prepare('UPDATE acceptance SET status = ?, revision_note = ?, decided_at = ? WHERE id = ?').run(status, note ?? null, now(), id)
  }

  setArtifactStatus(id: string, status: ArtifactStatus): void {
    this.db.prepare('UPDATE artifact SET status = ? WHERE id = ?').run(status, id)
  }

  // ── 交付 ───────────────────────────────────────────────

  createDelivery(input: Omit<DeliveryRecord, 'id' | 'createdAt'> & { id?: string }): DeliveryRecord {
    const record: DeliveryRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now(),
      actor: input.actor ?? 'user',
    }
    this.db
      .prepare('INSERT INTO delivery(id, task_id, acceptance_id, artifact_id, action, status, error, destination, created_at, ended_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.taskId,
        record.acceptanceId,
        record.artifactId,
        record.action,
        record.status,
        record.error ?? null,
        record.destination ?? null,
        record.createdAt,
        record.endedAt ?? null,
        record.actor,
      )
    return record
  }

  updateDelivery(id: string, status: DeliveryRecord['status'], patch: { error?: string; destination?: string } = {}): void {
    this.db
      .prepare('UPDATE delivery SET status = ?, error = COALESCE(?, error), destination = COALESCE(?, destination), ended_at = ? WHERE id = ?')
      .run(status, patch.error ?? null, patch.destination ?? null, now(), id)
  }

  listDeliveries(taskId: string): DeliveryRecord[] {
    return this.db
      .prepare('SELECT id, task_id as taskId, acceptance_id as acceptanceId, artifact_id as artifactId, action, status, error, destination, created_at as createdAt, ended_at as endedAt, actor FROM delivery WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as DeliveryRecord[]
  }

  decideApproval(
    id: string,
    status: 'approved' | 'rejected',
    reason?: string,
    approver: 'user' | 'system' = 'user',
  ): void {
    this.db
      .prepare('UPDATE approval SET status = ?, reason = ?, decided_at = ?, approver = ? WHERE id = ?')
      .run(status, reason ?? null, now(), approver, id)
  }

  /**
   * 原子地决定审批状态。
   *
   * 只允许 pending → approved/rejected，用条件 UPDATE 抢。
   *
   * 为什么必须原子：approve 和 reject 可能同时到达（用户双击、
   * 两个窗口同时操作、或者 approve 与超时同时发生）。
   * 非原子的「读 → 判断 → 写」会让两个操作都成功，
   * 结果审批状态取决于谁最后写，而副作用可能已经被批准执行了。
   *
   * @returns 是否抢到了这次状态转换
   */
  transitionApproval(
    id: string,
    to: 'approved' | 'rejected',
    reason?: string,
    approver: 'user' | 'system' = 'user',
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approval
         SET status = ?, reason = ?, decided_at = ?, approver = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(to, reason ?? null, now(), approver, id)
    return result.changes > 0
  }

  // ── denied ─────────────────────────────────────────────

  recordDenied(input: DeniedRequest): void {
    this.db
      .prepare('INSERT OR REPLACE INTO denied(run_id, tool_id, argument_hash, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.runId, input.toolId, input.argumentHash, input.reason, input.createdAt)
  }

  findDenied(runId: string, toolId: string, argumentHash: string): DeniedRequest | undefined {
    return this.db
      .prepare('SELECT run_id as runId, tool_id as toolId, argument_hash as argumentHash, reason, created_at as createdAt FROM denied WHERE run_id = ? AND tool_id = ? AND argument_hash = ?')
      .get(runId, toolId, argumentHash) as DeniedRequest | undefined
  }

  // ── artifact ───────────────────────────────────────────

  createArtifact(input: Omit<Artifact, 'id' | 'createdAt'> & { id?: string }): Artifact {
    const artifact: Artifact = { ...input, id: input.id ?? randomUUID(), createdAt: now() }
    // 同一 Run 同一路径出现第二份 candidate 时，旧的自动降级为 superseded。
    //
    // 为什么由这里处理而不是靠唯一索引拒绝：
    //   重新产出一份候选是**正常业务**（返工、重跑），不该让写入失败；
    //   但两份同时可接受的候选，会让验收时
    //   「用户看到的内容」和「最终交付的内容」可能不是同一份。
    //   语义因此是「新候选取代旧候选」，与唯一索引方向一致。
    //
    // 必须在插入前完成，且与插入同一事务：否则中间崩溃会留下零候选，
    // 或者被唯一索引直接拒绝。
    this.db.transaction(() => {
      if (artifact.path && artifact.status === 'candidate') {
        this.db
          .prepare(
            `UPDATE artifact SET status = 'superseded'
             WHERE run_id = ? AND path = ? AND status = 'candidate' AND id <> ?`,
          )
          .run(artifact.runId, artifact.path, artifact.id)
      }
      this.db
        .prepare('INSERT INTO artifact(id, task_id, run_id, type, path, content_hash, source_snapshot_id, version, parent_artifact_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          artifact.id,
          artifact.taskId,
          artifact.runId,
          artifact.type,
          artifact.path ?? null,
          artifact.contentHash ?? null,
          artifact.sourceSnapshotId ?? null,
          artifact.version,
          artifact.parentArtifactId ?? null,
          artifact.status,
          artifact.createdAt,
        )
    })()
    return artifact
  }

  private static readonly ARTIFACT_COLUMNS =
    'id, task_id as taskId, run_id as runId, type, path, content_hash as contentHash, source_snapshot_id as sourceSnapshotId, version, parent_artifact_id as parentArtifactId, status, created_at as createdAt'

  /** SQLite 会把 NULL 读成 null，而类型定义用的是可选字段。这里统一归一。 */
  private mapArtifact(row: Record<string, unknown>): Artifact {
    return {
      id: row.id as string,
      taskId: row.taskId as string,
      runId: row.runId as string,
      type: row.type as Artifact['type'],
      path: (row.path as string | null) ?? undefined,
      contentHash: (row.contentHash as string | null) ?? undefined,
      sourceSnapshotId: (row.sourceSnapshotId as string | null) ?? undefined,
      version: row.version as number,
      parentArtifactId: (row.parentArtifactId as string | null) ?? undefined,
      status: row.status as ArtifactStatus,
      createdAt: row.createdAt as number,
    }
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.db.prepare(`SELECT ${Store.ARTIFACT_COLUMNS} FROM artifact WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.mapArtifact(row) : undefined
  }

  listArtifacts(runId: string): Artifact[] {
    const rows = this.db
      .prepare(`SELECT ${Store.ARTIFACT_COLUMNS} FROM artifact WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapArtifact(r))
  }

  listTaskArtifacts(taskId: string): Artifact[] {
    const rows = this.db
      .prepare(`SELECT ${Store.ARTIFACT_COLUMNS} FROM artifact WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map((r) => this.mapArtifact(r))
  }

  // ── event（回放用） ─────────────────────────────────────

  /**
   * 追加事件（委托 EventStore）。
   *
   * 兼容旧签名 appendEvent(runId, kind, payload)；
   * 需要执行者 / 聚合 / 关联 id 时传第四个参数。
   * Store 不自己拼 SQL：序号分配必须与目录校验、唯一索引放在一起，
   * 拆开写必然有人只用一半。
   */
  appendEvent(
    runId: string,
    kind: string,
    payload: unknown,
    options?: EventAppendOptions,
  ): DomainEvent {
    return this.events.append({ runId, kind, payload, options })
  }

  /** 某个 Run 的全部事件，按写入顺序。 */
  listEvents(runId: string): DomainEvent[] {
    return this.events.listForRun(runId)
  }

  listEventsForAggregate(aggregateType: EventAggregateType, aggregateId: string): DomainEvent[] {
    return this.events.listForAggregate(aggregateType, aggregateId)
  }

  listEventsByCorrelation(correlationId: string, limit?: number): DomainEvent[] {
    return this.events.listByCorrelation(correlationId, limit)
  }

  /**
   * 全部事件（跨聚合），按 id 升序。只给不变式体检使用。
   *
   * 为什么需要：序号连续性必须按 (aggregateType, aggregateId) 逐组核对，
   * 而「有哪些组」只能从事件表自身反推——不能只遍历已知对象，
   * 那样已删除对象的历史事件会被漏掉。
   */
  listAllEvents(): Array<{ aggregateType: string; aggregateId: string; sequence: number; id: number }> {
    return this.events.listAllSequences()
  }

  listEventsSince(afterId: number, limit?: number): DomainEvent[] {
    return this.events.listSince(afterId, limit)
  }
  // ── 通用版本化契约（domain_contract） ───────────────────
  //
  // 语义与 task_contract 一致：
  //   · 内容变化 → 新版本；旧版本标 superseded，不删除
  //   · 内容完全相同 → 幂等返回当前版本（不让旧审计失效）
  //   · 同一 (scope, scopeId) 最多一条 active（部分唯一索引强制）
  //   · contentHash = sha256(canonicalJson(content))，重算可验真

  putDomainContract(input: {
    scope: DomainContractScope
    scopeId: string
    content: unknown
    actor: string
    /** 可选乐观锁：与当前版本不一致则抛 VERSION_CONFLICT。 */
    expectedVersion?: number
  }): DomainContract {
    if (!input.scopeId.trim()) throw new Error('契约的 scopeId 不能为空')

    // 规范化：键排序 + 无空格。同一内容必须得到同一 hash，
    // 否则「内容没变」永远判不出来，每次写都是新版本。
    const content = canonicalJson(input.content)
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')

    const tx = this.db.transaction((): DomainContract => {
      const current = this.getActiveDomainContract(input.scope, input.scopeId)

      if (
        input.expectedVersion !== undefined &&
        (current?.version ?? 0) !== input.expectedVersion
      ) {
        throw new Error(
          `VERSION_CONFLICT: 期望版本 ${input.expectedVersion}，当前是 ${current?.version ?? 0}`,
        )
      }

      if (current && current.contentHash === contentHash) return current

      const version = (current?.version ?? 0) + 1
      const ts = now()
      if (current) {
        this.db
          .prepare(
            "UPDATE domain_contract SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'active'",
          )
          .run(ts, current.id)
      }

      const record: DomainContract = {
        id: randomUUID(),
        scope: input.scope,
        scopeId: input.scopeId,
        version,
        content,
        contentHash,
        status: 'active',
        actor: input.actor,
        createdAt: ts,
      }
      this.db
        .prepare(
          `INSERT INTO domain_contract(id, scope, scope_id, version, content, content_hash, status, actor, created_at, superseded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          record.id,
          record.scope,
          record.scopeId,
          record.version,
          record.content,
          record.contentHash,
          record.status,
          record.actor,
          record.createdAt,
        )
      return record
    })

    return tx()
  }

  private static readonly DOMAIN_CONTRACT_COLUMNS =
    'id, scope, scope_id as scopeId, version, content, content_hash as contentHash, status, actor, created_at as createdAt, superseded_at as supersededAt'

  getActiveDomainContract(scope: DomainContractScope, scopeId: string): DomainContract | undefined {
    const row = this.db
      .prepare(
        `SELECT ${Store.DOMAIN_CONTRACT_COLUMNS} FROM domain_contract
         WHERE scope = ? AND scope_id = ? AND status = 'active'`,
      )
      .get(scope, scopeId) as Record<string, unknown> | undefined
    return row ? mapDomainContract(row) : undefined
  }

  /** 全部历史版本，新的在前。 */
  listDomainContracts(scope: DomainContractScope, scopeId: string): DomainContract[] {
    const rows = this.db
      .prepare(
        `SELECT ${Store.DOMAIN_CONTRACT_COLUMNS} FROM domain_contract
         WHERE scope = ? AND scope_id = ? ORDER BY version DESC`,
      )
      .all(scope, scopeId) as Array<Record<string, unknown>>
    return rows.map(mapDomainContract)
  }

  getDomainContract(id: string): DomainContract | undefined {
    const row = this.db
      .prepare(`SELECT ${Store.DOMAIN_CONTRACT_COLUMNS} FROM domain_contract WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? mapDomainContract(row) : undefined
  }
}

/**
 * 规范化 JSON：对象键按字典序排序，无空白。
 *
 * 为什么不用 JSON.stringify 直接来：键的顺序取决于插入顺序，
 * `{a,b}` 与 `{b,a}` 是同一份语义内容，却会算出两个 hash，
 * 导致「内容没变」判不出来，每次写都生成新版本。
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        // NaN / Infinity 不是合法 JSON。转成字符串保住「它确实出现过」。
        return String(v)
      }
      return v
    }
    if (seen.has(v as object)) throw new Error('契约内容不能包含循环引用')
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)

    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key]
      if (child === undefined) continue
      out[key] = walk(child)
    }
    return out
  }
  return JSON.stringify(walk(value))
}

function mapDomainContract(row: Record<string, unknown>): DomainContract {
  return {
    id: row.id as string,
    scope: row.scope as DomainContractScope,
    scopeId: row.scopeId as string,
    version: row.version as number,
    content: row.content as string,
    contentHash: row.contentHash as string,
    status: row.status as DomainContract['status'],
    actor: row.actor as string,
    createdAt: row.createdAt as number,
    supersededAt: (row.supersededAt as number | null) ?? undefined,
  }
}

// 知识库 / 项目记忆 / 工作组方法挂到 Store 上。
//
// 为什么用原型挂载而不是写进类里：
//   store.ts 已经 3000+ 行；再塞 19 个方法会让它更难审查，
//   而实现细节（SQL 列名、JSON 编解码）与 Store 的核心职责
//   （事务、CAS、事件）是两件不同的事。
//
// 风险与缓解：
//   原型挂载的风险是「挂载调用没执行 → 方法不存在 → 运行期 TypeError」。
//   那个失败会以最难懂的方式出现（不是缺方法，而是 undefined is not a function
//   出现在很远的地方）。所以下面加了一个**安装后自检**：
//   启动时立刻验证关键方法存在，缺了就在构造 Store 时就崩，而不是等到用时。
installKnowledgeStore(Store.prototype as unknown as Record<string, unknown>, randomUUID)
installWorkgroupStore(Store.prototype as unknown as Record<string, unknown>, randomUUID)

/**
 * 安装自检。
 *
 * 在模块加载时就执行——如果哪天有人删掉/改名了安装调用，
 * 这里会**立刻**报错，而不是让某个 API 在运行到一半时神秘失败。
 *
 * 只检查每个模块的一个代表方法：目的是发现「整个安装没执行」，
 * 不是穷举所有方法（那等于把方法列表维护两遍）。
 */
{
  const required = [
    'createKnowledge',
    'listMemory',
    'upsertRole',
    'casPackage',
    'casChangeSet',
  ] as const
  const proto = Store.prototype as unknown as Record<string, unknown>
  const missing = required.filter((m) => typeof proto[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `Store 原型挂载失败，缺少方法：${missing.join(', ')}。` +
      '请检查 installKnowledgeStore / installWorkgroupStore 的调用。',
    )
  }
}

/**
 * Store 的知识库 / 项目记忆方法由 store-knowledge.ts 在运行时挂载。
 *
 * 用接口合并而不是在类里写签名：TS 类不允许「只有签名没有实现」的方法，
 * 而把实现直接写进 3000 行的 store.ts 只会让它更难审查。
 * 安装期测试会验证这些方法真的存在。
 */
export interface Store extends KnowledgeStoreApi, WorkgroupStoreApi {}
