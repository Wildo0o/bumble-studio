// 快照并发控制、配额与 GC。
//
// 为什么单独一层，而不是塞进 SnapshotManager：
//
// 1. **并发锁**。capture 会改写影子仓库的 HEAD 与 refs，restore 会改写
//    工作区。两个操作同时进行时，快照可能记录下一个「恢复了一半」的
//    工作区，而那份快照看起来完全正常——这是最坏的一类数据损坏：
//    证据链里存着一份无法追溯的错误现场。
//
//    锁的粒度按**工作区**而不是进程：同一工作区只能有一个写操作。
//    读取（listFiles / diff / readFileAt）不加锁——它们不改变状态。
//
// 2. **配额**。快照占磁盘，且随每次 capture 增长。没有配额时，
//    一个循环执行的 Run 能把磁盘写满，之后整机不可用。
//    配额不是「超了就删最旧」——那会删掉可能还在被引用的证据。
//    超配额时**拒绝新的 capture**，并报告需要多少空间。
//
// 3. **GC**。只有既超过保留期、又没被任何记录引用、又不在保留名单里的
//    快照才能删。三者缺一不可。
//
// 这些都是「不可逆操作的保护」：删快照、覆盖工作区都不可回滚。
import { statfs } from 'node:fs'
import { promisify } from 'node:util'
import type { Snapshot } from '../shared/types.js'
import { DomainError } from './errors.js'

const statfsAsync = promisify(statfs)

// ── 并发锁 ─────────────────────────────────────────────────

export type SnapshotLockKind = 'capture' | 'restore' | 'destroy'

interface LockEntry {
  kind: SnapshotLockKind
  holder: string
  acquiredAt: number
}

/**
 * 按资源的互斥锁。
 *
 * 不排队：**立即失败**而不是等待。
 *
 * 为什么：快照 / 恢复可能持续数秒到数分钟。让第二个请求排队等待，
 * 会让 HTTP 连接挂起、超时，然后用户重试——最终同时跑起更多操作。
 * 立即返回 409 并说明「正在进行什么」是更有用的行为。
 */
export class ResourceLock {
  private held = new Map<string, LockEntry>()

  /**
   * 尝试获取锁。
   *
   * @returns 解锁函数；已被占用时抛 STATE_CONFLICT
   */
  acquire(resource: string, kind: SnapshotLockKind, holder = 'request'): () => void {
    const existing = this.held.get(resource)
    if (existing) {
      throw new DomainError(
        'STATE_CONFLICT',
        `该工作区正在执行 ${existing.kind}（开始于 ${new Date(existing.acquiredAt).toISOString()}），` +
        '请等它完成后再试。快照与恢复不能同时进行：' +
        '并发会让快照记录下一个不一致的现场。',
        { details: { resource, kind: existing.kind, since: existing.acquiredAt } },
      )
    }
    this.held.set(resource, { kind, holder, acquiredAt: Date.now() })
    let released = false
    return () => {
      if (released) return
      released = true
      // 只释放自己持有的锁：防止「A 超时后 B 拿到锁，A 的 finally 又把它放掉」
      const current = this.held.get(resource)
      if (current && current.holder === holder) this.held.delete(resource)
    }
  }

  /** 当前占用情况。用于 UI 展示「正在恢复中」。 */
  inspect(resource: string): LockEntry | undefined {
    return this.held.get(resource)
  }

  isLocked(resource: string): boolean {
    return this.held.has(resource)
  }
}

// ── 配额 ───────────────────────────────────────────────────

export interface SnapshotQuota {
  /** 快照总字节上限。 */
  maxTotalBytes: number
  /** 单个快照字节上限。 */
  maxSnapshotBytes: number
  /** 快照数量上限。 */
  maxCount: number
  /**
   * 快照之外还需要预留的磁盘空间。
   *
   * 为什么要留：快照只是磁盘上的一部分。如果快照把盘写满，
   * 数据库写入、日志、临时文件全部失败，连「记录这次失败」都做不到。
   */
  reservedFreeBytes: number
}

export const DEFAULT_QUOTA: SnapshotQuota = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  maxSnapshotBytes: 512 * 1024 * 1024, // 512 MiB
  maxCount: 500,
  reservedFreeBytes: 256 * 1024 * 1024, // 256 MiB
}

export interface QuotaUsage {
  totalBytes: number
  count: number
}

export interface QuotaDecision {
  allowed: boolean
  reason?: string
  /** 还需要多少额外空间才能执行（allowed=false 时有意义）。 */
  shortfallBytes?: number
}

/**
 * 判断一次 capture 是否在配额内。
 *
 * 纯函数：输入是当前用量 + 本次预计大小 + 配额，不读磁盘。
 * 这样测试可以穷举边界，且调用方可以选择在什么时候取用量。
 */
export function checkQuota(
  usage: QuotaUsage,
  incomingBytes: number,
  quota: SnapshotQuota = DEFAULT_QUOTA,
): QuotaDecision {
  if (incomingBytes > quota.maxSnapshotBytes) {
    return {
      allowed: false,
      reason:
        `单个快照 ${formatBytes(incomingBytes)} 超过上限 ${formatBytes(quota.maxSnapshotBytes)}。` +
        '请把大文件排除在快照范围外，或提高配额。',
      shortfallBytes: incomingBytes - quota.maxSnapshotBytes,
    }
  }

  if (usage.count + 1 > quota.maxCount) {
    return {
      allowed: false,
      reason:
        `快照数量 ${usage.count} 已达上限 ${quota.maxCount}。` +
        '需要先清理旧快照（未被引用的才能删）。',
    }
  }

  const projected = usage.totalBytes + incomingBytes
  if (projected > quota.maxTotalBytes) {
    return {
      allowed: false,
      reason:
        `快照总占用将达到 ${formatBytes(projected)}，超过上限 ${formatBytes(quota.maxTotalBytes)}。`,
      shortfallBytes: projected - quota.maxTotalBytes,
    }
  }

  return { allowed: true }
}

/** 检查磁盘剩余空间是否足够（真实 statfs）。无法读取时按「足够」处理并说明原因。 */
export async function checkDiskFree(
  path: string,
  incomingBytes: number,
  reservedFreeBytes: number,
): Promise<{ ok: boolean; freeBytes?: number; reason?: string }> {
  try {
    const st = await statfsAsync(path)
    const freeBytes = Number(st.bavail) * Number(st.bsize)
    if (freeBytes - incomingBytes < reservedFreeBytes) {
      return {
        ok: false,
        freeBytes,
        reason:
          `磁盘可用 ${formatBytes(freeBytes)}，` +
          `快照需要 ${formatBytes(incomingBytes)}，` +
          `且必须保留 ${formatBytes(reservedFreeBytes)} 余量。`,
      }
    }
    return { ok: true, freeBytes }
  } catch (err) {
    // 读不到磁盘信息（权限 / 文件系统不支持）时不阻止操作：
    // 拒绝会让「环境特殊」变成「完全不能用」，而配额检查仍在生效。
    return { ok: true, reason: `无法读取磁盘空间：${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── GC ─────────────────────────────────────────────────────

export interface GcPolicy {
  /** 早于这个时间点的快照才考虑删除。 */
  olderThan: number
  /** 一定保留的快照 id（正在被产物引用的、用户标记的）。 */
  keepIds: Set<string>
  /** 每个 Run 至少保留最近几个快照。 */
  keepPerRun: number
}

export interface GcCandidate {
  id: string
  runId: string
  createdAt: number
  totalBytes: number
  deletedAt?: number
}

export interface GcPlan {
  /** 可以删除的快照 id。 */
  deletable: string[]
  /** 因为被引用而保留的。 */
  keptBecauseReferenced: string[]
  /** 因为太新而保留的。 */
  keptBecauseRecent: string[]
  /** 因为「每个 Run 最近 N 个」规则保留的。 */
  keptBecausePerRun: string[]
  /** 预计可释放字节。 */
  reclaimableBytes: number
}

/**
 * 计算 GC 计划。
 *
 * **纯函数**：只产出计划，不删除任何东西。
 * 删除是另一个需要显式调用的动作，而且必须先看到计划——
 * 「自动删」在证据系统里是不可接受的。
 *
 * 三条保护规则（任一命中即保留）：
 *   1. 在 keepIds 里（被产物 / 验收引用）
 *   2. 创建时间晚于 olderThan
 *   3. 属于该 Run 最近的 keepPerRun 个快照
 *
 * 已有 deletedAt 的（已软删除）不在候选中，避免重复处理。
 */
export function planGc(
  candidates: GcCandidate[],
  policy: GcPolicy,
  now = Date.now(),
): GcPlan {
  const plan: GcPlan = {
    deletable: [],
    keptBecauseReferenced: [],
    keptBecauseRecent: [],
    keptBecausePerRun: [],
    reclaimableBytes: 0,
  }

  // 每个 Run 最近的 N 个（按 createdAt 降序）
  const byRun = new Map<string, GcCandidate[]>()
  for (const c of candidates) {
    if (c.deletedAt !== undefined) continue
    const list = byRun.get(c.runId) ?? []
    list.push(c)
    byRun.set(c.runId, list)
  }
  const recentPerRun = new Set<string>()
  for (const list of byRun.values()) {
    list.sort((a, b) => b.createdAt - a.createdAt)
    for (const c of list.slice(0, Math.max(0, policy.keepPerRun))) {
      recentPerRun.add(c.id)
    }
  }

  for (const c of candidates) {
    if (c.deletedAt !== undefined) continue
    if (policy.keepIds.has(c.id)) {
      plan.keptBecauseReferenced.push(c.id)
      continue
    }
    if (c.createdAt > now - policy.olderThan) {
      plan.keptBecauseRecent.push(c.id)
      continue
    }
    if (recentPerRun.has(c.id)) {
      plan.keptBecausePerRun.push(c.id)
      continue
    }
    plan.deletable.push(c.id)
    plan.reclaimableBytes += c.totalBytes
  }

  // 稳定顺序，便于日志与测试
  plan.deletable.sort()
  plan.keptBecauseReferenced.sort()
  plan.keptBecauseRecent.sort()
  plan.keptBecausePerRun.sort()
  return plan
}

/** 字节格式化。错误消息里用，避免「1073741824 字节不清楚」。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
