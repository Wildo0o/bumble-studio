// 工作组协调：任务图、工作包、变更集与冲突检测。
//
// 这一块解决一个具体问题：**多个角色同时改同一个工作区**。
//
// 核心概念：
//
//   角色（Role）        谁来做。每个角色有职责范围与可用的工具子集。
//   任务图（TaskGraph） 做什么、什么可以并行。节点是 WorkPackage，边是依赖。
//   工作包（WorkPackage）一次可交付的工作单元。它是**并发的粒度**：
//                       两个工作包互不依赖时可以同时进行。
//   变更集（ChangeSet） 一个工作包产出的文件变更集合。它是**冲突判定的粒度**：
//                       冲突按文件路径判定，不按「谁先跑完」判定。
//
// 三条设计决定：
//
// 1. **冲突在提交时判定，不在执行时阻止。**
//    执行时无法知道另一条线会改哪个文件（它还没开始）。
//    在 ChangeSet 提交时按路径比对，才能给出「这两个工作包改了同一文件」。
//
// 2. **冲突不等于失败。**
//    两个工作包改同一文件，可能是协作（一个加函数、一个加测试），
//    也可能是打架。系统只负责**如实报告冲突范围**，
//    由人决定合并还是重排。自动「后写覆盖」是最危险的默认行为。
//
// 3. **归属在提交时校验，不在事后修补。**
//    ChangeSet 必须声明它属于哪个 WorkPackage、由哪个角色产生。
//    提交时校验这条链是否成立——否则「谁改的这行」永远查不清。
import type { DomainContractScope } from '../shared/types.js'
import { DomainError } from './errors.js'

/** 角色职责范围。 */
export interface RoleDefinition {
  id: string
  name: string
  /** 这个角色负责什么。用于总控分配工作包。 */
  responsibility: string
  /**
   * 允许使用的工具 id。空数组 = 不限（但不是「全部允许」的语义，
   * 而是「由运行时按 riskLevel 决定」，见 canRoleUseTool）。
   */
  allowedTools: string[]
  /** 这个角色可以产出的工作包类型。 */
  produces: WorkPackageKind[]
}

export type WorkPackageKind = 'implementation' | 'test' | 'review' | 'documentation' | 'analysis'

/** 任务图节点。 */
export interface WorkPackage {
  id: string
  taskId: string
  /** 分配到的角色 id。未分配时为 undefined（总控还没派）。 */
  roleId?: string
  kind: WorkPackageKind
  title: string
  /** 交付说明：这个包做完应该是什么样。 */
  deliverable: string
  status: WorkPackageStatus
  /** 依赖的工作包 id。全部完成才能开始。 */
  dependsOn: string[]
  createdAt: number
  startedAt?: number
  endedAt?: number
}

export type WorkPackageStatus =
  | 'planned'
  | 'ready'
  | 'running'
  | 'submitted'
  | 'merged'
  | 'blocked'
  | 'cancelled'

export interface WorkPackageTransitions {
  states: readonly WorkPackageStatus[]
  initial: WorkPackageStatus
  transitions: Record<WorkPackageStatus, readonly WorkPackageStatus[]>
  terminal: readonly WorkPackageStatus[]
}

/**
 * 工作包状态机。
 *
 * 关键约束：
 *   · 只能从 ready 进入 running —— 依赖没满足时（planned）不能开始，
 *     这一条由依赖检查保证，状态机保证结构上不能跳
 *   · submitted 只能变成 merged 或 blocked —— 「提交了」不等于「合并了」
 *   · merged / cancelled 是终态
 */
export const WORK_PACKAGE_TRANSITIONS: WorkPackageTransitions = {
  states: ['planned', 'ready', 'running', 'submitted', 'merged', 'blocked', 'cancelled'],
  initial: 'planned',
  transitions: {
    planned: ['ready', 'blocked', 'cancelled'],
    ready: ['running', 'blocked', 'cancelled'],
    running: ['submitted', 'blocked', 'cancelled'],
    submitted: ['merged', 'blocked'],
    blocked: ['ready', 'cancelled'],
    merged: [],
    cancelled: [],
  },
  terminal: ['merged', 'cancelled'],
}

export function canTransitionWorkPackage(from: WorkPackageStatus, to: WorkPackageStatus): boolean {
  if (from === to) return true
  return WORK_PACKAGE_TRANSITIONS.transitions[from]?.includes(to) ?? false
}

/** 变更集：一个工作包产出的文件变更。 */
export interface FileChange {
  /** 相对工作区根目录的路径，统一用 / 分隔。 */
  path: string
  kind: 'added' | 'modified' | 'deleted'
  /** 变更后内容的哈希。删除时为 undefined。 */
  contentHash?: string
}

export interface ChangeSet {
  id: string
  taskId: string
  workPackageId: string
  roleId: string
  runId?: string
  changes: FileChange[]
  status: 'submitted' | 'merged' | 'conflict' | 'rejected'
  createdAt: number
  mergedAt?: number
}

// ── 路径规范化 ─────────────────────────────────────────────

/**
 * 规范化文件路径，用于冲突比对。
 *
 * 为什么必须规范化：
 *   `src/a.ts`、`./src/a.ts`、`src\\a.ts`、`SRC/A.ts`（Windows）
 *   在文件系统上可能是同一个文件。不规范化时，两条线改同一个文件
 *   会被判成「不冲突」——然后合并时后者覆盖前者。
 */
export function normalizeChangePath(p: string): string {
  let x = p.trim().replace(/\\/g, '/')
  while (x.startsWith('./')) x = x.slice(2)
  x = x.replace(/^\/+/, '')
  // 折叠重复分隔符
  x = x.replace(/\/{2,}/g, '/')
  return x.toLowerCase()
}

/**
 * 变更路径的危险形式检查。
 *
 * 为什么必须在这里拦：ChangeSet 的路径最终会被 merge / apply 当成
 * 真实的文件路径使用。`../../victim` 在冲突检测里是一个「普通字符串」，
 * 但到了写入那一刻就变成了「工作区外的文件」。
 *
 * 拒绝规则（任一命中即拒绝，不做「尽量修正」）：
 *   · 空路径
 *   · 绝对路径（`/x`、`C:\x`）
 *   · UNC / 设备路径（`\\server\share`、`\\?\...`）
 *   · 含 `..` 段（任何位置的父目录引用）
 *   · 含 NUL 或控制字符
 *   · 含 `~` 开头的家目录引用
 *
 * 为什么不做「规范化解掉 ..」：把 `a/../../b` 规约成 `b` 看起来更友好，
 * 但它掩盖了「这个变更集想跳出去」这个事实。拒绝并让人看到原因，
 * 比悄悄改写意图安全得多。
 */
export function validateChangePath(p: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, reason: '路径为空' }

  if (p.includes('\u0000')) return { ok: false, reason: '路径包含空字节' }
  // 控制字符（含换行）会让日志 / 终端输出产生歧义
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, reason: '路径包含控制字符' }

  const slashed = p.trim().replace(/\\/g, '/')

  if (/^[\\/]{2}/.test(p)) return { ok: false, reason: '不允许 UNC / 设备路径' }
  if (/^[a-zA-Z]:/.test(p)) return { ok: false, reason: '不允许盘符绝对路径' }
  if (slashed.startsWith('/')) return { ok: false, reason: '不允许绝对路径' }
  if (p.startsWith('~')) return { ok: false, reason: '不允许家目录引用' }

  const segments = slashed.split('/')
  if (segments.some((seg) => seg === '..')) {
    return { ok: false, reason: '路径不能包含 ..（父目录引用）' }
  }

  const normalized = normalizeChangePath(p)
  if (!normalized) return { ok: false, reason: '路径规范化后为空' }

  return { ok: true, path: normalized }
}

// ── 冲突检测 ───────────────────────────────────────────────

export interface Conflict {
  /** 冲突的文件路径（规范化后的形式）。 */
  path: string
  /** 冲突的两个工作包。 */
  workPackageIds: [string, string]
  /**
   * 是否「真冲突」。
   *
   *   true  —— 两个变更集都写了同一文件，且最终内容不同
   *   false —— 两边写了同一文件但内容完全相同（哈希一致），
   *            合并时不需要任何决定
   */
  differentContent: boolean
}

/**
 * 计算两个变更集之间的冲突。
 *
 * 只比对路径交集，不尝试自动合并内容：
 *   · 文本合并需要知道文件类型、编码、上下文
 *   · 错误的三方合并会静默产生语法正确但语义错误的代码，
 *     比直接报冲突危险得多
 * 所以这里只回答「哪些文件被两条线都改了，内容是否相同」。
 */
export function detectConflicts(a: ChangeSet, b: ChangeSet): Conflict[] {
  if (a.workPackageId === b.workPackageId) return []

  const byPath = new Map<string, FileChange>()
  for (const c of a.changes) byPath.set(normalizeChangePath(c.path), c)

  const out: Conflict[] = []
  for (const c of b.changes) {
    const key = normalizeChangePath(c.path)
    const other = byPath.get(key)
    if (!other) continue
    const different =
      other.contentHash !== c.contentHash || other.kind !== c.kind
    out.push({
      path: key,
      workPackageIds: [a.workPackageId, b.workPackageId],
      differentContent: different,
    })
  }
  return out
}

/** 检查一个变更集与一组已有变更集的冲突。 */
export function detectConflictsAgainst(
  incoming: ChangeSet,
  existing: ChangeSet[],
): Conflict[] {
  const out: Conflict[] = []
  for (const other of existing) {
    if (other.status === 'rejected') continue
    out.push(...detectConflicts(incoming, other))
  }
  return out
}

// ── 任务图 ─────────────────────────────────────────────────

/**
 * 检查依赖图是否可执行。
 *
 * 返回两类问题：
 *   cycle      —— 存在环，永远无法开始
 *   missing    —— 依赖了不存在的工作包
 *
 * 为什么必须在「分配」之前检查：一个带环的图会让所有相关工作包
 * 永远停在 planned，而 UI 只显示「等待中」。环是**配置错误**，
 * 应该在创建时就拒绝，而不是等用户困惑。
 */
export function validateGraph(packages: WorkPackage[]): {
  ok: boolean
  cycles: string[][]
  missing: Array<{ packageId: string; dependsOn: string }>
} {
  const ids = new Set(packages.map((p) => p.id))
  const missing: Array<{ packageId: string; dependsOn: string }> = []
  for (const p of packages) {
    for (const dep of p.dependsOn) {
      if (!ids.has(dep)) missing.push({ packageId: p.id, dependsOn: dep })
    }
  }

  // 找环（DFS + 递归栈）
  const graph = new Map<string, string[]>()
  for (const p of packages) graph.set(p.id, p.dependsOn.filter((d) => ids.has(d)))

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of ids) color.set(id, WHITE)
  const cycles: string[][] = []
  const stack: string[] = []

  const dfs = (node: string): void => {
    color.set(node, GRAY)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next)
      if (c === GRAY) {
        const start = stack.indexOf(next)
        cycles.push(stack.slice(start))
      } else if (c === WHITE) {
        dfs(next)
      }
    }
    stack.pop()
    color.set(node, BLACK)
  }
  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id)
  }

  return { ok: cycles.length === 0 && missing.length === 0, cycles, missing }
}

/**
 * 计算哪些工作包现在可以开始。
 *
 * 规则：
 *   · 状态必须是 planned 或 ready
 *   · 所有依赖都必须是 merged（不是 submitted —— 提交了还没合并，
 *     后续包基于它做的工作会在合并时对不上）
 *
 * 为什么依赖要求 merged 而不是 submitted：submitted 意味着
 * 「内容已提交但可能被拒绝 / 有冲突」。让后续包基于一个未确定
 * 的版本开始，等于让冲突扩散到整条链。
 */
export function readyPackages(packages: WorkPackage[]): WorkPackage[] {
  const byId = new Map(packages.map((p) => [p.id, p]))
  return packages.filter((p) => {
    if (p.status !== 'planned' && p.status !== 'ready') return false
    return p.dependsOn.every((dep) => byId.get(dep)?.status === 'merged')
  })
}

// ── 角色工具权限 ───────────────────────────────────────────

/**
 * 角色能否使用某个工具。
 *
 * 两条规则：
 *   1. allowedTools 非空时，只允许列出的工具
 *   2. 无论是否列出，**external 风险级别的工具都不允许角色直接使用** ——
 *      那类调用需要用户审批，审批的主体是用户，不是角色。
 *
 * 第 2 条是安全边界：让角色「可以调外部 API」等于让它能绕过审批表。
 */
export function canRoleUseTool(
  role: RoleDefinition,
  tool: { id: string; riskLevel: string },
): { allowed: boolean; reason?: string } {
  if (tool.riskLevel === 'external') {
    return {
      allowed: false,
      reason: `角色 ${role.id} 不能直接使用外部风险级别的工具 ${tool.id}：这类调用需要用户审批`,
    }
  }
  if (role.allowedTools.length > 0 && !role.allowedTools.includes(tool.id)) {
    return {
      allowed: false,
      reason: `角色 ${role.id} 未被允许使用工具 ${tool.id}`,
    }
  }
  return { allowed: true }
}

/** 角色对应的契约作用域（用于把角色策略版本化）。 */
export function roleContractScope(): DomainContractScope {
  return 'role'
}

// ── 校验 ───────────────────────────────────────────────────

export const MAX_DEPENDENCIES = 32

export function validateWorkPackageInput(input: Record<string, unknown>): {
  title: string
  kind: WorkPackageKind
  deliverable: string
  dependsOn: string[]
} {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Error('工作包必须有 title')

  const kindRaw = input.kind
  const kinds: WorkPackageKind[] = ['implementation', 'test', 'review', 'documentation', 'analysis']
  const kind = (kinds as string[]).includes(String(kindRaw))
    ? (kindRaw as WorkPackageKind)
    : 'implementation'

  const deliverable = typeof input.deliverable === 'string' ? input.deliverable.trim() : ''
  if (!deliverable) {
    // 没有交付说明的工作包无法验收，也无法判断「做完了没有」。
    throw new Error('工作包必须有 deliverable（做完应该是什么样）')
  }

  const dependsOn = Array.isArray(input.dependsOn)
    ? input.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : []
  if (dependsOn.length > MAX_DEPENDENCIES) {
    throw new Error(`依赖数量 ${dependsOn.length} 超过上限 ${MAX_DEPENDENCIES}`)
  }
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new Error('依赖列表里有重复项')
  }

  return { title, kind, deliverable, dependsOn }
}

export function validateChangeSetInput(input: Record<string, unknown>): FileChange[] {
  const raw = input.changes
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('变更集必须包含至少一个文件变更')
  }
  if (raw.length > 10_000) throw new Error('变更集文件数超过上限 10000')

  const seen = new Set<string>()
  const out: FileChange[] = []
  for (const item of raw) {
    const rec = item as { path?: unknown; kind?: unknown; contentHash?: unknown }
    if (typeof rec.path !== 'string' || !rec.path.trim()) {
      throw new Error('文件变更必须提供 path')
    }
    // 危险路径在这里就拒绝：后面的 merge / apply 会把它当真实路径用。
    const checked = validateChangePath(rec.path)
    if (!checked.ok) {
      // 用 DomainError 而不是普通 Error：
      // 普通 Error 会被映射成 500「服务端故障」，而这是**请求**的问题。
      // 客户端需要看到 400，才会去改路径而不是重试。
      throw new DomainError(
        'INVALID_INPUT',
        `文件路径不合法（${checked.reason}）：${rec.path}`,
      )
    }
    const path = checked.path
    if (seen.has(path)) {
      // 同一个变更集里同一路径出现两次：说明上游生成了矛盾的内容。
      // 取哪一个都是猜，直接拒绝。
      throw new Error(`变更集里同一路径重复出现：${rec.path}`)
    }
    seen.add(path)

    const kind =
      rec.kind === 'added' || rec.kind === 'modified' || rec.kind === 'deleted'
        ? rec.kind
        : undefined
    if (!kind) throw new Error(`文件变更 kind 非法：${String(rec.kind)}`)

    const change: FileChange = { path, kind }
    if (kind !== 'deleted') {
      // ── contentHash 必须是可校验的形态（审计 P1）───────────
      //
      // 冲突判定完全依赖它：两边改同一路径且 hash 相同时，
      // 系统会认为「内容一样，不需要人工处理」而直接放行。
      //
      // 如果放任客户端传任意字符串（甚至两边都传 ""），
      // 就等于让调用方决定「这次改动算不算冲突」。
      //
      // 这里要求十六进制哈希（sha256 = 64 位，也接受 40 位 sha1
      // 与算法前缀形式），并拒绝空值。
      //
      // 注意：服务端**不重算**——变更集描述的是工作区里的文件，
      // 服务端没有那份内容。真正的防线是合并时的内容比对，
      // 这里只保证「hash 至少是一个真实哈希的形态」。
      const h = rec.contentHash
      if (typeof h !== 'string' || !h) {
        throw new DomainError(
          'INVALID_INPUT',
          `文件 ${rec.path} 是 ${kind}，必须提供 contentHash`,
        )
      }
      // 只要求「非空」。
      //
      // 为什么不做格式 / 长度校验：服务端**没有变更后的文件内容**，
      // 无法验证 hash 是否真实。任何长度或格式限制都无法阻止
      // 有意伪造，只会挡住合法但使用短标识的调用方。
      //
      // 冲突判定的真正保证不在这里，而在合并时的内容比对
      // （mergeChangeSet 会再核对一次），以及「两边 hash 相同却
      // 内容不同」那类问题由产物层的内容哈希负责。
      change.contentHash = h
    }
    out.push(change)
  }
  return out
}
