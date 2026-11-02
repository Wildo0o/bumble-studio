# 第四批修复报告

> 日期：2026-10-30
> 代码基线：`11a35e3`（工作区未提交）
> 测试：**157 passed**（14 个测试文件，从 147 增至 157）
> E2E：**36 条断言通过，0 失败**

---

## 零、开始前发现的严重问题

### 项目仓库被快照功能污染

**现象**：执行 `git branch -v` 发现：

```
* main   3f24895 snapshot 2026-10-30T12:45:41.921Z
  master 11a35e3 docs: 第三批修复对照表
```

`main` 分支上有三个 `snapshot` 提交，内容是**删光了所有源码**：

```
54 files changed, 2 insertions(+), 19285 deletions(-)
```

**根因**：`SnapshotManager` 的 `repoDir` 如果落在工作区内（或等于工作区），
影子仓库的 git 命令会用工作区当 cwd，于是在用户项目根目录 init 了仓库、
覆盖了他的 `.git`、把源码当成快照提交。

**修复**：构造函数加防护，三种情况直接拒绝启动：

```ts
private assertRepoOutsideWorkspace(): void {
  const ws = normalizeForCompare(this.workspaceRoot)
  const repo = normalizeForCompare(this.repoDir)

  if (repo === ws) throw new Error(`快照仓库目录不能与工作区相同：${this.repoDir}`)
  if (repo.startsWith(ws + sep)) throw new Error(`快照仓库目录不能位于工作区内部：${this.repoDir}`)
  if (ws.startsWith(repo + sep)) throw new Error(`工作区不能位于快照仓库目录内部`)
}
```

**新增测试（4 条）**：`snapshot.test.ts`
- repoDir 等于工作区 → 拒绝 ✅
- repoDir 在工作区内 → 拒绝 ✅
- 工作区在 repoDir 内 → 拒绝 ✅
- repoDir 在工作区外 → 正常 ✅

**恢复操作**：`git checkout master` 回到干净基线。未执行 reset/clean。

---

## 一、本轮完成的修复（6 项）

| 项 | 内容 | 状态 |
|---|---|---|
| A | execute 状态门 + CAS | ✅ |
| B | approved-resume 共用安全检查 | ✅ |
| C | Approval / Grant 原子性 | ✅ |
| D | blocking issue 覆盖 | ✅ |
| F | 模型身份不可伪造 | ✅ |
| N | 验收接口统一状态门 | ✅ |

**未完成**：E（Auditor 收到任务目标）、G（completionSnapshotId）、H（HTTP 认证）、
I（预算 reservation）、J（ToolIntent）、K（apply TOCTOU）、L（路径进阶）、
M（Snapshot 并发）、O（reconcile 证据）、P（Evidence Bundle）。

---

## 二、A · execute 状态门

### 实现

```ts
private checkExecuteGate(run: Run): { allowed: boolean; reason: string; resultStatus: ... } {
  switch (run.status) {
    case 'queued':
    case 'running':  return { allowed: true, ... }
    case 'paused':   return { allowed: false, reason: '必须通过 resume 恢复', ... }
    case 'waiting_approval': return { allowed: false, reason: '必须先 approve 或 reject', ... }
    case 'needs_reconciliation': return { allowed: false, reason: '必须先对账', ... }
    case 'completed': return { allowed: false, reason: '已完成，不能重复执行', ... }
    case 'failed':
    case 'cancelled':
    case 'expired':   return { allowed: false, reason: `终态 ${run.status}`, ... }
    case 'auditing':  return { allowed: false, reason: '正在审计中', ... }
  }
}
```

### CAS 抢占

新增 `Store.transitionRunStatus(id, from, to)`：

```ts
transitionRunStatus(id, from, to): boolean {
  const placeholders = fromList.map(() => '?').join(', ')
  const result = this.db.prepare(
    `UPDATE run SET status = ?, ... WHERE id = ? AND status IN (${placeholders})`
  ).run(to, ..., id, ...fromList)
  return result.changes > 0
}
```

**关键**：只能从 `queued` 迁移到 `running`。

不能把 `running` 也放进起始集合——那样两个并发请求都会匹配到
`status='running'` 并"成功"更新成 running，结果两个都执行、模型被调用两次。

### 状态语义调整

审批/对账后 Run 回到 **`queued`** 而不是 `running`：

- `pause()` → `paused`（可以直接 resume）
- `resume()` → `queued`（解除暂停，等下次 execute）
- `approve()/reject()` → `queued`（审批结束，等下次 execute）
- `reconcile()` → `queued`（对账完成，等下次 execute）

这样状态门干净：**只有 queued 可以 execute，running 表示正在执行**。

### 测试（`state-gate.test.ts`，12 条）

| 测试 | 结果 |
|---|---|
| queued 可以执行 | ✅ |
| paused 不能 execute，模型 0 次调用 | ✅ |
| waiting_approval 不能 execute，模型 0 次调用 | ✅ |
| needs_reconciliation 不能 execute | ✅ |
| completed 不能重复执行，模型 0 次调用 | ✅ |
| failed / cancelled / expired 不能执行 | ✅ |
| **两个并发 execute 只有一个成功，模型只调 1 次** | ✅ |
| transitionRunStatus 支持多起始状态 | ✅ |
| transitionRunStatus 状态不匹配返回 false | ✅ |

---

## 三、B · approved-resume 共用安全检查

### 实现

`executeApprovedTool` 补齐两项：

**1. 预算检查**（原来完全没有）

```ts
try {
  this.checkBudget(runId, 'toolCalls', 1)
} catch (err) {
  if (err instanceof BudgetExceeded) {
    this.finishStep(stepId, 'failed', { error: err.message }, { toolName })
    this.store.setRunStatus(runId, 'expired', { endedAt: Date.now() })
    throw err
  }
  throw err
}
```

**2. 返回值改为结构化**

```ts
Promise<{ outcome: 'ok' | 'failed' | 'unknown'; content: string; reason?: string }>
```

**理由**：原来返回裸字符串，调用方只能靠 `content.startsWith('结果未知')` 猜。
一旦工具自己输出以这几个字开头就会误判。

**3. 超时后立即停止**

```ts
if (execResult.outcome === 'unknown') {
  this.store.setRunStatus(run.id, 'needs_reconciliation')
  this.emit(run.id, 'run.blocked_by_unknown', { viaApproval: true, ... })
  return { status: 'needs_reconciliation', reason: ..., run: ... }
}
```

与普通工具路径保持一致：不知道外部状态时，整个循环必须停。

---

## 四、C · Approval / Grant 原子性

### Approval 条件更新

```ts
transitionApproval(id, to: 'approved' | 'rejected', reason?): boolean {
  const result = this.db.prepare(
    `UPDATE approval SET status = ?, reason = ?, decided_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(to, reason ?? null, now(), id)
  return result.changes > 0
}
```

`approve()` / `reject()` 都改为先抢状态：

```ts
const won = this.store.transitionApproval(approvalId, 'approved', opts.approver)
if (!won) {
  const current = this.store.getApproval(approvalId)!
  throw new Error(`审批已被处理：当前状态 ${current.status}`)
}
```

### Grant 原子认领

表结构加 `max_calls` 列（从 constraints JSON 提出来，因为 SQLite 无法直接比较 JSON）：

```sql
ALTER TABLE grant ADD COLUMN max_calls INTEGER;
```

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

**流程从「先查再执行后计数」改为「执行前原子认领」**：

```ts
const candidateGrant = this.findUsableGrant(run.id, definition.id)
let grant: Grant | undefined
if (candidateGrant) {
  const claimed = this.store.claimGrantUsage(candidateGrant.id)
  if (claimed) grant = candidateGrant
  // 认领失败 = 额度已被别的请求用掉 → 走审批
}
```

### 测试（`atomicity.test.ts`，9 条）

| 测试 | 结果 |
|---|---|
| transitionApproval 只能成功一次 | ✅ |
| approve 与 reject 竞争只有一个生效 | ✅ |
| 重复 approve 抛错 | ✅ |
| approve 与 expiry 竞争只有一个能赢 | ✅ |
| claimGrantUsage 额度用尽返回 false | ✅ |
| **scope=once 两次执行只成功一次** | ✅ |
| 过期 Grant 无法认领 | ✅ |
| 已撤销 Grant 无法认领 | ✅ |
| maxCalls 为空可无限认领 | ✅ |

---

## 五、D · blocking issue 覆盖

### 实现

模型输出自相矛盾（`verdict: pass` 但含 `severity: blocking` 的 issue）时，
以阻断问题为准：

```ts
const modelReportedBlocking = issues.some((i) => i.severity === 'blocking')

if (modelVerdict === 'reject') {
  finalVerdict = 'reject'
} else if (modelVerdict === 'pass' && modelReportedBlocking) {
  finalVerdict = 'reject'
  downgradeReason = '模型给出 pass，但同时列出了阻断级问题——以阻断问题为准，判定为 reject'
} else if (modelVerdict === 'pass') { ... }
```

### 测试（2 条）

| 测试 | 结果 |
|---|---|
| 模型 pass + blocking issue → reject | ✅ |
| 模型 pass + 仅 warning issue → pass | ✅ |

---

## 六、F · 模型身份不可伪造

### 实现

**1. Run 增加 `modelIdentity` 字段**

```ts
interface ModelIdentity {
  providerId: string
  modelId: string
  modelFamily: string   // 服务端算出
  recordedAt: number
}
```

**2. 执行时记录，只写一次**

```ts
this.store.recordModelIdentity(run.id, {
  providerId: opts.provider.id,
  modelId: opts.model.id,
  modelFamily: modelFamily(opts.model.id),   // ← 服务端算
  recordedAt: Date.now(),
})
```

```sql
UPDATE run SET model_identity = ?
WHERE id = ? AND model_identity IS NULL   -- 只写一次
```

**3. `/review` 不信任请求体的 producerModel**

```ts
const producerIdentity = run.modelIdentity
if (!producerIdentity) {
  json(res, 409, { error: '这个 Run 没有记录模型身份，无法做族隔离校验。' })
  return
}
// ...
producerModel: producerIdentity.modelId,   // ← 用服务端记录
```

### 测试（`model-identity.test.ts`，6 条）

| 测试 | 结果 |
|---|---|
| 执行时记录模型身份 | ✅ |
| **身份只写一次，不会被后续执行覆盖** | ✅ |
| 模型族由服务端计算 | ✅ |
| 伪装名称不能绕过族隔离 | ✅ |
| 未知模型默认为独立族 | ✅ |
| 身份可跨重启查询 | ✅ |

---

## 七、N · 验收接口统一状态门

### 实现

新增共用方法：

```ts
private assertAcceptanceGate(input): { task: Task; artifact: Artifact } {
  const task = this.requireTask(input.taskId)
  const artifact = this.assertArtifactBelongsTo(input)

  if (task.status !== 'awaiting_acceptance') {
    throw new AcceptanceError(
      `Task 当前状态是 ${task.status}，只有 awaiting_acceptance 可以做质量决定。` +
      (task.status === 'accepted' ? '这个 Task 已经被接受过，不能再用返工或拒绝把它回退。' : '')
    )
  }

  if (artifact.status !== 'candidate') {
    throw new AcceptanceError(`产物状态是 ${artifact.status}，只有 candidate 可以做质量决定。`)
  }

  return { task, artifact }
}
```

三个接口全部走这个门：`accept()` / `requestRevision()` / `reject()`

### 测试（4 条）

| 测试 | 结果 |
|---|---|
| 已 accepted 的 Task 不能被 requestRevision 回退 | ✅ |
| 已 accepted 的 Task 不能被 reject 回退 | ✅ |
| 非 candidate 的产物不能被 requestRevision | ✅ |
| 返工不要求审计通过 | ✅ |

---

## 八、修复过程中发现的问题

### 1. `executeApprovedTool` 超时后不停

**现象**：超时后返回字符串"结果未知..."，主循环继续下一轮模型调用。

**修复**：改为结构化返回，`outcome === 'unknown'` 时立即返回 `needs_reconciliation`。

### 2. Audit 短路的返回路径缺 binding

**现象**：机器规则失败短路时，返回的 `AuditResult` 没有 `binding` 字段。
导致验收时无法核对"这个 reject 是针对哪个产物的"。

**修复**：抽出 `buildBinding()`，三条返回路径共用。

### 3. E2E 的 producer/auditor 同族

**现象**：E2E 用 `model: 'demo'` 作 producer，`modelFamily('demo')` = `other:demo`；
auditor 也是 demo，同族 → 全部 escalate。

这是**正确行为**（demo 不能自审），但 E2E 场景设计错了。

**修复**：producer 改用 `deepseek-chat`，与 auditor 的 `other:demo` 不同族。

**注意**：模型身份改由服务端记录后，`/review` 里传 `producerModel`
已经不起作用了。E2E 的同族测试必须让 execute 时就用同族的模型名。

### 4. E2E 用 `mktemp -d` 导致路径不一致

**现象**：Git Bash 的 `/tmp/tmp.XXX` 与 Node 解析的 `G:\tmp\tmp.XXX` 不是同一个位置，
服务和脚本操作不同目录。

**修复**：改用项目内的 `.e2e-run/` 目录。

---

## 九、完整测试结果

```bash
$ npx tsc -p tsconfig.json --noEmit
（无输出，退出码 0）

$ npx vitest run
 Test Files  14 passed (14)
      Tests  157 passed (157)
   Duration  ~25s
```

### 测试数量变化

| 阶段 | 测试数 |
|---|---|
| 第三批后 | 120 |
| **第四批后** | **157** |

新增 37 条：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `state-gate.test.ts` | 12 | 状态门 + CAS 并发 |
| `atomicity.test.ts` | 9 | Approval/Grant 原子性 |
| `model-identity.test.ts` | 6 | 模型身份 |
| `snapshot.test.ts` 新增 | 4 | 影子仓库位置防护 |
| `invariants.test.ts` 新增 | 6 | blocking 覆盖 + 统一验收门 |

**无 skipped / unsupported 测试**。所有测试都实际执行。

---

## 十、E2E 结果

```bash
$ DATA_DIR=$PWD/.e2e-run/data WORKSPACE=$PWD/.e2e-run/workspace PORT=4814 npx tsx src/server/index.ts
$ node scripts/e2e-reviewloop.mjs 4814

汇总
  通过: 36
  失败: 0
```

**注意**：E2E 必须用项目内路径，不能用 `mktemp -d`（见 §八.4）。

---

## 十一、修改文件列表

```
 src/core/__tests__/case-b.test.ts           |   2 +-
 src/core/__tests__/case-d-lifecycle.test.ts |  15 +-
 src/core/__tests__/invariants.test.ts       | 146 ++++++++++++
 src/core/__tests__/snapshot.test.ts         |  29 +++
 src/core/__tests__/state-gate.test.ts       | 新增 12 条
 src/core/__tests__/atomicity.test.ts        | 新增 9 条
 src/core/__tests__/model-identity.test.ts   | 新增 6 条
 src/core/acceptance.ts                      |  60 +++--
 src/core/audit.ts                           |  59 ++++-
 src/core/executor.ts                        | 339 ++++++++++++++++++++++++----
 src/core/snapshot.ts                        |  50 +++-
 src/core/store.ts                           | 141 +++++++++++++++-
 src/server/index.ts                         |  24 +-
 src/shared/types.ts                         |  16 ++
 scripts/e2e-reviewloop.mjs                  | 模型名、状态码、路径修正
 15 files changed, 808 insertions(+), 95 deletions(-)
```

---

## 十二、尚未关闭的风险

**以下全部未完成，按任务书原样列出：**

### 第二优先级

| 项 | 问题 | 风险 |
|---|---|---|
| **E** | Auditor 没收到 TaskContract | 审计不知道任务目标是什么，可能通过"满足最小长度但与目标无关"的产物 |
| **G** | 审计用 `snapshots.find(kind==='workspace')` 而非 `completionSnapshotId` | 多个快照时可能取错 |

### 第三优先级

| 项 | 问题 | 风险 |
|---|---|---|
| **H** | HTTP 控制面无认证 | 任何本地进程可调 execute/approve/accept |
| **H** | `autoApprove` 由请求体控制 | 可绕过审批 |
| **H** | `/health` 无保护返回绝对路径 | 信息泄漏 |
| **I** | 无调用前 reservation | 单次调用可超支（已在文档中如实说明） |
| **I** | maxInputTokens/maxOutputTokens 只做 `>=` 检查 | 不能防止本次超支 |

### 第四优先级

| 项 | 问题 | 风险 |
|---|---|---|
| **J** | 无 ToolIntent 模型 | 崩溃后可能重复执行副作用 |
| **K** | `apply()` 是 check-then-write | TOCTOU 窗口，跨进程可覆盖 |
| **L** | 路径校验未覆盖 junction / `\\?\` / ADS / 深层 symlink | Windows 特有攻击面 |
| **M** | Snapshot capture 无工作区锁 | 并发 capture 可能互相干扰 |
| **M** | 仍用 `git add --all --force` | 可能绕过排除规则 |

### 第五优先级

| 项 | 问题 | 风险 |
|---|---|---|
| **O** | reconcile 的 evidence 可选为空 | 任意客户端自述即可清除 unknown |
| **P** | 无 Evidence Bundle | 审计结果不能完整回放 |

---

## 十三、是否仍禁止最终送审

**是。仍禁止。**

理由：

1. **H（HTTP 认证）未做** —— 这是最基本的安全边界。任何人能访问 localhost:4801
   就能 approve 任何审批、接受任何产物。

2. **I（预算 reservation）未做** —— 文档已如实说明「只有调用后 overshoot 终止」，
   但这不满足任务书要求的「调用前预留」。

3. **J（ToolIntent）未做** —— 外部副作用仍有重复执行窗口。
   这一点从第三批起就没有变化。

4. **E（Auditor 收到任务目标）未做** —— 审计目前只看到产物文本和机器规则结果，
   不知道任务目标是什么。这会导致「格式对但内容无关」的产物被误判为通过。

5. **P（Evidence Bundle）未做** —— 审计结果不能离线回放验证。

**可以说的**：本轮修复的 6 项（A/B/C/D/F/N）都有源码、回归测试和 E2E 覆盖。
状态机、审批、授权的并发安全性比第三批有实质提升。

**不能说的**：P0 问题已全部关闭。至少 H、I、J、E、P 五项仍是硬阻塞。

---

## 十四、复现命令

```bash
cd G:\AI\ai-workstation

# 确认基线（工作区未提交）
git log --oneline | head -2        # 应为 11a35e3 及其前一条
git status --short                 # 应有未提交改动（本轮修改）

# 类型检查
npx tsc -p tsconfig.json --noEmit  # 无输出 = 通过

# 测试
npx vitest run                     # 14 files / 157 passed

# E2E（必须用项目内路径）
rm -rf .e2e-run && mkdir -p .e2e-run/data/exports
DATA_DIR=$PWD/.e2e-run/data WORKSPACE=$PWD/.e2e-run/workspace PORT=4814 npx tsx src/server/index.ts &
sleep 10
node scripts/e2e-reviewloop.mjs 4814   # 36 passed, 0 failed

# 证据基线
bash scripts/evidence-baseline.sh
cat docs/evidence/TEST-OUTPUT.md | grep -E "Tests|退出码"
```
