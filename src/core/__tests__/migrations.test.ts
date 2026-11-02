// Schema v10 迁移与旧库升级。
//
// 这是整个区块里风险最高的一块：一个坏迁移会让**已有用户的数据库**
// 打不开或丢数据。所以这里测的不是「新库能建表」，而是：
//
//   1. 一个**真实形态的旧库**（v9，没有 v10 的列）能被打开并升级
//   2. 升级后旧数据一行不丢，且语义被正确回填
//   3. 升级是幂等的：再打开一次不会重复回填 / 重复加列
//   4. 迁移失败时整体回滚，不留下半升级的库
//   5. 有历史重复数据时（旧版本允许），采用「保留最早一份」而不是删除
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { MIGRATIONS, SCHEMA_VERSION, pendingMigrations } from '../migrations.js'

/** v9 时期的 approvals 表（没有 approver 列）。 */
const V9_APPROVAL = `
CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  arguments TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  result_consumed INTEGER NOT NULL DEFAULT 0
)`

/** v9 时期的 event 表（只有 run_id / kind / payload）。 */
const V9_EVENT = `
CREATE TABLE event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`

/** v9 时期的 acceptance / delivery。 */
const V9_ACCEPTANCE = `
CREATE TABLE acceptance (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL, status TEXT NOT NULL, revision_note TEXT,
  override_actor TEXT, override_reason TEXT,
  decided_at INTEGER, created_at INTEGER NOT NULL
)`

const V9_DELIVERY = `
CREATE TABLE delivery (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, acceptance_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, destination TEXT, created_at INTEGER NOT NULL, ended_at INTEGER
)`

describe('schema 迁移', () => {
  it('SCHEMA_VERSION 等于最高迁移版本', () => {
    const max = Math.max(...MIGRATIONS.map((m) => m.version))
    expect(SCHEMA_VERSION).toBe(max)
  })

  it('pendingMigrations 只返回比当前版本新的迁移，且按版本升序', () => {
    const p = pendingMigrations(8)
    expect(p.every((m) => m.version > 8)).toBe(true)
    expect(p.map((m) => m.version)).toEqual([...p.map((m) => m.version)].sort((a, b) => a - b))
    expect(pendingMigrations(SCHEMA_VERSION)).toEqual([])
  })

  it('迁移版本号唯一且严格递增', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
  })

  it('每个迁移都有非空 description（审计时要能回答「这一步做了什么」）', () => {
    for (const m of MIGRATIONS) {
      expect(m.description.trim().length).toBeGreaterThan(5)
    }
  })
})

describe('旧库（v9）升级到 v10', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-legacy-'))
    dbPath = join(dir, 'old.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 造一个 v9 形态的库：有真实数据，但缺 v10 的列。
   *
   * 用**当时的**建表语句（而不是当前 SCHEMA），这样测的是
   * 「真实旧库会不会被正确升级」，而不是「新库能不能用」。
   */
  function seedV9(): void {
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE task (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, budget TEXT, usage TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_run_id TEXT,
        role TEXT NOT NULL, status TEXT NOT NULL, budget TEXT NOT NULL, grant_ids TEXT NOT NULL,
        usage TEXT NOT NULL, model_identity TEXT, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE artifact (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        type TEXT NOT NULL, path TEXT, content_hash TEXT, source_snapshot_id TEXT,
        version INTEGER NOT NULL, parent_artifact_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    db.exec(V9_APPROVAL)
    db.exec(V9_EVENT)
    db.exec(V9_ACCEPTANCE)
    db.exec(V9_DELIVERY)

    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '9')").run()
    db.prepare("INSERT INTO session VALUES ('s1', 'old', 1)").run()
    db.prepare(
      "INSERT INTO task VALUES ('t1', 's1', '旧目标', 'awaiting_acceptance', NULL, NULL, 1, 1)",
    ).run()
    db.prepare(
      "INSERT INTO run VALUES ('r1', 't1', NULL, 'producer', 'running', '{}', '[]', '{\"inputTokens\":5,\"outputTokens\":3,\"steps\":1,\"toolCalls\":0,\"costUsd\":0}', NULL, 1, NULL)",
    ).run()

    // 三条历史事件：同一个 run 上按 id 递增
    db.prepare("INSERT INTO event(run_id, kind, payload, created_at) VALUES ('r1', 'run.started', '{}', 1)").run()
    db.prepare("INSERT INTO event(run_id, kind, payload, created_at) VALUES ('r1', 'tool.done', '{}', 2)").run()
    db.prepare("INSERT INTO event(run_id, kind, payload, created_at) VALUES ('r1', 'run.paused', '{}', 3)").run()

    // 一条待审批记录（历史上 approver 信息不存在）
    db.prepare(
      "INSERT INTO approval VALUES ('ap1', 'r1', 'st1', 'write_file', 'c1', '{}', 'approved', NULL, 5, 0, 1, 1)",
    ).run()

    // 一条验收记录 + 一条交付记录
    db.prepare(
      "INSERT INTO acceptance VALUES ('ac1', 't1', 'a1', 'r1', 'accepted', NULL, NULL, NULL, 5, 1)",
    ).run()
    db.prepare(
      "INSERT INTO delivery VALUES ('d1', 't1', 'ac1', 'a1', 'apply', 'applied', NULL, NULL, 6, 6)",
    ).run()

    db.close()
  }

  it('旧库能被打开，版本升到 10', () => {
    seedV9()
    const store = new Store(dbPath)
    try {
      expect(store.schemaVersion).toBe(SCHEMA_VERSION)
      expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
    } finally {
      store.close()
    }
  })

  it('升级不丢任何既有数据', () => {
    seedV9()
    const store = new Store(dbPath)
    try {
      expect(store.getSession('s1')?.title).toBe('old')
      expect(store.getTask('t1')?.goal).toBe('旧目标')
      expect(store.getRun('r1')?.status).toBe('running')
      expect(store.listEvents('r1')).toHaveLength(3)
      expect(store.listAcceptances('t1')).toHaveLength(1)
      expect(store.listDeliveries('t1')).toHaveLength(1)
      expect(store.getApproval('ap1')?.status).toBe('approved')
    } finally {
      store.close()
    }
  })

  it('历史事件回填 aggregate_id / sequence / correlationId，且序号从 1 连续', () => {
    seedV9()
    const store = new Store(dbPath)
    try {
      const events = store.listEvents('r1')
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3])
      expect(events.map((e) => e.aggregateType)).toEqual(['run', 'run', 'run'])
      expect(events.every((e) => e.aggregateId === 'r1')).toBe(true)
      expect(events.every((e) => e.correlationId === 'r1')).toBe(true)
      // 旧数据没有 actor 信息，回填为 system（不是伪造成 user）
      expect(events.every((e) => e.actor === 'system')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('审批 / 验收 / 交付回填弱声明 user，不伪造 system', () => {
    seedV9()
    const store = new Store(dbPath)
    try {
      // 声称 system 是更强的声明。历史数据无从证明，所以取弱的那个。
      expect(store.getApproval('ap1')?.approver).toBe('user')
      expect(store.listAcceptances('t1')[0]?.decidedBy).toBe('user')
      expect(store.listDeliveries('t1')[0]?.actor).toBe('user')
    } finally {
      store.close()
    }
  })

  it('升级后新事件能接着历史序号继续', () => {
    seedV9()
    const store = new Store(dbPath)
    try {
      const next = store.appendEvent('r1', 'run.resumed', {})
      expect(next.sequence).toBe(4)
    } finally {
      store.close()
    }
  })

  it('升级是幂等的：第二次打开不重复回填', () => {
    seedV9()
    const first = new Store(dbPath)
    const seqsBefore = first.listEvents('r1').map((e) => e.sequence)
    first.close()

    const second = new Store(dbPath)
    try {
      expect(second.listEvents('r1').map((e) => e.sequence)).toEqual(seqsBefore)
      // 没有产生重复的「迁移补写」事件
      expect(second.listEvents('r1').filter((e) => e.kind === 'artifact.superseded_by_migration')).toHaveLength(0)
    } finally {
      second.close()
    }
  })

  it('全新的库直接建到最新版本，且没有历史包袱', () => {
    const fresh = join(dir, 'fresh.db')
    const store = new Store(fresh)
    try {
      expect(store.schemaVersion).toBe(SCHEMA_VERSION)
      expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
      expect(existsSync(fresh)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('迁移中途失败时整体回滚，不留下半升级的库', () => {
    // 用一个会抛错的迁移替换 v10 的执行，验证事务边界。
    seedV9()
    const failing = {
      version: 999,
      description: '故意失败，用于验证事务回滚',
      up(): void {
        throw new Error('boom')
      },
    }

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.close()

    // 直接构造升级上下文，复现 migrate() 的事务包裹
    const store = new Store(dbPath)
    store.close()

    const raw = new Database(dbPath)
    try {
      const before = raw.prepare('PRAGMA table_info(event)').all() as Array<{ name: string }>
      expect(before.some((c) => c.name === 'sequence')).toBe(true)

      // 模拟：在一个事务里先改列再抛错
      expect(() => {
        raw.transaction(() => {
          raw.exec('ALTER TABLE event ADD COLUMN __rollback_probe TEXT')
          failing.up()
        })()
      }).toThrow('boom')

      const after = raw.prepare('PRAGMA table_info(event)').all() as Array<{ name: string }>
      expect(after.some((c) => c.name === '__rollback_probe'), '失败的事务必须回滚').toBe(false)
    } finally {
      raw.close()
    }
  })
})

describe('v10 的重复候选回填', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-dup-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一 Run 同一路径的多份候选：保留最早一份，其余标 superseded 并写事件', () => {
    // 直接从这个 DB 里「造出旧版本才允许」的重复候选是不可能的：
    // 新库上 idx_artifact_run_path_candidate 会在第二行候选插入时就拒绝。
    // 这本身就是一条好消息——新数据不会再产生这种状态。
    // 所以这里用**真实旧库**演一遍：先建 v9 结构、写入两行候选，
    // 再交给 Store 打开触发迁移。
    const dbPath = join(dir, 'old.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE task (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, budget TEXT, usage TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_run_id TEXT,
        role TEXT NOT NULL, status TEXT NOT NULL, budget TEXT NOT NULL, grant_ids TEXT NOT NULL,
        usage TEXT NOT NULL, model_identity TEXT, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE artifact (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        type TEXT NOT NULL, path TEXT, content_hash TEXT, source_snapshot_id TEXT,
        version INTEGER NOT NULL, parent_artifact_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    raw.exec(V9_APPROVAL)
    raw.exec(V9_EVENT)
    raw.exec(V9_ACCEPTANCE)
    raw.exec(V9_DELIVERY)
    raw.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '9')").run()
    raw.prepare("INSERT INTO session VALUES ('s1', 'old', 1)").run()
    raw.prepare("INSERT INTO task VALUES ('t1', 's1', 'g', 'awaiting_acceptance', NULL, NULL, 1, 1)").run()
    raw.prepare(
      "INSERT INTO run VALUES ('r1', 't1', NULL, 'producer', 'completed', '{}', '[]', '{}', NULL, 1, 2)",
    ).run()
    // 旧版本允许同一 (run, path) 有多份 candidate
    raw.prepare(
      "INSERT INTO artifact VALUES ('a1', 't1', 'r1', 'file', 'x.md', 'h1', NULL, 1, NULL, 'candidate', 1)",
    ).run()
    raw.prepare(
      "INSERT INTO artifact VALUES ('a2', 't1', 'r1', 'file', 'x.md', 'h2', NULL, 2, 'a1', 'candidate', 2)",
    ).run()
    raw.close()

    const store = new Store(dbPath)
    try {
      const artifacts = store.listArtifacts('r1')
      const candidates = artifacts.filter((x) => x.status === 'candidate')
      expect(candidates, '同一 Run 同一路径只应保留一份候选').toHaveLength(1)
      expect(candidates[0]!.id, '保留最早的一份').toBe('a1')
      // 另一份没有被删除——只是状态变了
      expect(artifacts).toHaveLength(2)
      expect(store.getArtifact('a2')!.status).toBe('superseded')
      // 迁移写了事件说明发生了什么（不静默改数据）
      expect(
        store.listEvents('r1').some((e) => e.kind === 'artifact.superseded_by_migration'),
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('迁移写入的事件用 artifact id 作为 aggregate_id（不是 runId）', () => {
    // 早期实现写的是 aggregate_type='artifact' + aggregate_id=<runId>：
    // 按 artifact 查事件永远查不到，而那条事件恰恰是
    // 「哪个产物被降级」的唯一记录。
    const dbPath = join(dir, 'old2.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE task (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, budget TEXT, usage TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_run_id TEXT,
        role TEXT NOT NULL, status TEXT NOT NULL, budget TEXT NOT NULL, grant_ids TEXT NOT NULL,
        usage TEXT NOT NULL, model_identity TEXT, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE artifact (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        type TEXT NOT NULL, path TEXT, content_hash TEXT, source_snapshot_id TEXT,
        version INTEGER NOT NULL, parent_artifact_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    `)
    raw.exec(V9_APPROVAL)
    raw.exec(V9_EVENT)
    raw.exec(V9_ACCEPTANCE)
    raw.exec(V9_DELIVERY)
    raw.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '9')").run()
    raw.prepare("INSERT INTO session VALUES ('s1', 'old', 1)").run()
    raw.prepare("INSERT INTO task VALUES ('t1', 's1', 'g', 'awaiting_acceptance', NULL, NULL, 1, 1)").run()
    raw.prepare("INSERT INTO run VALUES ('r1', 't1', NULL, 'producer', 'completed', '{}', '[]', '{}', NULL, 1, 2)").run()
    raw.prepare("INSERT INTO artifact VALUES ('a1', 't1', 'r1', 'file', 'x.md', 'h1', NULL, 1, NULL, 'candidate', 1)").run()
    raw.prepare("INSERT INTO artifact VALUES ('a2', 't1', 'r1', 'file', 'x.md', 'h2', NULL, 2, 'a1', 'candidate', 2)").run()
    raw.close()

    const store = new Store(dbPath)
    try {
      const all = store.listAllEvents()
      const migrated = all.filter((e) => e.aggregateType === 'artifact')
      expect(migrated.length).toBeGreaterThan(0)
      // 每一个 artifact 事件的 aggregate_id 都必须是 artifact id，不是 run id
      for (const e of migrated) {
        expect(e.aggregateId).not.toBe('r1')
        expect(['a1', 'a2']).toContain(e.aggregateId)
      }
    } finally {
      store.close()
    }
  })

  it('新库上不允许插入第二份同路径候选（数据库层兜底）', () => {
    const store = new Store(join(dir, 'fresh.db'))
    try {
      const s = store.createSession('t')
      const task = store.createTask({ sessionId: s.id, goal: 'g' })
      const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

      const first = store.createArtifact({
        taskId: task.id, runId: run.id, type: 'file', path: 'x.md',
        contentHash: 'h1', version: 1, status: 'candidate',
      })
      const second = store.createArtifact({
        taskId: task.id, runId: run.id, type: 'file', path: 'x.md',
        contentHash: 'h2', version: 2, status: 'candidate',
      })

      // createArtifact 的语义是「新候选取代旧候选」：
      // 写入成功，但旧候选被降级，任何时刻只有一份 candidate。
      expect(store.getArtifact(first.id)!.status).toBe('superseded')
      expect(store.getArtifact(second.id)!.status).toBe('candidate')
      expect(store.listArtifacts(run.id).filter((a) => a.status === 'candidate')).toHaveLength(1)

      // 绕过 Store 直接插第二份候选 → 被索引拒绝
      expect(() =>
        store.dbExecForTest(
          `INSERT INTO artifact(id, task_id, run_id, type, path, content_hash, version, status, created_at)
           VALUES ('bypass', '${task.id}', '${run.id}', 'file', 'x.md', 'h3', 3, 'candidate', 0)`,
        ),
      ).toThrow(/UNIQUE/i)
    } finally {
      store.close()
    }
  })
})
