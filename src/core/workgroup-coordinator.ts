// 总控：任务图编排 + 工作包分配的并发控制。
//
// 总控做三件事：
//   1. 决定「现在哪些包可以开始」（依赖满足 + 没有冲突阻塞）
//   2. 把包分配给角色（一次只有一个总控能分配同一个包）
//   3. 在变更集提交时判定冲突，决定能否合并
//
// 并发控制的核心是**条件更新**（CAS），不是「读 → 判断 → 写」。
// 后者在并发下必然失败：两个总控都读到 ready，都去开始它。
//
// 这里的分配也走 CAS：
//   UPDATE work_package SET status='running', role_id=?, started_at=?
//   WHERE id=? AND status IN ('planned','ready')
// 返回 changes=0 就说明别人先拿到了，如实报告「被抢占」，
// 而不是覆盖对方的分配。
import type { ChangeSet, Conflict, FileChange, RoleDefinition, WorkPackage, WorkPackageKind, WorkPackageStatus } from './workgroup.js'
import {
  canTransitionWorkPackage,
  detectConflictsAgainst,
  readyPackages,
  validateGraph,
} from './workgroup.js'
import { DomainError } from './errors.js'

/** 编排器需要的存储能力。由 WorkgroupStore 实现。 */
export interface WorkgroupPersistence {
  listPackages(taskId: string): WorkPackage[]
  getPackage(id: string): WorkPackage | undefined
  insertPackage(pkg: WorkPackage): void
  /**
   * CAS 迁移：只在当前状态属于 expectedFrom 时更新。
   * @returns 是否成功
   */
  casPackage(
    id: string,
    expectedFrom: WorkPackageStatus[],
    next: WorkPackageStatus,
    patch?: Partial<Pick<WorkPackage, 'roleId' | 'startedAt' | 'endedAt'>>,
  ): boolean
  insertChangeSet(cs: ChangeSet): void
  listChangeSets(taskId: string): ChangeSet[]
  getChangeSet(id: string): ChangeSet | undefined
  casChangeSet(id: string, expectedFrom: ChangeSet['status'], next: ChangeSet['status'], mergedAt?: number): boolean
  getRole(id: string): RoleDefinition | undefined
  listRoles(): RoleDefinition[]
}

export class WorkgroupCoordinator {
  constructor(private readonly db: WorkgroupPersistence) {}

  // ── 工作包 ───────────────────────────────────────────────

  /** 创建一个工作包。依赖必须指向同一 Task 下已存在的包。 */
  createPackage(input: {
    taskId: string
    title: string
    kind: WorkPackageKind
    deliverable: string
    dependsOn: string[]
    roleId?: string
    id: string
  }): WorkPackage {
    const existing = this.db.listPackages(input.taskId)
    const ids = new Set(existing.map((p) => p.id))

    for (const dep of input.dependsOn) {
      if (dep === input.id) {
        throw new DomainError('INVALID_INPUT', '工作包不能依赖自己')
      }
      if (!ids.has(dep)) {
        // 跨 Task 的依赖是配置错误：依赖的是别处的包，
        // 那个包的完成状态与本 Task 无关，等于永久的假满足。
        throw new DomainError(
          'INVALID_INPUT',
          `依赖的工作包不存在（或不在同一 Task 下）：${dep}`,
        )
      }
    }

    // 角色能否产出这种包
    if (input.roleId) {
      const role = this.db.getRole(input.roleId)
      if (!role) throw new DomainError('NOT_FOUND', `角色不存在：${input.roleId}`)
      if (!role.produces.includes(input.kind)) {
        throw new DomainError(
          'INVALID_INPUT',
          `角色 ${role.id} 不产出 ${input.kind} 类型的工作包（它产出：${role.produces.join(', ')}）`,
        )
      }
    }

    const pkg: WorkPackage = {
      id: input.id,
      taskId: input.taskId,
      kind: input.kind,
      title: input.title,
      deliverable: input.deliverable,
      status: 'planned',
      dependsOn: input.dependsOn,
      createdAt: Date.now(),
    }
    if (input.roleId) pkg.roleId = input.roleId

    // 加进去之后验证整图：单独的「依赖存在」检查抓不到环。
    const check = validateGraph([...existing, pkg])
    if (!check.ok) {
      if (check.cycles.length > 0) {
        throw new DomainError(
          'INVALID_INPUT',
          `依赖关系形成环：${check.cycles.map((c) => c.join(' → ')).join(' | ')}`,
        )
      }
      throw new DomainError('INVALID_INPUT', '依赖图不合法')
    }

    this.db.insertPackage(pkg)
    return pkg
  }

  /**
   * 把现在可以开始的工作包标记为 ready。
   *
   * 只改 planned → ready，不改 running —— 已经在跑的不该被重复标记。
   */
  refreshReadiness(taskId: string): WorkPackage[] {
    const all = this.db.listPackages(taskId)
    const ready = readyPackages(all)
    const transitioned: WorkPackage[] = []
    for (const pkg of ready) {
      if (pkg.status === 'planned') {
        if (this.db.casPackage(pkg.id, ['planned'], 'ready')) {
          transitioned.push({ ...pkg, status: 'ready' })
        }
      } else {
        transitioned.push(pkg)
      }
    }
    return transitioned
  }

  /**
   * 把工作包分配给一个角色并开始。
   *
   * CAS：只有当前状态是 planned / ready 且尚未被别的角色占用时成功。
   * 被抢占时返回 conflict 而不是覆盖——两个总控同时派活时，
   * 覆盖会让「这个包到底谁在做」变成最后写入者的答案。
   */
  startPackage(input: {
    packageId: string
    roleId: string
  }): { ok: true; package: WorkPackage } | { ok: false; reason: string; current?: WorkPackage } {
    const current = this.db.getPackage(input.packageId)
    if (!current) throw new DomainError('NOT_FOUND', `工作包不存在：${input.packageId}`)

    const role = this.db.getRole(input.roleId)
    if (!role) throw new DomainError('NOT_FOUND', `角色不存在：${input.roleId}`)
    if (!role.produces.includes(current.kind)) {
      return {
        ok: false,
        reason: `角色 ${role.id} 不产出 ${current.kind} 类型的工作包`,
        current,
      }
    }

    // 依赖必须都 merged —— **先检查依赖，再检查状态**。
    //
    // 顺序很重要：新包处于 planned（状态机构造上不允许 planned → running），
    // 所以如果先查状态，用户只会看到「当前状态是 planned，不能开始」，
    // 那是个内部实现细节，不是他能采取行动的信息。
    // 依赖检查给出的才是可执行的理由（「等 a 合并」）。
    const all = this.db.listPackages(current.taskId)
    const byId = new Map(all.map((p) => [p.id, p]))
    const unmet = current.dependsOn.filter((d) => byId.get(d)?.status !== 'merged')
    if (unmet.length > 0) {
      return {
        ok: false,
        reason: `依赖尚未合并：${unmet.join(', ')}`,
        current,
      }
    }

    // planned → ready。这是状态机要求的中间态：
    // 只有确认过依赖满足，包才算「就绪」，才允许被派活。
    if (current.status === 'planned') {
      const readied = this.db.casPackage(current.id, ['planned'], 'ready')
      if (!readied) {
        const now = this.db.getPackage(current.id)
        return {
          ok: false,
          reason: `工作包已被其他总控处理（当前 ${now?.status ?? '未知'}）`,
          ...(now ? { current: now } : {}),
        }
      }
    }

    const pkg = this.db.getPackage(current.id)!
    if (!canTransitionWorkPackage(pkg.status, 'running')) {
      return { ok: false, reason: `工作包当前状态是 ${pkg.status}，不能开始`, current: pkg }
    }

    const startedAt = Date.now()
    const won = this.db.casPackage(pkg.id, ['ready'], 'running', {
      roleId: input.roleId,
      startedAt,
    })
    if (!won) {
      const now = this.db.getPackage(pkg.id)
      return {
        ok: false,
        reason: `工作包已被其他角色或总控抢占（当前 ${now?.status ?? '未知'}）`,
        ...(now ? { current: now } : {}),
      }
    }
    return {
      ok: true,
      package: { ...pkg, status: 'running', roleId: input.roleId, startedAt },
    }
  }

  // ── 变更集 ───────────────────────────────────────────────

  /**
   * 提交一个变更集。
   *
   * 三件事在同一个判断里完成：
   *   1. 归属：包属于这个 Task，角色是执行它的角色
   *   2. 状态：包必须处于 running / submitted
   *   3. 冲突：与已有的未拒绝变更集按路径比对
   *
   * 冲突时**仍然保存**变更集（status='conflict'），不丢弃：
   * 用户需要看到「两边都改了什么」才能决定怎么合并。
   * 丢弃等于让那次工作的成果消失。
   */
  submitChangeSet(input: {
    id: string
    taskId: string
    workPackageId: string
    roleId: string
    changes: FileChange[]
    runId?: string
  }): { changeSet: ChangeSet; conflicts: Conflict[] } {
    const pkg = this.db.getPackage(input.workPackageId)
    if (!pkg) throw new DomainError('NOT_FOUND', `工作包不存在：${input.workPackageId}`)

    if (pkg.taskId !== input.taskId) {
      throw new DomainError(
        'OWNERSHIP_MISMATCH',
        `工作包属于 Task ${pkg.taskId}，不是 ${input.taskId}`,
      )
    }
    if (pkg.roleId && pkg.roleId !== input.roleId) {
      throw new DomainError(
        'OWNERSHIP_MISMATCH',
        `工作包由角色 ${pkg.roleId} 执行，但变更集声明来自 ${input.roleId}`,
      )
    }
    if (pkg.status !== 'running' && pkg.status !== 'submitted') {
      throw new DomainError(
        'STATE_CONFLICT',
        `工作包当前状态是 ${pkg.status}，只有 running / submitted 可以提交变更集`,
      )
    }

    const existing = this.db.listChangeSets(input.taskId)
    const candidate: ChangeSet = {
      id: input.id,
      taskId: input.taskId,
      workPackageId: input.workPackageId,
      roleId: input.roleId,
      changes: input.changes,
      status: 'submitted',
      createdAt: Date.now(),
    }
    if (input.runId) candidate.runId = input.runId

    const conflicts = detectConflictsAgainst(candidate, existing)

    // 只有「内容确实不同」的才算需要人工处理的冲突。
    // 内容相同的重叠是正常的协作（两边独立写了同一份内容），
    // 报成冲突会让用户做无意义的决定。
    const blocking = conflicts.filter((c) => c.differentContent)
    if (blocking.length > 0) candidate.status = 'conflict'

    this.db.insertChangeSet(candidate)

    // 有冲突时把包标成 blocked：继续让它 running 会产生更多
    // 基于「未合并版本」的工作。
    if (blocking.length > 0 && pkg.status === 'running') {
      this.db.casPackage(pkg.id, ['running'], 'blocked')
    } else if (pkg.status === 'running') {
      this.db.casPackage(pkg.id, ['running'], 'submitted')
    }

    return { changeSet: candidate, conflicts: blocking }
  }

  /**
   * 合并一个变更集。
   *
   * 前置条件：
   *   · 变更集状态是 submitted（conflict 的必须先解决冲突）
   *   · 再次检查冲突——从提交到合并之间可能有新的变更集进来了
   *
   * 「再次检查」是关键：如果只在提交时检查，两个变更集
   * 在不同时间提交、都能通过检查，然后先后合并——后合并的那个
   * 静默覆盖了先合并的。
   */
  mergeChangeSet(changeSetId: string): { ok: true; changeSet: ChangeSet } | { ok: false; reason: string } {
    const cs = this.db.getChangeSet(changeSetId)
    if (!cs) throw new DomainError('NOT_FOUND', `变更集不存在：${changeSetId}`)

    if (cs.status === 'conflict') {
      return { ok: false, reason: '变更集存在冲突，必须先解决' }
    }
    if (cs.status !== 'submitted') {
      return { ok: false, reason: `变更集当前状态是 ${cs.status}，不能合并` }
    }

    const others = this.db
      .listChangeSets(cs.taskId)
      .filter((x) => x.id !== cs.id && x.status === 'merged')
    const late = detectConflictsAgainst(cs, others).filter((c) => c.differentContent)
    if (late.length > 0) {
      // 已经有别的变更集合并了同一文件的不同内容。
      // 此时合并会覆盖对方，必须拒绝并把状态改成 conflict。
      this.db.casChangeSet(cs.id, 'submitted', 'conflict')
      return {
        ok: false,
        reason:
          `合并时会覆盖已合并的变更：${late.map((c) => c.path).join(', ')}` +
          '。先把这些变更集之间的关系处理清楚。',
      }
    }

    const mergedAt = Date.now()
    const won = this.db.casChangeSet(cs.id, 'submitted', 'merged', mergedAt)
    if (!won) {
      return { ok: false, reason: '变更集状态已被其他操作改变' }
    }

    // 合并成功后允许工作包进入 merged。
    //
    // 这里不强制：同一个包可能有多个变更集（分阶段提交），
    // 最后一个合并时才该标 merged。由调用方按需推进。
    return { ok: true, changeSet: { ...cs, status: 'merged', mergedAt } }
  }

  /** 工作包全部变更集都合并后，把它标成 merged。 */
  finalizePackage(packageId: string): { ok: boolean; reason?: string } {
    const pkg = this.db.getPackage(packageId)
    if (!pkg) throw new DomainError('NOT_FOUND', `工作包不存在：${packageId}`)

    const sets = this.db.listChangeSets(pkg.taskId).filter((c) => c.workPackageId === packageId)
    if (sets.length === 0) {
      return { ok: false, reason: '工作包没有任何变更集' }
    }
    const pending = sets.filter((c) => c.status !== 'merged')
    if (pending.length > 0) {
      return {
        ok: false,
        reason: `还有 ${pending.length} 个变更集未合并（状态：${pending.map((c) => c.status).join(', ')}）`,
      }
    }
    if (!canTransitionWorkPackage(pkg.status, 'merged')) {
      return { ok: false, reason: `工作包当前状态是 ${pkg.status}，不能标记为 merged` }
    }
    const won = this.db.casPackage(pkg.id, ['submitted', 'running'], 'merged', {
      endedAt: Date.now(),
    })
    return won ? { ok: true } : { ok: false, reason: '工作包状态已被其他操作改变' }
  }
}
