# AI 工作站 · 审计送审包 v3

> **送审日期**：2026-10-30
> **代码基线**：`11a35e3` + 未提交改动（37 项，dirty tree）
> **状态**：**禁止最终送审**（见第十四章）
> **本文性质**：自包含。审计方无需阅读其他文档即可完成评审

---

## 目录

| 章 | 内容 |
|---|---|
| 一 | 送审范围与不含项 |
| 二 | 本版指标（与上一版的差异） |
| 三 | 核心链路 |
| 四 | 领域对象与数据模型 |
| 五 | 状态机 |
| 六 | 执行流程与状态门 |
| 七 | 权限与治理（含原子性） |
| 八 | 快照与产物 |
| 九 | 验收与交付 |
| 十 | ReviewLoop 审计协议 |
| 十一 | 安全设计 |
| 十二 | 可验证性：如何复现 |
| 十三 | 已修复的缺陷清单 |
| 十四 | **已知缺口（含硬阻塞）** |
| 十五 | 需要审计方回答的问题 |

---

# 一、送审范围与不含项

## 1.1 包含

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0-A | 状态机与治理 | ✅ |
| P0-B | 快照与产物 | ✅ |
| P0-C | 验收与交付 | ✅ |
| P1-A | ReviewLoop 最小闭环 | ✅ |
| 第四批 | 状态门 CAS、原子性、模型身份 | ✅ 部分（见十四章） |

## 1.2 不包含

UI / Skill Runtime / 知识库 / 沙箱 / MCP / 触发器 / 记忆 / 工作流 / 多用户协作

**理由**：先把「结果是什么、能否复现、谁确认完成」做扎实。

---

# 二、本版指标

## 2.1 规模

| 指标 | 数值 |
|---|---|
| 业务代码 | **9284 行** |
| 测试代码 | **10078 行** |
| HTTP 接口 | **36 个** |
| 数据库表 | **20 张** |
| 测试文件 | **32 个** |
| **测试用例** | **316 个，全部通过**（其中 HTTP 集成 50 个） |
| **E2E 断言** | **55 条通过，0 跳过，0 未覆盖** |
| skipped / unsupported | **0** |

## 2.2 与上一版（v2 送审包）的差异

| 项 | v2 送审包（90 测试） | 本版 v0.9（316 测试） |
|---|---|---|
| 测试数 | 90 | **316** |
| 业务代码 | 6234 行 | **8057 行** |
| 数据表 | 16 张 | **19 张** |
| Run 状态 | 8 种 | **11 种** |
| 已修复缺陷 | 3 个 | **19 个** |
| 硬阻塞 | 未列出 | **6 项** |

**v2 送审包已作废**，其中「已知缺口」章节有两项已在后续修复中解决。

## 2.3 版本历史

| 版本 | 日期 | 测试 | 主要变化 |
|---|---|---|---|
| v0.1 | 2026-10-29 | 90 | 初始实现 |
| v0.2 | 2026-10-30 | 103 | 验收门、unknown 阻塞、apply/export 真实化 |
| v0.3 | 2026-10-30 | 116 | 审计 fail-open、AuditBinding、unknown 立即停止 |
| v0.3.1 | 2026-10-30 | 120 | 归属校验、按 binding 查审计、证据基线 |
| v0.4 | 2026-10-30 | 159 | 状态门 CAS、审批/授权原子性、模型身份 |
| v0.4.1 | 2026-10-30 | 162 | 送审包 v3、服务重启崩溃修复 |
| v0.5 | 2026-10-31 | 195 | HTTP 认证、autoApprove 权限、token ACL |
| v0.5.1 | 2026-10-31 | 210 | 认证验收：Grant 不消耗、E2E unsupported 归零 |
| v0.6 | 2026-10-31 | 243 | ToolIntent：崩溃恢复、晚到副作用、统一执行入口 |
| v0.7 | 2026-10-31 | 270 | Intent 验收：执行顺序、sideEffect、证据校验 |
| v0.8 | 2026-10-31 | 292 | 事务化 beginToolAttempt、能力组合拒绝、reconcile 终态 |
| **v0.9** | **2026-10-31** | **316** | **事务边界验证、toolCallId 全局唯一、sideEffect 必填、actor 来源** |

---

# 三、核心链路

```
任务目标
→ Producer Run 执行（调工具）
→ 模型收束
→ 拍快照（不可变）
→ 生成版本化产物
→ 机器规则检查（失败短路）
→ Auditor 审计（只读快照）
→ pass    → awaiting_acceptance → 用户接受 → 应用 / 导出
→ reject  → ReworkBrief → 新 Producer Run
→ escalate → 转人工（不提供接受动作）
```

## 三个不可互换的概念

| 记录 | 含义 | 谁产生 |
|---|---|---|
| `Run.completed` | 执行完成，形成候选结果 | 系统 |
| `Task.accepted` | 用户认可内容质量 | **只有用户** |
| `DeliveryRecord.applied/exported` | 交付成功 | 系统 |

**Run 完成 ≠ 用户接受 ≠ 交付成功。** 交付失败不得抹掉接受证据。

---

# 四、领域对象与数据模型

## 4.1 对象关系

```
Workspace（环境变量 WORKSPACE，安全边界）
  └── Session
        ├── Message
        └── Task（goal + budget + usage）
              ├── Run（多次尝试）
              │     ├── RunMessage（工作历史）
              │     ├── Step → StepTrace
              │     ├── Grant
              │     ├── Approval
              │     ├── Snapshot
              │     ├── Artifact
              │     └── ReconciliationRecord
              ├── ReviewCycle → AuditResult
              ├── AcceptanceRecord（质量决定）
              └── DeliveryRecord（交付动作）
```

## 4.2 数据表（19 张）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `meta` | schema 版本 | — |
| `session` | 会话 | — |
| `message` | 会话消息 | ⚠️ 见 §14.1 |
| `task` | 任务 | budget / usage |
| `run` | 一次执行 | `model_identity`（服务端记录） |
| `run_message` | 运行历史 | 必须持久化 |
| `step` | 执行步骤 | attemptOf |
| `grant` | 授权 | `max_calls` 独立列（供原子认领） |
| `approval` | 审批 | `expires_at` + `result_consumed` |
| `denied` | 拒绝记录 | 参数哈希 |
| `reconciliation` | unknown 解决 | —— |
| `snapshot` | 快照 | reproducible |
| `artifact` | 产物 | content_hash / version / parent |
| `acceptance` | 验收 | 与 delivery 分离 |
| `delivery` | 交付 | 失败不回滚 acceptance |
| `review_cycle` | 审计循环 | `UNIQUE(task_id, cycle_number)` |
| `audit_result` | 审计结果 | 完整 JSON |
| `event` | 事件流 | 状态查询 vs 事件回放 |

## 4.3 两个关键字段

### `Run.model_identity`

```ts
{ providerId, modelId, modelFamily, recordedAt }
```

**为什么必须持久化**：审计的模型族隔离校验依赖它。
如果 `/review` 接受请求体里的 `producerModel`，
调用方可以把同族模型伪装成不同族，绕过隔离。

**只写一次**：`UPDATE ... WHERE model_identity IS NULL`。

### `grant.max_calls`

从 `constraints` JSON 提出来的独立列。

**为什么**：原子认领要求「检查额度 + 递增」在同一个 UPDATE 里完成，
而 SQLite 无法直接比较 JSON 字段。

---

# 五、状态机

## 5.1 Run 状态（11 种）

```ts
type RunStatus =
  | 'queued'                 // 待执行 —— 唯一可以 execute 的入口
  | 'running'                // 正在执行
  | 'paused'                 // 用户主动暂停，可 resume
  | 'waiting_approval'       // 等审批，必须先 approve/reject
  | 'needs_reconciliation'   // 有未解决 unknown，必须先 reconcile
  | 'auditing'               // 进入审计阶段
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'
```

## 5.2 状态门（硬规则）

| 当前状态 | 能否 execute | 正确入口 |
|---|---|---|
| `queued` | ✅ | execute |
| `running` | ❌ | （已被占用） |
| `paused` | ❌ | `POST /runs/:id/resume` |
| `waiting_approval` | ❌ | `POST /approvals/:id/approve\|reject` |
| `needs_reconciliation` | ❌ | `POST /runs/:id/reconcile` |
| `auditing` | ❌ | — |
| `completed` / `failed` / `cancelled` / `expired` | ❌ | 终态 |

**实现**：`checkExecuteGate()` + `transitionRunStatus()`（数据库 CAS）

```ts
const claimed = this.store.transitionRunStatus(run.id, 'queued', 'running')
if (!claimed) {
  return { status: 'failed', error: 'Run 状态已被其他执行占用' }
}
```

**为什么只能从 `queued` 抢**：如果把 `running` 也放进起始集合，
两个并发请求都会匹配并"成功"更新，结果两个都执行、模型被调用两次。

## 5.3 Task 状态（12 种）

```ts
type TaskStatus =
  | 'draft' | 'ready' | 'queued' | 'in_progress'
  | 'awaiting_acceptance'   // 有候选产物，等用户决定
  | 'accepted'              // 只由用户接受触发
  | 'revision_requested'
  | 'rejected' | 'cancelled' | 'failed' | 'expired' | 'archived'
```

## 5.4 Step 状态（9 种）

```ts
type StepStatus =
  | 'pending' | 'running' | 'waiting_approval'
  | 'completed' | 'failed' | 'rejected' | 'skipped' | 'cancelled'
  | 'unknown'    // 请求中断，无法确认外部操作是否已发生
```

**`unknown` 的定义**：不是 `failed`（明确失败），也不是 `completed`（明确成功）。
伪装成任一极端都是撒谎。

---

# 六、执行流程与状态门

## 6.1 主循环

```
execute(runId)
  │
  ├─ 0. 状态门：只有 queued 可通过
  │
  ├─ 1. 有未解决 unknown？ → needs_reconciliation，拒绝
  │
  ├─ 2. CAS 抢状态 queued → running
  │     抢不到说明被别的执行占用
  │
  ├─ 3. 记录模型身份（只写一次）
  │
  ├─ 4. 载入历史（run_message）
  │
  ├─ 5. 回填未消费的审批结果
  │     ├─ rejected → 生成 tool 消息
  │     └─ approved → 执行工具（共用预算/超时/unknown 处理）
  │
  └─ 6. 工具循环
        ├─ 预算检查
        ├─ 上下文裁剪
        ├─ 调模型 → 记录 Trace
        ├─ 调用后 overshoot 检查
        │
        ├─ 无 tool_calls？
        │    ├─ 有未解决 unknown → needs_reconciliation
        │    └─ 否则 → 拍快照 → 生成 Artifact → completed
        │
        └─ 有 tool_calls？对每个：
             ├─ 未知工具 / JSON 非法 / schema 不符 → 回给模型
             ├─ 命中拒绝去重 → 回「已拒绝」
             ├─ Grant 原子认领失败 → 走审批
             ├─ 预算检查
             ├─ 执行（带超时）
             ├─ **超时 → Step=unknown，Run=needs_reconciliation，立即停止**
             └─ 成功/失败 → 截断输出，回给模型
```

## 6.2 异常路径

| 异常 | 处理 | 状态 |
|---|---|---|
| 工具不存在 / 参数非法 | 回给模型 | Step failed |
| 路径越权 | 回给模型 | Step failed |
| **工具超时** | **立即停止循环** | **Step unknown，Run needs_reconciliation** |
| 模型调用失败 | 终止 | Run failed |
| 预算超限（调用前） | 终止 | Run expired |
| 预算 overshoot（调用后） | 立即终止 | Run expired |
| 用户取消 | 终止 | Run cancelled |
| 审批超时 | 自动拒绝 | Run → queued |
| 崩溃 | 启动清理 | running → unknown |

**原则**：工具层面的问题回给模型，系统层面的问题终止 Run。

## 6.3 启动清理

```
sweepDanglingSteps()      → 所有 running 的 Step 标为 unknown
expireStaleApprovals()    → 过期未决审批自动拒绝
```

每次 `execute` 前也会执行一次超时检查。

---

# 七、权限与治理

## 7.1 工具风险等级

| 等级 | 审批行为 | 工具 |
|---|---|---|
| `read` | 自动放行 | `read_file`, `list_dir` |
| `write` | 需要审批 | `write_file` |
| `external` | 需要审批 | （暂无） |

## 7.2 Grant 原子认领

```ts
claimGrantUsage(id: string): boolean {
  const result = this.db.prepare(
    `UPDATE grant SET used_calls = used_calls + 1
     WHERE id = ? AND status = 'active' AND expires_at > ?
       AND (max_calls IS NULL OR used_calls < max_calls)`
  ).run(id, now())
  return result.changes > 0
}
```

**流程：执行前认领，不是执行后计数。**

旧流程 `先查 → 执行 → 再计数` 有竞态窗口：
两个并发请求都读到 `usedCalls=0`，都通过判断，结果 `scope=once` 被用了两次。

## 7.3 Approval 条件更新

```ts
transitionApproval(id, to: 'approved' | 'rejected', reason?): boolean {
  const result = this.db.prepare(
    `UPDATE approval SET status = ?, reason = ?, decided_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(to, reason ?? null, now(), id)
  return result.changes > 0
}
```

**approve / reject / expiry 只有一个能赢。**

## 7.4 拒绝去重

同一 Run + 同一工具 + 相同参数（稳定哈希）→ 直接阻断，不重复创建审批。

参数哈希**对键排序**，避免 `{a,b}` 和 `{b,a}` 被当成不同请求。

## 7.5 预算

| 层级 | 字段 |
|---|---|
| Run 级 | maxInputTokens / maxOutputTokens / maxTotalTokens / maxSteps / maxToolCalls / maxCostUsd / deadlineAt |
| Task 级 | maxCostUsd / maxDurationMs / maxSteps / maxCycles |

**累计型用 `>=` 而非 `>`**：已达上限时再发起调用必然超限。

**调用后 overshoot 检查**：真实用量只有模型返回后才知道，
如果这次调用把预算撑破，立即终止，不再发起下一次。

**⚠️ 尚未实现调用前 reservation**（见 §14.1-H / I）。

---

# 八、快照与产物

## 8.1 快照：git 影子仓库

```
1. 在工作区之外建影子 git 仓库
2. capture():
   a. read-tree --empty（清空临时索引）
   b. --work-tree 指向真实工作区，add --all
   c. write-tree → 树对象
   d. commit-tree → 提交对象
   e. update-ref refs/heads/main
3. 快照 ref = commit SHA
```

## 8.2 三道位置防护（血的教训）

```ts
private assertRepoOutsideWorkspace(): void {
  // 1. repoDir ≠ workspace
  if (repo === ws) throw new Error('快照仓库目录不能与工作区相同')

  // 2. repoDir 不在 workspace 内
  if (repo.startsWith(ws + sep)) throw new Error('快照仓库目录不能位于工作区内部')

  // 3. 工作区不在 repoDir 内
  if (ws.startsWith(repo + sep)) throw new Error('工作区不能位于快照仓库目录内部')

  // 4. repoDir 不在任何 git 仓库内 ★ 最关键
  const existingRepoRoot = findGitRepoRoot(this.repoDir)
  if (existingRepoRoot) throw new Error('快照仓库目录不能位于任何已有的 git 仓库内部')
}
```

**第 4 条是真实事故换来的**：

```
repoDir   = <项目>/.e2e-run3/data/snapshots
workspace = <项目>/.e2e-run3/workspace
```

两者不重叠，前三条都通过。但 `git` 命令用 `cwd=repoDir` 时会**向上查找 `.git`**，
找到 `<项目>/.git`，于是在项目仓库里创建了 snapshot 提交，把 `main` 分支源码删光（-19285 行）。

**服务启动时也会检测**：`DATA_DIR` 在 git 仓库内则自动改到 `~/.ai-workstation/snapshots`。

## 8.3 事务性恢复

```
1. cat-file -e 校验目标快照真实存在
   （不能用 rev-parse --verify ——对全 0 SHA 也返回成功）
2. 先 capture() 一个回滚点
3. checkout + 删除快照里不存在的文件
4. 失败 → 从回滚点恢复，返回 rolledBack: true
```

## 8.4 产物（Artifact）

```ts
{
  id, taskId, runId, type, path?
  contentHash?          // 内容哈希
  sourceSnapshotId?     // 指向快照
  version               // 从 1 开始
  parentArtifactId?     // 版本链
  status: 'candidate' | 'accepted' | 'rejected' | 'superseded'
}
```

**三条规则**：
1. 不原地覆盖，返工产生新版本
2. 内容未变不产生新版本（**跨 Run 比对**）
3. `parentArtifactId` 可追溯

**拍快照的时机**：模型明确收束的那一刻，不是 Run 开始时。

---

# 九、验收与交付

## 9.1 两个独立记录

```ts
AcceptanceRecord {
  id, taskId, artifactId, runId
  status: 'pending' | 'accepted' | 'revision_requested' | 'rejected'
  revisionNote?, decidedAt?
}

DeliveryRecord {
  id, taskId, acceptanceId, artifactId
  action: 'apply' | 'export'
  status: 'pending' | 'running' | 'applied' | 'exported' | 'conflict' | 'failed' | 'cancelled'
  error?, destination?
}
```

**为什么必须分开**：用户认可了内容质量，但导出时磁盘满了。
如果只有一个状态，系统会把任务标成失败——**抹掉了"用户认可"这个事实**。

## 9.2 统一状态门

`accept` / `requestRevision` / `reject` 共用 `assertAcceptanceGate`：

```
1. Task 必须处于 awaiting_acceptance
2. 产物必须是 candidate
3. 产物 / Run / Task 归属一致
```

**已 accepted 的 Task 不能被 requestRevision 或 reject 回退。**

## 9.3 验收门（accept 额外要求）

```
1. 存在针对这个产物的审计记录（不是"Task 曾经 pass"）
2. 该审计 verdict = pass
3. binding.artifactIds 包含当前 artifactId
4. binding.producerRunId === artifact.runId
5. binding.snapshotId === artifact.sourceSnapshotId
6. binding.contentHashes[path] === artifact.contentHash
7. Run 无未解决 unknown
```

**为什么按 binding 查而不是按 `created_at` 排序取最新**：
并发审计或时钟相同时，"最后一条"不可靠；且一个 Task 可能有多个产物，
A 的 pass 不该被拿来验收 B。

## 9.4 交付

| 动作 | 源 | 保护 |
|---|---|---|
| `apply()` | **已验收快照** | 目标存在且内容不同 → `conflict`，不覆盖 |
| `export()` | **已验收快照** | 目标目录必须在白名单内 |

两者都：写入后校验内容与快照一致；失败不改变 AcceptanceRecord。

**⚠️ `apply()` 是 check-then-write，不是原子的**（见 §14.1-K）。

---

# 十、ReviewLoop 审计协议

## 10.1 流程

```
Producer Run 完成
→ 固定 Snapshot
→ 机器规则检查
   ├─ 失败 → 短路，不调模型，verdict = reject
   └─ 通过 → 继续
→ Auditor 只读 Snapshot
→ 结构化 verdict
```

## 10.2 三条硬规则

### 规则 1：机器规则先跑，失败短路

不花钱让模型审一个连形式都不合格的产物，也避免模型掩盖硬错误。

### 规则 2：模型 verdict 只能否决

```
模型 reject                     → 直接生效
模型 pass 但含 blocking issue   → reject（自相矛盾以阻断为准）
模型 pass 且每条规则都明确 pass
  且存在至少一条 strong 规则
  且所有 strong 规则明确 pass  → pass
其他                            → escalate
```

**weak / strong 的划分**：
- `strong`：能判定核心质量（JSON 合法性、最小长度、测试退出码）
- `weak`：只做形式检查（文件存在、产物非空）

**为什么必须有 strong 规则**：如果机器规则只做形式检查，
注入攻击者只需让产物通过形式检查就能骗过整个审计。

### 规则 3：Producer 与 Auditor 必须不同族

```ts
modelFamily('claude-sonnet-5-5') → 'anthropic-claude'
modelFamily('deepseek-chat')      → 'deepseek'
```

同族时**直接 escalate，不调用模型**。

**理由**：同族模型有系统性相关盲区——同一个知识点理解错了，
写的时候错，审的时候仍按同一个错误理解判"正确"。

**模型身份来源**：`Run.model_identity`，执行时由服务端写入，**不接受请求体声明**。

## 10.3 结构化审计结果

```ts
AuditResult {
  verdict: 'pass' | 'reject' | 'escalate'
  escalateReason?: 'uncertain' | 'same_model_family' | 'no_strong_rules'
                 | 'no_snapshot' | 'audit_error'
  confidence?: number
  blockingIssues: AuditIssue[]      // { ruleId, feature, probability?, severity, ... }
  nonBlockingIssues: AuditIssue[]
  checkedRules: RuleCheck[]         // { ruleId, ruleVersion, status, phase, evidence? }
  evidenceRefs: string[]
  binding: AuditBinding             // ★ 所有返回路径都带
  regression?: boolean
  summary: string
}

AuditBinding {
  producerRunId: string
  artifactIds: string[]
  snapshotId?: string
  snapshotRef?: string
  contentHashes?: Record<string, string>
}
```

## 10.4 回归检测

**冻结的是标准，不是结果。**

```
上一轮某规则 pass → 本轮 fail
→ 标记 regression
→ blockingIssue
→ 不允许直接通过
```

## 10.5 ReviewCycle 不存独立状态

状态由关联对象推导：

```
没审计 + Producer running    → producing
没审计 + Producer completed  → checking
审计 pass                    → passed
审计 reject                  → rework_required
审计 escalate                → escalated
```

**理由**：存一份可独立修改的 status，迟早和事实打架。

## 10.6 循环上限

```
UNIQUE(task_id, cycle_number) + 事务化创建
检查上限 + 创建 Cycle + 累加 cycles 在同一个事务里
```

---

# 十一、安全设计

## 11.1 路径校验

```
1. allowedRoots 为空 → 拒绝
2. UNC 前缀（\\ 或 //）→ 拒绝   ← 必须在 realpath 之前
3. realpath 解析（跟随符号链接）
4. 再次检查 UNC
5. Windows：转小写 + 统一分隔符
6. 按路径段比对（不是字符串前缀）
```

**第 2 步的位置**：`realpathSync('\\\\server\\share')` 会发起网络请求。
实测未修复时 2289ms，修复后 76ms。

## 11.2 六种攻击防护

| 攻击 | 防护 | 测试 |
|---|---|---|
| 路径穿越 | realpath | ✅ |
| 符号链接逃逸 | realpath | ✅ |
| Windows 大小写 | 统一转小写 | ✅（仅 Windows） |
| 短文件名 `PROGRA~1` | realpath | ⚠️ **无 fixture** |
| UNC 路径 | 前缀拦截 | ✅（仅 Windows） |
| 前缀假阳性 | 按段比对 | ✅ |
| junction / reparse point | — | ❌ 未覆盖 |
| `\\?\` / `\\.\` 设备路径 | — | ❌ 未覆盖 |
| ADS（备用数据流） | — | ❌ 未覆盖 |

**审计方请注意**：`paths.test.ts` 中部分测试在非 Windows 环境会 `return` 跳过，
但 vitest 统计为 passed（不是 skipped）。**这是虚假覆盖**，见 §14.1-L。

## 11.3 单一写者

只有 `RunExecutor` 能修改 Run / Step / Approval。
工具实现签名里没有 store、没有 runId——**类型层面无法改状态**。

## 11.4 注入防护

- 工具结果作为 `tool` 角色消息，不与 system 混合
- 审计者读到的产物文本单独放在 user 消息的「待审计产物」区块

**最关键的一条**：模型 `pass` 只在机器规则全部明确通过时生效。
这限制了注入的影响面——最多让审计变得保守，不能让它放行。

**⚠️ 没有显式注入检测**（见 §14.1）。

---

# 十二、可验证性

## 12.1 环境

```bash
cd G:\AI\ai-workstation
npm install
```

## 12.2 六项验证（按此顺序）

```bash
# 1. ToolIntent 定向测试（应为 33 passed）
npx vitest run src/core/__tests__/intent-store.test.ts \
  src/core/__tests__/intent-scenarios.test.ts \
  src/core/__tests__/intent-crash.test.ts \
  src/core/__tests__/tool-intent.test.ts

# 2. Grant/Approval 定向测试（应为 25 passed）
npx vitest run src/core/__tests__/atomicity.test.ts \
  src/core/__tests__/grant-consumption.test.ts \
  src/core/__tests__/state-gate.test.ts

# 3. HTTP 认证定向测试（应为 44 passed）
npx vitest run src/server/__tests__/

# 4. 类型检查（应无输出）
npx tsc -p tsconfig.json --noEmit

# 5. 完整测试（应为 32 files / 316 passed）
npx vitest run

# 6. 端到端（自己起服务，不需要另开终端）
node scripts/e2e-reviewloop.mjs
# 应为 52 passed / 0 failed / 0 skipped / 0 unsupported
```

**E2E 不再需要手动启动服务**。它会：

- 用 `listen(0)` 取一个空闲端口；**端口被占用直接失败，不自动换**
- 建临时 workspace 和 data 目录（在系统临时目录，不落进项目仓库）
- 等 `/health` 就绪
- 校验 `build.version` 与 `package.json` 一致、`schemaVersion` 是数字
- 断言 `/health` 不含 workspace 路径与 token
- 记录服务 PID、stdout、stderr、退出码；失败时打印并保留现场
- **`skipped > 0` / `unsupported > 0` / `passed === 0` 都让退出码非零**

**关于上一版的 `1 unsupported`**：那是一个错误。
它号称「本脚本暂无 Windows 专属断言」，但 Windows 的 token ACL
本来就可以、也应该在这里验证。现在它变成了 7 条真实断言
（启动第二个生成模式实例 → 检查 token 文件不落盘/落盘、
长度、不入日志、ACL 只对当前用户开放、当前用户确实有权限）。

**`unsupported` 现在不再是一种「可接受的结果」**：
只要 > 0 就让退出码非零，且汇总里标注「这是缺陷，不是结果」。

## 12.3 验证「纸面 vs 实现」

```bash
# 验证 message 表确实没被写入（已知缺口）
grep -rn "appendMessage" src/core/executor.ts     # 应返回空

# 验证调用前 reservation 确实不存在
grep -n "reserv" src/core/store.ts                # 应返回空

# 验证 Grant 只有两处认领点（普通路径 + 审批恢复路径）
grep -n "claimGrantUsage(" src/core/executor.ts
# 应恰好 2 处：普通工具循环 和 executeApprovedTool

# 验证请求体不再能打开 autoApprove
# 先排除注释行，再看有没有「活代码」还在读它
grep -vE '^\s*(//|\*)' src/core/executor.ts src/server/app.ts | grep -n "autoApprove"
# 应返回空

# 验证所有路由默认要求认证
grep -n "requiresAuth ?? true" src/server/app.ts

# 验证公开接口只有 /health
grep -n "requiresAuth: false" src/server/app.ts   # 应只有一处

# 验证没有静默跳过
grep -n "if (!isWin) return" src/core/__tests__/paths.test.ts   # 应返回空

# 验证认证测试真的能失败（变异测试）
sed -i 's/if (r.requiresAuth)/if (false \&\& r.requiresAuth)/' src/server/app.ts
npx vitest run src/server/__tests__/   # 应出现 8 个失败
# 改回后用 git diff 确认恢复
```
```

## 12.4 证据基线

```bash
bash scripts/evidence-baseline.sh
cat docs/evidence/TEST-OUTPUT.md | grep -E "Tests|退出码"
```

**注意**：本版是未提交状态。审计方应以**实际源码**为准，不以报告为准。

---

# 十三、已修复的缺陷清单（19 项）

## 第一批（6 项）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `accept()` 不要求审计 pass | 验收可完全绕过审计 |
| 2 | `unknown` 可回退 `completed` | 不确定被当成完成 |
| 3 | **`apply()` 假成功** | 标记 applied 但什么都没写 |
| 4 | `export()` 读当前工作区 | 导出的不是已验收内容 |
| 5 | 预算无 overshoot 控制 | 单次调用可超支 |
| 6 | 工具结果未持久化 | 恢复时序列非法 |

## 第二批（3 项）

| # | 缺陷 | 后果 |
|---|---|---|
| 7 | **审计门 fail-open（混合规则）** | weak pass + strong uncertain → 放行 |
| 8 | 审计未绑定具体产物 | 可用 A 的 pass 验收 B |
| 9 | `unknown` 只阻止完成，不阻止继续 | 继续在不确定状态上操作 |

## 第三批（2 项）

| # | 缺陷 | 后果 |
|---|---|---|
| 10 | `/review` 未校验 `run.taskId` / `run.role` | 污染两个 Task 的审计记录 |
| 11 | `reconcile()` 未校验 `step.runId` | 用 Run-A 的接口裁决 Run-B 的 Step |

## 第四批（4 项）

| # | 缺陷 | 后果 |
|---|---|---|
| 12 | 无 execute 状态门 | 可从任意状态重复执行 |
| 13 | Approval / Grant 非原子 | 并发导致 scope=once 被用两次 |
| 14 | 模型 pass 时忽略自己的 blocking issue | 自相矛盾的输出被放行 |
| 15 | 模型身份可由请求体声明 | 可伪装模型族绕过隔离 |

## 过程中发现的实现缺陷（3 项）

| # | 缺陷 | 后果 |
|---|---|---|
| 16 | `rev-parse --verify` 对全 0 SHA 返回成功 | 恢复到一半才报错，工作区已改动 |
| 17 | git 输出 `.trim()` 吃掉末尾换行 | 快照内容与原始文件不一致 |
| 18 | **快照仓库污染项目 git 仓库（两次）** | `main` 分支源码被删光 |

## 准备送审包时发现的第 19 项（本版新增）

| # | 缺陷 | 后果 |
|---|---|---|
| 19 | **位置防护把影子仓库自己当成了别人的仓库** | **服务第二次启动必定崩溃** |

### 详细说明

第 18 项的修复引入了 `findGitRepoRoot(repoDir)` 检查。
但影子仓库**本身就是**一个 git 仓库。

```
第一次启动：repoDir 不存在 → 检查通过 → 拍快照时 init 出 repoDir/.git
第二次启动：findGitRepoRoot(repoDir) → 返回 repoDir 自己
           → 抛错「不能位于任何已有的 git 仓库内部」
           → 进程退出，服务再也起不来
```

**默认配置必然触发**：`SNAPSHOT_DIR` 默认是 `~/.ai-workstation/snapshots`，
只要拍过一次快照，之后每次启动都失败。这是**可用性上的致命缺陷**，
而且是在跑 E2E 时才暴露的——之前所有测试都在 `afterEach` 里删掉了目录。

**修复**：引入归属标记。

```ts
private isOwnShadowRepo(repoRoot: string): boolean {
  if (repoRoot !== this.repoDir) return false
  if (existsSync(join(this.repoDir, SHADOW_MARKER))) return true     // 主判据
  // 升级路径：老影子仓库没有标记文件，退回 git 身份
  return readFileSync(join(this.repoDir, '.git', 'config'), 'utf8')
    .includes('snapshot@ai-workstation.local')
}
```

判据不用目录名、不用 remote、不用 commit message —— 那些用户可能碰巧撞上。
**别人的仓库仍然拒绝**，这一点由新增测试单独覆盖。

**教训**：位置防护的检查对象和它要保护的对象是同一类东西时，
必须能区分「我自己」和「别人」。只写「不能在任何 git 仓库内」是不够的。

## 第 20 项：HTTP 控制面无认证 + autoApprove 可被请求体打开（本版新增）

这两条原本是「硬阻塞 H」的全部内容，本版已关闭。**关闭不等于威胁消失**，
真实的残留在 §14.2 单独列出。

### 20a · 控制面无认证

**原始状态**：

```ts
server.listen(PORT, '127.0.0.1', ...)   // 只绑 loopback
// 36 个接口，0 个检查 Authorization
```

任何人（或任何本机进程）都能：

```bash
curl -X POST http://127.0.0.1:4820/approvals/<id>/approve   # 直接批准写文件
curl -X POST http://127.0.0.1:4820/tasks/<id>/accept        # 直接验收产物
curl -X POST http://127.0.0.1:4820/acceptances/<id>/apply   # 直接落盘
```

**`/health` 还额外泄露**：绝对 workspace 路径 + 数据目录。

**修复**：

| 层 | 措施 |
|---|---|
| 凭据 | 每实例 bearer token，256 位随机，`base64url` 43 字符 |
| 存放 | `<DATA_DIR>/auth-token`，**ACL 收紧到仅当前用户**；或 `AUTH_TOKEN` 环境变量 |
| 传输 | 只接受 `Authorization: Bearer <token>`；URL 里的 token 直接 400 |
| 比较 | 双方先 sha256 再 `timingSafeEqual`，抹平长度差异 |
| 默认 | 路由注册 `requiresAuth` 默认 `true`，公开必须显式声明 |
| Origin | 带了就必须精确匹配 loopback 白名单；`null` 一律拒绝 |
| 监听 | 默认 `127.0.0.1`；非 loopback 且无 `AUTH_TOKEN` → **拒绝启动** |
| `/health` | 只返回 `ready` + `version` + `commit` + `schemaVersion` |
| 请求体 | 1 MiB 上限；非 JSON 对象 → 400 |

**唯一公开接口**：`GET /health`。

### 20b · autoApprove 由请求体控制

**原始状态**：

```ts
// src/server/index.ts
autoApprove: Array.isArray(body.autoApprove) ? body.autoApprove : []
```

```ts
// src/core/executor.ts
if (!grant && !this.isAutoApproved(definition, opts.autoApprove)) { ...进审批... }

private isAutoApproved(def, autoApprove) {
  if (def.riskLevel === 'read') return true
  return (autoApprove ?? []).includes(def.id) || (autoApprove ?? []).includes(def.name)
}
```

也就是说：`{"autoApprove": ["write_file"]}` 让所有写操作免审批。

**修复**：**字段和入口一起删除**。

```ts
// ExecuteOptions 里不再有 autoApprove
if (!grant && definition.riskLevel !== 'read') { ...进审批... }
// isAutoApproved() 整个方法删除
```

HTTP 层额外做**字段白名单**，未知字段直接 400 而不是静默忽略：

```ts
onlyFields(body, ['provider','model','apiKey','goal','system','messages'], '...')
```

**为什么不是「忽略就好」**：静默忽略会让客户端以为权限生效了，
实际卡在审批——这种失效比报错危险得多。

**权限的唯一来源**：`Grant`。
`Grant` 只能由已认证的 `POST /approvals/:id/approve` 产生。
`read` 级工具例外（本来就不需要审批）。

### 20c · **修复过程中发现的第 21 项缺陷：`mode: 0o600` 在 Windows 上无效**

第一版实现写的是：

```ts
writeFileSync(file, token + '\n', { mode: 0o600 })
chmodSync(file, 0o600)   // 以为这样就够了
```

**实测结果**（不是推测）：

```
$ icacls auth-token
BUILTIN\Administrators:(I)(F)
NT AUTHORITY\SYSTEM:(I)(F)
NT AUTHORITY\Authenticated Users:(I)(M)     ← 所有已认证用户可写
BUILTIN\Users:(I)(RX)                       ← 所有用户可读
```

`(I)` 表示从父目录继承。Node 的 `mode` 在 Windows 上**只映射到「只读」标志位，不改写 ACL**。
也就是说：同机任何用户都能读走 token，整个认证形同虚设——
而文档里当时已经写了「token 文件 0600」，**这是一句假话**。

**修复**：用 `icacls` 真正重写 ACL，并在写入后**校验**。

```ts
execFileSync('icacls', [
  file,
  '/inheritance:r',                 // 断开继承，否则父目录权限继续生效
  '/grant:r', `${account}:(F)`,
  '/grant:r', 'SYSTEM:(F)',
  '/grant:r', 'Administrators:(F)',
])
// 再读一次 icacls，确认没有残留的可读主体；
// 有残留就抛错，拒绝以「看似受保护、实际没有」的状态启动。
```

修复后的实际 ACL：

```
BUILTIN\Administrators:(F)
NT AUTHORITY\SYSTEM:(F)
DESKTOP-xxx\HuangHaoYang:(F)
```

**这条写进了 `token-file.test.ts`（3 条用例）**，
用 `icacls` 解析结果断言「除当前用户 / SYSTEM / Administrators 外没有别的可访问主体」。
在 POSIX 上则用 `stat().mode` 断言 `0o077` 位全空。

**教训**：权限位是最容易「写了就以为生效」的东西。
`chmod` / `mode` 这类 API 在不同平台上语义完全不同，
**必须读回实际状态验证，不能相信写入时的参数**。

## 第 22 项：审批恢复路径从不消耗 Grant（本版新增，严重）

**这是本轮验收时被审计方逼出来的，不是我自查发现的。**

### 事实

`claimGrantUsage` 在整个代码库里**只有一处调用**（`executor.ts:661`），
位于普通工具路径。审批恢复走的是 `executeApprovedTool()`，
它**只检查预算，从不认领 Grant**。

### 完整漏洞链

```
1. 模型调用 write_file
   → 无可用 Grant → 建 approval(pending) → Run 停 waiting_approval

2. 用户 POST /approvals/:id/approve  { scope: 'once' }
   → 创建 Grant(maxCalls=1, usedCalls=0)

3. 再次 execute
   → pendingResolutions() 找到这条已批准的审批
   → executeApprovedTool() 直接执行工具
   → 但 usedCalls 仍是 0          ← 漏洞

4. 模型在同一 Run 里再调一次 write_file
   → findUsableGrant() 命中（0 < 1）
   → claimGrantUsage() 成功
   → 第二次执行，**全程没有再问用户**
```

**`scope='once'` 名义上「只允许一次」，实际允许两次**：
一次走审批恢复，一次走普通路径。

### 为什么之前的测试没抓到

`atomicity.test.ts` 的 9 条测试**全部只测 `Store` 层**：
`claimGrantUsage()` 本身是对的，条件更新也确实原子。
但从没有一条测试问过「executor 的两条执行路径是否都真的调用了它」。

这是「测了零件，没测装配」。

### 修复

两条路径共用同一个原子入口，认领不到就 fail-closed：

```ts
if (definition.riskLevel !== 'read') {
  const candidate = this.findUsableGrant(runId, definition.id)
  const claimed = candidate ? this.store.claimGrantUsage(candidate.id) : false
  if (!claimed) {
    this.finishStep(stepId, 'failed', { error: '没有可用授权', ... })
    this.emit(runId, 'tool.grant_unavailable', { tool: definition.name })
    return { outcome: 'failed', content: '错误：授权已用尽/已过期/已被撤销，本次没有执行…' }
  }
}
```

**fail-closed 而不是「继续执行」**：没有有效授权就不执行。
模型会收到一条明确的 tool 消息，如果仍需要这个操作，得重新请求、用户重新批准。

### 新增 `grant-consumption.test.ts`（4 条）

| 测试 | 验证 |
|---|---|
| once 授权在审批恢复后必须 usedCalls=1 | 核心漏洞 |
| 审批恢复只发生一次（重复 execute 不重放工具） | 幂等 |
| 批准后 Grant 被撤销 → 不执行、不消耗 | fail-closed |
| 审批恢复计入 Run 的 toolCalls 预算 | 预算不被绕过 |

**变异验证**：把 `if (definition.riskLevel !== 'read')` 改成 `if (false)`，
其中 2 条立刻失败。说明它们确实在约束行为。

### 仍未解决的相邻问题

**批准与执行不是同一个事务。** 如果执行成功、但写 `markApprovalConsumed`
之前进程崩溃，重启后会再执行一次。这是 §14.1-J（无 ToolIntent）的具体表现，
本批没有处理。

> **下一版已处理**，见第 23 项。

## 第 23 项：ToolIntent（本版新增，关闭 J）

### 为什么需要它

在它之前，系统面对「文件已经写了，但结果还没落库就崩了」只能靠猜：

- 重试 → 可能写两次
- 放弃 → 可能漏写

两者都错。缺失的不是逻辑，而是**一份能跨越进程死亡的记录**。

### 表结构

```sql
CREATE TABLE tool_intent (
  id, run_id, step_id, tool_call_id,
  tool_id, tool_name,
  request_hash,      -- 参数稳定哈希
  operation_key,     -- 跨重试稳定的操作标识（可作外部幂等键）
  status,
  created_at, updated_at, started_at, completed_at,
  result_hash, result_content, result_is_error,
  error, unknown_reason, resolution,
  UNIQUE (run_id, step_id, tool_call_id)
);
```

**唯一约束是硬保证**：同一个 `toolCallId` 不可能有两条 Intent。
如果执行路径有 bug 想插第二条，数据库直接拒绝——
而不是等重复副作用发生之后才发现。

### 状态机

```
prepared ──→ started ──→ committed
                ├──→ failed
                └──→ unknown ──→ reconciled
```

全部通过条件 UPDATE 转换，非法转换**返回 false 且不改状态**：

| 转换 | 是否允许 | 理由 |
|---|---|---|
| `committed → started` | ❌ | 已成功的不能重放 |
| `unknown → started` | ❌ | 不知道结果时自动重试 = 第二次副作用 |
| `failed → started` | ❌ | failed 不代表外部没生效 |
| `prepared → committed` | ❌ | 不能跳过 started |
| `unknown → reconciled` | ✅ | 只记结论，**不重新执行** |

### 执行顺序（唯一入口）

普通循环和审批恢复现在共用 `invokeTool()`：

```
1. 校验工具存在
2. 只读工具 → 直接执行，不建 Intent
3. 取或建 Intent（唯一约束）
4. committed → 返回保存的结果，不执行
5. started / unknown / failed / reconciled → 拒绝，给出原因
6. prepared → 原子转 started（抢不到就拒绝）
7. 认领 Grant
8. 检查预算
9. 执行
10. committed / failed / unknown
```

**第 4 步是整个机制存在的理由**：崩溃重启后再执行到这里，
能认出这次调用做过，直接复用结果。

### Intent 的键必须是「原始 stepId」

这是实现时踩到的坑：

审批恢复执行时会**新建**一个追踪 Step。如果用新 Step 的 id 当 Intent 键，
每次恢复都会得到一条全新 Intent，永远查不到「上次执行过」——机制白做。

正确做法：Intent 挂在 `approval.stepId`（审批创建时就固定），
追踪 Step 只用于写 Step 状态。代码里用 `stepId` 与 `traceStepId` 两个参数区分。

### 只读工具不走 Intent

`riskLevel === 'read'` 在创建 Intent **之前**就分流。

理由：Intent 的唯一目的是防重复副作用。读操作没有副作用。
如果对读也套同一套限制，一次进程崩溃会让这个 Run 剩下的所有读操作永久失效——
「安全」的代价不该是「系统不可用」。

但只读超时**仍然记 unknown**（不是 failed）：超时的语义始终是「不知道发生了什么」，
这一点与风险等级无关。区别在后续——只读没有 Intent 卡着，可以安全重试。

### 超时后的晚到副作用

`Promise.race` 超时返回后，底层 Promise **仍在继续跑**。
对 `await writeFile(...)` 这类调用，它无法被 abort 打断——
文件最终会被写下去，只是系统已经宣布「不知道结果」。

**这不是可以修的 bug，是本地文件系统的固有语义。** 能做的只有三件：

1. 如实记 unknown（已做）
2. 收好晚到结果，别让它变成 unhandled rejection（已做，`runWithTimeout` 内部 `.catch`）
3. 让调用方把晚到结果关联回同一次操作（已做，`tool.late_result` 事件）

**晚到结果不会把 Intent 从 unknown 改回 committed**：
状态机不允许，而且就算允许，也可能在判断之后再崩一次仍然不确定。
它唯一的用途是留个证据供对账参考。

### exactly-once 的边界（必须说清楚）

**不要声称 SQLite 能保证文件系统或网络 exactly-once。** 实际保证是：

| 场景 | 保证 |
|---|---|
| 副作用已发生 + 结果已落库 + 崩溃 | ✅ 重启后复用结果，不重复执行 |
| 副作用已发生 + 结果未落库 + 崩溃 | ⚠️ 记 unknown，**不自动重试**；需人工对账 |
| 支持幂等键的外部服务 | ✅ 传 `operationKey` 可让服务端去重 |
| 不支持幂等键的外部服务 | ❌ 只能 unknown + 人工 |

`resultConsumed` 的含义已在文档中改为「防止历史结果重复回填」，
**不是**「防止外部工具重复执行」。

### 新增测试（33 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `intent-store.test.ts` | 15 | 状态机全部合法/非法转换、唯一约束、sweep |
| `intent-scenarios.test.ts` | 11 | 任务书 10 个场景 + 对账联动 |
| `intent-crash.test.ts` | 2 | 崩窗口内重复执行（修复前 = 2 次） |
| `tool-intent.test.ts` | 5 | 超时晚到、重复 resume、普通/恢复共用入口 |

**变异验证**：

| 变异 | 结果 |
|---|---|
| 关掉 `committed` 短路 | 场景 3 失败（不重放 → 变成需要重放） |
| 强制所有工具走无 Intent 路径 | **8 条失败** |

第二个变异是关键：它证明这 8 条测试确实依赖 Intent 机制存在，
而不是碰巧通过。

### 仍然存在的事务缺口

| 缺口 | 后果 |
|---|---|
| claim / Step / Approval 三处写入无事务 | 极端情况下可能 Grant 已扣但 Step 未更新 |
| `markApprovalConsumed` 与执行不同事务 | 有了 Intent 后**不再导致重复执行**，但会多一次重放读取 |

第二项在本版被 Intent 兜住了：即使 `result_consumed` 没写，
重启后走 invokeTool 会命中 committed Intent 直接复用。
**这正是 Intent 的价值——它比 `resultConsumed` 更接近事实。**

## 第 24 项：Intent 验收发现的三处实现错误（本版新增）

ToolIntent 主体在 v0.6 完成。本版是**验收**，查出三处真实问题。

### 24a · 执行顺序错误：Grant 认领在 started 之后

**原顺序**：`prepared → started → claim Grant`

**后果**：claim 失败时 Intent 已离开 `prepared`，只能记 `failed`。
但工具**根本没有执行**，副作用一定没发生。
`failed` 不允许重试，于是这个 `toolCallId` 被永久锁死——
用户重新批准也没用。

**这是真实缺陷，有红测**（`intent-order.test.ts`）：

```
✗ Grant 认领失败时 Intent 必须仍可重试
  → Intent 停在 failed，工具从未执行却被永久锁死
✗ Grant 认领失败后，用户重新批准可以正常执行
  → 重新批准后仍然无法执行（calls=0）
```

**修复后的顺序**：

```
prepared
  → 认领 Grant（失败则留在 prepared，等用户重新批准）
  → 检查预算（失败同样留在 prepared）
  → prepared → started（原子，最后一道闸）
  → 执行
```

**为什么这个顺序是对的**：先确认「有权执行」，再声明「开始执行」。
`started` 的语义是「可能已经产生副作用」，不该在还没拿到许可时就进入。

### 24b · 用 riskLevel 代替副作用声明

**原判断**：`if (definition.riskLevel === 'read') 跳过 Intent`

**问题**：`riskLevel` 回答「要不要先问用户」，
`sideEffect` 回答「重复执行是否安全」。两者不是一回事。

反例：只读的 HTTP GET 可能计费、写对方访问日志、触发限流。
用 `riskLevel` 判断会把它当「重试无害」——那是误判。

**修复**：新增独立字段

```ts
sideEffect?: 'none' | 'filesystem' | 'external'
supportsIdempotencyKey?: boolean
cancellable?: boolean
```

只有 `sideEffect === 'none'` 才绕过 Intent。
不填时按 riskLevel 兜底（read → none），但那是兼容旧工具的降级，新工具应显式声明。

**注意**：`Grant` 的判据仍然是 `riskLevel`，不是 `sideEffect`。
一个 `riskLevel=read, sideEffect=external` 的工具需要 Intent 保护，
但不需要用户逐个批准——它本来就在自动放行白名单里。

**红测**（`side-effect.test.ts`）：

```
✓ riskLevel=read 但 sideEffect=external：超时后必须记 unknown 并建 Intent
✓ riskLevel=read 且 sideEffect=none：超时不需要 Intent，可安全重试
```

### 24c · reconcile 接受任意文字证据

**原实现**：`evidence?: string`，随便写什么都行。

**问题**：`"我确认过了"` 就能把 `unknown` 改成 `confirmed_success`。
那等于把「不确定」改成「确定」只差一次点击——
reconcile 不再是证据校验，而是免责声明。

**修复**：证据必须是 JSON，含 `type / source / observed / actor`，
且 `observed` 必须与 `resolution` 自洽：

| resolution | 允许的 observed |
|---|---|
| `confirmed_success` | `exists` / `partial` |
| `confirmed_failure` | `not_found` |
| `abandoned` / `retried` | 不限 |

`observed: 'indeterminate'` 不能支撑任何「确认」类裁决。

http 层用专门的异常类型映射 400，不靠匹配错误文案。

**红测**（`reconcile-evidence.test.ts`，8 条）：

```
✓ 空 evidence 被拒绝
✓ 纯文字搪塞被拒绝（没有结构化字段）
✓ 自相矛盾的证据被拒绝（confirmed_success 但 source 说没生效）
✓ 结构化证据被接受，且绑定到 Intent
✓ 重复 reconcile 被拒绝，且不会重新执行工具
✓ 错误的 stepId 不能对账别的 Run 的 Step
```

**这是破坏性变更**：旧的纯文字 `evidence` 不再被接受。
仓库里三处旧测试已改为结构化证据，**断言强度不变**
（仍然要求 evidence 里保留关键判断信息）。

## 第 25 项：六个崩溃点的验证结果

| 点 | 场景 | 结果 |
|---|---|---|
| A | Intent 已建、未 claim Grant | 正常执行一次 |
| B | Grant 已扣、Intent 仍 prepared | **不执行**，额度丢失，重新进入审批（**已知缺陷**） |
| C | Intent 停在 started | sweep 成 unknown，不重试 |
| D | 副作用已发生、Intent 仍 started | 记 unknown，文件保持原样 |
| E | committed、resultConsumed=0 | 复用结果，不重放 |
| F | 超时后底层完成 | Intent 保持 unknown，不产生第二次执行 |

### B 点是未修复的缺陷

**Grant 扣减与 Intent 状态不在同一事务里。**

崩溃会留下「额度已扣、工具没执行」的状态。重启后没有可用 Grant，
系统会重新请求审批——**用户第一次的批准被白白浪费了**。

修复需要把 claim / Step / Approval 放进同一事务。
本版没有做（任务书明确排除），测试 `intent-order.test.ts` 里有一条
专门记录这个事实的用例。

> **v0.8 已闭合**，见第 26 项。

## 第 26 项：`beginToolAttempt` 事务（本版新增）

### 闭合的两个确定性缺陷

**缺陷 1：预算不足时 Grant 已被扣。**

原顺序 `claim Grant → checkBudget → startIntent`。
`checkBudget` 抛错时，额度已经扣掉了——工具没执行、Intent 还在 prepared，
用户批准的权限被一次「预算不够」白白吃掉。

**缺陷 2：Grant 被扣了两次。**

`handleToolCall` 里先 claim 一次（判断要不要审批），
`invokeTool` 里又 claim 一次（执行前）。同一个工具调用扣了两次额度。

### 修复

**审批闸门改为只读判断**：`findUsableGrant()` 不扣减，只回答「有没有」。
真正的扣减统一在 `invokeTool` 的事务里。

**新增 `Store.beginToolAttempt()`**，在一个 SQLite 事务内完成：

```
① 读或建 Intent（唯一约束保证不重复）
② committed → 直接复用，不再 claim Grant
③ started/unknown/failed/reconciled → 拒绝
④ 预算检查（在 claim 之前）
⑤ 原子占用 Grant
⑥ prepared → started
```

任一步失败 → 整个事务回滚 → **Grant 不消耗、Intent 留在 prepared**。

### 边界（不夸大）

**这个事务只覆盖进入 `started` 之前。**

进入 `started` 之后就要调用外部工具，而 SQLite 事务无法和文件系统/网络
组成原子事务。那之后崩溃仍然只能记 `unknown`。

所以这不是 exactly-once，只是「**准备阶段要么全做要么全不做**」。

三种崩溃点分别的归宿：

| 崩溃时机 | 结果 |
|---|---|
| 事务提交前 | 事务回滚，Grant 未扣，Intent 留 prepared |
| 事务提交后、外部调用前 | Intent 已 started → 重启 sweep 成 unknown，不重试 |
| 外部副作用发生后、结果落库前 | 同上，unknown + 人工对账 |
| timeout 后底层 Promise 晚到 | unknown 保持，晚到结果只记事件 |

### 新增 `attempt-atomicity.test.ts`（5 条）

| 测试 | 验证 |
|---|---|
| 预算不足 | 工具不执行、**Grant usedCalls=0**、Intent 留 prepared、Run=expired |
| 预算充足 | 工具 1 次、Grant 扣 1 次、Intent committed |
| Grant 额度为 0 | 不执行、额度不变、走审批而非 completed |
| 预算不足 | 不创建 Intent（还没到执行阶段） |
| claim 后崩溃 | 不重放、不静默完成、重新进入审批 |

**红测证据**：

```
✗ 预算不足：预算检查失败，但 Grant 已经被扣: expected 1 to be 0
✗ 预算充足：expected 2 to be 1        ← 重复扣减
```

## 第 27 项：拒绝危险的能力组合（本版新增）

### 问题

`riskLevel='read'` 表示「不需要审批」，工具在自动放行白名单里。
如果这样的工具还有副作用，等于**有副作用的操作可以绕过审批**。

上一版允许这个组合存在，靠 `sideEffect` 在运行时兜底。
但那是**运行时**防护，配置错了要到执行时才暴露。

### 修复：方案 A，注册时 fail-closed

```ts
if (def.sideEffect && def.sideEffect !== 'none' && def.riskLevel === 'read') {
  throw new Error(
    `工具 ${def.id} 的能力声明矛盾：` +
    `riskLevel='read' 表示不需要审批，但 sideEffect='${def.sideEffect}' 表示它会改变外部状态。` +
    '有副作用的工具必须声明 riskLevel=\'write\'，否则会绕过用户审批。'
  )
}
```

未声明 `sideEffect` 时不检查——那是兼容旧工具的降级路径，
按 `riskLevel` 推断（read → none），不会产生矛盾。

### 新增测试（5 条）

```
✓ read + sideEffect=filesystem 必须注册失败
✓ read + sideEffect=external 必须注册失败
✓ read + sideEffect=none 可以注册
✓ write + 任意 sideEffect 都可以注册
✓ 未声明 sideEffect 时按 riskLevel 推断，不会误判
```

### 对既有测试的影响

`side-effect.test.ts` 里三条测试原本用 `riskLevel: 'read'` + `sideEffect: 'external'`
来模拟「会写的 GET」。方案 A 生效后这个组合注册不通过。

**改法**：把那三条改成 `riskLevel: 'write'`，并显式给 Grant。
它们真正要验证的是「有副作用的工具走 Intent」，与 riskLevel 无关。
**断言强度不变。**

## 第 28 项：reconcile 终态语义（本版新增）

### 四种 resolution 的严格映射

| resolution | Step 终态 | Intent 终态 | 是否重放 |
|---|---|---|---|
| `confirmed_success` | `completed` | `reconciled` | ❌ |
| `confirmed_failure` | `failed` | `reconciled` | ❌ |
| `retried` | `skipped` | `reconciled` | ❌（原 Intent） |
| `abandoned` | `cancelled` | `reconciled` | ❌ |

**`abandoned` 绝不能标成 `completed`**——放弃不等于完成。

### `retried` 的准确语义

`retried` 意味着「用户决定重做」，**但系统不会自动重试原 Intent**。

模型重新发一个 tool_call 会得到**新的 toolCallId** → 新的 Intent → 允许执行。
那是用户明确要求的行为，不是缺陷。

要防的是「**原 Intent 被重放**」——同一个 `toolCallId` 再执行一次。
这一点由 `reconciled` 状态挡住。

### 新增 `reconcile-semantics.test.ts`（12 条）

覆盖四种 resolution 的终态、Step/Intent 一致性、重复 reconcile、
证据自洽性、approved-resume 路径的真实 reconcile、toolCallId 重复。

## 第 29 项：修正上一版的三处不实之处（本版新增）

上一版（v0.8）有三处说法站不住脚，本版逐个纠正。

### 29a · 崩溃测试手工构造了事务不会产生的状态

**上一版的问题**：三条崩溃测试手工调用 `claimGrantUsage`，
制造出「Grant 已扣、Intent 仍 prepared」的状态，然后当作崩溃结果来断言。

**但 `beginToolAttempt` 是一个事务**：claim 和 startIntent 一起提交。
这个中间状态**不可能**通过正常路径产生。手工构造它，
等于在验证一个系统根本不会进入的状态。

**修复**：删除这三条手工构造的测试，改为 `tx-boundary.test.ts`
（6 条），用真实故障注入验证四个边界：

| 边界 | 验证方式 | 结果 |
|---|---|---|
| 事务提交前失败 | 让 `checkBudget` 抛错 | Grant=0、Intent=prepared |
| `startIntent` 失败 | 预先把 Intent 推到 started | Grant=0、返回 blocked |
| 事务提交后崩溃 | 真实调一次 `beginToolAttempt` 后重启 | Grant=1、Intent=started→unknown |
| 副作用后崩溃 | 工具写文件后抛错 | Intent=unknown、Run=needs_reconciliation |

还加了一条**对照测试**：正常路径下断言
`!(grant.usedCalls === 1 && intent.status === 'prepared')`——
证明事务外的不一致状态不会出现。

### 29b · `sideEffect` 可以靠隐式推断放行

**上一版的问题**：未声明 `sideEffect` 时按 `riskLevel` 推断
（read → none）。一个作者忘了声明、实际有副作用的工具会被当成无副作用，
从而跳过 Intent 保护。

**修复**：**必须显式声明，缺失直接拒绝注册。**

```ts
if (!def.sideEffect) throw new Error(`工具 ${def.id} 必须显式声明 sideEffect`)
if (!VALID_SIDE_EFFECTS.includes(def.sideEffect)) throw new Error('值非法')
if (def.sideEffect !== 'none' && def.riskLevel === 'read') throw new Error('声明矛盾')
```

`write + sideEffect=none` **允许**，但必须显式——
表示「需要审批，但操作本身不改外部状态」（例如预览）。

**影响**：仓库里 6 处测试工具补了字段；一条旧测试
（「未声明时按 riskLevel 推断」）的期望反转，注释说明这是有意的收紧。

### 29c · `toolCallId` 只按 `(run, step, call)` 唯一

**上一版的问题**：旧约束挡不住「不同 step + 相同 toolCallId」产生两条 Intent。
后果是同一个逻辑调用可能执行两次副作用。

**产品语义**：**同一个 Run 内，`toolCallId` 全局唯一。**

理由：`toolCallId` 来自模型的一次 tool_call，标识「这一次调用」。
同一次调用不该因为换了 step 就变成两次操作。

**修复**：

- 约束改为 `UNIQUE (run_id, tool_call_id)`
- schema 从 v3 升到 v4，带迁移（旧数据按 `(run_id, tool_call_id)` 去重，
  保留最早一条）
- `getOrCreateIntent` 按新键查，并校验 `requestHash` 一致：
  - 相同 `toolCallId` + 相同 `requestHash` → 复用
  - 相同 `toolCallId` + **不同** `requestHash` → **抛错**
  - 不能静默复用（会执行错的参数），也不能新建（会执行两次）

**新增 `toolcall-uniqueness.test.ts`（7 条）**，含 Executor 级测试：
模型重复发同一 `toolCallId` 时只执行一次副作用。

## 第 30 项：reconcile 的绑定与 actor 来源（本版新增）

### 30a · `ReconciliationRecord` 没绑定 Intent

上一版只绑定 `stepId`。但 Step 只是执行轨迹，Intent 才是
「这次外部调用怎么样」的记录——尤其审批恢复时 Step 每次新建，
Intent 跨恢复稳定。

**修复**：记录加 `intentId` / `toolCallId` 字段，schema 升到 v4。
并且**先定位 Intent 再创建记录**（上一版是先建记录再补，结果永远是空的）。

### 30b · `decidedBy` 可以由请求体伪造成 `system`

`system` 表示「系统自动裁决」，在审计上是更强的声明。
如果请求体写什么就信什么，这个字段就失去意义。

**修复**：

- `Executor.reconcile()` 加 `trusted?: boolean` 参数
- 请求体传 `system` 但没有 `trusted` → 降级为 `user`
- **HTTP 层根本不接受 `system`**：`decidedBy` 只可能是 `reconciler` 或 `user`

**新增 `reconcile-binding.test.ts`（5 条）+ HTTP 层 2 条**。

---

# 十四、已知缺口

## 14.1 硬阻塞（3 项）

本版关闭了 **ToolIntent**。剩余三项，**按完整名称列出**：

### 1. 无调用前预算预留（budget reservation）

**现状**：调用前只检查「已用是否已达上限」，没有预留额度。

**后果**：
```
limit = 100, current = 90, 本次调用消耗 50
→ 调用仍会发出 → usage = 140 → 标记 expired
```

**能阻止后续继续，但不能防止本次超支。**

**文档已如实说明，不宣称「绝对硬上限」。**

### 2. 审计者没有收到任务契约（TaskContract）

**现状**：审计输入只有产物文本 + 机器规则结果，**没有任务目标**。

**影响**：可能放过「格式正确、长度达标、但与任务目标无关」的产物。

### 3. 无证据包（Evidence Bundle）

**现状**：`AuditResult` 只存结构化摘要，不能离线回放验证。

**缺失**：code commit / contract hash / prompt hash / 原始 request-response /
rule manifest hash / tool trace / usage / 环境版本 / 回放命令。

---

## 14.1b 仍未完成的其他项（不只列字母）

| 项 | 完整名称 | 现状 |
|---|---|---|
| G | 快照选取用 `find(kind)` 而非 `completionSnapshotId` | 未修 |
| K | `apply()` 是 check-then-write，存在 TOCTOU 窗口 | 未修 |
| L | Windows 路径未覆盖 junction / `\\?\` / ADS | 未修 |
| M | Snapshot capture 无工作区锁 | 未修 |
| O | `reconcile()` 的 evidence 曾可为空 | ✅ v0.7 已修 |
| — | **Grant 扣减与 Intent 状态不在同一事务** | ✅ **v0.8 已修**（`beginToolAttempt`） |
| — | **Grant 被重复扣减（两处 claim）** | ✅ **v0.8 已修** |
| — | **`riskLevel=read` + `sideEffect!=none` 可注册** | ✅ v0.8 已修（注册时拒绝） |
| — | **`sideEffect` 可隐式推断放行** | ✅ **v0.9 已修**（必须显式声明） |
| — | **`toolCallId` 可跨 step 重复** | ✅ **v0.9 已修**（UNIQUE(run, tool_call_id)） |
| — | **`decidedBy` 可被请求体伪造成 system** | ✅ **v0.9 已修** |
| — | Windows 路径测试的 junction / ADS 分支 | 未覆盖 |
| — | reconcile 证据校验没有端到端（E2E）覆盖 | 未覆盖 |
| — | `beginToolAttempt` 事务只覆盖 started 之前 | 之后崩溃仍只能记 unknown |

### 关于 Evidence Bundle 的旧内容

**现状**：`AuditResult` 只存结构化摘要，不能离线回放验证。

**缺失**：code commit / contract hash / prompt hash / 原始 request-response /
rule manifest hash / tool trace / usage / 环境版本 / 回放命令。

## 14.2 认证方案的残余风险（必读）

**认证已实现，但威胁模型有明确边界。不要把「有认证」读成「安全」。**

### localhost 不是认证机制

`127.0.0.1` 只限制**网络可达范围**，不限制**谁能连**。
任何以同一 OS 用户身份运行的进程都能连上来，也能读 `auth-token` 文件。

**当前威胁模型覆盖**：

| 攻击者 | 是否能防 | 靠什么 |
|---|---|---|
| 局域网/互联网 | ✅ | 默认只绑 loopback |
| 浏览器里的恶意页面（CSRF） | ✅ | bearer 不在 cookie；Origin 校验 |
| 其他 OS 用户 | ✅ | token 文件 ACL 收紧（见 20c） |
| **同一 OS 用户的恶意进程** | ❌ **不防** | 它能读 token 文件 |
| 内存转储 / 调试器附加 | ❌ | — |
| 物理接触 | ❌ | — |

**结论**：本模型的安全边界是**操作系统用户账户**，不是进程。
「同一用户下的进程互相不可信」不在承诺范围内。

### 仍存在的具体弱点

| 项 | 问题 | 影响 |
|---|---|---|
| 认证-N1 | token 文件与数据库同目录 | 读数据库的进程通常也能读 token |
| 认证-N2 | 没有速率限制 | 本机可暴力猜 token（256 位，实际不可行，但没有显式防护） |
| 认证-N3 | token 不过期、不轮换 | 长期运行实例的凭据生命周期无限 |
| 认证-N4 | 单 token，无主体区分 | 无法审计「是谁批准的」——`approver` 字段来自请求体 |
| 认证-N5 | 无 TLS | 本机明文传输；跨机必须自行加反向代理 |
| 认证-N6 | Origin 白名单按端口推导 | 反代改端口后需显式配置 `allowedOrigins` |

### 次要缺口（与认证无关，本版未动）

| 项 | 问题 |
|---|---|
| G | 审计取快照用 `find(kind === 'workspace')` 而非 `completionSnapshotId` |
| K | `apply()` 是 check-then-write，TOCTOU 窗口 |
| L | 路径校验未覆盖 junction / `\\?\` / ADS / 深层 symlink |
| M | Snapshot capture 无工作区锁；仍用 `git add --all --force` |
| O | `reconcile()` 的 `evidence` 可选为空 |

**关于 L 的更新**：`paths.test.ts` 里三处静默 `return` 已改为显式 `ctx.skip()`。
在 Windows 上这三条真实执行；在非 Windows 上 UNC 那条仍保留了一条跨平台断言，
大小写那条标记为 skipped 而非 passed。**跳过不再冒充通过。**

## 14.3 有表但未接通

| 项 | 现状 |
|---|---|
| `message` 表 | 建了，执行器从不写入 → `GET /sessions/:id/messages` 永远为空 |

## 14.4 完全未实现

Skill Runtime（只有硬编码的 `general` 技能）· 知识库 / RAG · 记忆 ·
沙箱隔离 · MCP 客户端 · 触发器 / 无人值守 · 工作流引擎 · UI ·
显式注入检测 · 多用户 / RBAC

---

# 十五、需要审计方回答的问题

## 15.1 状态与并发

1. Run 的 11 个状态是否有遗漏的转换？特别是异常路径。
2. 只有 `queued` 可以 execute，这个约束是否过严？崩溃恢复场景怎么处理？
3. Grant 原子认领在 SQLite 的单进程模型下是否足够？多进程呢？
4. `transitionRunStatus` 的 CAS 是否覆盖了所有状态变更路径？

## 15.2 审计门

5. 「模型 pass 只在所有规则明确 pass 时生效」是否足够防注入？
6. weak / strong 的划分标准由谁定？会不会被人为操纵成「全标 strong 然后自动放行」？
7. 模型输出自相矛盾（pass + blocking issue）时判 reject，这个策略对吗？
8. 没有显式注入检测，只靠 verdict 不对称兜底，够吗？

## 15.3 验收与交付

9. 验收门的 7 项检查是否有遗漏？
10. 按 binding 查审计（而不是按时间排序）是否解决了「A 的 pass 验收 B」问题？
11. `apply()` 的 conflict 语义（不覆盖）是否正确？
12. TOCTOU 窗口的风险在「单进程桌面应用」假设下是否可接受？

## 15.4 快照

13. 三道位置防护是否覆盖了所有污染路径？
14. git shadow repo 在 Windows 上有什么已知问题？
15. 快照没有配额，长期使用会不会磁盘无限增长？

## 15.5 优先级

16. 剩下 6 项硬阻塞（H/I/J/E/P + autoApprove），建议的实施顺序？
17. 在当前状态下，是否允许「本地单用户内部试用」？
18. 有没有我们没意识到但更严重的问题？

---

# 附录 A：完整接口清单（36 个）

## 基础

| 方法 | 路径 | 需要认证 |
|---|---|---|
| GET | `/health` | ❌ **唯一公开接口**（不含路径/token） |
| GET | `/skills` | ✅ |
| GET | `/tools` | ✅ |

## 会话

| 方法 | 路径 | 需要认证 |
|---|---|---|
| GET / POST | `/sessions` | ✅ |
| GET | `/sessions/:id/messages` | ✅（永远为空 ⚠️） |

## 任务

| 方法 | 路径 | 需要认证 |
|---|---|---|
| GET / POST | `/tasks` | ✅ |
| GET | `/tasks/:id` | ✅ |

## Run 执行

| 方法 | 路径 | 需要认证 |
|---|---|---|
| POST | `/runs` | ✅ |
| GET | `/runs/:id` | ✅ |
| **POST** | **`/runs/:id/execute`** | ✅ |
| POST | `/runs/:id/cancel` | ✅ |
| POST | `/runs/:id/pause` | ✅ |
| POST | `/runs/:id/resume` | ✅ |
| POST | `/runs/:id/reconcile` | ✅ |
| GET | `/runs/:id/reconciliations` | ✅ |

## 审批

| 方法 | 路径 | 需要认证 |
|---|---|---|
| GET | `/approvals` | ✅ |
| **POST** | **`/approvals/:id/approve`** | ✅ |
| **POST** | **`/approvals/:id/reject`** | ✅ |

## 快照与产物

| 方法 | 路径 | 需要认证 |
|---|---|---|
| POST | `/runs/:id/snapshot` | ✅ |
| GET | `/runs/:id/snapshots` | ✅ |
| GET | `/snapshots/diff` | ✅ |
| POST | `/snapshots/:id/restore` | ✅ |
| GET | `/snapshots/:id/files` | ✅ |
| GET | `/tasks/:id/artifacts` | ✅ |

## 验收与交付

| 方法 | 路径 | 需要认证 |
|---|---|---|
| **POST** | **`/tasks/:id/accept`** | ✅ |
| POST | `/tasks/:id/request-revision` | ✅ |
| POST | `/tasks/:id/reject` | ✅ |
| GET | `/tasks/:id/acceptances` | ✅ |
| **POST** | **`/acceptances/:id/apply`** | ✅ |
| **POST** | **`/acceptances/:id/export`** | ✅ |
| GET | `/tasks/:id/deliveries` | ✅ |

## ReviewLoop

| 方法 | 路径 | 需要认证 |
|---|---|---|
| POST | `/tasks/:id/review` | ✅ |
| GET | `/tasks/:id/cycles` | ✅ |
| GET | `/tasks/:id/audits` | ✅ |

**✅ = 需要 `Authorization: Bearer <token>`。只有 `/health` 不需要。**

---

# 附录 B：测试用例清单（316 个）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `case-a.test.ts` | 2 | 只读工具自动执行、重启后可查询 |
| `case-b.test.ts` | 4 | 写工具拒绝、去重、历史持久 |
| `case-c.test.ts` | 4 | 超时 → unknown、三种对账建议 |
| `case-d-lifecycle.test.ts` | 9 | 状态分离、审批超时、悬挂清理、对账 |
| `case-e-artifact.test.ts` | 6 | 快照生成、版本链、去重 |
| `case-f-acceptance.test.ts` | 15 | 验收与交付分离、unknown 阻塞 |
| `case-g-audit.test.ts` | 16 | 族隔离、短路、verdict 不对称、回归 |
| `case-h-reviewloop.test.ts` | 14 | Cycle、ReworkBrief、循环上限、归属 |
| `invariants.test.ts` | 29 | 验收门、unknown、审计合并、交付、预算 |
| `paths.test.ts` | 14 | 六种路径攻击、参数哈希 |
| `snapshot.test.ts` | **22** | 捕获/恢复/diff、事务保护、位置防护、**重启** |
| `state-gate.test.ts` | **12** | 状态门 + CAS 并发 |
| `atomicity.test.ts` | **9** | Approval / Grant 原子性 |
| `model-identity.test.ts` | **6** | 模型身份不可伪造 |
| `server/__tests__/auth.test.ts` | **27** | **认证原语、401、Origin、autoApprove、无副作用** |
| `server/__tests__/startup.test.ts` | **3** | **非 loopback 无认证拒绝启动、token 不入日志** |
| `server/__tests__/token-file.test.ts` | **3** | **token 文件 ACL：其他用户不可读、旧文件被收紧、env 模式不落盘** |
| `server/__tests__/routes.test.ts` | **11** | **穷举全部 36 条路由无 token → 401、只有 /health 公开** |
| `core/__tests__/grant-consumption.test.ts` | **4** | **审批恢复必须消耗 Grant、撤销后 fail-closed** |
| `core/__tests__/intent-store.test.ts` | **15** | **ToolIntent 状态机：合法/非法转换、唯一约束、sweep** |
| `core/__tests__/intent-scenarios.test.ts` | **11** | **任务书 10 个副作用场景 + 对账联动** |
| `core/__tests__/intent-crash.test.ts` | **2** | **崩溃窗口内重复执行（修复前 = 2 次）** |
| `core/__tests__/tool-intent.test.ts` | **5** | **超时晚到、重复 resume、共用入口** |
| `core/__tests__/intent-order.test.ts` | **5** | **执行顺序：Grant 前置于 started、额度耗尽行为** |
| `core/__tests__/side-effect.test.ts` | **8** | **sideEffect 判据、非法组合注册拒绝** |
| `core/__tests__/reconcile-evidence.test.ts` | **8** | **证据结构化、自洽性、绑定 Intent** |
| `core/__tests__/intent-crashpoints.test.ts` | **7** | **崩溃点 A-F + 无遗留 started** |
| `core/__tests__/attempt-atomicity.test.ts` | **5** | **预算失败 Grant 不变、重复扣减修复、事务回滚** |
| `core/__tests__/reconcile-semantics.test.ts` | **12** | **四种 resolution 终态、Step/Intent 一致、toolCallId 重复** |
| `core/__tests__/tx-boundary.test.ts` | **6** | **真实故障注入：事务四边界** |
| `core/__tests__/toolcall-uniqueness.test.ts` | **7** | **toolCallId 全局唯一、requestHash 冲突拒绝** |
| `core/__tests__/reconcile-binding.test.ts` | **5** | **intentId 绑定、actor 不可伪造** |

**加粗为本版新增。总计 316，与 `npx vitest run` 输出一致。**

**统计口径分开列（三者不能相加）**：

| 类别 | 数量 | 命令 |
|---|---|---|
| 单元 + 集成测试 | **316** | `npx vitest run` |
| 其中 HTTP 集成（真实 `listen` + `fetch`） | **50** | `npx vitest run src/server/__tests__/` |
| E2E 断言 | **55** | `node scripts/e2e-reviewloop.mjs` |

**E2E 的真实覆盖边界**：没有覆盖 reconcile 的证据校验，
因为黑盒测试无法造出真实的 `unknown` Step。
证据校验只在单元测试里验证（8 条）。这是已知覆盖缺口，不写成「全部覆盖」。

## B.0 路由清单测试为什么重要

其他测试都是「我知道有个接口，去测它」。
`routes.test.ts` 反过来：**从 `app.ts` 源码解析出全部 36 条 `route(...)` 调用**，
然后逐条发真实 HTTP 请求。它断言三件事：

1. 路由数量正好是 36（数量变化时测试失败，提醒人来看）
2. **公开路由有且只有 `GET /health`**
3. 每一条 `requiresAuth` 的路由，无 token / 错 token 都返回 401

**验证过它真的能抓漏**：故意加一条 `requiresAuth: false` 的
`GET /secret-leak`，测试立刻两处失败（数量 37、公开路由不匹配）。
这不是人工检查 36 个接口能提供的保证——新增第 37 个接口时，
如果忘了标记，测试会失败而不是默默放过。

## B.1 认证测试的覆盖方式（27 条）

| 组 | 条数 | 覆盖 |
|---|---|---|
| 认证原语 | 6 | bearer 解析、恒定时间比较、loopback 判断、Origin 判断、token 落盘、短 token 拒绝 |
| 控制面认证 | 6 | 无 token / 错 token / 格式错 → 401；正确 token → 200；URL token → 400；`/health` 不泄露 |
| 认证失败无副作用 | 4 | execute 不改 Run、不调模型；approve 不建 Grant；accept 不建 AcceptanceRecord |
| autoApprove | 3 | 请求体带 autoApprove → 400；未知字段 → 400；无 Grant 时 write_file 仍进审批 |
| Origin | 4 | 跨站 403、`null` 403、本机 200、Origin 先于认证 |
| token 不泄露 | 2 | 所有响应体/响应头不含 token；401 不回显错误 token |
| 请求体上限 | 2 | 超大 → 400；非对象 JSON → 400 |

## B.2 这些测试真的能失败吗

**做了变异测试，不是只看绿灯。**

| 变异 | 结果 |
|---|---|
| 把 `if (r.requiresAuth)` 改成 `if (false && ...)` | **8 条失败** |
| 删掉 `onlyFields(...)` 调用 | **2 条失败** |

两次都恢复原状并用 `git diff` 确认。如果这两条变异不产生失败，
说明测试只是「打印了 assert」而没有真正约束行为。

## B.3 三条这次才补的启动测试

`startup.test.ts` 用子进程验证，因为这三个行为只存在于进程顶层：
`import` 会真的去监听端口，无法在测试进程内安全触发。

- `HOST=0.0.0.0` + 无 `AUTH_TOKEN` → 退出码 1，且不创建数据库
- `HOST=0.0.0.0` + 有 `AUTH_TOKEN` → 成功监听，token 不出现在日志
- 自动生成 token → 写入文件，日志只说「已生成」

**写这些测试时踩了一个坑**：启动后立刻 `rmSync` 会撞上 Windows 的文件锁
（SQLite 还开着）。修复是「等进程真的退出再删」——
这是测试自身的竞态，不是被测代码的问题，但会让测试随机变红。

**另外修复了 E2E 的一个虚假通过**：旧版在 fixture 阶段崩溃时
`passed=0 / failed=0`，仍然打印「全部断言通过」并退出 0。
现在 `passed === 0` 也算失败。**「什么都没验证」不能等于「验证通过」。**

---

# 附录 C：许可证

Apache-2.0。运行时依赖仅 `better-sqlite3`（MIT），无 copyleft。

架构思路参考：Parallax（MIT）、Cline（Apache-2.0）、LangGraph（MIT）、
OpenHands（MIT）、Temporal（MIT）、Langfuse（MIT）。

Cherry Studio（AGPL-3.0）**仅参考产品交互，未使用任何代码**。
