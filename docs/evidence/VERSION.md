# 证据基线

生成时间：2026-10-31T03:37:38+08:00

> ⚠️ **这是 dirty-tree manifest，不是 commit 可复现证据。**
>
> 下面记录的 commit 是 HEAD，但源码哈希是对**当前工作树**算的。
> 工作树相对 HEAD 有 47 项未提交改动，
> 只 checkout 该 commit 无法复现相同的哈希。
> 审计方应直接对收到的源码目录重算哈希，而不是从 git 取。

## Git

```
commit:    11a35e3970bca9132370efdf7ba1af90e9d7aa18
branch:    master
dirty:     47 个未提交改动
工作树状态: 不干净（哈希只对当前工作树有效）
```

## 工作树偏离 HEAD 的文件

```
 M .gitignore
 M docs/AUDIT-README.md
 D docs/AUDIT-SUBMISSION-v2.md
 D docs/AUDIT-SUBMISSION.md
 M docs/evidence/SOURCE-HASHES.md
 M docs/evidence/TEST-OUTPUT.md
 M docs/evidence/VERSION.md
 M scripts/e2e-reviewloop.mjs
 M scripts/evidence-baseline.sh
 M src/core/__tests__/case-b.test.ts
 M src/core/__tests__/case-c.test.ts
 M src/core/__tests__/case-d-lifecycle.test.ts
 M src/core/__tests__/invariants.test.ts
 M src/core/__tests__/paths.test.ts
 M src/core/__tests__/snapshot.test.ts
 M src/core/acceptance.ts
 M src/core/audit.ts
 M src/core/executor.ts
 M src/core/snapshot.ts
 M src/core/store.ts
 M src/core/tools.ts
 M src/server/index.ts
 M src/shared/types.ts
?? docs/AUDIT-SUBMISSION-v3.md
?? docs/FIX-REPORT-batch4.md
?? docs/archive/
?? src/core/__tests__/atomicity.test.ts
?? src/core/__tests__/attempt-atomicity.test.ts
?? src/core/__tests__/grant-consumption.test.ts
?? src/core/__tests__/intent-crash.test.ts
?? src/core/__tests__/intent-crashpoints.test.ts
?? src/core/__tests__/intent-order.test.ts
?? src/core/__tests__/intent-scenarios.test.ts
?? src/core/__tests__/intent-store.test.ts
?? src/core/__tests__/model-identity.test.ts
?? src/core/__tests__/reconcile-binding.test.ts
?? src/core/__tests__/reconcile-evidence.test.ts
?? src/core/__tests__/reconcile-semantics.test.ts
?? src/core/__tests__/side-effect.test.ts
?? src/core/__tests__/state-gate.test.ts
?? src/core/__tests__/tool-intent.test.ts
?? src/core/__tests__/toolcall-uniqueness.test.ts
?? src/core/__tests__/tx-boundary.test.ts
?? src/server/__tests__/
?? src/server/app.ts
?? src/server/auth.ts
?? src/shared/net.ts
```

## 环境

```
node:    v24.19.0
npm:     11.17.0
os:      MINGW64_NT-10.0-19045 3.6.10-710e5275.x86_64
```
