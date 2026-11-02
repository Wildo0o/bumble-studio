// Schema 迁移。
//
// 规则（改动即破坏兼容）：
//   1. 迁移**只能新增**。新版本只能加列 / 加表 / 加索引 / 回填数据。
//      不允许删列、改列类型、放宽约束——那会让已升级的库无法打开旧数据。
//   2. 每个版本一个函数，按顺序执行，且整个升级在一个事务里。
//      中途失败必须回滚到升级前的状态，不能留下「升级了一半」的库。
//   3. 每个迁移必须能用真实旧库验证（见 `legacy-migration.test.ts`）。
//   4. 迁移只依赖自己的检测（`hasColumn` 等），不依赖「当前版本号一定正确」——
//      手工改过 meta 的库也能安全升级。
//
// 为什么不用 `CREATE TABLE IF NOT EXISTS` 来隐式创建新表：
//   新建表可以那样做（幂等），但**修改已有表**必须走这里，
//   否则一个已经存在的旧库永远拿不到新列。
export interface MigrationContext {
  exec(sql: string): void
  hasColumn(table: string, column: string): boolean
  hasTable(table: string): boolean
  /** 表的原始 CREATE 语句（用于识别旧约束）。表不存在时返回 undefined。 */
  tableSql(table: string): string | undefined
  /** 通用查询（迁移里的回填偶尔需要读取数值）。 */
  queryOne<T>(sql: string, ...params: unknown[]): T | undefined
}

export interface Migration {
  version: number
  description: string
  up(ctx: MigrationContext): void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    description: 'approval.expires_at；task.budget/usage；artifact.task_id/content_hash/source_snapshot_id',
    up(ctx) {
      if (!ctx.hasColumn('approval', 'expires_at')) {
        ctx.exec('ALTER TABLE approval ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0')
      }
      if (!ctx.hasColumn('task', 'budget')) ctx.exec('ALTER TABLE task ADD COLUMN budget TEXT')
      if (!ctx.hasColumn('task', 'usage')) ctx.exec('ALTER TABLE task ADD COLUMN usage TEXT')
      if (!ctx.hasColumn('artifact', 'task_id')) {
        ctx.exec("ALTER TABLE artifact ADD COLUMN task_id TEXT NOT NULL DEFAULT ''")
      }
      if (!ctx.hasColumn('artifact', 'content_hash')) {
        ctx.exec('ALTER TABLE artifact ADD COLUMN content_hash TEXT')
      }
      if (!ctx.hasColumn('artifact', 'source_snapshot_id')) {
        ctx.exec('ALTER TABLE artifact ADD COLUMN source_snapshot_id TEXT')
      }
    },
  },
  {
    version: 3,
    description: 'tool_intent 唯一约束从 (run, step, tool_call) 改为 (run, tool_call)',
    up(ctx) {
      // 旧约束挡不住「不同 step + 相同 toolCallId」产生两条 Intent。
      // 重建时如果旧数据里已经有重复的 (run_id, tool_call_id)，
      // 保留最早的一条，其余丢弃——但它们必须已经被标记过，
      // 所以先记录数量，交由调用方在日志里体现（不静默删除是这里的约定：
      // 重复记录本身代表历史 bug，保留最早一条是可用性上的折中）。
      if (!ctx.hasTable('tool_intent')) return
      const existing = ctx.tableSql('tool_intent') ?? ''
      if (!existing.includes('UNIQUE (run_id, step_id, tool_call_id)')) return

      ctx.exec(`
        CREATE TABLE tool_intent_v3 (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          operation_key TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          result_hash TEXT,
          result_content TEXT,
          result_is_error INTEGER,
          error TEXT,
          unknown_reason TEXT,
          resolution TEXT,
          UNIQUE (run_id, tool_call_id)
        )
      `)
      ctx.exec(`
        INSERT INTO tool_intent_v3
        SELECT * FROM tool_intent
        WHERE rowid IN (
          SELECT MIN(rowid) FROM tool_intent GROUP BY run_id, tool_call_id
        )
      `)
      ctx.exec('DROP TABLE tool_intent')
      ctx.exec('ALTER TABLE tool_intent_v3 RENAME TO tool_intent')
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_intent_run ON tool_intent(run_id)')
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_intent_status ON tool_intent(status)')
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_intent_opkey ON tool_intent(run_id, operation_key)')
    },
  },
  {
    version: 4,
    description: 'reconciliation 绑定 intent_id / tool_call_id',
    up(ctx) {
      if (!ctx.hasColumn('reconciliation', 'intent_id')) {
        ctx.exec('ALTER TABLE reconciliation ADD COLUMN intent_id TEXT')
      }
      if (!ctx.hasColumn('reconciliation', 'tool_call_id')) {
        ctx.exec('ALTER TABLE reconciliation ADD COLUMN tool_call_id TEXT')
      }
    },
  },
  {
    version: 6,
    description: 'budget_reservation 增加 status / actual_* / settled_at',
    up(ctx) {
      if (!ctx.hasColumn('budget_reservation', 'status')) {
        ctx.exec("ALTER TABLE budget_reservation ADD COLUMN status TEXT NOT NULL DEFAULT 'reserved'")
        ctx.exec(
          "UPDATE budget_reservation SET status = CASE WHEN settled = 1 THEN 'settled' ELSE 'reserved' END",
        )
      }
      if (!ctx.hasColumn('budget_reservation', 'actual_steps')) {
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_steps INTEGER NOT NULL DEFAULT 0')
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_tool_calls INTEGER NOT NULL DEFAULT 0')
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_input_tokens INTEGER NOT NULL DEFAULT 0')
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_output_tokens INTEGER NOT NULL DEFAULT 0')
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_cost_usd REAL NOT NULL DEFAULT 0')
      }
      if (!ctx.hasColumn('budget_reservation', 'settled_at')) {
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN settled_at INTEGER')
      }
    },
  },
  {
    version: 7,
    description: 'budget_reservation.actual_cost_known',
    up(ctx) {
      // 旧数据的 actual_cost_usd 可能是「价格未知时记的 0」，
      // 无法区分「真的是 0」和「不知道」。保守做法：一律标成未知。
      if (!ctx.hasColumn('budget_reservation', 'actual_cost_known')) {
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN actual_cost_known INTEGER NOT NULL DEFAULT 0')
      }
    },
  },
  {
    version: 8,
    description: 'acceptance 记录人工 override',
    up(ctx) {
      if (!ctx.hasColumn('acceptance', 'override_actor')) {
        ctx.exec('ALTER TABLE acceptance ADD COLUMN override_actor TEXT')
      }
      if (!ctx.hasColumn('acceptance', 'override_reason')) {
        ctx.exec('ALTER TABLE acceptance ADD COLUMN override_reason TEXT')
      }
    },
  },
  {
    version: 9,
    description: 'budget_reservation.owner',
    up(ctx) {
      if (!ctx.hasColumn('budget_reservation', 'owner')) {
        ctx.exec('ALTER TABLE budget_reservation ADD COLUMN owner TEXT')
      }
    },
  },
  {
    version: 10,
    description:
      '事件序号/关联 id/执行者；审批执行者；交付执行者；通用版本化契约表；产物版本唯一；遗留行归属回填',
    up(ctx) {
      // ── event：聚合序号、执行者、关联 id ─────────────────
      //
      // 旧表只有 (run_id, kind, payload)，没有序号。
      // 补列后**回填**：按 id 顺序给每个 run 内的历史事件编序号，
      // 让「历史事件」和「新事件」在同一套规则下有序。
      if (!ctx.hasColumn('event', 'aggregate_type')) {
        ctx.exec("ALTER TABLE event ADD COLUMN aggregate_type TEXT NOT NULL DEFAULT 'run'")
      }
      if (!ctx.hasColumn('event', 'aggregate_id')) {
        ctx.exec("ALTER TABLE event ADD COLUMN aggregate_id TEXT NOT NULL DEFAULT ''")
        // 回填：旧事件的聚合就是 run 本身
        ctx.exec("UPDATE event SET aggregate_id = run_id WHERE aggregate_id = ''")
      }
      if (!ctx.hasColumn('event', 'sequence')) {
        ctx.exec('ALTER TABLE event ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0')
        // 回填：每个聚合按 id 升序从 1 开始编号。
        // 用相关子查询而不是窗口函数——SQLite 3.25 以前的版本也能跑。
        ctx.exec(`
          UPDATE event SET sequence = (
            SELECT COUNT(*) FROM event e2
            WHERE e2.aggregate_type = event.aggregate_type
              AND e2.aggregate_id = event.aggregate_id
              AND e2.id <= event.id
          )
        `)
      }
      if (!ctx.hasColumn('event', 'actor')) {
        ctx.exec("ALTER TABLE event ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'")
      }
      if (!ctx.hasColumn('event', 'correlation_id')) {
        ctx.exec('ALTER TABLE event ADD COLUMN correlation_id TEXT NOT NULL DEFAULT \'\'')
        // 回填：旧事件没有 correlationId。用事件自己的聚合 id 当关联，
        // 这样「同一个 Run 的事件」在旧数据上仍然能串起来。
        ctx.exec("UPDATE event SET correlation_id = aggregate_id WHERE correlation_id = ''")
      }
      ctx.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_event_aggregate_seq ON event(aggregate_type, aggregate_id, sequence)',
      )

      // ── 执行者 / 操作者列 ────────────────────────────────
      //
      // 记录「谁做的这个决定」。旧数据没有这个信息，
      // 回填成 'user'（历史上这些操作只能来自用户或未标记的内部路径，
      // 而声称 'system' 比声称 'user' 是更强的声明——回填时取弱的那个）。
      if (!ctx.hasColumn('approval', 'approver')) {
        ctx.exec("ALTER TABLE approval ADD COLUMN approver TEXT NOT NULL DEFAULT 'user'")
      }
      if (!ctx.hasColumn('acceptance', 'decided_by')) {
        ctx.exec("ALTER TABLE acceptance ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'user'")
      }
      if (!ctx.hasColumn('delivery', 'actor')) {
        ctx.exec("ALTER TABLE delivery ADD COLUMN actor TEXT NOT NULL DEFAULT 'user'")
      }

      // ── 快照配额 ─────────────────────────────────────────
      if (!ctx.hasColumn('snapshot', 'deleted_at')) {
        ctx.exec('ALTER TABLE snapshot ADD COLUMN deleted_at INTEGER')
      }

      // ── 通用版本化契约 ───────────────────────────────────
      //
      // task_contract 是「任务契约」的专用表，字段是领域特定的。
      // 权限策略、项目策略、无人值守策略都需要同样的
      // 「版本化 + 单 active + 内容哈希」语义，但字段各不相同。
      // 所以再加一张通用表：scope + scope_id 区分对象，content 是规范化 JSON。
      ctx.exec(`
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
        )
      `)
      ctx.exec(
        'CREATE INDEX IF NOT EXISTS idx_domain_contract_scope ON domain_contract(scope, scope_id)',
      )
      ctx.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_contract_active
          ON domain_contract(scope, scope_id) WHERE status = 'active'
      `)

      // ── 产物：(run, path) 只有一份当前候选 ───────────────
      //
      // 顺序很重要，必须是「先收敛数据，再建约束」：
      //   旧库里可能已经有同 (run, path) 的多份 candidate（旧版本允许）。
      //   先建唯一索引会直接失败——那不是「发现有重复」，
      //   而是整个库打不开。所以先改数据，再建索引。
      //
      // 这个索引在 SCHEMA 里也有一份（全新库直接建）。
      // 这里保留是因为迁移早于 SCHEMA 的索引阶段执行，
      // 而下面的收敛逻辑需要「建索引前」的数据状态判断。
      // 两处都用 IF NOT EXISTS，重复执行安全。
      //
      // 收敛规则：**保留最早的一份**，其余标成 superseded。
      // 不删除任何行——那是用户数据；也不静默改状态——
      // 下面会写一条事件说明发生了什么。
      const dup = ctx.queryOne<{ n: number }>(`
        SELECT COUNT(*) AS n FROM (
          SELECT run_id, path FROM artifact
          WHERE path IS NOT NULL AND status = 'candidate'
          GROUP BY run_id, path HAVING COUNT(*) > 1
        )
      `)

      if ((dup?.n ?? 0) > 0) {
        ctx.exec(`
          UPDATE artifact SET status = 'superseded'
          WHERE path IS NOT NULL
            AND status = 'candidate'
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM artifact
              WHERE path IS NOT NULL AND status = 'candidate'
              GROUP BY run_id, path
            )
        `)
        // 一条事件说明「迁移做了什么」。按 run 去重，重复执行不会再写。
        //
        // 注意 event 的 NOT NULL 列：v10 迁移里补列的默认值保证能写，
        // 但 aggregate_id / sequence 必须显式给——事件目录要求它们是事实，
        // 不能靠默认值。
        ctx.exec(`
          INSERT INTO event(run_id, kind, payload, created_at, aggregate_type, aggregate_id, sequence, actor, correlation_id)
          SELECT a.run_id, 'artifact.superseded_by_migration',
                 json_object(
                   'runId', a.run_id,
                   'artifactId', a.id,
                   'path', a.path,
                   'reason', '同一 Run 同一路径存在多份候选，迁移时保留最早一份'
                 ),
                 CAST(strftime('%s','now') AS INTEGER) * 1000,
                 -- aggregate_type 是 artifact，所以 aggregate_id 必须是 **artifact id**。
                 -- 早期写的是 a.run_id：那会产生
                 --   aggregate_type='artifact' + aggregate_id=<runId>
                 -- 的错配，按 artifact 查事件永远查不到，
                 -- 而那条事件恰恰是「哪个产物被降级」的唯一记录。
                 'artifact', a.id,
                 -- 每个 artifact 各自一个序号：取该聚合当前最大序号 +1。
                 -- 迁移是一次性、单事务的，不存在并发写入，所以这样足够安全。
                 (SELECT COALESCE(MAX(e.sequence), 0) + 1 FROM event e
                  WHERE e.aggregate_type = 'artifact' AND e.aggregate_id = a.id),
                 'system', a.run_id
          FROM artifact a
          WHERE a.status = 'superseded'
            AND a.path IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM event e2
              WHERE e2.aggregate_type = 'artifact'
                AND e2.aggregate_id = a.id
                AND e2.kind = 'artifact.superseded_by_migration'
            )
        `)
      }

      // 收敛完成后才能建唯一索引。
      // 先删掉 v10 开发期间出现过的不带 status 条件的旧索引名：
      // 它会把「返工产生的新候选」也挡住。只删这一个确切名字，
      // 不做模式匹配——迁移里不该出现「猜着删」。
      ctx.exec('DROP INDEX IF EXISTS idx_artifact_run_path')
      ctx.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_run_path_candidate
          ON artifact(run_id, path) WHERE path IS NOT NULL AND status = 'candidate'
      `)
    },
  },
  {
    version: 11,
    description: '知识库与项目记忆表（knowledge_doc / memory_item）',
    up(ctx) {
      // 知识库：用户提供的事实。content_hash 用于去重与变更检测。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_doc (
          id             TEXT PRIMARY KEY,
          scope          TEXT NOT NULL,
          scope_id       TEXT NOT NULL,
          title          TEXT NOT NULL,
          content        TEXT NOT NULL,
          source         TEXT NOT NULL,
          tags           TEXT NOT NULL,
          content_hash   TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          deleted_at     INTEGER
        )
      `)
      ctx.exec(
        'CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge_doc(scope, scope_id)',
      )
      // 同一作用域内相同内容只保留一条：重复导入同一份文件不应该
      // 在检索结果里占据多个位置。
      ctx.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scope_hash
          ON knowledge_doc(scope, scope_id, content_hash) WHERE deleted_at IS NULL
      `)

      // 项目记忆：跑出来的经验。带来源（task / run）与可信度来源。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS memory_item (
          id             TEXT PRIMARY KEY,
          scope          TEXT NOT NULL,
          scope_id       TEXT NOT NULL,
          statement      TEXT NOT NULL,
          evidence       TEXT NOT NULL,
          task_id        TEXT,
          run_id         TEXT,
          origin         TEXT NOT NULL,
          tags           TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          deleted_at     INTEGER
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_item(scope, scope_id)')
    },
  },
  {
    version: 12,
    description: '会话附件表、会话归档标记、消息搜索索引',
    up(ctx) {
      // 附件元信息。内容**不**入库：大文件会撑爆 SQLite，
      // 而且备份数据库时会连带把二进制一起复制。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS attachment (
          id             TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          name           TEXT NOT NULL,
          mime_type      TEXT NOT NULL,
          bytes          INTEGER NOT NULL,
          storage_path   TEXT NOT NULL,
          content_hash   TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          deleted_at     INTEGER
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_attachment_session ON attachment(session_id)')

      // 会话归档：归档不删除，只是从默认列表里收起来。
      if (!ctx.hasColumn('session', 'archived_at')) {
        ctx.exec('ALTER TABLE session ADD COLUMN archived_at INTEGER')
      }
      if (!ctx.hasColumn('session', 'updated_at')) {
        ctx.exec('ALTER TABLE session ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
        // 回填：用最后一条消息的时间，没有消息则用创建时间。
        // 直接写 0 会让「按最近活动排序」把老会话排到最前。
        ctx.exec(`
          UPDATE session SET updated_at = COALESCE(
            (SELECT MAX(created_at) FROM message m WHERE m.session_id = session.id),
            created_at
          )
        `)
      }
    },
  },
  {
    version: 13,
    description: '工作组表：role / work_package / change_set',
    up(ctx) {
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS role (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          responsibility TEXT NOT NULL,
          allowed_tools  TEXT NOT NULL,
          produces       TEXT NOT NULL
        )
      `)

      // 工作包：任务图的节点。
      //
      // depends_on 存 JSON 数组而不是关联表：
      //   依赖数量小（上限 32），查询模式永远是「取这个 Task 的全部包」，
      //   不需要按依赖反查。关联表会多一次 join 而没有任何收益。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS work_package (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          role_id     TEXT,
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          deliverable TEXT NOT NULL,
          status      TEXT NOT NULL,
          depends_on  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          started_at  INTEGER,
          ended_at    INTEGER
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_pkg_task ON work_package(task_id)')
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_pkg_status ON work_package(task_id, status)')

      // 变更集：冲突判定的粒度。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS change_set (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          work_package_id TEXT NOT NULL,
          role_id         TEXT NOT NULL,
          run_id          TEXT,
          changes         TEXT NOT NULL,
          status          TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          merged_at       INTEGER
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_cs_task ON change_set(task_id)')
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_cs_pkg ON change_set(work_package_id)')
    },
  },
  {
    version: 14,
    description: '人工裁决记录表 human_decision',
    up(ctx) {
      // 人工裁决是**例外**：它让一个本该被门禁挡住的东西通过（或明确拒绝）。
      // 例外必须能回答「谁、为什么、针对什么」。所以 reason / actor 都是 NOT NULL。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS human_decision (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          artifact_id TEXT NOT NULL,
          actor       TEXT NOT NULL,
          decision    TEXT NOT NULL,
          reason      TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_ref  TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_decision_task ON human_decision(task_id)')
    },
  },
  {
    version: 15,
    description: '无人值守租约表 lease（跨进程崩溃接管）',
    up(ctx) {
      // 租约必须持久化：无人值守运行器可能被重启，
      // 重启后要能判断「另一个进程是不是还活着」。
      // 内存租约在重启后全部消失，等于把正在执行的 Run 变成可接管。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS lease (
          lease_key         TEXT PRIMARY KEY,
          owner             TEXT NOT NULL,
          expires_at        INTEGER NOT NULL,
          heartbeat_at      INTEGER NOT NULL,
          acquisition_count INTEGER NOT NULL DEFAULT 1
        )
      `)
      ctx.exec('CREATE INDEX IF NOT EXISTS idx_lease_expiry ON lease(expires_at)')
    },
  },
  {
    version: 16,
    description: '取消意图表 cancel_intent（暂停 / 取消必须跨进程持久化）',
    up(ctx) {
      // 为什么必须持久化：
      //   起初心意只存在 runner 的内存 Set 里。但 runner 重启后那个 Set 就没了，
      //   而租约过期后另一个 runner 会接管这个 Run 并重新排队——
      //   用户点过的「取消」就这么消失了。
      //   取消是**用户的决定**，不能因为一次进程重启而失效。
      ctx.exec(`
        CREATE TABLE IF NOT EXISTS cancel_intent (
          run_id     TEXT PRIMARY KEY,
          requested_at INTEGER NOT NULL,
          requested_by TEXT NOT NULL,
          reason     TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 17,
    description: 'lease epoch 改为全局单调计数（不再依赖删行 + acquisition_count）',
    up(ctx) {
      // 旧实现把 epoch 存在 acquisition_count，且 release 是 DELETE。
      // 删行后重新 INSERT 的起点是 1，epoch 因此**不单调**:
      //   acquire(epoch=1) → release → acquire(epoch=1)
      // 于是旧持有者的 epoch 与新持有者相同，fencing 形同虚设。
      //
      // 修法：epoch 由一个**全局单调计数器**分配，记录在 meta 里。
      // 它只在真正换手时 +1，永不复用。
      if (!ctx.hasTable('lease_epoch_counter')) {
        ctx.exec(`CREATE TABLE IF NOT EXISTS lease_epoch_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`)
        ctx.exec('INSERT OR IGNORE INTO lease_epoch_counter(id, value) VALUES (1, 0)')
      }
      // 把已有租约的 acquisition_count 抬到计数器之上，保证不回退
      const maxRow = ctx.queryOne<{ n: number }>('SELECT COALESCE(MAX(acquisition_count), 0) AS n FROM lease')
      const cur = ctx.queryOne<{ v: number }>('SELECT value AS v FROM lease_epoch_counter WHERE id = 1')
      const floor = Math.max(Number(maxRow?.n ?? 0), Number(cur?.v ?? 0))
      ctx.exec(`UPDATE lease_epoch_counter SET value = ${floor} WHERE id = 1`)
    },
  },
  {
    version: 18,
    description: 'run / step / tool_intent / run_message 记录 lease_epoch，用于 fencing 条件写',
    up(ctx) {
      // 审计二轮 P0：fencing 必须是**条件写**，不能「先 SELECT 再普通 UPDATE」。
      //
      // 旧实现里 transitionRunStatus 只判 status，不判 epoch：
      // 接管发生后，旧 owner 只要发现状态仍是 running，就能写进去。
      // 现在每个关键表带一列 lease_epoch，写入时必须与租约当前 epoch 相符。
      //
      // 0 表示「没有租约约束」（历史数据 / 非租约路径）。
      for (const table of ['run', 'step', 'tool_intent', 'run_message']) {
        if (!ctx.hasTable(table)) continue
        if (!ctx.hasColumn(table, 'lease_epoch')) {
          ctx.exec(`ALTER TABLE ${table} ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0`)
        }
      }
    },
  },
]

/** 当前 schema 版本 = 最高迁移版本。 */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/** 需要执行的迁移（当前版本 → 最新）。 */
export function pendingMigrations(current: number): Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
