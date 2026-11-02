# AI 工作站 v2 总体设计稿

> 状态：Proposed design for approval
> 日期：2026-10-29
> 本文定义产品边界、模块职责、接口原则、功能优先顺序和验收标准；本轮不实现代码。
> 原 `docs/AUDIT-SUBMISSION.md` 不修改；本文是下一版总体设计，待确认后再拆分模块规格。

---

## 0. 一句话定义

> **一个 Cherry 风格的本地优先 AI 开发工作台：聊天是入口，能力通过 Provider / Skill / Tool / MCP 接入，项目空间保存共享事实，工作群组织多个角色协作，总控负责澄清和整合，审计是可选质量门，无人值守负责在用户离开时继续生产。**

产品不是“每次都必须执行的审计流水线”，也不是“把所有 AI 功能都重新实现一遍”。

### 0.1 与当前代码的关系

本文是目标架构，不把规划能力写成已实现能力。当前仓库可复用的执行地基主要包括：

- `RunExecutor`：模型调用、工具循环、审批恢复、Trace 和 Run 状态写入。
- `Store`：SQLite 持久化、Run/Step/Approval/Grant/Event 数据。
- `ToolRegistry`：内置文件工具、参数校验和超时包装。
- `providers/`：OpenAI、Anthropic、Demo 适配器及 Provider 预设。
- `paths.ts`：工作区路径解析和路径段校验。

以下能力在当前送审资料中仍属于规划或缺口，不能当作已经交付：Project/Workgroup、Skill Runtime、项目 Artifact 接通、ReviewLoop、知识库索引、图像 Capability、无人值守调度和桌面 UI。当前实现与缺口以 [`AUDIT-SUBMISSION.md`](./AUDIT-SUBMISSION.md) 为准；本文只规定它们未来应满足的接口和验收条件。

当前执行内核还存在必须先封闭的安全/一致性问题：外部请求可传 `autoApprove`、Grant 约束尚未全面执行、批准恢复路径的 Grant 消费不完整、`unknown` 可能传播成普通 `completed`、回环 HTTP 无鉴权、预算和请求体存在无界路径、并发写入和启动恢复尚未形成原子协议。这些不是 v2 的“以后优化”，而是 `foundation-contracts` 和执行内核进入工作群/无人值守之前的阻断项。

---

## 1. 目标、非目标和反目标

### 1.1 目标

1. 让开发者在一个聊天工作台里完成讨论、规划、执行、验证和交付，减少复制粘贴。
2. 让多个 AI 角色围绕同一个项目空间协作，成果可组合、可追溯、可恢复。
3. 让普通聊天、工作群、任务执行和审计之间可以平滑升级，而不是切换到互不相干的系统。
4. 让用户可以接入云端模型、本地模型、图像模型、知识库、技能、MCP 和其他 AI 工具。
5. 让用户睡觉或离开时，系统在明确的权限、时间、成本和风险边界内继续工作。
6. 让系统诚实区分“已完成”“带警告完成”“未审计”“结果未知”和“需要人工决定”。

### 1.2 非目标（v1 不做）

- 不做独立的绘图软件；图像能力作为内置 Capability，能在聊天、工作群和角色任务中调用。
- 不做独立的翻译产品；普通聊天模型可以处理翻译，但不建设翻译专属工作流。
- 不做多人云端协作平台、账号体系和团队计费。
- 不做强制审计；普通聊天可以完全不经过审计。
- 不自研所有模型和工具；通过 Provider、MCP、Skill 和 Adapter 扩展。
- 不把“AI 说完成了”当作验证结果。

### 1.3 反目标

以下情况视为设计失败：

- 用户必须在多个对话之间复制粘贴上下文。
- 每个角色各自修改同一份文件，最后无法判断谁覆盖了谁。
- 总控默默猜测关键需求，之后所有角色一起做错。
- 无人值守模式为了“看起来完成”而跳过权限、验证或未知状态处理。
- 为了接入一个新模型而修改聊天、项目和工作群核心逻辑。
- 功能很多，但用户无法回答“它现在在做什么、改了什么、依据是什么”。

---

## 2. 能力地图与依赖顺序

本项目包含多个可独立验证的能力，先冻结模块边界，再按依赖建设。

| 模块 ID | 职责 | 依赖 |
|---|---|---|
| `foundation-contracts` | 领域类型、状态机、事件、权限、错误和持久化契约 | — |
| `capability-platform` | Provider、模型能力、Tool、Skill、MCP、图像和本地模型适配 | `foundation-contracts` |
| `workspace-knowledge` | 用户工作区、项目空间、文件、知识库、项目记忆、资产和检查点 | `foundation-contracts`, `capability-platform` |
| `conversation-shell` | Cherry 风格会话、消息、附件、模型选择、搜索和会话升级 | `foundation-contracts`, `capability-platform`, `workspace-knowledge` |
| `workgroup-coordination` | 总控、角色、任务图、WorkPackage、ChangeSet、冲突和合并 | `conversation-shell`, `workspace-knowledge`, `capability-platform` |
| `quality-gates` | 机器检查、AI 审计、快照、Review、ReworkBrief 和人工裁决 | `workspace-knowledge`, `workgroup-coordination` |
| `autonomous-runner` | 后台调度、无人值守策略、预算、暂停条件、恢复和报告 | `workgroup-coordination`, `quality-gates`, `capability-platform` |
| `desktop-experience` | 桌面壳、侧栏、工作区切换、审批中心、活动流、通知和设置 | 上述模块的稳定接口 |

建议建设顺序：

```text
foundation-contracts
→ capability-platform + workspace-knowledge
→ conversation-shell
→ workgroup-coordination
→ quality-gates
→ autonomous-runner
→ desktop-experience 的完整化
```

桌面壳可以提前做骨架，但不能绕过这些模块的接口直接读取数据库或调用模型。

### 2.1 功能先行、界面后置的交付门

用户已经明确：先把功能做出来，再根据真实功能设计 UI。本文采用这个顺序，但“界面后置”不等于完全没有可视化验证：

1. **P0 功能阶段**：先实现稳定的领域接口、持久化、Provider/Skill/Tool 运行时和可测试的 HTTP/IPC 调试入口。
2. **功能验收阶段**：用 Demo Provider、本地模型和一个真实小型项目跑通会话、项目、总控、角色和产物闭环；期间只使用低保真的开发调试页面或接口。
3. **UI 设计阶段**：根据已经稳定的对象、状态、错误和活动流设计最终桌面信息架构、交互和视觉，不反过来让 UI 猜测后端状态。
4. **UI 实现阶段**：按垂直切片实现会话、项目、工作群、审批/活动、产物和无人值守报告，并用真实运行数据验证。

最终 UI 的设计输入必须来自真实功能契约：对象字段、状态转换、错误码、权限结果、活动事件和恢复路径。不得先做一个漂亮但无法表达 `unknown`、`needs_reconciliation`、`waiting_merge` 等状态的静态界面。

### 2.2 每个模块的交付门

每个模块在进入下一个模块前必须具备：

- 稳定的输入/输出契约和结构化错误。
- 单元测试、契约测试和至少一个故障路径测试。
- 事件和持久化行为可恢复。
- 权限边界有拒绝测试。
- 不把尚未实现的能力标成可用。

---

## 3. 产品对象模型

### 3.1 用户看到的层级

```text
应用
└── Workspace（用户工作区，类似 Cherry 的工作区）
    ├── Conversations（普通会话）
    ├── Projects（可选的结构化项目）
    │   ├── Workgroup（工作群）
    │   ├── TaskGraph（任务图）
    │   ├── Artifacts（产物与版本）
    │   ├── Decisions（已确认决策）
    │   ├── Reviews（审计记录）
    │   ├── Knowledge（项目知识）
    │   └── ActivityLog（项目活动）
    ├── Skills
    ├── Providers / Models
    └── Settings / Policies
```

### 3.2 物理路径和产品对象必须分开

当前代码中的 `WORKSPACE` 是文件安全根目录。v2 不再把它直接当成用户意义上的 Workspace：

- `LocalRoot`：物理路径安全边界，只决定工具能访问哪里。
- `Workspace`：产品级隔离容器，包含会话、项目、Provider、技能、知识库和策略。
- `Project`：可选的结构化工作空间，承载角色、任务、产物和审计。

普通聊天不必创建 Project；用户可以在聊天中点击“升级为项目”或“创建工作群”。

### 3.3 核心类型（草案）

```ts
type RunPurpose =
  | 'chat'
  | 'role_task'
  | 'coordinator'
  | 'review'
  | 'rework'
  | 'automation'

type CapabilityKind =
  | 'chat'
  | 'vision'
  | 'image_generation'
  | 'image_editing'
  | 'embedding'
  | 'rerank'
  | 'web_search'
  | 'browser'
  | 'code_execution'

type ReviewMode = 'off' | 'assist' | 'strict'

interface Project {
  id: string
  workspaceId: string
  name: string
  briefRef?: string
  policy: ProjectPolicy
  status: 'active' | 'paused' | 'archived'
}

interface RoleProfile {
  id: string
  projectId: string
  name: string
  mission: string
  modelRef?: string
  defaultSkillRefs: string[] // 默认技能，不代表技能专属
  allowedCapabilityKinds: CapabilityKind[]
  allowedToolIds: string[]
  writeScopes: string[]
  outputContract: string
}

interface WorkPackage {
  id: string
  taskId: string
  runId: string
  summary: string
  artifactRefs: string[]
  changedFiles: string[]
  decisions: string[]
  tests: TestResult[]
  unresolvedIssues: Issue[]
  evidenceRefs: string[]
  status: 'draft' | 'submitted' | 'accepted' | 'rejected' | 'superseded'
}

interface ProjectPolicy {
  reviewMode: ReviewMode
  maxReworkRounds: number
  unattended: UnattendedPolicy
  allowedProviderIds: string[]
  allowedSkillIds: string[]
  allowedToolIds: string[]
}

interface CapabilityDescriptor {
  kind: CapabilityKind
  providerId: string
  modelId?: string
  supportsStreaming: boolean
  requiresNetwork: boolean
  dataResidency: 'local' | 'remote' | 'configurable'
}

interface InvocationContext {
  workspaceId: string
  projectId?: string
  runId: string
  actor: 'user' | 'coordinator' | 'role' | 'automation'
  signal: AbortSignal
  policy: EffectivePolicy
}

interface CapabilityRequest {
  kind: CapabilityKind
  providerId?: string
  modelId?: string
  input: unknown
  idempotencyKey?: string
}

interface CapabilityResult {
  status: 'succeeded' | 'failed' | 'unknown'
  output?: unknown
  evidenceRefs: string[]
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  warning?: string
}

```

### 3.4 状态和错误是公共契约

所有模块使用结构化状态和错误，不把异常文本当作协议：

```ts
type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'waiting_merge'
  | 'needs_reconciliation'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'
  | 'expired'

interface WorkbenchError {
  code: string
  message: string
  retryable: boolean
  details?: unknown
  correlationId: string
}
```

状态转换由 `RunStateMachine` 统一检查。任何模块不能直接把 Run 写成任意状态；例如 `waiting_approval → running` 只能来自有效审批决定，`needs_reconciliation → running` 只能来自对账结果或人工决定。`unknown` 是 Step/外部操作结果状态，不是可以被模型一句话覆盖的成功或失败。

公共 HTTP/IPC 接口统一返回 `WorkbenchError`；内部日志可以记录详细原因，但对用户的错误不能泄漏密钥、堆栈或完整第三方响应。

### 3.5 最小深接口

模块之间优先依赖小而稳定的接口，具体 Adapter 隐藏在实现中：

```ts
interface CapabilityInvoker {
  describe(kind: CapabilityKind): CapabilityDescriptor
  invoke(request: CapabilityRequest, context: InvocationContext): Promise<CapabilityResult>
}

interface SkillRuntime {
  resolve(query: SkillQuery, context: SkillContext): Promise<ResolvedSkill[]>
  run(skill: ResolvedSkill, input: SkillInput, context: SkillContext): Promise<SkillResult>
}

interface ProjectCoordinator {
  clarify(input: ClarificationInput): Promise<CoordinatorBrief>
  dispatch(plan: TaskGraph): Promise<DispatchResult>
  integrate(packages: WorkPackage[]): Promise<IntegrationResult>
}
```

`CapabilityInvoker`、`SkillRuntime` 和 `ProjectCoordinator` 是外部模块看到的 seam；Provider、解析器、Prompt 组装、权限计算、重试和持久化是内部实现，不扩散到调用方。

### 3.6 `foundation-contracts` 必须先冻结

上面的 TypeScript 片段是方向性示例。实现前必须把以下类型、归属和生命周期写成版本化 JSON Schema/TypeScript 合同，避免各模块各自发明字段：

```ts
interface EvidenceRef {
  id: string
  kind: 'event' | 'file' | 'test' | 'snapshot' | 'provider_response'
  uri: string
  sha256?: string
}

interface Issue {
  id: string
  fingerprint: string
  severity: 'blocking' | 'warning' | 'info'
  summary: string
  evidenceRefs: string[]
  status: 'open' | 'resolved' | 'accepted' | 'repeated'
}

interface TestResult {
  id: string
  command?: string
  name: string
  status: 'passed' | 'failed' | 'skipped' | 'unknown'
  evidenceRefs: string[]
}

interface ChangeSet {
  id: string
  projectId: string
  actorRunId: string
  baseRevision: string
  paths: Array<{ path: string; beforeHash?: string; afterHash?: string; operation: 'create' | 'modify' | 'delete' }>
  status: 'proposed' | 'validated' | 'conflicted' | 'applied' | 'rejected'
}
```

合同还必须定义 Workspace/Project/Task/Run/Step/Artifact/Snapshot 的归属字段、版本号、状态转换、事件类型、错误码、分页、幂等键和迁移编号。模块只依赖这些 port，不直接依赖 SQLite 行、HTTP body 或某个 Provider 的私有响应。

---

## 4. Cherry 风格底座

### 4.1 应保留并强化的体验

| 能力 | v1 方向 | 说明 |
|---|---|---|
| 会话 | 必须 | 普通聊天仍然是最常用入口 |
| 模型/Provider | 必须 | 云端、本地、OpenAI-compatible 统一配置 |
| 消息操作 | 必须 | 编辑重发、重新生成、复制、引用、分支 |
| 文件与附件 | 必须 | 拖入、`@` 引用、项目文件引用 |
| 技能 | 必须 | `/skill` 调用，作用域和权限可见 |
| 多模型 | P1 | 并排比较或投票，不阻塞核心工作流 |
| 知识库 | P0/P1 | 本地文件夹、全文检索、手动引用先于向量 RAG |
| MCP | P1 | 通过统一 Tool Registry 接入 |
| 搜索 | P1 | 搜索会话、项目、产物、决策和设置 |
| 导出/备份 | P1 | 开放格式，本地数据主权 |
| 主题/快捷键 | P1 | 借鉴成熟客户端，不做创新负担 |
| 绘图 | 内置 Capability | 不做一级导航，聊天和角色都可调用 |
| 翻译 | 暂不做专属功能 | 普通模型能力可以完成 |

### 4.2 会话升级而非硬切

```text
普通聊天
→ “帮我把这个做出来”
→ 创建 Task 或 Project
→ “让几个角色讨论一下”
→ 创建 Workgroup
→ “改完审一下”
→ 附加 Review Gate
```

不设置互相割裂的“聊天区 / 任务区”两套数据源。任务、工作群、审计都应该附着在会话或项目上。

---

## 5. Provider / API / Capability 平台

### 5.1 统一分层

```text
Provider（服务商/端点）
    ↓
ModelProfile（模型及能力声明）
    ↓
Capability Adapter（chat/image/embed/rerank/...）
    ↓
Tool / Skill / Conversation / Role / Automation
```

核心模块不直接判断“这是 OpenAI 还是某个图像 CLI”，只依赖 Capability 接口。

### 5.2 Provider 配置

```ts
interface ProviderConfig {
  id: string
  name: string
  endpoint: string
  protocol: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'lmstudio' | 'custom'
  secretRef?: string // 只存 KeyStore 引用，不存明文
  capabilities: CapabilityKind[]
  localOnly: boolean
  enabled: boolean
}

interface ModelProfile {
  id: string
  providerId: string
  modelId: string
  capabilities: CapabilityKind[]
  contextWindow?: number
  supportsTools?: boolean
  supportsVision?: boolean
  pricing?: { input?: number; output?: number }
  limits?: { maxInputBytes?: number; maxOutputTokens?: number }
}

interface ProviderSecret {
  kind: 'api_key' | 'oauth_token' | 'custom_header'
  value: string
  expiresAt?: number
}

interface SecretStore {
  put(providerId: string, secret: ProviderSecret): Promise<{ secretRef: string }>
  resolve(secretRef: string, purpose: 'provider_request' | 'health_check'): Promise<ProviderSecret>
  revoke(secretRef: string): Promise<void>
}

interface EndpointPolicy {
  validate(endpoint: string, mode: 'local' | 'remote'): Promise<{ normalizedEndpoint: string }>
}
```

`ProviderConfig` 永远不接受长期明文 `apiKey`；只有 Adapter 的发送边界通过 `SecretStore.resolve()` 取得短生命周期密钥，且不能进入 `ChatRequest`、事件 payload、Skill 上下文或错误消息。`EndpointPolicy` 必须在请求前执行 scheme/host/TLS/私有地址/重定向策略；健康检查和真实请求共用这套策略。

### 5.3 适配策略

- OpenAI-compatible Provider 通过配置接入，不为每个兼容服务商写一套聊天代码。
- Anthropic、Gemini 等协议保留独立 Adapter。
- Ollama、LM Studio、llama.cpp 等本地服务作为 Local Provider。
- 图像、Embedding、Rerank 不强行伪装成 Chat Provider，使用各自 Capability Adapter。
- Provider 必须声明能力，不支持的能力不能在 UI 中伪装成可用。
- 每个外部调用记录 Provider、模型、能力、参数摘要、耗时、成本和结果状态。

### 5.4 API 密钥和端点

- API Key 只写入操作系统 KeyStore，数据库只保存 `secretRef`。
- HTTP 请求体不允许传入任意 API Key 作为长期配置。
- 用户配置的远程端点必须经过协议、主机、TLS 和重定向策略校验。
- 本地 Provider 默认只允许 `127.0.0.1` / 本机 IPC；扩大范围必须明确授权。
- Provider 健康检查不能把密钥或完整响应写进日志。
- Provider 错误对外只返回稳定的 `PROVIDER_UNAVAILABLE`、`PROVIDER_AUTH_FAILED`、`PROVIDER_RATE_LIMITED`、`PROVIDER_INVALID_RESPONSE` 等错误码；原始响应只进入脱敏内部诊断。
- Provider 请求必须带 deadline、最大响应字节数和取消信号；流式响应在达到上限或超时时进入明确的 `failed`/`unknown`，不能无限等待。

### 5.5 聊天请求合同

当前执行器的 `system` 参数不能只停留在 HTTP 层；v2 的 Adapter 合同必须显式携带系统指令、策略信封、预算和数据来源：

```ts
interface ChatRequest {
  provider: ProviderRef
  model: ModelRef
  system?: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  policy: InvocationPolicy
  budget: RequestBudget
  sources: EvidenceRef[]
  signal: AbortSignal
}
```

系统提示只提供行为上下文，不能授予权限；工具、路径、成本、网络和角色约束由 `InvocationPolicy` 在代码中强制执行。`ProviderRef`、`ModelRef`、`ChatMessage`、`ToolSpec`、`InvocationPolicy` 和 `RequestBudget` 都属于 `foundation-contracts`，不是由某个 Provider 私自定义的传输类型。

---

## 6. 技能系统：全局能力，不是角色私有物

### 6.1 关系

```text
Skill = 方法、约束、输出契约、推荐工具
Role  = 模型 + 角色目标 + 默认 Skill + 权限策略
Conversation / Project / Task = Skill 的实际作用域
```

角色的 `defaultSkillRefs` 只是预装或推荐，不代表其他会话不能调用同一个技能。

### 6.2 技能作用域

```ts
type SkillScope =
  | 'global'
  | 'workspace'
  | 'project'
  | 'conversation'
  | 'task'
  | 'role_default'
```

技能调用流程：

```text
技能已安装
→ 技能已启用
→ 当前作用域允许
→ 当前角色/会话策略允许
→ 所需工具和 Capability 允许
→ 需要审批则进入审批
→ 执行并记录证据
```

### 6.3 Skill Manifest

```ts
interface SkillManifest {
  id: string
  version: string
  name: string
  description: string
  license: string
  source: 'builtin' | 'marketplace' | 'local' | 'project'
  trust: 'builtin' | 'reviewed' | 'untrusted'
  instructionRef: string
  requiredCapabilities: CapabilityKind[]
  suggestedToolIds: string[]
  outputContract?: string
  dependencies?: string[]
  compatibility?: {
    minAppVersion?: string
    maxAppVersion?: string
  }
  permissions?: {
    filesystemRoots?: string[]
    networkHosts?: string[]
    capabilityKinds?: CapabilityKind[]
    maxCostUsd?: number
    maxDurationMs?: number
  }
  contentHash: string
}
```

技能的提示词内容和可执行代码必须分开：

- 纯指导型 Skill：默认可读，不能自动获得工具权限。
- 带工具的 Skill：必须声明工具、路径、网络、成本和副作用。
- 未审查的外部 Skill：默认沙箱/禁用高风险工具。
- Skill、知识库文档和工具输出都属于不可信输入，不能覆盖系统权限。

### 6.4 技能安装、更新和回滚

技能生命周期必须与普通文件复制区分开：

```text
发现来源 → 下载/导入 → 校验 Manifest/许可证/哈希
→ 静态审查 → 安装但不启用 → 用户或项目启用
→ 固定版本运行 → 评估/更新 → 可回滚
```

- 内置技能可以随应用发布，但仍记录版本和内容哈希。
- 本地/Git/市场技能默认 `untrusted`，不能直接获得高风险工具。
- 更新不能覆盖正在运行的 Run；Run 固定使用启动时的版本和引用哈希。
- 删除或禁用技能不删除历史 Run 中的 SkillUsage 记录。
- 未确认许可证、来源或依赖的技能不能进入内置发行包。
- 外部技能的脚本不自动执行；如果确实需要执行，必须经过能力和权限审批，并在隔离进程中运行。

每个 Run 记录：

```ts
interface SkillUsage {
  skillId: string
  version: string
  contentHash: string
  loadedReferences: string[]
  configurationHash: string
}
```

### 6.5 总控技能

`karpathy-guidelines` 适合成为总控的默认行为约束，但必须落实为可检查协议，而不是只塞进 Prompt：

```text
明确目标
→ 列出假设
→ 标记未决问题
→ 定义成功标准
→ 生成计划
→ 低风险可自动继续 / 高风险请求确认
→ 执行
→ 验证
→ 提交证据
```

总控不需要让每个角色无限提问：只有阻塞性未知才暂停，非阻塞未知记录为假设并标记未确认。

---

## 7. 本地模型与知识库

### 7.1 本地模型角色

知识库不应只依赖云端模型。模型配置要区分用途：

```text
聊天模型       → 普通对话 / 总控 / 角色
Embedding 模型 → 文档向量化
Reranker 模型  → 检索结果重排（可选）
Vision 模型    → 图片理解
Summarizer     → 项目摘要和上下文压缩（可复用聊天模型）
```

Ollama、LM Studio 等本地服务可以分别提供这些模型；某个模型不支持 Embedding 时，不能假装支持。

### 7.2 知识库处理链

```text
本地文件夹 / 拖入文件 / URL（可选）
→ 解析
→ 文档结构提取
→ 分块
→ 关键词索引
→ Embedding（本地或远程）
→ 可选 Rerank
→ 组装上下文
→ 返回引用和来源
```

v1 的最低可用知识库必须包括：

- 挂载本地文件夹和拖入文件。
- 全文关键词检索。
- 手动 `@` 引用进上下文。
- 索引状态：索引中、成功、失败、过期。
- 文件来源、更新时间和引用位置。
- 本地模型模式下不把内容发送到远程 Provider。

这延续了现有 [`DESIGN.md`](./DESIGN.md) 中“本地文件夹 + 全文检索 + 手动引用先于自动 RAG”的思路；当前送审包也把这几项列为未来能力，不代表已经实现。

### 7.3 知识范围和优先级

```text
全局知识
→ Workspace 知识
→ Project 知识
→ Conversation 附件
→ Task 输入产物
→ 当前消息
```

冲突时必须标记来源和时间，不能静默合并两个互相矛盾的事实。

### 7.4 知识库与项目事实的区别

- 知识库：可检索的外部资料。
- 项目事实：总控确认过的目标、规范、决策和状态。
- 原始聊天：完整过程记录。

AI 不应该把一段未经确认的聊天内容自动升级为项目事实。

---

## 8. 图像能力和 UI 生产

### 8.1 产品定位

图像生成不是孤立的绘图页面，而是一个全局 Capability：

```text
普通聊天       → 直接生成/编辑图片
工作群美术角色 → 生成视觉方向和项目资产
UI 任务        → 图生图/局部编辑/多方案探索
无人值守       → 按预算生成候选方案
```

### 8.2 统一接口

```ts
interface ImageCapability {
  generate(input: ImageGenerateRequest): Promise<ImageJob>
  edit(input: ImageEditRequest): Promise<ImageJob>
  batch(input: ImageBatchRequest): Promise<ImageJob[]>
  inspect(input: ImageInspectRequest): Promise<ImageInspection>
}

type ImageJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled'

interface ImageJob {
  id: string
  status: ImageJobStatus
  assetIds: string[]
  providerId: string
  modelId: string
  idempotencyKey: string
  warning?: string
}
```

图像生成是有费用和外部副作用的能力：每个 Job 必须有由调用意图派生的幂等键，服务端原子地登记 `queued/running`，同一幂等键和不同请求体必须报冲突；请求超时进入 `unknown`，不能因为客户端重试就盲目创建第二次付费任务。批量任务还必须受并发数、总成本、总数量和输出磁盘配额限制。

Adapter 可以包括：

```text
Codex Image Adapter
OpenAI-compatible Image Adapter
Gemini Image Adapter
ComfyUI Adapter（后续）
其他 Provider Adapter
```

`codex-image2-5` 可以作为第一个 Adapter 的参考实现，但在正式内嵌前必须单独核对 CLI 二进制、依赖、许可证、API 服务条款和密钥存储方式，不能直接把技能目录或密钥逻辑复制进主程序。

### 8.3 图生图必须保留版本和来源

```ts
interface ImageAsset {
  id: string
  projectId?: string
  sourceAssetIds: string[]
  prompt: string
  model: string
  provider: string
  requestedSize?: string
  actualSize?: string
  maskRef?: string
  version: number
  status: 'draft' | 'selected' | 'rejected' | 'superseded'
  createdBy: string
}
```

必须做到：

- 默认写入新文件，不覆盖原图。
- 保存参考图、蒙版、提示词、模型、分辨率和实际输出尺寸。
- 支持多张参考图和局部编辑。
- 失败、警告和实际尺寸如实展示。
- 生成结果可被项目、角色和审计引用。

### 8.4 UI 生成不能止于图片

UI 生产的完成物应包括：

```text
视觉方向图
+ 颜色/字体/间距 Token
+ 布局和响应式规则
+ 组件状态
+ 资源清单
+ 前端实现
+ 浏览器截图/可访问性证据
```

图片只是探索和参考，不是最终可运行界面。

---

## 9. 工作群与总控

### 9.1 工作群结构

```text
Project
├── Coordinator（总控）
├── Participants（策划/编剧/程序/美术/UI/测试等）
├── Conversation（讨论）
├── TaskGraph（执行任务）
├── WorkPackages（角色提交）
├── ChangeSets（代码/资产变更）
└── Decisions（确认过的项目事实）
```

### 9.2 角色职责

角色不是独立聊天窗口，而是具有目标、技能推荐、权限和输出契约的 Worker。

- 总控：澄清、规划、调度、整合、冲突升级。
- 策划：玩法、规则、数值、任务结构。
- 编剧：世界观、角色、对话、叙事一致性。
- 美术/UI：视觉方向、资源清单、UI 规范、图像能力调用。
- 程序：代码、测试、构建、工具执行。
- 测试/审计：验证和问题报告，不直接偷偷修改产物。

### 9.3 总控的四种动作

```text
Discuss   组织讨论
Plan      形成任务图
Dispatch  分配角色和权限
Integrate 合并成果和更新项目事实
```

总控默认不直接修改所有文件；它通过 ChangeSet 和系统引擎完成整合。

### 9.4 角色隔离和合并

不允许多个角色无控制地写同一个工作区：

```text
角色独立 Run
→ 独立工作目录 / worktree
→ 生成 WorkPackage 和 ChangeSet
→ 运行角色级验证
→ 总控检查依赖和冲突
→ 合并
→ 创建 Project Checkpoint
```

同一文件发生冲突时：

```text
禁止静默覆盖
→ 生成冲突对象
→ 总控分析
→ 必要时请求用户
```

### 9.5 角色成果必须结构化

角色不能只返回“完成了”。最少要提交：

- 做了什么。
- 产物在哪里。
- 修改了哪些文件。
- 运行了哪些验证。
- 仍有哪些问题。
- 依赖哪些决策或其他角色产物。
- 建议下一步是什么。

---

## 10. 上下文、保存和项目日志

### 10.1 三类上下文

#### 项目事实

长期稳定：目标、技术栈、已确认决策、规范、目录和当前版本。

#### 工作过程

动态变化：任务状态、依赖、角色提交、审计、返工、假设和未解决问题。

#### 原始对话

完整保留：用户消息、群聊、模型输出、工具调用和事件。

角色默认读取：

```text
项目事实 + 当前任务 + 输入产物 + 相关决策 + 必要的对话片段
```

而不是每次把全部聊天历史塞进上下文。

### 10.2 保存策略

| 事件 | 保存方式 |
|---|---|
| 用户/角色消息 | 立即写事件和消息记录 |
| 工具调用前 | 先写操作意图和幂等键 |
| 工具调用后 | 写结果、状态、Trace 和证据 |
| 文件变更 | 写 ChangeSet 和文件摘要 |
| 审批/审计/返工 | 立即写状态和决定理由 |
| 流式 Token | UI 实时显示；按批次落盘，结束时强制 flush |
| 任务/角色提交 | 生成 WorkPackage |
| 任务完成/审计前/返工前 | 创建 Checkpoint |
| 阶段结束 | 生成可读项目摘要 |

默认建议：流式内容按 250–500ms 批量保存，任务结束强制保存；这个数字应可配置，不把每个 Token 都写入项目文件。

### 10.3 项目目录建议

```text
.ai-workstation/
├── project.yaml
├── brief.md
├── decisions.md
├── tasks/
├── artifacts/
├── reviews/
├── worklog/
└── checkpoints/
```

数据库负责恢复和查询，项目目录负责用户可读、可迁移和可审查的记录。

### 10.4 恢复原则

- 任何外部副作用先记录 intent，再执行。
- 重启时扫描 `running`、`in_progress` 和 `unknown` 操作。
- 不能根据“没有收到响应”判断外部操作失败。
- 不确定操作必须进入对账或人工裁决，不能自动重复。

---

## 11. 产物快照和恢复安全

### 11.1 快照的目标

快照用于审计、版本比较和恢复，不等于可以撤销所有外部副作用。邮件、付款、远程发布和第三方状态必须单独记录证据，不能声称能从文件快照恢复。

### 11.2 v1 快照安全策略

- 默认在独立的 shadow/bare 仓库或内容寻址对象存储中生成快照，不在用户工作区执行 `git clean -fd` 作为回滚机制。
- 先记录工作区指纹、文件清单、哈希和不可捕获项，再创建不可变 Snapshot；创建失败不得删除用户文件。
- 恢复采用“先保存当前状态 → 校验目标 Snapshot → 原子应用 → 重新扫描指纹”的步骤；每一步都可中断并回到用户当前状态。
- Git 适配器必须隔离配置和 hooks，处理 ignored/untracked、symlink/reparse、submodule/LFS、大文件和用户外部修改；无法保证的对象标记 `reproducible: false`。
- 任何删除、覆盖或移动都需要路径根、最小深度、所有权证据和版本冲突检查；不可通过 Prompt 或文件名绕过。

### 11.3 Snapshot 合同

```ts
interface Snapshot {
  id: string
  projectId: string
  baseRevision?: string
  contentRoot: string
  manifestHash: string
  reproducible: boolean
  unresolvedExternalEffects: string[]
  status: 'creating' | 'ready' | 'corrupt' | 'deleted'
}
```

在完成故障注入、崩溃恢复、并发修改和恶意路径测试前，不允许把恢复操作开放给无人值守模式。

---

## 12. 可选审计和返工

### 12.1 三种审计模式

```text
off     不自动审计，用户按需触发
assist  机器检查自动执行，AI 审计建议触发
strict  机器检查 + Auditor 通过后才进入下一阶段
```

### 12.2 审计对象

Auditor 只能审查冻结的 Artifact Snapshot，不能直接读取仍在变化的工作区。

```text
Producer / Role WorkPackage
→ Snapshot
→ Machine Checks
→ Auditor
→ pass / pass_with_warnings / rework_required / escalate
```

### 12.3 模型不允许单方面放行

- 机器规则明确失败：直接阻断。
- 机器规则明确通过，Auditor reject：返工。
- 机器规则 uncertain / 未覆盖，Auditor pass：降级为 `escalate` 或 `passed_with_warnings`，不能直接宣称严格通过。
- 所有结论必须有 RuleVersion、EvidenceRef 和 EventRef。

### 12.4 返工策略

```ts
interface ReviewPolicy {
  mode: 'off' | 'assist' | 'strict'
  maxRounds: number
  maxCostUsd?: number
  maxDurationMs?: number
  stopOnRepeatedFinding: boolean
  onLimit: 'ask_user' | 'accept_with_warning' | 'stop'
}
```

每次返工生成 `ReworkBrief`，用户可以选择全部返工、选择问题、修改要求、忽略警告或人工接管。

以下情况必须停止自动返工：

- 达到最大轮数。
- 同一问题指纹连续两轮没有实质变化。
- 机器规则和 Auditor 互相矛盾。
- 需要不可逆外部操作。
- 预算、时间或权限达到上限。

---

## 13. 无人值守工作模式

### 13.1 目标

用户离开或睡觉时，系统按照当前已确认目标继续低风险生产，遇到高风险、关键歧义或未知副作用时暂停或记录，而不是完全停摆或胡乱猜测。

### 13.2 启动前策略

```ts
interface UnattendedPolicy {
  enabled: boolean
  maxDurationMs: number
  maxCostUsd?: number
  maxReworkRounds: number
  allowedRoleIds: string[]
  allowedSkillIds: string[]
  allowedToolIds: string[]
  allowedRoots: string[]
  allowedCapabilities: CapabilityKind[]
  onBlockingQuestion: 'pause' | 'assume_and_record'
  onUnknown: 'reconcile' | 'pause'
  onConflict: 'continue_unrelated' | 'pause'
  onLimit: 'pause' | 'stop_with_report'
}
```

### 13.3 自动决策分级

```text
安全且明确       → 自动执行
低风险且可逆     → 执行并记录
低风险但有歧义   → 按策略记录假设后继续
高风险/不可逆    → 暂停等待用户
结果未知         → 不自动重复，进入对账
```

允许示例：读取项目、修改允许目录、运行已有测试、生成图像草案、生成文档。

默认禁止示例：访问工作区外路径、删除整个项目、安装依赖、发布、发邮件、购买服务、修改系统配置。

### 13.4 夜间报告

早上用户看到的是摘要：

- 已完成任务和证据。
- 未完成任务和原因。
- 假设列表及未确认项。
- 审计和返工轮次。
- 成本、耗时、工具调用。
- 冲突、未知结果和风险。
- 发生过的权限请求。

`unreviewed`、`best_effort` 和 `passed` 必须使用不同状态，不能混为“完成”。

---

## 14. 安全与当前执行内核的前置修复

### 14.1 信任边界和数据路由

设计必须显式标记以下信任边界：

```text
用户输入 / 附件 / 项目文件 / 知识库文档
    → Context Builder
模型输出 / 技能指令
    → Structured Parser + Permission Gate
Provider / 图像 API / MCP / 外部命令
    → Adapter + Response Validator
角色 Run / 项目共享状态
    → Coordinator Writer + ChangeSet Merge
```

- 文档、工具输出、模型输出和技能内容都按不可信数据处理；不能让它们覆盖系统提示、权限或项目策略。
- 知识库索引按 Workspace/Project 隔离；引用上下文必须带来源和权限检查。
- 远程知识库、URL 导入、图像引用和 Provider 端点要防 SSRF：限制协议/主机，解析并拒绝私有和保留地址，禁止未经策略允许的重定向。
- 本地模式必须有可测试的数据路由记录：本次请求使用的 Provider、是否联网、发送的数据范围和引用来源。
- LLM 生成的路径、命令、代码和 JSON 只能作为候选输入，经过 schema 校验、路径检查、工具策略和人工/自动审批后才能执行。

### 14.2 当前执行内核的前置修复

在实现工作群和无人值守前，必须先补齐执行内核：

1. **状态语义**：把单一 `paused` 拆成 `waiting_approval`、`waiting_user`、`waiting_merge`、`needs_reconciliation` 等可行动状态。
2. **unknown 传播**：存在未解决的 unknown 时，Run 不能普通地标记为 completed。
3. **Grant 约束**：真正执行 `allowedPaths`、`allowedHosts`、`maxBytes`，不能只检查 toolId、过期时间和次数。
4. **预算完整性**：补齐 maxInputTokens、maxOutputTokens、deadline、cost 和并发预算。
5. **审批原子性**：操作 intent、幂等键、外部状态和 resultConsumed 必须形成可恢复协议。
6. **并发写入**：多角色不能共享一个可竞争的 Run 写者；SQLite 序号和 usage 更新必须具备原子性。
7. **HTTP 安全**：请求体大小限制、本地 API 鉴权、来源校验、错误脱敏、健康检查不暴露路径、禁止调用方通过 `autoApprove` 越权。
8. **密钥管理**：Provider 密钥移入 OS KeyStore，日志和事件不得记录明文。
9. **沙箱**：代码执行、浏览器和外部命令不能长期运行在主进程内；至少要有独立进程、超时、资源和路径限制。
10. **产物/消息接通**：`artifact` 和 `message` 不能只建表不写入，否则项目空间和 Cherry 风格会话都会出现空接口。

---

## 15. 接口和持久化约束

### 15.1 HTTP/IPC 统一原则

对外 HTTP 和未来桌面 IPC 使用同一组领域契约；传输层只负责解析、鉴权、调用和序列化。接口必须：

- 使用统一错误对象：`code`、用户可读 `message`、`retryable`、`correlationId` 和可选的已脱敏 `details`。
- 对列表提供游标或页码分页，不能返回无上限的会话、事件、消息或资产集合。
- 对创建、批准、启动、图像生成和外部副作用操作提供幂等键或明确标记为不可重试。
- 对同一资源的并发更新使用版本号/乐观锁；版本冲突返回 `409`，不能静默覆盖。
- 对用户提供的 Provider、Skill、MCP、路径、URL、模型参数和文件上传在入口处 schema 校验。
- 绝不把完整 API Key、Authorization 头、内部堆栈或第三方原始错误响应返回给客户端。

### 15.2 事件和事实写入

事件日志是事实记录，不是 UI 临时缓存。事件至少包含：

```ts
interface DomainEvent {
  id: string
  aggregateType: 'conversation' | 'project' | 'task' | 'run' | 'artifact' | 'review' | 'job'
  aggregateId: string
  sequence: number
  kind: string
  actor: 'user' | 'coordinator' | 'role' | 'system' | 'provider'
  payload: unknown
  occurredAt: number
  correlationId: string
}
```

同一聚合的 `sequence` 必须由存储层原子分配并有唯一约束；不能用“先读 MAX 再插入”的竞争实现。用量累加、审批决定、幂等键登记和状态转换需要事务或等价的原子更新。

### 15.3 角色并发模型

- 一个角色一次只拥有一个可写的工作分支/工作目录。
- 总控不能把多个角色直接映射到同一个可竞争的 Run 写者。
- 共享项目事实由 Coordinator Writer 串行合并；角色只提交 WorkPackage/ChangeSet。
- 合并前检查基线版本、路径范围、文件哈希和验证结果。
- 冲突、过期基线或验证缺失都必须形成显式状态，不能靠最后写入者获胜。

---

## 16. 成功标准（建议验收）

### S1：Cherry 风格基础体验

- 不配置密钥也能进入 Demo 会话。
- 可以创建会话、编辑重发、引用文件、调用技能。
- 可以配置一个云端 Provider 和一个本地 Provider。
- Provider 的能力不支持时，UI 不显示为可用。

### S2：项目和工作群

- 从普通聊天一键升级为 Project。
- 创建总控和至少两个角色。
- 总控能列出目标、假设、成功标准和任务图。
- 角色独立执行并提交 WorkPackage。
- 项目页面能看到产物、决策、文件变更和活动记录。
- 两个角色修改同一文件时不会静默覆盖。

### S3：知识库和本地模型

- 能挂载本地目录和手动引用文档。
- 能使用本地 Embedding/聊天模型完成一次本地检索问答。
- 回答带来源和引用位置。
- 本地模式下有明确证据表明内容未发往远程 Provider。

### S4：图像和 UI

- 普通聊天和美术/UI 角色都能调用 Image Capability。
- 支持文生图、图生图和局部编辑中的至少两项。
- 输出保存为项目资产并保留模型、提示词、参考图和版本信息。
- UI 任务能从视觉图继续生成设计规范，而不是停在图片。

### S5：审计和返工

- 审计可关闭、可辅助、可严格执行。
- 审计结果包含规则版本和证据。
- 返工次数有上限，重复问题会停止自动循环。
- 未审计和带警告结果不会显示为严格通过。

### S6：无人值守

- 用户可以配置时间、成本、角色、技能、工具和目录边界。
- 高风险操作会暂停。
- unknown 不会自动重复。
- 重启后能恢复或进入对账状态。
- 完成后生成可读报告。

---

## 16. Always / Ask First / Never

### Always

- 外部输入在边界处验证。
- 工具和模型输出按不可信数据处理。
- 状态、事件、权限和副作用可追溯。
- 文件修改有范围限制和版本/检查点。
- 任务结束前运行声明的验证。
- 保留原始消息、事件和证据，不用摘要替代事实。

### Ask First

- 新增 Provider、外部服务或付费模型。
- 扩大工作区路径、网络主机或工具权限。
- 安装未审查的 Skill/MCP。
- 安装依赖、运行外部命令、发布或发送内容。
- 修改项目政策、最大成本、无人值守策略或审计模式。
- 恢复可能产生外部副作用的 unknown 操作。

### Never

- 把 API Key 写进代码、数据库普通字段、日志、Prompt 或事件 payload。
- 让模型自行授予自己工具权限。
- 让多个角色静默覆盖同一个文件。
- 把工具超时伪装成成功或失败。
- 把“模型说通过”当作机器验证通过。
- 为了跑通而删除测试、放宽权限或禁用安全检查。

---

## 17. 当前建议的产品优先级

### P0：开发者能真正用起来

1. 修复执行内核状态、权限、预算、恢复和 HTTP 安全。
2. Cherry 风格会话与 Provider 管理。
3. Workspace / Project / Artifact / Decision / ActivityLog。
4. 总控澄清、任务图和一个程序角色。
5. 本地模型 Provider 和最小本地知识库。

### P1：工作群成为生产力

1. 策划、编剧、美术/UI、程序等角色模板。
2. 全局 Skill Registry、Skill 作用域和权限。
3. 独立工作区、ChangeSet、合并和冲突处理。
4. Image Capability 和项目资产版本。
5. 可选 Review Gate 和有限返工。

### P2：持续生产

1. 无人值守策略、后台调度和夜间报告。
2. 浏览器验证、更多 MCP 和外部工具。
3. 多模型并行、模型路由、降级和缓存。
4. 备份、导出、通知和更完整的桌面体验。

---

## 18. 需要确认的开放问题

1. 桌面壳是否采用 Electron（复用 Node/TypeScript/本地 CLI 生态），还是选择 Tauri？当前建议 Electron，但这会增加内存占用。
2. 用户可见的一级容器是否叫 Workspace，结构化开发容器是否叫 Project？本文建议两级分开。
3. v1 的本地模型是否以 Ollama/LM Studio 为主，还是需要直接打包 llama.cpp？本文建议先接外部本地服务，不把模型文件打包进应用。
4. 图像 Provider 的第一批范围是否为 Codex Image + 一个 OpenAI-compatible 适配器？本文建议如此，不一次性接所有模型。
5. 无人值守默认策略是否采用“低风险自动继续，高风险暂停，unknown 对账”？本文建议这是默认安全策略。
6. 第一个端到端演示是否采用小型游戏原型，以同时验证总控、策划、编剧、美术/UI、程序、项目资产和审计？

---

## 19. 设计结论

最终产品不应再被定义为“任务 + 审计系统”，而应定义为：

> **Cherry 风格的 AI 开发工作台：聊天是入口，能力是可插拔的，项目空间是共享事实，工作群是协作方式，总控是协调者，技能是全局能力，图像 API 是内置 Provider，审计是可选质量门，无人值守是持续生产模式。**

下一步应先由用户确认第 2 节的模块边界和第 17 节的开放问题；确认后再为各模块分别写实现规格和计划，不直接开始大规模编码。
