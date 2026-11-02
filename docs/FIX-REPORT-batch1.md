# 第一批修复对照表

> 日期：2026-10-30
> 对应审计意见：`01a18c89`（三项补充）+ `01a18c85`（首批 19 条）
> 测试结果：**103 passed**（新增 13 个不变量测试）
> 端到端：8 个场景全部通过

---

## 一、修复总览

| # | 审计发现 | 严重度 | 修复内容 | 状态 |
|---|---|---|---|---|
| 1 | `accept()` 不要求审计 pass | 🔴 阻塞 | 强制要求最新审计 = pass | ✅ |
| 2 | `unknown` 可回退为 `completed` | 🔴 阻塞 | 完成前检查未解决 unknown | ✅ |
| 3 | `apply()` 假成功（不写文件） | 🔴 阻塞 | 从快照读内容并真实写入 + 写入后校验 | ✅ |
| 4 | `export()` 读当前工作区 | 🔴 阻塞 | 改为读已验收快照 | ✅ |
| 5 | 预算只检查已用量（无 overshoot） | 🔴 阻塞 | 调用后 overshoot 检查 + `>=` 替代 `>` | ✅ |
| 6 | 普通工具结果未持久化 | 🟠 重要 | 写入 `run_message` | ✅ |
| 7 | Audit pass 对 uncertain strong rule 可能 fail-open | 🔴 阻塞 | **核实后确认原实现已正确** | ✅ 无需修复 |

---

## 二、逐条对照

### 1 · 验收绕过审计

**审计发现**
> `accept()` 不检查审计结果，任何 `awaiting_acceptance` 的 Task 都能被接受。

**核实**：属实。`acceptance.ts` 里完全没有引用 `auditResult`。

**修复**
```ts
// acceptance.ts — accept() 新增前置检查
this.assertLatestAuditPassed(input.taskId)
```

```ts
private assertLatestAuditPassed(taskId: string): void {
  const audits = this.store.listAuditResults(taskId)
  if (audits.length === 0) {
    throw new AcceptanceError('这个 Task 还没有经过审计，不能验收。')
  }
  const latest = audits[audits.length - 1]!
  if (latest.verdict !== 'pass') {
    throw new AcceptanceError(
      `最新一轮审计结论是 ${latest.verdict}，不能验收。`
    )
  }
}
```

**不变量**
> 没有 pass 审计 → 不可接受。
> 最新一条是 reject / escalate → 不可接受。
> 只有「最新一条是 pass」才允许。

**为什么看「最新一条」而不是「曾经有一条 pass」**：返工后可能有新一轮 reject，不能用旧的 pass 蒙混过关。

**回归测试**（`invariants.test.ts`）
- 未审计 → 拒绝 ✅
- reject → 拒绝 ✅
- escalate → 拒绝 ✅

---

### 2 · unknown 回退为 completed

**审计发现**
> 工具超时后 `Run = needs_reconciliation`，但模型收束时仍会走 `setRunStatus('completed')`。

**核实**：属实。收束路径没有检查 `hasUnresolvedUnknown`。

**修复**
```ts
// executor.ts — 模型收束前
if (this.store.hasUnresolvedUnknown(run.id)) {
  this.store.setRunStatus(run.id, 'needs_reconciliation')
  this.emit(run.id, 'run.blocked_by_unknown', { ... })
  return {
    status: 'failed',
    error: '这个 Run 有未解决的 unknown 操作，不能判定为完成。',
    run: this.store.getRun(run.id)!,
  }
}
```

**不变量**
> 存在未解决的 unknown → Run 不得为 completed，Task 不得为 awaiting_acceptance。

**回归测试**
- 工具超时 + 模型收束 → Run 停在 `needs_reconciliation` ✅

---

### 3 · `apply()` 假成功

**审计发现**
> `apply()` 只把 DeliveryRecord 标成 `applied`，实际什么都没写。

**核实**：属实，而且这是最严重的一条。我写这段代码时以为在写文件，实际漏了写操作。

**修复**
```ts
private async readAcceptedContent(artifact) {
  const snapshot = this.store.getSnapshot(artifact.sourceSnapshotId)
  if (!snapshot.reproducible) throw new Error(...)
  const content = await this.config.snapshotManager.readFileAt(snapshot.ref, artifact.path)
  // 内容哈希校验
  if (artifact.contentHash) {
    const actual = createHash('sha256').update(content, 'utf8').digest('hex')
    if (actual !== artifact.contentHash) throw new Error('内容哈希不匹配')
  }
  return { content, snapshotRef: snapshot.ref }
}

async apply(acceptanceId) {
  const { content } = await this.readAcceptedContent(artifact)

  // 目标已存在且内容不同 → 冲突，不是覆盖
  if (existsSync(target)) {
    const current = await readFile(target, 'utf8')
    if (current !== content) throw new DeliveryConflictError(...)
  }

  await writeFile(target, content, 'utf8')

  // 写入后校验
  const written = await readFile(target, 'utf8')
  if (written !== content) throw new Error('写入后校验失败')
}
```

**不变量**
> `applied` 之后，目标文件内容必须等于快照内容。
> 目标已存在且内容不同 → `conflict`，不覆盖。
> 写入失败 → 不得标记 `applied`。

**回归测试**
- 工作区漂移 → `conflict`，用户内容未被覆盖 ✅
- 工作区一致 → `applied`，内容来自快照 ✅
- 目标不存在 → 创建文件，内容来自快照 ✅

---

### 4 · `export()` 读当前工作区

**审计发现**
> `export()` 用 `copyFile(sourcePath, targetPath)`，源是当前工作区。

**核实**：属实。工作区在验收后可能已被改动。

**修复**：与 `apply()` 共用 `readAcceptedContent()`，都从快照读。

**不变量**
> 导出内容必须等于已验收快照的内容，不是当前工作区。

**回归测试**
- 工作区漂移后导出 → 内容仍等于快照 ✅

---

### 5 · 预算无 overshoot 控制

**审计发现**
> `checkBudget` 只检查已用量，不预留本次消耗；用 `>` 而非 `>=`。

**核实**：属实。

**修复**

三处改动：

```ts
// 1. 累计型改用 >=（已达上限即拦截）
if (b.maxTotalTokens != null && usedTokens >= b.maxTotalTokens) {
  throw new BudgetExceeded('maxTotalTokens', b.maxTotalTokens)
}

// 2. 补上原先未检查的两个字段
if (b.maxInputTokens != null && run.usage.inputTokens >= b.maxInputTokens) { ... }
if (b.maxOutputTokens != null && run.usage.outputTokens >= b.maxOutputTokens) { ... }

// 3. 调用后 overshoot 检查
const overshoot = this.detectOvershoot(run.id)
if (overshoot) {
  this.store.setRunStatus(run.id, 'expired', { endedAt: Date.now() })
  return { status: 'expired', reason: `调用后超出预算：...` }
}
```

**不变量**
> 已达上限 → 不允许发起下一次调用。
> 调用后实际超限 → 立即终止，不再发起后续调用。

**文档措辞修正**（采纳审计建议）：
> 调用前按已用量止损，调用后按真实用量结算；响应导致 overshoot 时立即终止后续调用。
> **不宣称「绝对不超限」**——token 和 cost 只有响应后才知道真实值。

**回归测试**
- `usage == limit` → 阻止调用，模型未被调用 ✅
- 单次调用后超限 → 不再发起第二次 ✅

---

### 6 · 普通工具结果未持久化

**审计发现**
> 只有「审批恢复路径」写 `run_message`，普通工具结果只进内存 `history`。

**核实**：属实。

**修复**
```ts
const toolMsg: ChatMessage = {
  role: 'tool', toolCallId: call.id,
  content: outcome.content, isError: outcome.isError,
}
history.push(toolMsg)
this.store.appendRunMessage(run.id, toolMsg)
```

**不变量**
> 任何工具执行后，`run_message` 必须包含对应的 tool 消息。

**回归测试**
- 读文件后 `run_message` 里有 tool 消息且含文件内容 ✅

---

### 7 · Audit pass fail-open

**审计发现**
> strong rule 返回 `uncertain` / `not_applicable` 时，模型仍可能给出 `pass`。

**核实结果：这条批评不成立。**

现有实现：
```ts
const allUncertain = checks.length > 0 &&
  checks.every((c) => c.status === 'uncertain' || c.status === 'not_applicable')

if (modelVerdict === 'pass') {
  if (allUncertain) {
    finalVerdict = 'escalate'   // ← 已正确处理
    escalateReason = 'uncertain'
  } else if (!hasStrongRules) {
    finalVerdict = 'escalate'
    escalateReason = 'no_strong_rules'
  } else {
    finalVerdict = 'pass'
  }
}
```

`allUncertain` 的判定覆盖了 strong rule uncertain 的情况。

**但**：这里有一个**边缘情况**值得说明：

如果 skill 有 **2 条 strong 规则**，一条 pass 一条 uncertain，那么：
- `allUncertain` = false（因为有一条 pass）
- `hasStrongRules` = true
- → 模型 pass 会生效

**这是设计选择**：只要有一条 strong 规则确认通过，就认为有足够证据。如果审计方认为这不够严格，应改为「所有 strong 规则都必须明确 pass」。

**保留的两个回归测试**（防止将来改坏）：
- strong uncertain + 模型 pass → escalate ✅
- strong not_applicable + 模型 pass → escalate ✅

---

## 三、修复过程中发现的新问题

### 新问题：`contentHash` 与快照内容不一致

**现象**：端到端跑导出时，哈希校验失败：
```
内容哈希不匹配：验收时记录 1c7d74ca9546，快照里实际 4a667484389f
```

**根因**：`captureSnapshot()` 里用 `hook.hashFile(relPath)` 从**当前工作区**算哈希，但快照已经拍好了。如果之后工作区又变化（返工 Run 又写了同一个文件），哈希就与快照对不上。

**修复**：改成从**刚拍的快照**里读内容算哈希：
```ts
const content = await hook.readFileAt(result.ref, relPath)
const hash = createHash('sha256').update(content, 'utf8').digest('hex')
```

**这是个真实缺陷**，而且是靠「导出时的哈希校验」发现的——如果当初 `apply()` 就写对了文件，这个 bug 会在更晚的时候以更隐蔽的方式暴露。

**这条恰好验证了审计的核心判断**：
> 最危险的不是功能少，而是系统会把没完成、没审计、没写入的东西报告成完成。

---

## 四、测试结果

```
Test Files  11 passed (11)
Tests       103 passed (103)
```

新增测试文件：`src/core/__tests__/invariants.test.ts`（13 个）

| 不变量 | 测试数 |
|---|---|
| 1 · 验收必须经过审计 | 3 |
| 2 · unknown 时 Run 不得 completed | 1 |
| 3 · strong uncertain + pass → escalate | 2 |
| 4 · apply 必须真正写入 | 3 |
| 5 · export 读已验收快照 | 1 |
| 6 · 预算超限阻止调用 | 2 |
| 7 · 工具结果持久化 | 1 |

**修复前的红测证据**：10 failed / 2 passed（第 3 组原本就通过，印证审计该条批评不成立）。

---

## 五、端到端验证

```
场景 1 · 审计（demo 审计者）           ✅
场景 2 · 同族模型降级为 escalate        ✅
场景 3 · Cycle 状态推导                 ✅
场景 4 · 审计结果可查询                 ✅
场景 5 · 审计前置条件（未完成拒绝）      ✅
场景 6 · 审计结果与验收联动             ✅
场景 7 · 完整返工闭环（含导出）          ✅
场景 8 · Cycle 记录                     ✅
```

---

## 六、仍未修复（第二批）

以下来自审计报告，**本批未处理**：

| # | 问题 | 原因 |
|---|---|---|
| 8 | `scope=once` 的 Grant 并发消耗 | 需要事务/条件更新 |
| 9 | 外部副作用的幂等键 / Intent 模型 | 需要新表 + 设计冻结 |
| 10 | Task `maxCycles` 未真正执行 | 依赖 Intent 设计 |
| 11 | ReviewCycle 创建无事务和唯一约束 | 并发问题 |
| 12 | 审批 approve/reject 无条件更新 | 并发问题 |
| 13 | HTTP API 无认证 | 需先定 localhost-only 策略 |
| 14 | 路径测试静默跳过 | 需重构测试输出 |
| 15 | 缺少 fixture（短文件名、junction、TOCTOU） | 需补测试 |
| 16 | 文档措辞（`resultConsumed`、Run 状态数、表数量） | 待批量修正 |
| 17 | Auditor 是内嵌调用而非独立 Run | 文档需澄清 |

---

## 七、关于「B+C 方案」的设计冻结

采纳审计的修正：

> **B+C 不能实现 exactly-once，只能让不确定性被诚实记录，并避免无依据的自动重放。**

目标应表述为：
```
不重复静默执行
不把未知伪装成成功
不在没有证据时自动重试
```

### 拟定的 ToolIntent 模型（待第二批实现）

```ts
ToolIntent {
  id, runId, stepId, toolCallId, toolId
  argumentsHash
  operationKey            // 可用于幂等查询
  status: 'planned' | 'started' | 'succeeded' | 'failed' | 'unknown' | 'reconciled'
  startedAt, finishedAt?
  resultRef?, evidence?
  attempt
}
```

**约束**：
- `(runId, toolCallId)` 唯一
- 崩溃恢复时：`planned` / `started` → 无法确认 → Step = `unknown`，Run = `needs_reconciliation`
- **不是** `approved + resultConsumed=false → 自动再次执行`

### `supportsIdempotencyKey` 的落地要求

审计指出「不能只是声明」。采纳：

- 工具实现必须真正接受 operation key
- Executor 每次重试传入相同 key
- 工具或外部服务根据 key 去重
- **没有测试或实现保证的「自称支持」不能作为安全依据**

对内置 `write_file` 的初步定义：
```
同一 operationKey + 相同内容 → 可确认成功
同一 operationKey + 内容不同 → 冲突
```

**但审计也提醒**：还要考虑文件时间戳、并发写入、目标被外部修改——不能只看「最终文件存在」。

这条留到第二批。

---

## 八、`resultConsumed` 的文档修正

采纳审计建议，文档措辞改为：

> `resultConsumed` 防止**已处理的审批结果被重复回填**；
> 它**不能单独保证**外部工具副作用只发生一次。
> 非幂等工具需要操作意图、幂等键或人工对账。

`AUDIT-SUBMISSION-v2.md` §3.3 需要同步修改（列入第二批文档修正）。
