# L3 / L4 / L5 Backlog

本文件只登记，**不实现**。每项都写明「为什么不在 L2 做」以及「什么条件下才该动它」。

L2 的边界是：单机、单用户、本地场景，八个核心区块主要功能通过真实
HTTP/服务入口运行，核心状态不永久卡死。

---

## L3：跨环境与多进程（本地多实例 / 跨平台）

| 项 | 现状 | 为什么不在 L2 | 完成判据 |
|---|---|---|---|
| **Windows provider-secrets 真实 ACL** | 仅 `chmod 0600`（Windows 上是 no-op）；文件仍受目录 ACL 保护 | 需要用 `icacls` 设置并读回 DACL 验证，非管理员环境不可靠；L2 场景是单用户本机 | 写入后用 `icacls /save` 或 Win32 API 验证只有当前用户可读；验证失败必须 fail-closed |
| **IPv4-mapped IPv6 / DNS rebinding** | `isPrivateHost` 覆盖 `::ffff:a.b.c.d`；但不做「解析后按 IP 校验」 | Node 的 `fetch` 不支持自定义 `lookup`，要彻底防必须在连接层固定 IP（需要自建 http agent 或用 socket 直连） | 建立连接前解析并绑定 IP；或改用支持 `dnsLookup` 的 HTTP 客户端 |
| **完整多进程 lease fencing** | epoch 已是全局单调计数器 + 条件写；单进程内可靠 | 多进程需要跨进程验证（真实并发进程、时钟偏移、SQLite 锁竞争）；L2 是单机单实例 | 两个真实进程并发抢同一 Run 的实现与测试；时钟偏移下的过期判定 |
| **Snapshot junction / reparse-point 完整防护** | 用 `lstat.isSymbolicLink()` 识别；junction 也是 true | Windows reparse point 种类多（mount point、OneDrive 占位符、AppExecLink），需要逐类验证；Linux 上是 `btrfs` 子卷 | 覆盖每类 reparse tag；跨平台测试矩阵 |
| **Snapshot GC 长期 Git 对象设计** | `reclaimObjects` 用临时 keep ref + `gc --prune=now`；多 keepRefs 已串联成链 | 大仓库（十万级提交）的 gc 耗时与内存未验证；`commit-tree` 串联会改变历史形态 | 在真实大仓上验证耗时、内存、以及「保留 N 个快照后仍可逐个 listFiles」 |
| **Migration 历史数据保留** | v10–v18 只做加列 / 回填，不删数据 | 长期演进会出现「字段语义变化」而非「新增字段」，那需要显式的数据迁移与回滚方案 | 每个破坏性迁移都有 down 路径或在文档里明确「不可回滚」 |

---

## L4：完整安全边界

| 项 | 现状 | 为什么不在 L2 | 完成判据 |
|---|---|---|---|
| **MCP standard streamable HTTP transport** | 只支持 stdio 与简单 HTTP POST | 协议有 SSE 流、session 管理、重连语义；L2 只需「能用 stdio 接一个本地 server」 | 按 MCP 规范实现 SSE 流与会话恢复 |
| **MCP timeout → unknown/reconciliation** | 超时返回 `CAPABILITY_UNAVAILABLE`，工具层记为失败 | 「超时」与「明确失败」在语义上不同（外部副作用可能已发生），需要接入现有的 Intent 对账链 | MCP 工具调用超时后生成 ToolIntent unknown，进入 needs_reconciliation |
| **MCP DNS rebinding 完整防护** | `redirect: 'error'` + 主机名黑名单 | 同 L3 的 IP 绑定问题 | 同 L3 |
| **Evidence 签名与时间戳** | 哈希链完整（partHashes + bundleHash） | 哈希只能证明「没被改」，不能证明「谁在什么时候签的」；需要非对称签名与可信时间源 | 用 Ed25519 对 bundleHash 签名；签名可离线验证 |
| **审批的独立审计主体** | approver 记 `user` / `system` | 真正的「谁批的」需要身份系统；L2 是单用户，`user` 就是本机用户 | 接入 OS 用户身份或外部 IdP |

---

## L5：生产级运维

| 项 | 现状 | 为什么不在 L2 | 完成判据 |
|---|---|---|---|
| **Soak test** | 无 | 需要连续运行数天，观察内存 / WAL 增长 / 快照累积 | 72h 连续执行 + 内存曲线平稳 + 数据库大小收敛 |
| **Fault injection** | 无 | 需要注入磁盘满、SQLite busy、进程被 kill -9、网络中断 | 每个故障点都有自动化注入 + 状态最终自洽 |
| **跨平台** | 只在 Windows 验证 | 路径分隔符、ACL、进程管理、git 行为都不同 | CI 矩阵覆盖 win32 / linux / darwin |
| **第三方独立审计** | 无（本文件不构成审计） | 需要独立第三方 | 外部审计报告 |
| **可观测性（Pino / OpenTelemetry）** | 只有 `console.log` | 引入结构化日志与追踪是依赖决策，会改变错误处理与隐私边界 | 结构化日志 + trace 关联 correlationId；敏感字段过滤有测试 |
| **性能基线** | 无 | 需要真实工作负载 | 定义 p50/p95 目标并持续测量 |

---

## 已明确的取舍（不是 backlog，是设计决定）

这些**不会**在后续阶段改：

1. **Workgroup `contentHash` 不做格式校验** —— 服务端没有变更后的文件内容，
   任何格式限制都拦不住有意伪造，只会挡合法调用方。真正的保证在合并时
   的内容比对。
2. **启动体检是全表扫描** —— 只在启动时跑一次。大库上慢是可接受的，
   因为「发现问题」比「启动快 200ms」重要。
3. **Evidence 空规则必须显式 `ruleChecksWaived`** —— 默认 fail-closed。
   纯模型审计需要显式声明，这是刻意的摩擦。
4. **`paused` 不在执行入口里** —— 必须有人明确 resume。这让「暂停」
   真的停住，而不是被下一轮调度悄悄重启。
