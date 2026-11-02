# 第三批修复对照表

> 日期：2026-10-30
> 对应审计意见：`01a18cc2`（对第二批修复的复核）
> 代码基线：commit `7c33c50`
> 测试结果：**120 passed**（11 个测试文件）
> 端到端：**43 条断言通过，0 失败**

---

## 一、修复总览

| # | 审计发现 | 严重度 | 修复 | 状态 |
|---|---|---|---|---|
| 1 | `/review` 未校验 `run.taskId` / `run.role` | 🔴 阻塞 | 路由层增加两项校验 | ✅ |
| 2 | `reconcile()` 未校验 `step.runId` | 🔴 阻塞 | 增加归属校验 | ✅ |
| 3 | `ReviewLoop.audit()` 接受外部传入 artifacts | 🟠 重要 | 收回选择权，内部按 cycle 查询并校验 | ✅ |
| 4 | ReviewCycle 创建无事务/唯一约束 | 🟠 重要 | `UNIQUE(task_id, cycle_number)` + 事务 | ✅ |
| 5 | `accept()` 依赖 `created_at` 排序取最新审计 | 🟠 重要 | 改为按 binding 归属关系查询 | ✅ |
| 6 | 无源码/测试证据基线 | 🟠 重要 | 初始化 git + 证据基线脚本 | ✅ |
| 7 | HTTP 状态码用正则匹配错误消息推断 | 🟡 建议 | 改为 `statusForError` 分类函数 | ✅ |
| 8 | 报告措辞「38 条测试」不准确 | 🟡 建议 | 改为「43 条 E2E 断言」 | ✅ |

---

## 二、逐条对照

### 1 · `/review` 归属校验

**审计原文**
> 缺少 `run.taskId !== taskId` 和 `run.role !== 'producer'` 校验，
> 因此仍可能提交 `POST /tasks/task-A/review { runId: task-B 的 Run }`。

**核实**：属实。

**修复**

```ts
// src/server/index.ts
if (run.taskId !== taskId) {
  json(res, 409, { error: `Run ${producerRunId} 属于 Task ${run.taskId}，不是 ${taskId}` })
  return
}

if (run.role !== 'producer') {
  json(res, 409, { error: `只有 producer Run 可以审计，当前 role 是 ${run.role}` })
  return
}
```

**不变量**
> 只有「属于 URL 中 Task 的 producer Run」可以发起审计。

**E2E 断言（新增）**
- 用别的 Task 的 id 发起 review → 409 ✅
- 拒绝原因包含「属于 Task」✅

---

### 2 · `reconcile()` 归属校验

**审计原文**
> 没有检查 `step.runId === input.runId`，可以用 Run-A 的接口裁决 Run-B 的 Step。

**核实**：属实。

**修复**

```ts
// src/core/executor.ts — reconcile()
if (step.runId !== input.runId) {
  throw new Error(`Step ${input.stepId} 属于 Run ${step.runId}，不是 ${input.runId}`)
}
```

**不变量**
> 只能裁决属于指定 Run 的 Step。

**E2E 断言（新增）**
- 用不存在的 Step 对账 → 404 ✅
- 用别的 Run 的 Step 对账 → 409 ✅
- 拒绝原因包含「属于 Run」✅

---

### 3 · ReviewLoop 收回 Artifact 选择权

**审计原文**
> `ReviewLoop.audit()` 的公共接口仍接受调用方直接传入 `artifacts`，
> 没有在内部重新通过 `cycle.producerRunId` 查询并校验。

**核实**：属实。

**修复**

接口层面删除 `artifacts` 字段：

```ts
export interface RunAuditInput {
  cycleId: string
  // 注意：不接收 artifacts。
  producerModel: string
  auditorModel: string
  auditorProvider: { presetId: string; apiKey?: string }
  signal: AbortSignal
  adapterResolver?: ...
}
```

内部改为自己查并校验三条归属关系：

```ts
const artifacts = this.store.listArtifacts(cycle.producerRunId)
for (const artifact of artifacts) {
  if (artifact.taskId !== cycle.taskId) throw ...
  if (artifact.runId !== cycle.producerRunId) throw ...
  if (artifact.sourceSnapshotId && artifact.sourceSnapshotId !== workspaceSnapshot.id) throw ...
}
```

**不变量**
> 审计的产物集合由 Cycle 的 `producerRunId` 唯一确定，不接受外部指定。

**新增测试（2 条）**
- 产物属于别的 Task → 抛错 ✅
- 产物关联的快照不是本 Cycle 的快照 → 抛错 ✅

---

### 4 · ReviewCycle 事务与唯一约束

**审计原文**
> 没有事务，也没有唯一约束。并发请求会都通过 maxCycles 检查、都创建 cycle #2。

**核实**：属实。

**修复**

表结构加唯一约束：

```sql
CREATE TABLE review_cycle (
  ...
  UNIQUE(task_id, cycle_number)
);
```

新增事务化创建方法：

```ts
createReviewCycleAtomic(input): { ok: true; cycle } | { ok: false; reason } {
  const tx = this.db.transaction(() => {
    // 事务内重新读取
    const existing = COUNT(*) WHERE task_id = ?
    const nextNumber = existing.n + 1

    if (nextNumber > skillMaxCycles) return { ok: false, reason: ... }

    const task = SELECT budget, usage FROM task WHERE id = ?
    if (budget.maxCycles != null && used >= budget.maxCycles) return { ok: false, reason: ... }

    const cycle = this.createReviewCycle({ ... })
    this.addTaskUsage(taskId, { cycles: 1 })
    return { ok: true, cycle }
  })
  return tx()
}
```

**为什么用 `better-sqlite3` 的 `transaction()`**：它是同步 API，天然串行，不需要额外的锁机制。

**不变量**
> 「检查上限 + 创建 Cycle + 累加 cycles」是原子的。
> 同一 Task 下 `cycle_number` 唯一。

**新增测试（2 条）**
- 连续创建 5 次，`cycle_number` 为 1..5 无重复，第 6 次被拦截 ✅
- 插入重复 `cycle_number` 抛错（唯一约束生效）✅

---

### 5 · `accept()` 改为按 binding 查审计

**审计原文**
> 当前按 `ORDER BY created_at ASC` 取最后一条。并发审计或时钟相同时，
> 不应依赖创建时间判定「最新」。更稳妥的是按 binding/foreign key 关系查询。

**核实**：属实。

**修复**

```ts
// 旧：按 Task 取最后一条
const latest = audits[audits.length - 1]

// 新：找绑定到「这个产物 + 这个 Run」的审计
const boundAudits = audits.filter((a) =>
  a.result.binding?.artifactIds.includes(artifact.id) &&
  a.result.binding?.producerRunId === artifact.runId,
)

if (boundAudits.length === 0) {
  throw new AcceptanceError(`没有找到针对产物 ${artifact.id} 的审计记录。...`)
}

// 同一产物可能被审过多次（返工），取最后一次
const audit = boundAudits.reduce((latest, current) =>
  current.createdAt >= latest.createdAt ? current : latest,
)
```

**注意**：`createdAt` 仍然用于「同一产物多次审计」的排序，但**不再跨产物比较**。这是关键区别——同一产物的审计必然属于同一条时间线，排序可靠。

**不变量**
> 验收依据是「针对这个产物的审计」，不是「这个 Task 的最后一条审计」。

**测试更新**
- 原断言 `/不包括当前产物/` 改为 `/没有找到针对产物/`（新错误消息更准确）

---

### 6 · 证据基线

**审计原文**
> 当前不是 Git repository，修复报告不能提供 commit / diff / hash 基线。

**修复**

1. 初始化 git 仓库，提交三次：
```
7c33c50 chore: 修复证据基线脚本的输出捕获
e3908f8 fix: 第三批审计修复
248e9f8 feat: AI 工作站 P0/P1-A 实现 + 两批审计修复
```

2. 新增 `scripts/evidence-baseline.sh`，生成 `docs/evidence/`：

| 文件 | 内容 |
|---|---|
| `VERSION.md` | commit hash、branch、node/npm 版本、OS |
| `SOURCE-HASHES.md` | src/ 下每个 .ts 文件的 SHA-256 |
| `DEPENDENCY-HASHES.md` | package-lock.json 的 SHA-256 |
| `TEST-OUTPUT.md` | 完整测试输出 + 退出码 |
| `TYPECHECK-OUTPUT.md` | 类型检查输出 |

**审计方可复现**：
```bash
bash scripts/evidence-baseline.sh
# 对比 docs/evidence/SOURCE-HASHES.md 是否与报告一致
```

**过程中发现的一个问题**：脚本最初在 `{ } > file` 里直接跑 `npx vitest run`，输出被截断。改为先写临时文件再读回。这个 bug 也是靠「检查生成的文件内容」发现的——如果只看脚本「跑完了」，会以为成功。

---

### 7 · HTTP 状态码分类

**审计间接指出**：原来的实现用正则匹配错误消息推断状态码。

```ts
// 旧
const status = /只有.*可以|必须先|不能直接|不存在/.test(message) ? 409 : 500
```

**问题**：
- 「不存在」被归到 409，应该是 404
- 改一句文案就换了状态码，太脆弱

**修复**

```ts
function statusForError(message: string): number {
  if (/不存在|not found/i.test(message)) return 404
  if (/只有.*可以|必须先|不能直接|不属于|属于 Task|属于 Run|与 Cycle|没有找到针对|还没有经过审计|不能验收|状态是/.test(message)) {
    return 409
  }
  return 500
}
```

**顺序很重要**：先判 404，再判 409。否则「Step 不存在」会被归到 409。

---

## 三、仍未完成（第四批）

**以下来自审计报告，本次未处理：**

| # | 问题 | 说明 |
|---|---|---|
| 1 | 调用前预算 reservation | 当前只有「调用前检查已用量 + 调用后 overshoot」 |
| 2 | `resultConsumed` 的 exactly-once | 需要 Intent 模型，仍是未完成状态 |
| 3 | Grant `scope=once` 并发消耗 | 需要条件原子更新 |
| 4 | `autoApprove` 由 HTTP 请求体控制 | 安全边界 |
| 5 | 本地 HTTP API 无认证 | 需先定 localhost-only 策略 |
| 6 | 审批 approve/reject 无条件更新 | 并发问题 |
| 7 | 快照 `--force` 可能绕过排除规则 | 需验证 |
| 8 | Auditor 不是独立 Run | 设计选择，需文档澄清 |
| 9 | 审计结果不能完整回放 | 需要 Evidence Bundle |
| 10 | 路径测试静默跳过 | 需重构测试输出 |
| 11 | `apply()` 的 TOCTOU 窗口 | exists/read 与 writeFile 之间仍可能被改 |

**其中第 11 条审计说得对**：当前 `apply()` 的冲突检测是「检查后写入」，不是原子的。文档应写成：

> 已实现基本内容漂移检测；不保证跨进程 TOCTOU 下的绝对无覆盖。

---

## 四、测试与验证

### 测试数量变化

| 阶段 | 测试数 |
|---|---|
| 初始实现 | 90 |
| 第一批修复 | 103 |
| 第二批修复 | 116 |
| **第三批修复** | **120** |

### E2E 断言数量变化

| 阶段 | 断言数 |
|---|---|
| 重写后 | 38 |
| **第三批新增** | **43** |

新增 5 条：review 归属、reconcile 404、reconcile 归属、拒绝原因检查 ×2

### 实际输出

```
Test Files  11 passed (11)
Tests       120 passed (120)
```

```
E2E：通过 43，失败 0
```

---

## 五、措辞修正

采纳审计建议：

| 旧表述 | 新表述 |
|---|---|
| 「38 条测试」 | 「43 条 E2E 断言」 |
| 「测试 10 个失败 2 个通过」 | 见 §六，附原始输出 |

---

## 六、关于「修复前红测」的证据

上一版我写「13 个不变量测试：10 个失败、2 个通过」但没附证据。这次补上。

**当时的实际输出**（第一批修复前）：

```
× 不变量 1：验收必须经过审计 > 未审计的 Task 不能被接受
× 不变量 1：验收必须经过审计 > 审计 reject 后不能被接受
× 不变量 1：验收必须经过审计 > 审计 escalate 后不能被接受
× 不变量 2：unknown 时 Run 不得 completed > 工具超时后模型收束，Run 不得变 completed
✓ 不变量 3：strong rule uncertain + 模型 pass → 必须 escalate
✓ 不变量 3：strong rule not_applicable + 模型 pass → 必须 escalate
× 不变量 4：apply 必须真正写入文件 > apply 后目标文件必须变成快照里的内容
× 不变量 4：apply 必须真正写入文件 > apply 失败时不得标记为 applied
× 不变量 5：export 必须读已验收快照 > 导出内容必须等于快照
× 不变量 6：预算超限必须阻止下一次调用 > usage 已达上限时不得再发起调用
× 不变量 6：预算超限必须阻止下一次调用 > 调用后 overshoot 必须终止后续调用
× 不变量 7：普通工具结果必须写入 run_message > 工具执行后 run_message 必须包含 tool 结果

Tests  10 failed | 2 passed (12)
```

**注意**：当时只有 12 个测试，不是 13 个。上一版写「13 个」是错的——审计指出「数字没有对上」是对的。

**那 2 个通过的测试后来被证明是覆盖不足**：它们只测了「全 uncertain」和「全 strong」两个极端，没测混合状态。第二批补充了 5 条混合场景测试，才真正覆盖了 fail-open 反例。

**这说明一件事**：**测试通过不等于反例已覆盖**。当时那 2 个绿灯给了我错误的信心。

---

## 七、当前状态的准确描述

> 三批修复后，测试从 90 增至 120，E2E 断言 43 条。
>
> 已修复：`apply()` 假成功、导出读错源、审计门 fail-open（含混合规则）、审计与产物绑定、`unknown` 立即阻塞、跨对象归属校验（accept/review/reconcile）、Cycle 事务与唯一约束、审计查询改为按 binding、快照换行保真、HTTP 状态码分类。
>
> 已建立：git 基线（3 次提交）、证据基线脚本（源码/依赖/测试/类型检查的 hash 与输出）。
>
> **仍未完成**：调用前预算 reservation、外部副作用幂等的 Intent 模型、Grant 并发消耗、审批条件更新、本地 HTTP 认证、审计完整回放、路径测试跳过统计、`apply()` 的 TOCTOU 保护。
>
> **因此仍不建议标记为最终送审版本。**

---

## 八、复现方式

```bash
cd G:\AI\ai-workstation

# 1. 确认代码基线
git log --oneline | head -3
# 应为：
# 7c33c50 chore: 修复证据基线脚本的输出捕获
# e3908f8 fix: 第三批审计修复
# 248e9f8 feat: AI 工作站 P0/P1-A 实现 + 两批审计修复

# 2. 类型检查（应无输出）
npx tsc -p tsconfig.json --noEmit

# 3. 测试（应为 120 passed）
npx vitest run

# 4. 生成证据基线并对比
bash scripts/evidence-baseline.sh
# 检查 docs/evidence/TEST-OUTPUT.md 的「退出码」应为 0

# 5. E2E（需干净端口）
DATA_DIR=./.e2e/data WORKSPACE=./.e2e/workspace PORT=4807 npx tsx src/server/index.ts
# 另开终端
node scripts/e2e-reviewloop.mjs 4807
# 应为：通过 43，失败 0
```

**注意**：必须先确认端口没有被旧服务占用，否则 E2E 会跑在旧代码上，产生误导性结果。
