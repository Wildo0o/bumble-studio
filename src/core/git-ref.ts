// Git ref 参数校验。
//
// 问题：`from` / `to` 这类值会被拼进 git 命令行参数。
// 直接传用户输入会带来两类攻击：
//
//   1. **参数注入**：`--output=/etc/x` 会被 git 当成选项而不是 ref。
//      同理 `--exec=...`（在某些子命令下会执行命令）、`-p` 等短选项。
//   2. **引用不存在 / 模糊**：`HEAD~1000000`、`@{-1}` 之类的 rev 语法
//      会遍历提交图，在超大仓库上是拒绝服务面。
//
// 正确做法是**白名单式**校验，而不是黑名单过滤：
//   只接受两种形态——
//     · 完整 40 / 64 位十六进制 commit hash
//     · 数据库里存在的 snapshot ref（由调用方查库确认）
//
// 任何以 `-` 开头、含空白、含 `..`、含 shell 元字符的值一律拒绝。

/** 完整 commit hash：40 位（SHA-1）或 64 位（SHA-256）。 */
const FULL_HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i

export type RefCheck =
  | { ok: true; ref: string; kind: 'hash' | 'snapshot-ref' }
  | { ok: false; reason: string }

/**
 * 形态校验（不查库）。
 *
 * @param value 待校验的 ref 文本
 * @param knownRefs 允许的 snapshot ref 集合（来自数据库）
 */
export function validateGitRef(value: unknown, knownRefs: ReadonlySet<string>): RefCheck {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'ref 必须是字符串' }
  }
  const ref = value.trim()
  if (!ref) return { ok: false, reason: 'ref 不能为空' }

  // ── 拒绝所有看起来像选项的值 ──────────────────────────
  //
  // 这是最关键的一条：git 把 `-` 开头的参数当选项。
  // 无论内容多「合法」，只要以 - 开头就不能进命令行。
  if (ref.startsWith('-')) {
    return { ok: false, reason: 'ref 不能以 - 开头（会被当成 git 选项）' }
  }

  // 控制字符 / 空白：会被 shell 或 git 参数拆分
  if (/[\u0000-\u0020\u007f]/.test(ref)) {
    return { ok: false, reason: 'ref 不能包含空白或控制字符' }
  }

  // rev 语法与路径成分：`..`、`~`、`^`、`@{}` 会遍历提交图
  if (/\.\.|~|\^|@\{/.test(ref)) {
    return { ok: false, reason: 'ref 不能包含 rev 语法（.. ~ ^ @{）' }
  }

  // shell 元字符（虽然我们不走 shell，但拒绝它们能防住未来的实现变更）
  if (/[;&|$`<>(){}[\]*?!\\]/.test(ref)) {
    return { ok: false, reason: 'ref 不能包含 shell 元字符' }
  }

  // ── 白名单：完整 hash 或已知 snapshot ref ────────────
  if (FULL_HASH.test(ref)) {
    return { ok: true, ref, kind: 'hash' }
  }

  if (knownRefs.has(ref)) {
    return { ok: true, ref, kind: 'snapshot-ref' }
  }

  return {
    ok: false,
    reason:
      'ref 不在允许范围内：只接受完整 commit hash（40/64 位十六进制）' +
      '或数据库中存在的快照 ref',
  }
}

/** 便捷版：已知 refs 从快照表构造。 */
export function knownSnapshotRefs(
  snapshots: ReadonlyArray<{ ref: string }>,
): Set<string> {
  return new Set(snapshots.map((s) => s.ref))
}
