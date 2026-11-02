# AI 工作站 · 系统设计文档

> 版本：v0.1（对应代码 4117 行，24 个测试通过）
> 本文描述**已经实现的部分**。规划中但未实现的内容在文末单独标注。

---

## 一、定位

一个有状态、可审批、可恢复、可追溯的本地 AI 工作站。

**不是聊天客户端。** 聊天只是它的入口。它的终点是一个可验收的产物。

当前版本实现的是**执行内核**：从「模型决定做什么」到「工具真的做了」再到「全过程可查」这条链路。审计回路和产物版本化尚未实现。

---

## 二、核心设计原则

### 原则 1 · 状态必须诚实

工具超时后，系统**不知道**操作到底成没成。这时状态是 `unknown`——不是 `failed`，也不是 `completed`。

这是整个系统的可信度基石。伪装成任一极端都是撒谎。

### 原则 2 · 单一写者

只有 `RunExecutor` 能修改 Run / Step / Approval。工具本身只返回结果。

这保证了「谁在什么时候把 Run 改成 completed」永远有唯一答案。

### 原则 3 · 工具不拥有状态

`ToolImpl.run()` 的签名里没有 store，没有 runId。它在类型层面就无法改状态。

---

## 三、分层架构

```
┌──────────────────────────────────────────────────────────┐
│  server/index.ts         HTTP 接口（薄层，业务逻辑不在此）  │
├──────────────────────────────────────────────────────────┤
│  core/executor.ts        RunExecutor —— 唯一状态权威       │
│  core/tools.ts           工具注册表 + 内置工具             │
│  core/paths.ts           路径校验 + 参数哈希               │
│  core/prompt.ts          上下文整理 / token 估算 / 截断     │
│  core/sse.ts             SSE 解码器（状态机实现）          │
│  core/store.ts           SQLite 持久化（单写者）           │
├──────────────────────────────────────────────────────────┤
│  providers/              适配器（openai / anthropic / demo）│
│  shared/types.ts         领域类型                          │
└──────────────────────────────────────────────────────────┘
```

**关键约束**：`server` 层将来会被替换成 Electron IPC，`core` 层不依赖任何传输方式。

---

## 四、数据模型

### 4.1 对象关系

```
Workspace（= 环境变量 WORKSPACE，是安全边界，非数据库对象）
  └── Session
        ├── Message
        └── Task
              └── Run
                    ├── RunMessage   （Run 的工作历史，必须持久化）
                    ├── Step
                    │     └── StepTrace
                    ├── Grant
                    └── Approval
```

### 4.2 表结构

| 表 | 作用 | 关键字段 |
|---|---|---|
| `meta` | schema 版本 | `key`, `value` |
| `session` | 会话 | `id`, `title` |
| `message` | 会话消息 | `id`, `session_id`, `role`, `content` |
| `task` | 任务 | `id`, `session_id`, `goal`, `status` |
| `run` | 一次执行 | `id`, `task_id`, `role`, `status`, `budget`, `usage` |
| `run_message` | **Run 工作历史** | `run_id`, `seq`, `payload` |
| `step` | 执行步骤 | `id`, `run_id`, `idx`, `kind`, `status`, `trace` |
| `grant` | 授权 | `id`, `run_id`, `tool_id`, `constraints`, `used_calls` |
| `approval` | 审批 | `id`, `tool_call_id`, `result_consumed` |
| `denied` | 拒绝记录 | `run_id`, `tool_id`, `argument_hash` |
| `artifact` | 产物 | **已建表，尚未写入** |
| `event` | 事件流 | `run_id`, `kind`, `payload` |

### 4.3 为什么需要 `run_message`

这是踩过坑才加的表。

Run 暂停后恢复时，如果从初始消息重新开始，模型会看不到自己刚发出的 `tool_call`，也看不到工具结果。这时发给 API 的序列是「assistant 带 tool_calls，但没有对应的 tool 消息」——**大多数 API 会直接判定为非法请求并报错**。

所以 Run 的完整工作历史必须落盘，恢复时接着上次继续。

---

## 五、状态机

### 5.1 Run 状态

```
         ┌─────────┐
         │ queued  │
         └────┬────┘
              │ execute()
              ▼
         ┌─────────┐  需要审批    ┌─────────┐
         │ running │◄────────────►│ paused  │
         └────┬────┘  批准/拒绝    └─────────┘
              │
     ┌────────┼────────┬──────────┬───────────┐
     ▼        ▼        ▼          ▼           ▼
┌─────────┐┌──────┐┌─────────┐┌──────────┐┌─────────┐
│completed││failed││cancelled││  expired ││ (循环)  │
└─────────┘└──────┘└─────────┘└──────────┘└─────────┘
```

| 状态 | 含义 |
|---|---|
| `queued` | 已创建，未执行 |
| `running` | 执行中 |
| `paused` | 等待审批 |
| `completed` | 模型正常收束 |
| `failed` | 明确失败（模型报错、轮数耗尽） |
| `cancelled` | 用户取消 |
| `expired` | 预算超限 |

### 5.2 Step 状态

| 状态 | 含义 | 谁会进入这个状态 |
|---|---|---|
| `pending` | 已创建未执行 | — |
| `running` | 执行中 | llm / tool |
| `waiting_approval` | 等待审批 | approval |
| `completed` | 成功 | 全部 |
| `failed` | 明确失败 | 全部 |
| `rejected` | 用户拒绝 | tool / approval |
| `skipped` | 明确跳过 | — |
| `cancelled` | 被取消 | tool |
| **`unknown`** | **请求中断，无法确认外部操作是否已发生** | **tool** |

`unknown` 只在工具超时时出现。它不能显示成功，也不能自动重试。

---

## 六、执行流程

### 6.1 主循环

```
execute(runId)
  │
  ├─ 1. 状态 → running，记录 run.started 事件
  │
  ├─ 2. 载入历史
  │     ├─ run_message 有记录 → 用它（恢复场景）
  │     └─ 无记录 → 用传入的初始消息，并落盘
  │
  ├─ 3. 回填未消费的审批结果
  │     ├─ rejected → 生成 tool 消息（含拒绝原因）
  │     └─ approved → 现在才真正执行工具
  │
  └─ 4. 工具循环（最多 maxToolRounds 轮）
        │
        ├─ 检查预算（steps）
        ├─ 裁剪上下文（fitToBudget）
        ├─ 创建 llm Step
        ├─ 调用模型（流式）
        ├─ 记录 Trace（首字延迟 / token / 成本）
        │
        ├─ 无 tool_calls？
        │    └─ 是 → 记录 assistant 消息，Run = completed，返回
        │
        └─ 有 tool_calls？
             └─ 对每个 call：
                  ├─ 工具不存在 → 返回可重试错误给模型
                  ├─ JSON 解析失败 → 返回可重试错误
                  ├─ schema 校验失败 → 返回可重试错误
                  ├─ 命中拒绝去重 → 返回「已拒绝」给模型
                  ├─ 无 Grant 且非自动放行
                  │    └─ 创建 approval Step，Run = paused，返回
                  ├─ 检查预算（toolCalls）
                  ├─ 创建 tool Step，执行（带超时）
                  ├─ 超时 → Step = unknown，返回「结果未知」给模型
                  ├─ 成功/失败 → 截断输出，返回结果给模型
                  └─ 追加 tool 消息到历史
```

### 6.2 关键位置

| 位置 | 说明 |
|---|---|
| `executor.ts` 主循环 | 第 166 行起 |
| 工具执行 | `runTool()` |
| 恢复时执行已批准工具 | `executeApprovedTool()` |
| 超时对账建议 | `reconcileAdvice()` |

---

## 七、工具协议

### 7.1 ToolDefinition

```ts
{
  id: string
  name: string
  description: string
  inputSchema: JSONSchema
  source: 'builtin' | 'mcp'
  riskLevel: 'read' | 'write' | 'external'
  enabled: boolean
  timeoutMs: number
  maxOutputBytes: number
  reconcile: {
    idempotent: boolean       // 幂等 → 超时后可安全重试
    queryToolId?: string      // 有查询工具 → 先查外部真实状态
    unsafeToRetry: boolean    // 不安全 → 必须人工裁决
  }
}
```

### 7.2 风险等级与审批

| 等级 | 审批行为 | 内置工具 |
|---|---|---|
| `read` | **自动放行** | `read_file`, `list_dir` |
| `write` | 需要审批 | `write_file` |
| `external` | 需要审批 | （暂无） |

`autoApprove` 参数可以让调用方在本次 Run 内免除指定工具的审批。

### 7.3 超时后的对账

超时 → Step = `unknown` → 按 `reconcile` 声明给模型建议：

```
queryToolId 存在  → 「建议先用 X 查询外部真实状态，再决定是否重试」
unsafeToRetry     → 「这个操作不安全重试，必须由人工确认」
idempotent        → 「这个操作是幂等的，可以安全重试一次」
都没有            → 「无法判断是否可以重试，建议由人工确认」
```

模型收到的文本固定以「结果未知」开头，并明确告知**不要假设成功，也不要盲目重试**。

---

## 八、审批与 Grant

### 8.1 流程

```
工具请求
  → 查有效 Grant（同 tool_id + active + 未过期 + 未超次数）
  → 有 → 直接执行
  → 无 → 是 read 或在 autoApprove 里？
          → 是 → 直接执行
          → 否 → 创建 approval Step + Approval 记录
                  → Run = paused
                  → 等待用户决定
```

### 8.2 Grant

```ts
{
  id, runId, toolId
  constraints: { maxCalls?, allowedPaths?, allowedHosts?, maxBytes? }
  expiresAt: number       // 默认 1 小时
  status: 'active' | 'revoked' | 'expired'
  usedCalls: number
}
```

**授权绑定到单次 Run。** 不能因为某个工具曾经被批准，就永久允许后续任务使用。

`scope: 'once'` → `maxCalls: 1`
`scope: 'run'` → `maxCalls: 50`

### 8.3 拒绝去重

```
同一 Run + 同一工具 + 相同参数（稳定哈希）
→ 命中 denied 表
→ 直接阻断，不重复创建审批
→ 返回给模型：「这个操作之前被你拒绝过，原因：…」
```

参数哈希会**对键排序**，避免 `{a,b}` 和 `{b,a}` 被当成不同请求。

### 8.4 `result_consumed` 标志

这是容易漏掉的一个设计。

审批被批准/拒绝后，结果需要回填进 Run 历史。但如果回填后又崩溃，重新恢复时不能重复执行工具（尤其是写操作）。

所以 Approval 有 `result_consumed` 字段：只有结果真正写入历史后，才标记为已消费。

---

## 九、上下文预算

### 9.1 估算

```
CJK 字符 → 1 token/字
其他字符 → 4 字符/token
× 保守系数 1.15
```

**永远不要把这个数字当精确值展示。** UI 上必须写「约 12.4k」。

### 9.2 裁剪策略

`fitToBudget(messages, budget)`：

1. 分离 system 消息（永不丢弃）
2. 找到最后一条 user 消息，它之后的内容全部保留
3. 从剩余消息的尾部往前装，装到预算为止
4. **修复成对关系**：
   - 保留区开头是 `tool` 消息 → 丢弃（它的 assistant 来源不在）
   - 保留区末尾是带 `tool_calls` 的 assistant → 丢弃（它的 tool 结果被丢了）

第 4 步是必须的。留下「有调用无结果」的序列会被 API 拒绝。

### 9.3 工具输出截断

超过 `maxOutputBytes` 时，保留头 65% + 尾 35%，中间标记丢弃字节数。

保留尾部的原因：错误信息和总结通常在末尾，比开头的日志更有价值。

截断信息记录在 `StepTrace.truncation`，包含原始大小、保留大小、原因。

---

## 十、安全

### 10.1 路径校验

`isPathAllowed(requested, allowedRoots)` 的检查顺序：

```
1. allowedRoots 为空 → 拒绝
2. UNC 前缀（\\ 或 //）→ 拒绝   ← 必须在 realpath 之前
3. realpath 解析（跟随符号链接）
4. 再次检查 UNC
5. Windows：转小写 + 统一分隔符
6. 按路径段比对（不是字符串前缀）
```

**第 2 步的位置很关键。** `realpathSync('\\\\server\\share')` 会发起网络请求，攻击者用一个不存在的服务器就能把执行器卡住。实测未修复时耗时 2289ms，修复后 76ms。

必须防住的六种攻击：

| 攻击 | 防护 |
|---|---|
| 路径穿越 `../../` | realpath 解析 |
| 符号链接逃逸 | realpath 解析 |
| Windows 大小写 | 统一转小写 |
| 短文件名 `PROGRA~1` | realpath 解析 |
| UNC 路径 | 前缀拦截 |
| 前缀假阳性 `/allowed` vs `/allowed-evil` | 按路径段比对 |

### 10.2 工具输出视为不可信数据

工具返回的内容可能包含「忽略之前的所有指令」这类注入文本。

当前实现：工具结果作为 `tool` 角色消息传递，不与 system 消息混合。

**尚未实现**：显式的注入检测。这是待办项。

---

## 十一、可观测性

### 11.1 StepTrace

```ts
{
  firstTokenMs?, totalMs?
  inputTokens?, outputTokens?
  costUsd?              // 价格未知时为 undefined，不猜
  servedBy?             // 实际作答模型（与请求不同时）
  toolName?, toolLatencyMs?
  retryCount?
  truncation?: { originalBytes, keptBytes, reason }
}
```

### 11.2 事件流

每个 Run 记录完整事件序列，可顺序回放：

```
run.started
tool.done
approval.approved / approval.rejected
approval.result
tool.unknown
run.completed / run.failed / run.cancelled / run.expired
```

### 11.3 用量累计

Run 上有 `usage`，每次模型调用和工具调用后累加：

```ts
{ inputTokens, outputTokens, steps, toolCalls, costUsd }
```

---

## 十二、适配器层

### 12.1 接口

```ts
interface ProviderAdapter {
  stream(request: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>
}

interface StreamHandlers {
  onText(delta: string): void
  onReasoning(delta: string): void      // 推理内容独立通道
  onToolCallDelta?(index, id, name, argsDelta): void
}
```

### 12.2 两个协议的关键差异

| 项 | OpenAI | Anthropic |
|---|---|---|
| system | 消息数组第一条 | 顶层字段 |
| 工具结果 | `role: 'tool'` 消息 | `user` 里的 `tool_result` block |
| 同角色连续 | 允许 | **会报错，必须合并** |
| 工具参数流 | `delta.tool_calls[].function.arguments` 拼接 | `input_json_delta` 按 block index 累积 |
| 认证头 | `Authorization: Bearer` | `x-api-key` |

### 12.3 可注入的适配器解析器

`RunExecutor` 构造时接受 `adapterResolver`，默认按 `provider.kind` 取内置适配器。

这让测试可以注入假模型，也让将来接入 MCP 或 CLI 时能复用同一套执行器。

### 12.4 演示模型

`demo.ts` 是一个不需要密钥的适配器，按用户输入意图决定是否发起工具调用。

它**真的会调工具**，所以新人第一次打开就能看到审批、Trace 这些核心能力，而不是只看到一段文字。

---

## 十三、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回工作区路径 |
| GET/POST | `/sessions` | 会话列表 / 创建 |
| GET | `/sessions/:id/messages` | 会话消息 |
| GET/POST | `/tasks` | 任务列表 / 创建 |
| GET | `/tasks/:id` | 任务详情（含所有 Run） |
| POST | `/runs` | 创建 Run |
| GET | `/runs/:id` | Run 详情（Step / 审批 / 事件 / 产物） |
| POST | `/runs/:id/execute` | 执行 Run |
| POST | `/runs/:id/cancel` | 取消 Run |
| GET | `/approvals?status=` | 审批列表 |
| POST | `/approvals/:id/approve` | 批准（`scope`: once \| run） |
| POST | `/approvals/:id/reject` | 拒绝（带原因） |
| GET | `/tools` | 工具列表 |

---

## 十四、已验证行为

24 个测试，覆盖 SPEC 的固定验收用例：

| 用例 | 内容 | 文件 |
|---|---|---|
| A | 只读工具自动执行，重启后可查询 | `case-a.test.ts` |
| B | 写工具被拒绝，去重生效，历史持久 | `case-b.test.ts` |
| C | 工具超时 → `unknown`，Run 不显示完成 | `case-c.test.ts` |
| H | 路径越权防护（14 个断言） | `paths.test.ts` |

端到端验证（`scripts/e2e.mjs`）五个场景全部通过：

```
读文件：llm → tool → llm                          completed
写文件：llm → approval(waiting)                    paused
批准后：llm → approval → tool → llm                completed
拒绝后：llm → approval(rejected) → llm             completed
去重：  同工具同参数再次请求，审批记录仍为 1 条
```

---

## 十五、已知缺口

### 15.1 有表但未接通

| 项 | 现状 | 影响 |
|---|---|---|
| `artifact` 表 | 建了，执行器从不写入 | `GET /runs/:id` 的 `artifacts` 永远为空 |
| `message` 表 | 建了，执行器不写 | `GET /sessions/:id/messages` 永远为空 |
| `maxInputTokens` / `maxOutputTokens` | 声明了，`checkBudget` 不检查 | 只有 `maxTotalTokens` 生效 |

### 15.2 完全未实现

| 项 | 说明 |
|---|---|
| **产物快照** | 审计无对象，是 ReviewLoop 的前置 |
| **ReviewLoop** | Producer / Auditor / Skill / 返工，核心差异化 |
| **注入检测** | 工具输出未做显式注入扫描 |
| **MCP 客户端** | 只有 3 个内置工具 |
| **知识库 / RAG** | — |
| **记忆** | — |
| **沙箱** | 工具跑在主进程，仅靠路径限制 |
| **工作流引擎** | — |
| **触发器** | — |
| **UI** | 只有 HTTP 接口 |
| **模型路由 / 降级 / 缓存** | — |
| **模型族隔离校验** | 评审补丁 1，未实现 |
| **verdict 只能否决** | 评审补丁 2，未实现 |

---

## 十六、下一步

按依赖顺序：

```
1. 产物快照 + Artifact 接通
   ├─ 内容寻址存储，增量快照
   ├─ 执行器在模型收束时自动拍快照
   └─ 顺带补上 message 投影

2. ReviewLoop 最小闭环
   ├─ Producer 跑完 → 拍快照 → 机器规则检查
   ├─ Auditor 审 → 结构化 verdict
   └─ pass / reject / escalate（先不做多轮返工）

3. 最小 UI
   └─ 会话 / Run 详情 / 审批中心
```

**为什么快照必须先做**：没有快照，审计对象是「还在变化的真实目录」，用例 D（审计可复现）在原理上无法通过。

---

## 附：许可证

Apache-2.0。第三方依赖全部为宽松许可（MIT / ISC / Apache-2.0 / BSD），无 copyleft 依赖。

架构思路参考了 Parallax（MIT）、Cline（Apache-2.0）、LangGraph（MIT）、OpenHands（MIT）、Temporal（MIT）。Cherry Studio（AGPL-3.0）仅参考产品交互，未使用任何代码。详见 `NOTICE`。
