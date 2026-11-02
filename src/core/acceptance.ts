// 验收与交付。
//
// 核心设计（来自 v0.3 设计稿 §6.3 / §8.4）：
//   用户接受 ≠ 交付成功。
//   用户可能已经认可了内容质量，但导出时磁盘满了。
//   这不该把「用户接受」这个事实抹掉。
//
// 所以是两个对象：
//   AcceptanceRecord —— 质量决定（accepted / revision_requested / rejected）
//   DeliveryRecord   —— 交付动作（applied / exported / conflict / failed）
import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  AcceptanceRecord,
  Artifact,
  AuditBinding,
  DeliveryRecord,
  Task,
} from '../shared/types.js'
import { Store } from './store.js'
import { isPathAllowed, isWritablePath } from './paths.js'
import type { SnapshotManager } from './snapshot.js'

/**
 * 验收相关的领域错误。
 *
 * `code` 是**稳定的机器可读标识**，HTTP 层按它映射状态码。
 *
 * 为什么不能用「正则匹配中文错误消息」：
 *   错误文案会改（措辞、翻译、补说明），每次改都要同步改正则，
 *   忘了就变成 500。而且文案里恰好包含「不能验收」四个字
 *   并不代表它真的该返回 409。
 *
 *   code 是契约：改它需要改调用方，改文案不需要。
 */
export type AcceptanceErrorCode =
  /** 找不到目标对象 */
  | 'NOT_FOUND'
  /** Task / Run / Artifact 状态不允许这个操作 */
  | 'STATE_CONFLICT'
  /** 归属关系不成立（跨 Task / 跨 Run） */
  | 'OWNERSHIP_MISMATCH'
  /** 没有可用的 pass 审计 */
  | 'NO_PASSING_AUDIT'
  /** 审计绑定不完整或与当前对象不一致 */
  | 'BINDING_MISMATCH'
  /** 内容 hash 对不上（数据库记录或快照字节） */
  | 'CONTENT_MISMATCH'
  /** 契约变了或缺失 */
  | 'CONTRACT_MISMATCH'
  /** 快照不可复现且未提供 override */
  | 'SNAPSHOT_NOT_REPRODUCIBLE'
  /** 还有未解决的 unknown */
  | 'UNRESOLVED_UNKNOWN'
  /** 参数不合法 */
  | 'INVALID_INPUT'

export class AcceptanceError extends Error {
  constructor(
    message: string,
    readonly code: AcceptanceErrorCode = 'STATE_CONFLICT',
  ) {
    super(message)
    this.name = 'AcceptanceError'
  }
}

/** 交付冲突：目标已被改动，不能静默覆盖。 */
export class DeliveryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryConflictError'
  }
}

export interface AcceptanceServiceConfig {
  /** 交付时可以写入的目录（导出目标） */
  deliveryRoots: string[]
  /** 工作区根目录 */
  workspaceRoot: string
  /**
   * 快照管理器。
   *
   * 交付必须从快照读取内容，不能读当前工作区——
   * 工作区在验收之后可能已经被改动，读它就等于导出了别的东西。
   */
  snapshotManager: SnapshotManager
  /**
   * 符号链接探测（可选注入）。
   *
   * 部分环境无法创建文件 symlink（Windows 非管理员），
   * 注入让「导出写穿 symlink」这条防护仍可被完整验证，
   * 而不是因为本机没权限就跳过。
   */
  isSymlink?: (path: string) => boolean
}

export class AcceptanceService {
  constructor(
    private store: Store,
    private config: AcceptanceServiceConfig,
  ) {}

  // ── 验收 ────────────────────────────────────────────────

  /**
   * 用户接受候选产物。
   *
   * 前置检查（缺一不可）：
   *   1. Task 必须处于 awaiting_acceptance
   *   2. 产物必须存在且是 candidate
   *   3. Run 不能有未解决的 unknown
   *   4. **必须存在最新的审计记录，且 verdict = pass**
   *
   * 第 4 条是关键：没有它，审计可以被完全绕过。
   * 用户直接接受一个从未被审计、或被审计拒绝的产物，
   * 等于整个 ReviewLoop 形同虚设。
   */
  async accept(input: {
    taskId: string
    artifactId: string
    runId: string
    /** 不可复现快照的人工放行。必须同时给出 actor 与 reason。 */
    override?: { actor: string; reason: string }
  }): Promise<AcceptanceRecord> {
    const { artifact } = this.assertAcceptanceGate(input)
    this.assertNoUnresolvedUnknown(input.runId)
    await this.assertAuditPassedForArtifact(input.taskId, artifact, input.override)

    // ── 五处写入必须在同一事务 ────────────────────────────
    //
    //   supersede 同路径其他候选 / 标记产物 accepted /
    //   创建 AcceptanceRecord / 标记 Task accepted / 写事件
    //
    // 分开写会在崩溃时留下「Task 已 accepted 但没有 AcceptanceRecord」
    // 或者「产物 accepted 但 Task 还在 awaiting_acceptance」——
    // 两种状态都让「验收」这个事实无法回答。
    return this.store.runInTransaction(() => {
      // ── CAS：只有第一个 accept 能成功 ──────────────────
      //
      // 前面的 assertAcceptanceGate 是「读-判断」，两个并发请求
      // 都会读到 awaiting_acceptance 并都通过。真正的互斥在这里：
      // 条件 UPDATE，只有把状态从 awaiting_acceptance 改成 accepted
      // 的那一次才算数。
      const won = this.store.transitionTaskStatus(
        input.taskId, 'awaiting_acceptance', 'accepted',
      )
      if (!won) {
        throw new AcceptanceError(
          '这个 Task 已经被其他请求处理过（不是 awaiting_acceptance），不能重复验收。',
          'STATE_CONFLICT',
        )
      }

      // 同一 Task 的其他候选产物标为 superseded
      for (const other of this.store.listTaskArtifacts(input.taskId)) {
        if (other.status === 'candidate' && other.id !== artifact.id && other.path === artifact.path) {
          this.store.setArtifactStatus(other.id, 'superseded')
        }
      }
      this.store.setArtifactStatus(artifact.id, 'accepted')

      const record = this.store.createAcceptance({
        taskId: input.taskId,
        artifactId: artifact.id,
        runId: input.runId,
        status: 'accepted',
        decidedAt: Date.now(),
        ...(input.override
          ? { overrideActor: input.override.actor, overrideReason: input.override.reason }
          : {}),
      })

      this.store.appendEvent(input.runId, 'acceptance.accepted', {
        // taskId 必须显式给：EventStore 用 payload.taskId 推导 task 聚合的
        // aggregate_id。缺了它，事件会退回 run 聚合并标记 inferred，
        // 按 Task 查「这个任务被接受过吗」就查不到。
        taskId: record.taskId,
        acceptanceId: record.id,
        artifactId: artifact.id,
        ...(input.override ? { override: input.override } : {}),
      })
      return record
    })
  }

  /**
   * 要求返工。保留当前产物与证据，创建返工说明供下一轮 Producer 使用。
   *
   * 与 accept 一样：四处写入（产物状态 / AcceptanceRecord / Task 状态 / 事件）
   * 必须在同一事务里。分开写会在崩溃时留下「产物 rejected 但没有 AcceptanceRecord」——
   * 那个状态既不能说「用户要求了返工」，也不能说「什么都没发生」。
   *
   * Task 状态用 CAS 而不是无条件 UPDATE：前置状态门是「读-判断」，
   * 两个并发请求都会读到 awaiting_acceptance。真正互斥的是条件 UPDATE。
   */
  requestRevision(input: { taskId: string; artifactId: string; runId: string; note: string }): AcceptanceRecord {
    if (!input.note.trim()) {
      throw new AcceptanceError('要求返工必须给出说明——否则下一轮 Producer 不知道要改什么', 'INVALID_INPUT')
    }
    const { artifact } = this.assertAcceptanceGate(input)
    this.assertNoUnresolvedUnknown(input.runId)

    return this.store.runInTransaction(() => {
      const won = this.store.transitionTaskStatus(
        input.taskId, 'awaiting_acceptance', 'revision_requested',
      )
      if (!won) {
        throw new AcceptanceError(
          '这个 Task 已经被其他请求处理过（不是 awaiting_acceptance），不能重复要求返工。',
          'STATE_CONFLICT',
        )
      }

      this.store.setArtifactStatus(artifact.id, 'rejected')

      const record = this.store.createAcceptance({
        taskId: input.taskId,
        artifactId: artifact.id,
        runId: input.runId,
        status: 'revision_requested',
        revisionNote: input.note,
        decidedAt: Date.now(),
      })

      this.store.appendEvent(input.runId, 'acceptance.revision_requested', {
        acceptanceId: record.id,
        note: input.note,
      })
      return record
    })
  }

  /** 拒绝并放弃。不自动删除证据。事务语义与 requestRevision 相同。 */
  reject(input: { taskId: string; artifactId: string; runId: string; reason?: string }): AcceptanceRecord {
    const { artifact } = this.assertAcceptanceGate(input)

    return this.store.runInTransaction(() => {
      const won = this.store.transitionTaskStatus(
        input.taskId, 'awaiting_acceptance', 'rejected',
      )
      if (!won) {
        throw new AcceptanceError(
          '这个 Task 已经被其他请求处理过（不是 awaiting_acceptance），不能重复拒绝。',
          'STATE_CONFLICT',
        )
      }

      this.store.setArtifactStatus(artifact.id, 'rejected')

      const record = this.store.createAcceptance({
        taskId: input.taskId,
        artifactId: artifact.id,
        runId: input.runId,
        status: 'rejected',
        revisionNote: input.reason,
        decidedAt: Date.now(),
      })

      this.store.appendEvent(input.runId, 'acceptance.rejected', { acceptanceId: record.id })
      return record
    })
  }

  // ── 交付 ────────────────────────────────────────────────

  /**
   * 应用产物到原工作区。
   *
   * 语义：把**已验收快照里**的那个文件写到工作区。
   * 不能从当前工作区读——工作区在验收之后可能已经被改动。
   *
   * 前置：必须有 accepted 的 AcceptanceRecord。
   * 失败不改变 AcceptanceRecord——用户的接受是既成事实。
   */
  async apply(acceptanceId: string): Promise<DeliveryRecord> {
    const acceptance = this.requireAcceptance(acceptanceId)
    if (acceptance.status !== 'accepted') {
      throw new AcceptanceError('只有当 AcceptanceRecord 是 accepted 时才能应用', 'STATE_CONFLICT')
    }

    const artifact = this.requireArtifact(acceptance.artifactId)
    const delivery = this.store.createDelivery({
      taskId: acceptance.taskId,
      acceptanceId: acceptance.id,
      artifactId: artifact.id,
      action: 'apply',
      status: 'running',
      destination: this.config.workspaceRoot,
    })

    try {
      const { content, snapshotRef } = await this.readAcceptedContent(artifact)

      if (!artifact.path) throw new Error('产物没有路径，无法应用')
      const target = resolve(this.config.workspaceRoot, artifact.path)

      // ── apply 必须用 isWritablePath（审计二轮 P1-5）─────────
      //
      // isPathAllowed 只判「在不在工作区内」。apply 是**写操作**，
      // 还多一条要求：目标本身不能是符号链接。
      //   · 工作区内若有 link -> 外部文件，isPathAllowed 会放行
      //     （解析后仍在工作区内），但 writeFile 会改写链接目标
      const check = isWritablePath(
        target,
        [this.config.workspaceRoot],
        this.config.isSymlink ? { isSymlink: this.config.isSymlink } : {},
      )
      if (!check.allowed) {
        throw new Error(`目标路径不可写（${check.reason ?? '越界'}）：${artifact.path}`)
      }

      // 目标已存在且内容不同 → 这是冲突，不是覆盖
      if (existsSync(target)) {
        const current = await readFile(target, 'utf8')
        if (current !== content) {
          throw new DeliveryConflictError(
            `目标文件已存在且内容不同（漂移）。` +
            `快照内容 ${content.length} 字符，当前文件 ${current.length} 字符。` +
            `请先确认要覆盖还是放弃。`,
          )
        }
      }

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')

      // 写入后校验：确认真的写进去了
      const written = await readFile(target, 'utf8')
      if (written !== content) {
        throw new Error('写入后校验失败：文件内容与快照不一致')
      }

      this.store.updateDelivery(delivery.id, 'applied')
      this.store.appendEvent(acceptance.runId, 'delivery.applied', {
        deliveryId: delivery.id,
        artifactId: artifact.id,
        path: artifact.path,
        snapshotRef,
        bytes: Buffer.byteLength(content, 'utf8'),
      })
      return { ...delivery, status: 'applied', endedAt: Date.now() }
    } catch (err) {
      const isConflict = err instanceof DeliveryConflictError
      const message = err instanceof Error ? err.message : String(err)
      this.store.updateDelivery(delivery.id, isConflict ? 'conflict' : 'failed', { error: message })
      this.store.appendEvent(acceptance.runId, isConflict ? 'delivery.conflict' : 'delivery.failed', {
        // artifactId / taskId 是交付事件的关键引用：没有它就无法回答
        // 「哪个产物交付失败了」，EventStore 也靠它们推导聚合。
        artifactId: delivery.artifactId,
        taskId: delivery.taskId,
        deliveryId: delivery.id,
        error: message,
      })
      return {
        ...delivery,
        status: isConflict ? 'conflict' : 'failed',
        error: message,
        endedAt: Date.now(),
      }
    }
  }

  /**
   * 导出产物到指定目录。
   *
   * 与 apply 的区别：apply 写回原工作区，export 写到用户指定的目录。
   * 相同点：**两者都必须从已验收快照读取内容**，不能读当前工作区。
   */
  async export(acceptanceId: string, destination: string): Promise<DeliveryRecord> {
    const acceptance = this.requireAcceptance(acceptanceId)
    if (acceptance.status !== 'accepted') {
      throw new AcceptanceError('只有当 AcceptanceRecord 是 accepted 时才能导出', 'STATE_CONFLICT')
    }

    const artifact = this.requireArtifact(acceptance.artifactId)
    const delivery = this.store.createDelivery({
      taskId: acceptance.taskId,
      acceptanceId: acceptance.id,
      artifactId: artifact.id,
      action: 'export',
      status: 'running',
      destination,
    })

    try {
      const destCheck = isPathAllowed(destination, this.config.deliveryRoots)
      if (!destCheck.allowed) {
        throw new Error(`导出目录不在允许范围内：${destCheck.reason ?? destination}`)
      }

      const { content, snapshotRef } = await this.readAcceptedContent(artifact)

      if (!artifact.path) throw new Error('产物没有路径，无法导出')
      const targetDir = resolve(destination)
      await mkdir(targetDir, { recursive: true })
      const targetPath = join(targetDir, artifact.path.split('/').pop() ?? 'artifact')

      // ── 校验**最终文件路径**，而不只是目录（审计 E-2）──────
      //
      // 只查 destination 会漏掉两种越权：
      //   1. targetDir 里已经存在一个同名 symlink 指向外部
      //      → writeFile 会写穿到链接目标
      //   2. 产物文件名本身是恶意的（例如含 ../）
      //      → join 之后跑到 targetDir 之外
      //
      // isWritablePath 同时拒绝「目标本身是符号链接」和
      // 「解析后不在允许范围内」。
      const targetCheck = isWritablePath(
        targetPath,
        this.config.deliveryRoots,
        this.config.isSymlink ? { isSymlink: this.config.isSymlink } : {},
      )
      if (!targetCheck.allowed) {
        throw new Error(
          `导出目标不安全（${targetCheck.reason ?? targetPath}）：${targetPath}`,
        )
      }

      await writeFile(targetPath, content, 'utf8')

      const written = await readFile(targetPath, 'utf8')
      if (written !== content) {
        throw new Error('导出后校验失败：文件内容与快照不一致')
      }

      this.store.updateDelivery(delivery.id, 'exported', { destination: targetPath })
      this.store.appendEvent(acceptance.runId, 'delivery.exported', {
        deliveryId: delivery.id,
        artifactId: artifact.id,
        destination: targetPath,
        snapshotRef,
        bytes: Buffer.byteLength(content, 'utf8'),
      })
      return { ...delivery, status: 'exported', destination: targetPath, endedAt: Date.now() }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.updateDelivery(delivery.id, 'failed', { error: message })
      this.store.appendEvent(acceptance.runId, 'delivery.failed', {
        // artifactId / taskId 是交付事件的关键引用：没有它就无法回答
        // 「哪个产物交付失败了」，EventStore 也靠它们推导聚合。
        artifactId: delivery.artifactId,
        taskId: delivery.taskId,
        deliveryId: delivery.id,
        error: message,
      })
      return { ...delivery, status: 'failed', error: message, endedAt: Date.now() }
    }
  }

  /**
   * 从已验收快照读取产物内容。
   *
   * 这是 apply 和 export 的共同前置。抽出来的原因：
   * 两条路径都必须做同样的校验（快照存在、可复现、文件在快照里），
   * 分开写迟早会漏掉一条。
   */
  private async readAcceptedContent(artifact: Artifact): Promise<{ content: string; snapshotRef: string }> {
    if (!artifact.path) throw new Error('产物没有路径')
    if (!artifact.sourceSnapshotId) throw new Error('产物没有关联快照，无法交付')

    const snapshot = this.store.getSnapshot(artifact.sourceSnapshotId)
    if (!snapshot) throw new Error(`快照不存在：${artifact.sourceSnapshotId}`)
    if (!snapshot.reproducible) {
      throw new Error(`这个快照标记为不可完整复现：${snapshot.notReproducibleReason ?? '未说明原因'}`)
    }

    const content = await this.config.snapshotManager.readFileAt(snapshot.ref, artifact.path)
    if (content === null) {
      throw new Error(`快照 ${snapshot.ref.slice(0, 8)} 里找不到 ${artifact.path}`)
    }

    // 内容哈希校验：确认读到的是当初验收的那份内容
    if (artifact.contentHash) {
      const actual = createHash('sha256').update(content, 'utf8').digest('hex')
      if (actual !== artifact.contentHash) {
        throw new Error(
          `内容哈希不匹配：验收时记录 ${artifact.contentHash.slice(0, 12)}，` +
          `快照里实际 ${actual.slice(0, 12)}。快照可能已被篡改。`,
        )
      }
    }

    return { content, snapshotRef: snapshot.ref }
  }

  // ── 内部校验 ────────────────────────────────────────────

  private requireTask(taskId: string): Task {
    const task = this.store.getTask(taskId)
    if (!task) throw new AcceptanceError(`Task 不存在：${taskId}`, 'NOT_FOUND')
    return task
  }

  private requireArtifact(artifactId: string): Artifact {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) throw new AcceptanceError(`产物不存在：${artifactId}`, 'NOT_FOUND')
    return artifact
  }

  /**
   * 验收类接口的统一状态门。
   *
   * accept / requestRevision / reject 三者共用，保证无论走哪条路径，
   * 前置条件都一样。分开写迟早会漏掉某一条。
   *
   * 检查项：
   *   1. Task 存在
   *   2. 产物 / Run / Task 归属一致
   *   3. Task 处于 awaiting_acceptance（已 accepted 的不能回退）
   *   4. 产物处于 candidate（已 accepted / superseded 的不能改）
   */
  private assertAcceptanceGate(input: {
    taskId: string
    artifactId: string
    runId: string
  }): { task: Task; artifact: Artifact } {
    const task = this.requireTask(input.taskId)
    const artifact = this.assertArtifactBelongsTo(input)

    // Task 状态：只有 awaiting_acceptance 才能做质量决定
    if (task.status !== 'awaiting_acceptance') {
      throw new AcceptanceError(
        `Task 当前状态是 ${task.status}，只有 awaiting_acceptance 可以做质量决定。` +
        (task.status === 'accepted'
          ? '这个 Task 已经被接受过，不能再用返工或拒绝把它回退。'
          : ''), 'STATE_CONFLICT',
      )
    }

    // 产物状态：已 accepted / superseded 的不能被改动
    if (artifact.status !== 'candidate') {
      throw new AcceptanceError(
        `产物状态是 ${artifact.status}，只有 candidate 可以做质量决定。`, 'STATE_CONFLICT',
      )
    }

    return { task, artifact }
  }

  /**
   * 校验产物、Run、Task 的归属关系一致。
   *
   * 没有这个校验，就可能出现：
   *   · 用 Task A 的接口去接受 Task B 的产物
   *   · 用一个 Run 的 id 去接受另一个 Run 的产物
   * 这会让审计与验收的绑定关系失效。
   */
  private assertArtifactBelongsTo(input: {
    taskId: string
    artifactId: string
    runId: string
  }): Artifact {
    const artifact = this.requireArtifact(input.artifactId)

    if (artifact.taskId !== input.taskId) {
      throw new AcceptanceError(
        `产物属于 Task ${artifact.taskId}，不是 ${input.taskId}`, 'OWNERSHIP_MISMATCH',
      )
    }
    if (artifact.runId !== input.runId) {
      throw new AcceptanceError(
        `产物属于 Run ${artifact.runId}，不是 ${input.runId}`, 'OWNERSHIP_MISMATCH',
      )
    }

    const run = this.store.getRun(input.runId)
    if (!run) throw new AcceptanceError(`Run 不存在：${input.runId}`, 'NOT_FOUND')
    if (run.taskId !== input.taskId) {
      throw new AcceptanceError(
        `Run ${input.runId} 属于 Task ${run.taskId}，不是 ${input.taskId}`, 'OWNERSHIP_MISMATCH',
      )
    }

    return artifact
  }

  private requireAcceptance(id: string): AcceptanceRecord {
    const record = this.store.getAcceptance(id)
    if (!record) throw new AcceptanceError(`AcceptanceRecord 不存在：${id}`, 'NOT_FOUND')
    return record
  }

  /**
   * 有未解决的 unknown 时禁止验收。
   *
   * 理由：如果某个工具操作的结果不确定，那么产物本身可能是基于
   * 一个错误的前提生成的。此时接受它就是把不确定性固化下来。
   */
  private assertNoUnresolvedUnknown(runId: string): void {
    if (this.store.hasUnresolvedUnknown(runId)) {
      throw new AcceptanceError(
        '这个 Run 有未解决的 unknown 操作，必须先对账确认后才能验收、应用或导出', 'UNRESOLVED_UNKNOWN',
      )
    }
  }

  /**
   * 验收门：必须存在**针对这个产物**的 pass 审计。
   *
   * 四个条件缺一不可：
   *   1. Task 至少有一条审计记录
   *   2. 最新一条是 pass
   *   3. 这条审计的 binding 覆盖当前 artifactId
   *   4. 这条审计的 binding 与当前产物一致（run / snapshot / contentHash）
   *
   * 为什么第 3、4 条必须存在：
   * 只检查「Task 最新审计是 pass」是不够的。
   * 一个 Task 可能有多个产物，A 通过审计不代表 B 也通过。
   * 没有绑定校验，就可以拿 A 的 pass 去接受 B。
   */
  private async assertAuditPassedForArtifact(
    taskId: string,
    artifact: Artifact,
    override?: { actor: string; reason: string },
  ): Promise<void> {
    // 按「归属关系」查审计，而不是按「Task 最后一条审计记录」。
    //
    // 为什么不能用 created_at 排序取最后一条：
    //   · 并发审计或时钟相同/乱序时，"最后一条"不可靠
    //   · 一个 Task 可能有多个产物，A 的 pass 不该被拿来验收 B
    //
    // 正确做法：找到这个产物所属的 Run 对应的 Cycle，取那个 Cycle 的审计结果。
    const audits = this.store.listAuditResults(taskId)
    if (audits.length === 0) {
      throw new AcceptanceError(
        '这个 Task 还没有经过审计，不能验收。' +
        '请先调用 POST /tasks/:id/review 完成审计。', 'NO_PASSING_AUDIT',
      )
    }

    // 找到绑定了这个产物的审计记录。
    // 如果有多个（返工多轮），取最新的那一条（按 createdAt，仅在同一产物内比较）。
    const boundAudits = audits.filter((a) => {
      const b = a.result.binding
      if (!b) return false
      // 部分绑定（早期失败）不能用于验收，但可以参与「有没有审过」的判断
      return b.artifactIds.includes(artifact.id) && b.producerRunId === artifact.runId
    })

    if (boundAudits.length === 0) {
      throw new AcceptanceError(
        `没有找到针对产物 ${artifact.id} 的审计记录。` +
        `（这个 Task 有 ${audits.length} 条审计，但都不是审这个产物的。）` +
        '不能用其他产物的审计结论来验收这个产物，请先审计这个产物。', 'NO_PASSING_AUDIT',
      )
    }

    // 同一产物可能被审过多次（返工），取最后一次
    const audit = boundAudits.reduce((latest, current) =>
      current.createdAt >= latest.createdAt ? current : latest,
    )

    if (audit.verdict !== 'pass') {
      const reason = audit.result.escalateReason
        ? `（原因：${audit.result.escalateReason}）`
        : ''
      throw new AcceptanceError(
        `针对这个产物的最新审计结论是 ${audit.verdict}${reason}，不能验收。` +
        `审计摘要：${audit.result.summary}`, 'STATE_CONFLICT',
      )
    }

    // ── 绑定必须完整 ──────────────────────────────────────
    //
    // 这是验收门的核心不变量：**不能拿一条绑不上任何东西的 pass 去验收**。
    //
    // 旧实现允许 snapshotId / contractHash 缺失，理由是「兼容旧数据」。
    // 但「兼容旧数据」的实际效果是：一条 `{artifactIds, producerRunId}` 的
    // 极简绑定就能验收任何产物——只要 artifactId 对得上。
    // 而 artifactId 是调用方传的，等于验收门形同虚设。
    //
    // 现在：缺任何一项直接拒绝，不提供兼容路径。
    const binding = audit.result.binding

    if (!binding) {
      throw new AcceptanceError(
        '这条审计记录没有绑定信息，无法确认它审的是什么。不能验收。', 'BINDING_MISMATCH',
      )
    }

    // 部分绑定（早期失败）明确不可验收
    if ('complete' in binding && binding.complete === false) {
      throw new AcceptanceError(
        `这条审计是早期失败的结果（${binding.failureReason}），不是有效审计。不能验收。`, 'OWNERSHIP_MISMATCH',
      )
    }

    const full = binding as AuditBinding
    const missing: string[] = []
    if (!full.taskId) missing.push('taskId')
    if (!full.cycleId) missing.push('cycleId')
    if (!full.artifactIds || full.artifactIds.length === 0) missing.push('artifactIds')
    if (!full.producerRunId) missing.push('producerRunId')
    if (!full.snapshotId) missing.push('snapshotId')
    if (!full.snapshotRef) missing.push('snapshotRef')
    if (!full.contentHashes || Object.keys(full.contentHashes).length === 0) {
      missing.push('contentHashes')
    }
    if (!full.contractHash) missing.push('contractHash')
    if (full.contractVersion == null) missing.push('contractVersion')

    if (missing.length > 0) {
      throw new AcceptanceError(
        `审计绑定不完整，缺少：${missing.join(', ')}。` +
        '不完整的绑定无法确认审计与产物的对应关系，不能验收。请重新审计。', 'BINDING_MISMATCH',
      )
    }

    // taskId 必须对得上
    if (full.taskId !== taskId) {
      throw new AcceptanceError(
        `审计绑定的 Task 是 ${full.taskId}，不是 ${taskId}。`, 'BINDING_MISMATCH',
      )
    }

    // ── 快照校验 ──────────────────────────────────────────
    if (!artifact.sourceSnapshotId) {
      throw new AcceptanceError(
        `产物 ${artifact.id} 没有记录来源快照，无法确认它对应审计的哪份内容。不能验收。`, 'CONTENT_MISMATCH',
      )
    }
    if (full.snapshotId !== artifact.sourceSnapshotId) {
      throw new AcceptanceError(
        `审计针对的快照是 ${full.snapshotId}，` +
        `当前产物的快照是 ${artifact.sourceSnapshotId}。不能验收。`, 'STATE_CONFLICT',
      )
    }

    // ── 内容哈希校验：确认审的就是这份内容 ────────────────
    if (!artifact.path) {
      throw new AcceptanceError(
        `产物 ${artifact.id} 没有 path，无法确认审计的是哪个文件。不能验收。`, 'STATE_CONFLICT',
      )
    }
    if (!artifact.contentHash) {
      throw new AcceptanceError(
        `产物 ${artifact.id} 没有 contentHash，无法确认内容是否被改过。不能验收。`, 'CONTENT_MISMATCH',
      )
    }
    const auditedHash = full.contentHashes[artifact.path]
    if (!auditedHash) {
      throw new AcceptanceError(
        `审计绑定里没有 ${artifact.path} 的内容哈希，无法确认审的是这份内容。不能验收。`, 'BINDING_MISMATCH',
      )
    }
    if (auditedHash !== artifact.contentHash) {
      throw new AcceptanceError(
        `产物内容在审计之后发生了变化（${artifact.path}：` +
        `审计时 ${auditedHash.slice(0, 12)}，现在 ${artifact.contentHash.slice(0, 12)}）。` +
        '请重新审计。', 'CONTENT_MISMATCH',
      )
    }

    // ── 快照字节再验一次 ──────────────────────────────────
    //
    // 上面比的是三个**数据库里的值**（binding / artifact / audit）。
    // 它们可以被同时篡改而不被发现。
    //
    // 唯一不可伪造的是快照本身：把文件重新读出来算 hash。
    // 这一步和 ReviewLoop 里的检查重复，但必须重复——
    // 从审计到验收之间，数据库仍可能被改。
    const snapshot = this.store.getSnapshot(full.snapshotId)
    if (!snapshot) {
      throw new AcceptanceError(
        `审计绑定的快照 ${full.snapshotId} 不存在，无法验证内容。不能验收。`, 'NOT_FOUND',
      )
    }

    // ── 不可复现快照：默认拒绝，人工 override 才放行 ──────
    //
    // 「不可复现」意味着无法从快照重建这份内容——它可能依赖外部
    // API 的返回、随机数、当前时间。审计看到的是**一次性的**，
    // 事后任何人都无法验证「当时到底审了什么」。
    //
    // 这不能自动通过。但如果用户确实人工核对过，允许 override，
    // 代价是必须留下 actor + reason：例外要能被追溯。
    if (!snapshot.reproducible) {
      if (!override) {
        throw new AcceptanceError(
          `审计依据的快照不可复现（${snapshot.notReproducibleReason ?? '未说明原因'}），` +
          '不能自动验收。如果已人工核对内容，请提供 override.actor 与 override.reason。', 'CONTENT_MISMATCH',
        )
      }
      if (!override.actor?.trim()) {
        throw new AcceptanceError('override 必须给出 actor（谁批准了这次例外）')
      }
      if (!override.reason?.trim()) {
        throw new AcceptanceError(
          'override 必须给出 reason（为什么这次例外可以被接受）', 'INVALID_INPUT',
        )
      }
    }

    const content = await this.config.snapshotManager.readFileAt(snapshot.ref, artifact.path)
    if (content === null) {
      throw new AcceptanceError(
        `无法从快照 ${snapshot.id} 读出 ${artifact.path}，不能验收。`, 'STATE_CONFLICT',
      )
    }
    const actualHash = createHash('sha256').update(content, 'utf8').digest('hex')
    if (actualHash !== artifact.contentHash) {
      throw new AcceptanceError(
        `快照里的实际内容与产物记录的 hash 不一致（${artifact.path}：` +
        `记录 ${artifact.contentHash.slice(0, 12)}，实际 ${actualHash.slice(0, 12)}）。` +
        '数据库记录不可信，不能验收。', 'CONTENT_MISMATCH',
      )
    }

    // ── 契约哈希校验：确认审的是**当前这一版**任务要求 ────
    //
    // 没有这一条，可以先写一个宽松契约审出 pass，
    // 再把契约改成严格版本——用户看到的是「符合最新要求且已通过审计」。
    // 实际上通过的是旧契约。
    const current = this.store.getActiveTaskContract(taskId)
    if (!current) {
      throw new AcceptanceError(
        '审计绑定了一份任务契约，但当前 Task 没有生效契约。' +
        '契约可能被删除——请重新定义契约并重新审计。', 'BINDING_MISMATCH',
      )
    }
    if (current.contractHash !== full.contractHash) {
      throw new AcceptanceError(
        `任务契约在审计之后发生了变化，不能验收` +
        `（审计时 v${full.contractVersion} ` +
        `${full.contractHash.slice(0, 12)}，现在是 v${current.contractVersion} ` +
        `${current.contractHash.slice(0, 12)}）。请重新审计。`, 'CONTRACT_MISMATCH',
      )
    }
  }
}

export { randomUUID, readFile, stat, writeFile, dirname }
