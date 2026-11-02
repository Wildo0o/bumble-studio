# 测试输出

生成时间：2026-10-31T03:38:04+08:00

运行命令：`npx vitest run`

退出码：0

```

[1m[46m RUN [49m[22m [36mv3.2.7 [39m[90mG:/AI/ai-workstation[39m

 [32m✓[39m src/core/__tests__/intent-scenarios.test.ts [2m([22m[2m11 tests[22m[2m)[22m[33m 797[2mms[22m[39m
   [33m[2m✓[22m[39m 副作用语义：10 个场景[2m > [22m4. 超时后底层写入晚到：记 unknown，晚到不改变状态 [33m 372[2mms[22m[39m
 [32m✓[39m src/core/__tests__/side-effect.test.ts [2m([22m[2m14 tests[22m[2m)[22m[33m 827[2mms[22m[39m
   [33m[2m✓[22m[39m 副作用能力声明[2m > [22m有副作用（sideEffect=external）：超时后必须记 unknown 并建 Intent [33m 392[2mms[22m[39m
   [33m[2m✓[22m[39m 副作用能力声明[2m > [22m同一 toolCallId 在 sideEffect=external 下重复执行不会产生第二个 Intent [33m 364[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-f-acceptance.test.ts [2m([22m[2m15 tests[22m[2m)[22m[33m 988[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 F：验收与交付[2m > [22m导出失败时明确报错（快照不存在） [33m 583[2mms[22m[39m
 [32m✓[39m src/core/__tests__/intent-store.test.ts [2m([22m[2m15 tests[22m[2m)[22m[33m 351[2mms[22m[39m
 [32m✓[39m src/core/__tests__/reconcile-semantics.test.ts [2m([22m[2m12 tests[22m[2m)[22m[33m 402[2mms[22m[39m
 [32m✓[39m src/core/__tests__/intent-crashpoints.test.ts [2m([22m[2m7 tests[22m[2m)[22m[33m 659[2mms[22m[39m
   [33m[2m✓[22m[39m 六个崩溃点[2m > [22mF. 超时后底层完成：Intent 保持 unknown，文件被晚到写入，不产生第二次执行 [33m 382[2mms[22m[39m
 [32m✓[39m src/core/__tests__/tool-intent.test.ts [2m([22m[2m5 tests[22m[2m)[22m[33m 2029[2mms[22m[39m
   [33m[2m✓[22m[39m ToolIntent：副作用执行语义[2m > [22m超时后底层写操作仍会落盘，但系统必须记为 unknown（不能记 failed） [33m 524[2mms[22m[39m
   [33m[2m✓[22m[39m ToolIntent：副作用执行语义[2m > [22m超时后的晚到结果不得让模型继续循环（不能当普通错误字符串返回） [33m 508[2mms[22m[39m
   [33m[2m✓[22m[39m ToolIntent：副作用执行语义[2m > [22munknown 状态下重复 execute 必须被状态门拦住，不得重放工具 [33m 902[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-c.test.ts [2m([22m[2m4 tests[22m[2m)[22m[33m 438[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-d-lifecycle.test.ts [2m([22m[2m9 tests[22m[2m)[22m[33m 356[2mms[22m[39m
 [32m✓[39m src/core/__tests__/state-gate.test.ts [2m([22m[2m12 tests[22m[2m)[22m[33m 361[2mms[22m[39m
 [32m✓[39m src/server/__tests__/token-file.test.ts [2m([22m[2m3 tests[22m[2m)[22m[33m 656[2mms[22m[39m
   [33m[2m✓[22m[39m token 文件的访问控制[2m > [22m已存在的 token 文件会被重新收紧权限 [33m 393[2mms[22m[39m
 [32m✓[39m src/server/__tests__/routes.test.ts [2m([22m[2m11 tests[22m[2m)[22m[33m 3602[2mms[22m[39m
   [33m[2m✓[22m[39m 路由清单[2m > [22m每一条需要认证的路由，无 token 时都返回 401 [33m 736[2mms[22m[39m
   [33m[2m✓[22m[39m 路由清单[2m > [22m每一条需要认证的路由，错 token 时都返回 401 [33m 645[2mms[22m[39m
 [32m✓[39m src/core/__tests__/reconcile-evidence.test.ts [2m([22m[2m8 tests[22m[2m)[22m[33m 326[2mms[22m[39m
 [32m✓[39m src/core/__tests__/atomicity.test.ts [2m([22m[2m9 tests[22m[2m)[22m[32m 282[2mms[22m[39m
 [32m✓[39m src/core/__tests__/toolcall-uniqueness.test.ts [2m([22m[2m7 tests[22m[2m)[22m[32m 265[2mms[22m[39m
 [32m✓[39m src/core/__tests__/tx-boundary.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 232[2mms[22m[39m
 [32m✓[39m src/core/__tests__/reconcile-binding.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 210[2mms[22m[39m
 [32m✓[39m src/core/__tests__/intent-order.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 240[2mms[22m[39m
 [32m✓[39m src/core/__tests__/model-identity.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 193[2mms[22m[39m
 [32m✓[39m src/core/__tests__/grant-consumption.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 173[2mms[22m[39m
 [32m✓[39m src/core/__tests__/attempt-atomicity.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 151[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-b.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 147[2mms[22m[39m
 [32m✓[39m src/core/__tests__/intent-crash.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 123[2mms[22m[39m
 [32m✓[39m src/core/__tests__/paths.test.ts [2m([22m[2m14 tests[22m[2m)[22m[32m 87[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-g-audit.test.ts [2m([22m[2m16 tests[22m[2m)[22m[32m 13[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-a.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 106[2mms[22m[39m
 [32m✓[39m src/core/__tests__/invariants.test.ts [2m([22m[2m29 tests[22m[2m)[22m[33m 6354[2mms[22m[39m
   [33m[2m✓[22m[39m 不变量 4：apply 必须真正写入文件[2m > [22m工作区漂移时 apply 必须报冲突，不得静默覆盖 [33m 1366[2mms[22m[39m
   [33m[2m✓[22m[39m 不变量 4：apply 必须真正写入文件[2m > [22m工作区一致时 apply 必须真正写入并校验 [33m 1598[2mms[22m[39m
   [33m[2m✓[22m[39m 不变量 4：apply 必须真正写入文件[2m > [22m目标不存在时 apply 必须创建文件 [33m 1488[2mms[22m[39m
   [33m[2m✓[22m[39m 不变量 5：export 必须读已验收快照而非当前工作区[2m > [22mexport 出的内容必须等于已验收快照，不是当前工作区 [33m 1263[2mms[22m[39m
 [32m✓[39m src/server/__tests__/auth.test.ts [2m([22m[2m33 tests[22m[2m)[22m[33m 6713[2mms[22m[39m
   [33m[2m✓[22m[39m 认证失败不产生副作用[2m > [22m未认证的 approve 不会创建 Grant [33m 385[2mms[22m[39m
   [33m[2m✓[22m[39m autoApprove 权限来源[2m > [22m请求体携带 autoApprove 直接 400，而不是被静默忽略 [33m 333[2mms[22m[39m
   [33m[2m✓[22m[39m autoApprove 权限来源[2m > [22m已认证但没有 Grant 时，write_file 仍进入 waiting_approval [33m 332[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-e-artifact.test.ts [2m([22m[2m6 tests[22m[2m)[22m[33m 8082[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 E：产物与快照[2m > [22mRun 完成时自动拍快照并为文件生成 Artifact [33m 1547[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 E：产物与快照[2m > [22m返工产生新版本，不原地覆盖 [33m 2572[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 E：产物与快照[2m > [22m内容未变时不产生重复 Artifact [33m 2216[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 E：产物与快照[2m > [22mTask 下的产物可以跨 Run 查询并保持版本链 [33m 1699[2mms[22m[39m
 [32m✓[39m src/server/__tests__/startup.test.ts [2m([22m[2m3 tests[22m[2m)[22m[33m 8482[2mms[22m[39m
   [33m[2m✓[22m[39m 非 loopback 监听必须配认证[2m > [22mHOST=0.0.0.0 且没有 AUTH_TOKEN 时拒绝启动 [33m 328[2mms[22m[39m
   [33m[2m✓[22m[39m 非 loopback 监听必须配认证[2m > [22mHOST=0.0.0.0 且有 AUTH_TOKEN 时能启动并生成 token 文件之外的凭据 [33m 4076[2mms[22m[39m
   [33m[2m✓[22m[39m 非 loopback 监听必须配认证[2m > [22m自动生成的 token 不会打印到日志，但会写进 0600 文件 [33m 4077[2mms[22m[39m
 [32m✓[39m src/core/__tests__/case-h-reviewloop.test.ts [2m([22m[2m14 tests[22m[2m)[22m[33m 14310[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m审计通过时返回 passed [33m 1522[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22mreject 生成 ReworkBrief，包含阻断问题与冻结规则 [33m 1609[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m返工说明文本包含关键信息 [33m 1663[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m产物属于别的 Task 时审计必须拒绝 [33m 1200[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m产物关联的快照不是本 Cycle 审计的快照时拒绝 [33m 970[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m并发创建 Cycle 时 cycle_number 不重复 [33m 920[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m同一 Task 下 cycle_number 有唯一约束 [33m 931[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m达到 maxCycles 后不再创建新 Cycle [33m 859[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22mCycle 状态由关联对象推导，不存独立 status [33m 993[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m审计结果可持久化并在重启后查询 [33m 1022[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m同族模型审计时降级为 escalate [33m 972[2mms[22m[39m
   [33m[2m✓[22m[39m 用例 H：ReviewLoop[2m > [22m回归检测：上一轮通过的规则本轮失败 [33m 1588[2mms[22m[39m
 [32m✓[39m src/core/__tests__/snapshot.test.ts [2m([22m[2m22 tests[22m[2m)[22m[33m 21424[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m影子仓库已经存在时，再次构造必须成功（服务重启） [33m 1214[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m重启后的实例能继续拍快照并沿用历史链 [33m 2670[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m指认的仓库是影子仓库自己时放行，是别人的仓库时仍要拒绝 [33m 1468[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m快照能捕获文件并记录数量与大小 [33m 1040[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m恢复能还原到快照时刻 [33m 1765[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m恢复会删除快照里不存在的文件 [33m 1578[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m恢复不存在的快照会失败而不是破坏工作区 [33m 362[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22mdiff 能算出两次快照的差异 [33m 1481[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m能读取快照里某个文件的历史内容 [33m 966[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m读取文件时必须保留末尾换行 [33m 966[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m读取文件时必须保留前导空白与空行 [33m 904[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22mlistFiles 返回快照内的文件清单 [33m 902[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m不污染工作区自身的 git 仓库 [33m 1245[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m连续快照形成可比较的历史链 [33m 2030[2mms[22m[39m
   [33m[2m✓[22m[39m 快照与恢复[2m > [22m恢复后再次快照，内容与目标快照一致 [33m 2309[2mms[22m[39m

[2m Test Files [22m [1m[32m32 passed[39m[22m[90m (32)[39m
[2m      Tests [22m [1m[32m316 passed[39m[22m[90m (316)[39m
[2m   Start at [22m 03:37:41
[2m   Duration [22m 22.56s[2m (transform 2.09s, setup 0ms, collect 6.59s, tests 79.38s, environment 9ms, prepare 6.25s)[22m

```
