# 第二批修复对照表（含第一批误判纠正）

> 日期：2026-10-30
> 对应审计意见：`01a18ca9`（对第一批修复汇报的复核）
> 测试结果：**116 passed**（11 个测试文件）
> 端到端：**38 条断言全部通过，0 失败**
> 版本基线：本文件生成时的 `src/` 目录

---

## 零、先纠正上一版的一个错误结论

**上一版我写：「Audit pass fail-open 这条批评不成立」。这是错的。**

我当时只测了两个场景：
- 全是 `uncertain` → 得到 `escalate` ✅
- 全是 `strong` → 得到 `pass` ✅

于是得出结论「实现已正确」。但**漏掉了混合场景**：

```
weak rule    = pass
strong rule  = uncertain
model verdict = pass
→ 旧实现得到 pass   ← fail-open
```

**我实际运行验证了审计的说法：**

```
=== 混合规则场景 ===
verdict: pass
checkedRules: [ 'weak.pass=pass', 'strong.uncertain=uncertain' ]
❌ 确认 fail-open：weak pass + strong uncertain 竟然给出 pass
```

**根因**：旧逻辑看的是聚合标志，不是逐条判定。

```ts
// 旧（错）
const allUncertain = checks.every(c => c.status === 'uncertain' || c.status === 'not_applicable')
const hasStrongRules = skill.machineRules.some(r => r.strength === 'strong')

if (allUncertain) escalate
else if (!hasStrongRules) escalate
else pass          // ← 只要有一条 pass 且存在 strong 规则就放行
```

只要有一条 weak 规则 pass，`allUncertain` 就是 false，直接跳到最后的 `pass`。

**这是一个真实的安全漏洞。审计判断正确，我判断错误。**

---

## 一、本批修复总览

| # | 审计发现 | 严重度 | 修复 | 状态 |
|---|---|---|---|---|
| 1 | **Audit pass 混合规则 fail-open** | 🔴 阻塞 | 改为逐条判定：所有规则必须 pass | ✅ |
| 2 | `accept()` 未绑定具体 Artifact | 🔴 阻塞 | AuditResult 增加 `binding`，验收时核对 | ✅ |
| 3 | `unknown` 只阻止完成，不阻止继续执行 | 🔴 阻塞 | 立即停止循环，新增 `needs_reconciliation` 结果类型 | ✅ |
| 4 | 跨对象 ID 关系未校验 | 🟠 重要 | `assertArtifactBelongsTo` 校验 taskId/runId | ✅ |
| 5 | `TaskBudget.maxCycles` 未执行 | 🟠 重要 | 真正执行 + `cycles` 计数 | ✅ |
| 6 | 预算表述夸大 | 🟠 重要 | 文档改为准确表述（见 §六） | ✅ |
| 7 | E2E 无 fixture、无强断言 | 🟠 重要 | 重写脚本：38 条断言，失败非零退出 | ✅ |
| 8 | 测试文件残留「红测」标记 | 🟡 建议 | 已清除，改为说明性注释 | ✅ |

---

## 二、逐条对照

### 1 · Audit pass 混合规则 fail-open

**修复后逻辑**

```ts
const allRulesPass = checks.length > 0 && checks.every((c) => c.status === 'pass')
const strongChecks = checks.filter((c) =>
  skill.machineRules.some((r) => r.id === c.ruleId && r.strength === 'strong'),
)
const allStrongPass = strongChecks.length > 0 && strongChecks.every((c) => c.status === 'pass')

if (checks.length === 0)                        → escalate（没有任何规则）
else if (!allRulesPass)                          → escalate（有规则没明确通过）
else if (!hasStrongRules || strongChecks.length === 0) → escalate（全是 weak）
else if (!allStrongPass)                         → escalate（防御性兜底）
else                                             → pass
```

**不变量**
> 模型 `pass` 只有在**每一条规则都明确 `pass`** 且**存在至少一条 strong 规则**时才生效。
> 任何一条规则是 `uncertain` / `not_applicable` / `fail`，都不得放行。

**新增回归测试（5 条）**

| 场景 | 期望 |
|---|---|
| weak pass + strong uncertain + 模型 pass | escalate ✅ |
| weak pass + strong not_applicable + 模型 pass | escalate ✅ |
| strong pass + weak pass + 模型 pass | pass ✅ |
| strong pass + weak uncertain + 模型 pass | escalate ✅ |
| 没有任何规则 + 模型 pass | escalate ✅ |

---

### 2 · 审计与 Artifact 的绑定

**问题**：`assertLatestAuditPassed()` 只检查「Task 最新审计是 pass」，不检查这条审计审的是不是**当前这个产物**。

于是可以：
```
Artifact A 审计通过
→ 接受 Artifact B（Task 最新审计仍是 pass）
→ B 被接受
```

**修复**：新增 `AuditBinding`

```ts
export interface AuditBinding {
  producerRunId: string
  artifactIds: string[]
  snapshotId?: string
  snapshotRef?: string
  contentHashes?: Record<string, string>   // 路径 → 内容哈希
}
```

写入时机：`runAudit()` 把传入的 artifacts 与 snapshot 写进 `binding`。

**验收时的四项核对**

```ts
1. binding 存在吗？
2. binding.artifactIds 包含当前 artifactId 吗？
3. binding.producerRunId === artifact.runId 吗？
4. binding.snapshotId === artifact.sourceSnapshotId 吗？
5. binding.contentHashes[path] === artifact.contentHash 吗？
```

**不变量**
> 验收要求的是「**这个产物**通过审计」，不是「**这个 Task** 曾经有产物通过审计」。

**新增测试**
- 审计绑定的是别的产物 → 拒绝 ✅
- contentHash 与当前产物不一致 → 拒绝 ✅

---

### 3 · unknown 立即停止执行

**问题**：超时后返回 `kind: 'ok'`，主循环继续：
- 继续调用下一轮模型
- 继续处理同一批的其他工具调用

**修复**

```ts
// runTool 新增返回类型
| { kind: 'unknown'; content: string; reason: string }

// 主循环立即返回
if (outcome.kind === 'unknown') {
  history.push(unknownMsg)
  this.store.appendRunMessage(run.id, unknownMsg)
  this.store.setRunStatus(run.id, 'needs_reconciliation')
  this.emit(run.id, 'run.blocked_by_unknown', { ... })
  return { status: 'needs_reconciliation', reason: outcome.reason, run: ... }
}
```

**同时新增结果类型**

```ts
| { status: 'needs_reconciliation'; reason: string; run: Run }
```

**为什么不能复用 `failed`**：`failed` 在语义上可以被调用方当作「明确失败，可以重试」。`needs_reconciliation` 是「不知道成没成」，自动重试会重复执行副作用。

**不变量**
> 工具结果无法确认 → 立即停止整个执行循环。
> 不继续调模型，不处理同批其他工具，不返回 `failed`。

**新增测试**
- 超时后 `script.turnCount === 1`（模型只被调用 1 次）✅
- 同批两个工具，第一个超时 → 第二个未被执行 ✅
- 返回类型是 `needs_reconciliation` 而非 `failed` ✅

---

### 4 · 跨对象 ID 关系校验

**新增 `assertArtifactBelongsTo`**

```ts
private assertArtifactBelongsTo(input: { taskId, artifactId, runId }): Artifact {
  const artifact = this.requireArtifact(input.artifactId)
  if (artifact.taskId !== input.taskId) throw ...
  if (artifact.runId !== input.runId) throw ...
  const run = this.store.getRun(input.runId)
  if (run.taskId !== input.taskId) throw ...
  return artifact
}
```

应用于 `accept()` / `requestRevision()` / `reject()`。

**不变量**
> 产物、Run、Task 三者的归属关系必须一致，否则拒绝操作。

**新增测试**
- 产物不属于指定 Task → 拒绝 ✅
- 产物不属于指定 Run → 拒绝 ✅

---

### 5 · `TaskBudget.maxCycles` 真正执行

**问题**：字段定义了，从未被检查——等于一个假的限制。

**修复**

```ts
// ReviewLoop.begin()
const task = this.store.getTask(input.taskId)
if (task?.budget?.maxCycles != null) {
  const used = task.usage?.cycles ?? existing.length
  if (used >= task.budget.maxCycles) {
    return { limitReached: true, reason: `已达到任务预算规定的最大循环次数 ...` }
  }
}

// 创建 Cycle 后累加
this.store.addTaskUsage(input.taskId, { cycles: 1 })
```

**新增测试**
- Skill 允许 10 轮，Task 预算只允许 2 轮 → 第 3 轮被 Task 预算拦截 ✅
- `usage.cycles` 正确累加 ✅

---

### 6 · 预算表述修正

**上一版我写的**：「调用前预留 + 调用后结算」

**实际实现**：调用前只检查「已用量是否已达上限」，没有预留字段、没有预估、没有原子预留。

**采纳审计的修正表述**：

> 调用前按已用量止损（`>=` 而非 `>`），调用后按真实用量结算；
> 响应导致 overshoot 时立即终止后续调用。
> **尚未实现严格的调用前预算预留**——token/cost 只有响应后才知道真实值，
> 因此不宣称「绝对不超限」。

**未做**（列入第三批）：
- `reserved` 字段
- 调用前按 `maxOutputTokens` 限制 provider
- 原子预留

---

### 7 · E2E 重写

**旧脚本的问题**（审计指出）：
- 没有自建 fixture，依赖外部预置的 `readme.txt`
- `longContent` 变量定义了但未使用
- 导出路径与白名单不一致
- 没有强断言，打印成功就算过
- 失败不退出

**新脚本的特点**：

```
0 · 准备 fixture        自己创建文件并验证内容
1 · Producer Run        验证产物数量/状态/版本/contentHash 与真实文件一致
2 · 验收门              验证未审计时验收被拒绝（且原因提到审计）
3 · 审计                验证 verdict 合法、checkedRules >= 3、binding 完整
4 · 同族模型隔离        验证 escalate 且 reason === 'same_model_family'
5 · 审计前置条件        验证未完成的 Run 不能审计
6 · 验收与交付          验证接受≠交付、导出文件真实存在、内容等于快照、hash 一致
7 · 跨对象归属校验      验证用别的 Task 的 id 会被拒绝
8 · Cycle 记录          验证 Cycle 数与状态推导
```

**断言框架**：
```js
assert(condition, message)      // 失败时记录并继续
assertEq(actual, expected, msg)
assertIncludes(haystack, needle, msg)

// 结尾
if (failed > 0) {
  console.log('失败的断言：...')
  process.exit(1)              // ← 非零退出
}
```

**实际运行结果**：`通过: 38，失败: 0`

---

## 三、本批新发现的缺陷

### 缺陷：git 输出 trim 导致文件末尾换行丢失

**现象**：E2E 的「导出内容等于快照内容」失败：

```
actual:   "这是端到端测试用的固定文件内容。\n第二行用于验证读取完整。"
expected: "这是端到端测试用的固定文件内容。\n第二行用于验证读取完整。\n"
```

差一个末尾换行。

**根因**：`SnapshotManager.git()` 无条件 `.trim()` 所有命令输出。`git show` 返回的文件内容被 trim 了。

**影响**：
- 快照读回的内容与原始文件不一致
- 内容哈希校验必然失败
- 导出/应用的文件缺末尾换行

**修复**：`git()` 增加 `raw` 选项，`readFileAt()` 使用 `raw: true`。

```ts
return opts.raw ? stdout : stdout.trim()
```

**验证**：
```
原始: "line1\nline2\n"
读回: "line1\nline2\n"
一致: true
```

**新增回归测试（2 条）**
- 读取文件时保留末尾换行 ✅
- 读取文件时保留前导空白与空行 ✅

**这条修复的意义**：如果没有 E2E 的强断言，这个 bug 会一直存在——因为单元测试里用的都是 `'content'` 这种没有末尾换行的字符串。

---

## 四、测试结果

```
Test Files  11 passed (11)
Tests       116 passed (116)
```

**测试数量变化**：

| 阶段 | 测试数 |
|---|---|
| 第一批修复前 | 90 |
| 第一批修复后 | 103 |
| 第二批修复后 | **116** |

**新增测试分布**：
- 混合规则回归：5
- 审计绑定：2
- 跨对象归属：2
- unknown 立即停止：2（原 1 条改为 2 条更严格的）
- maxCycles：1
- EOL 保留：2

---

## 五、E2E 验证输出（完整）

```
0 · 准备 fixture
  ✅ fixture 文件已创建
  ✅ fixture 内容正确

1 · Producer Run 与产物
  ✅ Run 完成
  ✅ 产物数量 > 0（实际 3）
  ✅ 存在 readme.txt 产物
  ✅ 产物状态是 candidate
  ✅ 产物版本是 1
  ✅ 产物记录了 contentHash
  ✅ contentHash 与文件内容一致
  ✅ 拍了 1 个快照
  ✅ 快照标记为可复现
  ✅ Task 进入 awaiting_acceptance

2 · 验收门：未审计不可接受
  ✅ 未审计时验收被拒绝
  ✅ 拒绝原因提到审计

3 · 审计
  ✅ 审计结果合法（passed）
  ✅ 返回了审计记录
  ✅ 至少检查了 3 条规则
  ✅ 审计结果包含 binding
  ✅ binding 覆盖当前产物
  ✅ binding 的 runId 正确
  ✅ binding 的 snapshotId 正确

4 · 同族模型隔离
  ✅ 同族模型降级为 escalate
  ✅ escalate 原因正确

5 · 审计前置条件
  ✅ 未完成的 Run 不能审计

6 · 验收与交付
  ✅ 审计通过后允许验收
  ✅ 验收成功
  ✅ Task 变为 accepted
  ✅ 接受后还没有交付记录
  ✅ 导出成功
  ✅ 记录了导出路径
  ✅ 导出文件真实存在
  ✅ 导出内容等于快照内容
  ✅ 导出文件 hash 与产物一致
  ✅ 交付记录与接受记录分开

7 · 跨对象归属校验
  ✅ 用别的 Task 的 id 验收被拒绝

8 · Cycle 记录
  ✅ 创建了 1 个 Cycle
  ✅ Cycle 状态推导正确（passed）
  ✅ 审计结果已持久化

汇总
  通过: 38
  失败: 0
```

---

## 六、仍未修复（第三批）

**这批全部来自审计报告，本次未处理：**

| # | 问题 | 说明 |
|---|---|---|
| 1 | `scope=once` Grant 恢复路径未可靠消耗 | 需要条件原子更新 |
| 2 | Grant 使用不是条件原子更新 | 并发问题 |
| 3 | `autoApprove` 仍由 HTTP 请求体控制 | 安全边界 |
| 4 | 本地 HTTP API 无认证 | 需先定 localhost-only 策略 |
| 5 | 普通工具执行与 `resultConsumed` 之间的副作用重复窗口 | 需要 Intent 模型 |
| 6 | `maxCycles` 并发创建无事务/唯一约束 | 并发问题 |
| 7 | 快照 `--force` 可能绕过排除规则 | 需验证 |
| 8 | Auditor 仍不是独立 Run | 设计选择，需文档澄清 |
| 9 | 审计结果仍不能完整回放 | 需要 Evidence Bundle |
| 10 | 路径测试仍有静默跳过风险 | 需重构测试输出 |

**另外，第一批遗留的：**
- 调用前预算预留（reservation 字段）
- `TaskUsage.cycles` 在并发场景下的正确性

---

## 七、当前状态的准确描述

**不能说「P0/P1-A 已完整实现」，也不能说「已可最终送审」。**

准确描述：

> 第一批修复使测试从 90 增至 103，修掉了 `apply()` 假成功、导出读错源、工具历史丢失、unknown 收束保护、部分预算逻辑。
>
> 第二批修复使测试从 103 增至 116，修掉了**审计门 fail-open**（我上一版误判为「不成立」）、审计与产物的绑定缺失、unknown 只阻完成不阻执行、跨对象归属校验缺失、`maxCycles` 未执行、以及一个 **git 输出 trim 导致的内容损坏**。
>
> **仍不具备最终送审条件**：并发安全（Grant / Cycle 创建 / 审批更新）、本地 HTTP 认证、副作用幂等的 Intent 模型、审计回放能力都还未完成。

---

## 八、关于我上一版的判断错误

**我上一版写「审计批评不成立」，是因为测试覆盖不足就下了结论。**

这是方法论上的错误：**测试通过 ≠ 反例已覆盖**。

审计指出的反例（weak pass + strong uncertain）是一个我完全没想到的组合。我只想到了「全 uncertain」和「全 strong」两个极端，没想中间状态。

**教训**：对于「规则合并」这类逻辑，必须枚举状态组合，而不是只测边界。5 种新回归测试就是按这个思路补的。

---

## 九、复现方式

```bash
cd G:\AI\ai-workstation
npm run typecheck       # 应无输出
npm test                # 应为 116 passed

# 端到端（需要干净端口）
DATA_DIR=./.e2e/data WORKSPACE=./.e2e/workspace PORT=4801 npm run dev
# 另开终端
node scripts/e2e-reviewloop.mjs 4801    # 应为 38 passed, 0 failed
```

**注意**：如果之前有服务占用端口，必须先杀掉。旧服务会让 E2E 跑在旧代码上，产生误导性结果——本次修复过程中就遇到过这个问题。
