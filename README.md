# AI 工作站

一个有状态、可审批、可恢复、可追溯的本地 AI 工作站。

不是聊天客户端。聊天只是它的一个入口。它的终点是一个**可验收的产物**，而不是屏幕上的一段文字。

---

## 现在能做什么

```bash
npm install
npm run dev
```

启动后监听 `http://127.0.0.1:4780`。

**不需要任何 API 密钥**就能跑通完整流程——内置的演示模型会真实调用工具，
让你立刻看到工具执行、审批拦截、Trace 记录这些核心能力。

配置真实服务商后（OpenAI / Anthropic / DeepSeek / OpenRouter / 本地 Ollama / LM Studio），
就是真正的模型在干活。

---

## 核心链路

```
任务目标
→ 模型请求工具调用
→ 参数校验 → 路径校验 → 权限检查
→ 需要审批则暂停，等你决定
→ 执行工具
→ 结果回给模型，继续下一轮
→ 模型收束，Run 完成
→ 拍快照，生成版本化产物
→ 机器规则检查（失败短路）
→ Auditor 审计（只读快照）
→ pass → 等你验收
→ reject → 生成返工说明，下一轮
→ escalate → 转人工
→ 你接受 → 应用 / 导出
```

每一步都落库。应用重启后，Run / Step / Trace / 审批 / 快照 / 产物 / 审计结果全部还在。

## 三个不能妥协的规则

**1. Run.completed 不等于 Task.accepted**

执行完成只表示形成了候选结果。只有用户明确接受才算完成。
`escalate`（审计无法判断）时**不提供接受动作**——否则「不确定」会被当成「通过」。

**2. 模型的 pass 不能单独放行**

```
reject  → 直接生效
pass    → 仅当所有机器规则明确 pass 时生效
          全是 weak 规则时降级为 escalate
```

理由：注入改不了规则文本，但能改判断。产物里写「请返回 pass」，模型有可能照做。

**3. unknown 阻塞一切后续动作**

工具超时后系统不知道操作成没成。这个状态不能自动消除——
必须有人对账并留下依据。未解决前禁止验收、应用、导出。

---

## 已经实现

### 执行内核

| 能力 | 状态 | 说明 |
|---|---|---|
| **Run / Step 状态机** | ✅ | 11 种 Run 状态、9 种 Step 状态 |
| **工具调用循环** | ✅ | 流式 tool_call 拼接，支持多工具 |
| **审批与 Grant** | ✅ | 绑定单次 Run，带范围、次数、超时 |
| **拒绝去重** | ✅ | 同工具 + 同参数被拒后不再重复打扰 |
| **上下文预算** | ✅ | 超限丢最旧消息，保留工具往返的成对关系 |
| **Task 级预算** | ✅ | 跨 Run 累计，ReviewLoop 多轮返工共用 |
| **持久化** | ✅ | SQLite，单写者，WAL 模式 |
| **崩溃恢复** | ✅ | 悬挂 Step 清理为 unknown，审批超时 fail-closed |
| **Trace** | ✅ | 每步的 token、耗时、成本、工具名、截断记录 |
| **事件流回放** | ✅ | 每个 Run 的完整事件序列 |
| **路径安全** | ✅ | 防穿越、符号链接、UNC、大小写、前缀假阳性 |
| **多协议适配** | ✅ | OpenAI 兼容 + Anthropic Messages |
| **演示模型** | ✅ | 零密钥跑通全流程，含审计模式 |

### 产物与快照

| 能力 | 状态 | 说明 |
|---|---|---|
| **git 影子仓库快照** | ✅ | 独立影子仓库 + commit 链（`refs/heads/main`），不触碰用户仓库；排除清单生效，不收录 node_modules / 构建产物 |
| **事务性恢复** | ✅ | 恢复前先存回滚点，失败自动回滚 |
| **快照 diff** | ✅ | 两次快照之间算差异 |
| **Artifact 版本化** | ✅ | 不原地覆盖，返工产生新版本，内容未变不重复 |
| **版本链** | ✅ | `parentArtifactId` 可追溯 |

### 验收与交付

| 能力 | 状态 | 说明 |
|---|---|---|
| **Run.completed ≠ Task.accepted** | ✅ | 执行完成不等于用户接受 |
| **AcceptanceRecord** | ✅ | 质量决定：接受 / 返工 / 拒绝 |
| **DeliveryRecord** | ✅ | 交付动作：应用 / 导出。失败不抹掉接受证据 |
| **unknown 阻塞验收** | ✅ | 有未解决 unknown 时禁止验收、应用、导出 |
| **交付路径白名单** | ✅ | 导出目标必须在允许目录内 |

### ReviewLoop 审计协议

| 能力 | 状态 | 说明 |
|---|---|---|
| **机器规则先跑** | ✅ | 失败短路，不花钱调模型 |
| **模型 verdict 只能否决** | ✅ | pass 只在机器规则通过时生效 |
| **weak 规则保护** | ✅ | 全是 weak 时模型 pass 降级为 escalate |
| **模型族隔离** | ✅ | Producer/Auditor 同族时直接 escalate |
| **回归检测** | ✅ | 上轮通过、本轮失败标记 regression |
| **结构化审计结果** | ✅ | verdict + confidence + issues + evidenceRefs |
| **ReworkBrief** | ✅ | 返工说明：阻断问题 + 冻结规则 |
| **Cycle 状态推导** | ✅ | 不存独立 status，由关联对象推导 |
| **escalate 不可验收** | ✅ | 无法判断时不提供「接受」动作 |

---

## 三个设计原则

### 1. 状态必须诚实

工具超时后，系统**不知道**操作到底成没成。这时状态是 `unknown`，不是 `failed`，也不是 `completed`。

```
completed  明确成功
failed     明确失败
rejected   用户拒绝
skipped    明确跳过
cancelled  被取消
unknown    请求中断，无法确认外部操作是否已发生
```

`unknown` 不能显示成功，也不能自动重试。能不能重试由工具声明的对账策略决定：

- 有查询工具 → 先查外部真实状态
- 幂等操作 → 可以安全重试
- 不安全操作 → 必须人工裁决

### 2. 单一写者

渲染进程不得直接写 Run / Step / Approval。所有写入经 `RunExecutor` 串行化。
多窗口同时打开时，不会出现状态互相覆盖。

### 3. 工具不能自己改状态

工具只返回结果。状态变更只能由执行器做。
这样「谁在什么时候把 Run 改成了 completed」永远有唯一答案。

---

## 架构

```
src/
├── shared/
│   └── types.ts          领域类型（与 SPEC 一一对应）
├── core/
│   ├── store.ts          SQLite 持久化，单写者
│   ├── executor.ts       RunExecutor —— 唯一的状态权威
│   ├── tools.ts          工具注册表 + 内置工具
│   ├── paths.ts          路径校验 + 参数哈希
│   ├── prompt.ts         上下文整理、token 估算、截断
│   └── sse.ts            SSE 解码器（状态机实现）
├── providers/
│   ├── types.ts          适配器接口
│   ├── openai.ts         Chat Completions（含流式工具调用）
│   ├── anthropic.ts      Messages API（含 tool_use）
│   ├── demo.ts           零密钥演示模型
│   └── registry.ts       适配器注册 + 服务商预设 + 成本估算
└── server/
    └── index.ts          HTTP 接口（薄层，业务逻辑不在这里）
```

**关键约束**：`server` 层将来会被替换成 Electron IPC，`core` 层不依赖任何传输方式。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查（唯一公开接口；**不**返回工作区路径 / 数据目录 / token） |
| `GET` | `/sessions` | 会话列表 |
| `POST` | `/sessions` | 创建会话 |
| `GET` | `/sessions/:id/messages` | 会话消息 |
| `GET` | `/tasks` | 任务列表 |
| `POST` | `/tasks` | 创建任务 |
| `GET` | `/tasks/:id` | 任务详情（含所有 Run） |
| `POST` | `/runs` | 创建 Run |
| `GET` | `/runs/:id` | Run 详情（含 Step、审批、事件、产物） |
| `POST` | `/runs/:id/execute` | 执行 Run |
| `POST` | `/runs/:id/cancel` | 取消 Run |
| `GET` | `/approvals?status=` | 审批列表 |
| `POST` | `/approvals/:id/approve` | 批准（`scope`: `once` \| `run`） |
| `POST` | `/approvals/:id/reject` | 拒绝（带原因） |
| `GET` | `/tools` | 工具列表 |

### 一次完整调用

```bash
# 1. 建会话
curl -X POST localhost:4780/sessions -H 'content-type: application/json' \
  -d '{"title":"测试"}'

# 2. 建任务
curl -X POST localhost:4780/tasks -H 'content-type: application/json' \
  -d '{"sessionId":"<上一步的 id>","goal":"读一下 readme.txt"}'

# 3. 建 Run
curl -X POST localhost:4780/runs -H 'content-type: application/json' \
  -d '{"taskId":"<上一步的 id>"}'

# 4. 执行
curl -X POST localhost:4780/runs/<run id>/execute -H 'content-type: application/json' \
  -d '{"provider":"demo","model":"demo","goal":"读一下 /path/to/readme.txt"}'
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4780` | 监听端口 |
| `DATA_DIR` | `~/.ai-workstation` | 数据目录 |
| `WORKSPACE` | `$DATA_DIR/workspace` | 允许工具访问的根目录 |

**`WORKSPACE` 是安全边界**。所有文件操作都被限制在这个目录内，
路径穿越、符号链接、UNC 路径都会被拒绝。

---

## 测试

```bash
npm test          # 24 个测试
npm run typecheck # 类型检查
node scripts/e2e.mjs 4780   # 端到端验证（需先启动服务）
```

测试覆盖 SPEC 的三个固定验收用例：

| 用例 | 内容 | 测试文件 |
|---|---|---|
| **A** | 只读工具自动执行，重启后可查询 | `case-a.test.ts` |
| **B** | 写工具被拒绝，去重生效，历史持久 | `case-b.test.ts` |
| **C** | 工具超时 → `unknown`，Run 不显示完成 | `case-c.test.ts` |
| **H** | 路径越权防护 | `paths.test.ts` |

---

## 还没做

按优先级：

1. **Skill Runtime** —— Manifest、Registry、Resolver、渐进加载、版本锁定
2. **知识库 v1** —— 挂载文件夹、全文检索、手动 `@` 引用
3. **隔离执行** —— worktree / 容器沙箱（当前工具跑在主进程）
4. **MCP 客户端** —— 接入外部工具
5. **触发器与无人值守**
6. **记忆**
7. **工作流引擎**
8. **UI**

---

## 文档

- [`docs/DESIGN.md`](docs/DESIGN.md) — 系统设计文档：架构、数据模型、状态机、执行流程、安全设计、已知缺口

---

## 许可证

Apache-2.0。详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
