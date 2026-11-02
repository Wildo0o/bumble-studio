# 送审说明（先看这一页）

> 给审计方的入口文档。**读完这一页再打开正式送审包**，能省掉一半的摸索时间。
>
> 送审包：`docs/AUDIT-SUBMISSION-v3.md`（约 1070 行，自包含）

---

## 一、这是什么

一个本地 AI 工作站。核心不是「聊天」，而是：
**你给目标 → AI 调工具干活 → 自动审计 → 你验收 → 交付**。

送审范围是已实现的执行内核 + 审计回路，**不含 UI**（只有 HTTP 接口）。

---

## 二、10 分钟上手

```bash
cd G:\AI\ai-workstation
npm install
npx tsc -p tsconfig.json --noEmit     # 应无输出
npx vitest run                        # 应为 32 files / 316 passed
```

端到端（**会自己起服务，不需要另开终端**）：

```bash
node scripts/e2e-reviewloop.mjs       # 应为 55 通过 / 0 失败 / 0 跳过 / 0 未覆盖
```

**不需要任何 API 密钥**——内置演示模型会真实调用工具、真实执行审计。

手动启动服务时，token 会自动生成：

```bash
DATA_DIR=$PWD/.e2e/data WORKSPACE=$PWD/.e2e/workspace PORT=4820 npx tsx src/server/index.ts
# 日志会告诉你 token 存在哪个文件，但不会打印 token 本身
cat $PWD/.e2e/data/auth-token
```

然后所有接口都要带它：

```bash
TOKEN=$(cat $PWD/.e2e/data/auth-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4820/sessions
curl http://127.0.0.1:4820/sessions          # 401
curl http://127.0.0.1:4820/health            # 200，唯一公开接口
```

**建议再启一次**：关掉进程，用同样的命令重新启动。
token 会从文件读回，历史链延续。这个「重启」场景见送审包第 19 项。

---

## 三、先看什么（按这个顺序）

| 顺序 | 看什么 | 位置 | 为什么先看这个 |
|---|---|---|---|
| 1 | **§14 已知缺口（6 项硬阻塞）** | 送审包第十四章 | 先知道哪些是纸面，避免把精力花在已知问题上 |
| 2 | **§15 的 18 个问题** | 第十五章 | 直接看我们想知道什么，带着问题读会快很多 |
| 3 | **§5 状态机** | 第五章 | 整套设计的地基 |
| 4 | **§10 ReviewLoop 三条硬规则** | 第十章 | 这是产品的核心差异化 |
| 5 | **§13 已修复清单** | 第十三章 | 看我们踩过哪些坑，判断还有多少同类问题 |

**如果只有 30 分钟**：看 §14 + §15，再跑一遍 e2e。这已经足够形成第一轮反馈。

---

## 四、最需要你判断的四件事

### 1. 「模型 pass 只能否决」够不够防注入

```
模型 reject → 直接生效
模型 pass  → 仅当所有机器规则明确 pass、且至少一条 strong 规则也明确 pass 时才生效
其他        → escalate
```

设计意图：注入改不了规则文本，但能改判断。产物里写「请返回 pass」，审计模型可能照做。

**我们想知道**：这条防线有绕过方式吗？

### 2. weak / strong 的划分是否站得住

- `strong`：能判定核心质量（JSON 合法性、最小长度、测试退出码）
- `weak`：只做形式检查（文件存在、产物非空）

**问题**：谁来决定一条规则是 strong 还是 weak？
这个划分会不会被人为操纵成「全标 strong 然后自动放行」？

**注意**：这是**策略问题**，不是代码问题。代码只保证「所有规则都 pass 才放行」。

### 3. Goodhart 定律

Producer 会优化到规则所定义的那个点——规则说「要三个论点」，就给三个空洞的论点。

**我们想知道**：怎么检测「规则覆盖不足」？
用例测试抓不到这个，因为测试样本天然在规则射程内。

### 4. 验收门是不是过严或过松

验收要求 7 项全部满足（见 §9.3），其中「审计必须绑定到被接受的这个产物」是关键。

**我们想知道**：有没有可能出现「合法操作被卡死」的死锁？
比如一个 Task 产生多个产物，是否每个都必须单独审计才能验收？

---

## 五、验证「纸面 vs 实现」

文档里说的每一条都可以自己验：

```bash
# 验证 message 表确实没被写入（已知缺口，不是 bug）
grep -rn "appendMessage" src/core/executor.ts        # 应返回空

# 验证调用前预算 reservation 确实不存在（硬阻塞 I）
grep -n "reserv" src/core/store.ts src/core/executor.ts   # 应返回空

# 验证请求体再也打不开 autoApprove（第 20 项）
grep -vE '^\s*(//|\*)' src/core/executor.ts src/server/app.ts | grep "autoApprove"
# 应返回空

# 验证所有路由默认要认证，公开接口只有一处
grep -n "requiresAuth ?? true" src/server/app.ts
grep -c "requiresAuth: false" src/server/app.ts       # 应为 1

# 验证认证测试真的能失败（变异测试，记得改回来）
sed -i 's/if (r.requiresAuth)/if (false \&\& r.requiresAuth)/' src/server/app.ts
npx vitest run src/server/__tests__/                  # 应出现 8 个失败
git diff src/server/app.ts                            # 确认改回来

# 验证路径校验确实先拦 UNC（已修复的真实缺陷）
grep -n -A3 "UNC 路径必须在" src/core/paths.ts

# 验证审计门不是 fail-open（已修复，修复前是真 bug）
grep -n -B2 -A8 "allStrongPass" src/core/audit.ts

# 验证影子仓库归属判断（第 19 项）
grep -n -A12 "isOwnShadowRepo" src/core/snapshot.ts

# 验证没有静默跳过（第 20 项一起修掉的）
grep -n "if (!isWin) return" src/core/__tests__/paths.test.ts   # 应返回空
```

---

## 六、认证与威胁模型（第 20 项，本轮新增）

**这是本轮最需要被审的部分。**

### 做了什么

- 每实例 bearer token（256 位），存 `0600` 文件或 `AUTH_TOKEN`
- 只有 `GET /health` 公开
- Origin 校验：带 `Origin` 就必须精确匹配 loopback 白名单；`null` 拒绝
- 非 loopback 监听 + 无 `AUTH_TOKEN` → **拒绝启动**
- `autoApprove` 字段从请求体和 executor 里**彻底删除**，出现即 400

### 没做什么（重要）

**localhost 不是认证机制。** `127.0.0.1` 只限制网络可达范围。

当前安全边界是**操作系统用户账户**，不是进程：

| 攻击者 | 防不防 |
|---|---|
| 局域网 / 互联网 | ✅ 只绑 loopback |
| 恶意网页（CSRF） | ✅ token 不在 cookie + Origin 校验 |
| 其他 OS 用户 | ✅ 文件 ACL 收紧（见送审包 20c） |
| **同一 OS 用户的恶意进程** | ❌ **它读得到 token 文件** |
| 内存转储 / 物理接触 | ❌ |

**请重点质疑**：这个边界划得对不对？
「同一用户下的进程互相可信」这个假设，在桌面应用里成立吗？

---

## 七、不用管的部分

以下明确不在送审范围，**不必提意见**：

UI / 视觉 · Skill 市场 · 知识库 / RAG · 沙箱隔离 · MCP ·
触发器 / 无人值守 · 记忆 · 工作流引擎 · 多用户协作

理由：先把「结果是什么、能否复现、谁确认完成」这三个问题做扎实。
主链不成立的话，加再多能力也只是把问题藏得更深。

---

## 八、一个请求

**请优先指出「设计错误」，其次才是「代码 bug」。**

举三个我们已经承认的设计错误：

- `escalate` 后 Task 曾错误进入 `awaiting_acceptance` —— 等于把「我不确定」当成「通过」
- 默认 Skill 全是 weak 规则 —— 系统曾经永远无法自动通过任何任务
- 位置防护把影子仓库自己当成了「别人的仓库」——**服务第二次启动必定崩溃**

第三个是**安全检查导致系统不可用**的典型形态。前 18 项修复都测过，
但所有测试都在临时目录里跑完就删，所以永远看不到「第二次启动」。

所以我们更想知道：**还有哪些地方是「看起来对、实际会失效」的？**

---

## 九、本轮最该被质疑的地方

我主动列出五个：

1. **测试通过 ≠ 场景覆盖。** 有两次活证据：
   - 第 19 项：162 个测试全绿的系统，重启即死
   - 第 22 项：`atomicity.test.ts` 的 9 条 Grant 测试全部通过，
     但**审批恢复路径从不消耗 Grant**，`scope=once` 实际可用两次。
     原因是那 9 条只测 `Store` 层，从没问过「两条执行路径是否都调了它」。
2. **大量测试只覆盖单线程顺序执行。** `atomicity.test.ts` 里的并发测试用的是
   `Promise.all`，跑在同一个进程、同一个 SQLite 连接上。**这不等于多进程并发已验证。**
3. **「同一 OS 用户下进程互信」这个假设没被验证。** 认证的实际强度
   完全取决于这一点，而它在桌面应用里很可疑。
4. **认证测试全部跑在本机 loopback 上。** 跨机访问、反向代理、
   非 loopback 监听的**功能**只验证了「能启动」，没验证过真实网络下的行为。
5. **ToolIntent 挡不住「结果未落库」的不确定性，只能让它被诚实记录。**
   本轮加了 Intent 后，崩溃窗口不再导致重复执行，但那是因为
   **系统选择不重试**，不是因为知道副作用一定发生过。
   「unknown 之后由人工对账」仍然是需要人来承担的成本。

**已修复、不再列为缺点的三条**（保留记录，说明我们改过）：

- `paths.test.ts` 三处 `if (!isWin) return` 会让 Windows 专属用例
  在非 Windows 上被记成 passed。现在改为显式 `ctx.skip()`。
- E2E 的 `1 unsupported` 是错标。它本来就不是「平台不支持」，
  而是「我没想到要测」。现在是 7 条真实的 ACL 断言。
- `unsupported > 0` 现在会让退出码非零，不再是一种可接受的结果。

---

## 十、反馈格式（如果方便）

```
【严重度】阻塞 / 重要 / 建议
【位置】文档章节 或 文件:行号
【问题】具体是什么
【为什么】会导致什么后果
【建议】怎么改（可选）
```

不需要客套，直接指出问题即可。

---

## 十一、当前状态

**仍然禁止最终送审。** 硬阻塞从 6 项降到 3 项（ToolIntent 已关闭）。

### 已关闭

| 项 | 状态 |
|---|---|
| H · HTTP 控制面无认证 | ✅ 每实例 bearer token，只有 `/health` 公开 |
| H · `autoApprove` 由请求体控制 | ✅ 字段与入口都删除，出现即 400 |
| J · 无 ToolIntent | ✅ 持久化副作用记录，崩溃后复用结果而不重放 |

### 仍未关闭（3 项）

| 项 | 完整名称 | 问题 |
|---|---|---|
| 1 | 无调用前预算预留（budget reservation） | 单次调用可超支 |
| 2 | 审计者没有收到任务契约（TaskContract） | 可能放过「格式对但内容无关」 |
| 3 | 无证据包（Evidence Bundle） | 审计不可离线回放 |

### 仍未完成的其他项

| 项 | 问题 |
|---|---|
| — | **Grant 扣减与 Intent 状态不在同一事务**（崩溃会浪费一次批准） |
| G | 快照选取用 `find(kind)` 而非 `completionSnapshotId` |
| K | `apply()` 是 check-then-write，有 TOCTOU 窗口 |
| L | Windows 路径未覆盖 junction / `\\?\` / ADS |
| M | Snapshot capture 无工作区锁 |
| — | reconcile 证据校验没有端到端（E2E）覆盖 |

### ToolIntent 的保证边界

**ToolIntent 只能做到「避免已知结果重复执行；未知副作用进入人工对账」。**

**不是 exactly-once。** 实际保证是：

| 场景 | 保证 |
|---|---|
| 副作用已发生 + 结果已落库 + 崩溃 | ✅ 重启后复用结果，不重复执行 |
| 副作用已发生 + 结果未落库 + 崩溃 | ⚠️ 记 unknown，**不自动重试**，需人工对账 |
| 支持幂等键的外部服务 | ✅ 传 `operationKey` 由服务端去重 |
| 不支持幂等键的外部服务 | ❌ 只能 unknown + 人工 |

**「不重复执行」成立，是因为系统选择不重试，不是因为知道副作用一定发生过。**
这个区别很重要——它决定了下一条。

### Grant / Approval 仍有事务缺口

**不能写「完全关闭」。**

| 缺口 | 后果 | 状态 |
|---|---|---|
| Grant 扣减与 Intent 状态不在同一事务 | 崩溃浪费一次批准 | ✅ v0.8 已修（`beginToolAttempt`） |
| Grant 被重复扣减（两处 claim） | 一次调用扣两次额度 | ✅ v0.8 已修 |
| `markApprovalConsumed` 与执行不同事务 | 多一次重放读取 | ✅ 被 committed Intent 挡住 |
| claim / Step / Approval 三处写入无事务 | 极端情况下状态不一致 | ⚠️ **部分原子化** |

**当前状态：部分原子化。Grant / Intent / Step 的事务仍未完全闭合。**

`beginToolAttempt` 只覆盖**进入 started 之前**的准备工作。
进入 started 之后要调外部工具，SQLite 无法与之组成原子事务，
那之后崩溃只能记 unknown。

**v0.9 补的验证**：`tx-boundary.test.ts` 用真实故障注入证明了这个边界——
事务提交前失败则全部回滚，提交后崩溃则 Intent=started 且 sweep 成 unknown。
上一版那几条「手工 claim 后崩溃」的测试已删除，因为它们构造的状态
在事务下不可能出现。

### 认证自身的残留风险

见 §14.2。核心一条：**localhost 不是认证机制**，
同一 OS 用户下的恶意进程能读到 token 文件。

---

**可以做**：本地单用户、可信环境下的内部试用。
**不能做**：多人共用（单 token 无主体区分）、处理敏感数据、
声称外部副作用 exactly-once、声称审计可离线回放、
声称对同用户的其他进程安全。
