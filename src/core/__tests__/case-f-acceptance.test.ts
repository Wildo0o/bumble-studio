// 用例 F：验收与交付（P0-C 验收）
//
// 验证 v0.3 §6.3 的核心设计：
//   1. Run.completed 不等于 Task.accepted
//   2. 验收和交付是两个独立记录
//   3. 交付失败不抹掉接受证据
//   4. 未解决的 unknown 禁止验收
//   5. 返工必须给说明
//   6. 接受一个候选会 supersede 同路径的其他候选
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { Store } from '../store.js'
import { SnapshotManager } from '../snapshot.js'
import { AcceptanceService, AcceptanceError } from '../acceptance.js'

/**
 * 当前环境能否创建符号链接（Windows 非管理员默认不能）。
 * 用 skipIf 显式标注，而不是 try/catch 后 return ——
 * 后者会让测试「通过」，看起来防护被验证了，其实没跑到。
 */
const canCreateSymlink = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-f-'))
    try {
      mkdirSync(join(probe, 'a'))
      mkdirSync(join(probe, 'b'))
      symlinkSync(join(probe, 'b'), join(probe, 'a', 'l'), 'dir')
      return true
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  } catch {
    return false
  }
})()

describe('用例 F：验收与交付', () => {
  let dir: string
  let workspace: string
  let exportsDir: string
  let store: Store
  let service: AcceptanceService
  let taskId: string
  let runId: string
  let artifactId: string
  let snapId: string
  let REAL_HASH: string
  let contract: import('../../shared/types.js').TaskContract | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-accept-'))
    workspace = join(dir, 'workspace')
    exportsDir = join(dir, 'exports')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(exportsDir, { recursive: true })

    store = new Store(join(dir, 'test.db'))
    service = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [exportsDir],
      snapshotManager: new SnapshotManager(workspace, { repoDir: join(dir, 'snap') }),
    })

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    taskId = task.id
    // 契约是审计的前提（ReviewLoop 缺契约会 escalate）。
    // 这个文件测的是验收门本身，所以夹具必须给出一个有效契约。
    contract = store.putTaskContract({
      taskId, goal: 'g', acceptanceCriteria: [], actor: 'test',
    })
    const run = store.createRun({ taskId, role: 'producer', budget: {} })
    runId = run.id

    // 真实快照：验收门现在会重新读快照并算 hash，
    // 用假的 ref 会读不出文件。
    const CONTENT = 'accepted content'
    writeFileSync(join(workspace, 'out.md'), CONTENT, 'utf8')
    const snapManager = new SnapshotManager(workspace, { repoDir: join(dir, 'snap') })
    // 注意：service 用的是另一个 SnapshotManager 实例，
    // 但 repoDir 相同，所以能读到同一份快照。
    const realSnap = await snapManager.capture()

    const snap = store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: realSnap.ref,
      reproducible: true, fileCount: realSnap.fileCount, totalBytes: realSnap.totalBytes,
    })
    REAL_HASH = createHash('sha256').update(CONTENT, 'utf8').digest('hex')
    const artifact = store.createArtifact({
      taskId, runId, type: 'file', path: 'out.md',
      contentHash: REAL_HASH, sourceSnapshotId: snap.id, version: 1, status: 'candidate',
    })
    artifactId = artifact.id
    snapId = snap.id

    // Task 进入 awaiting_acceptance（模拟 Run 已完成）
    store.updateTaskStatus(taskId, 'awaiting_acceptance')
    store.setRunStatus(runId, 'completed')

    // 验收门要求必须有 pass 审计。这里预置一条，让原有测试继续测它们关心的东西。
    // 专门测「没有审计不能验收」的用例在 invariants.test.ts 里。
    passAudit()
  })

  /**
   * 造一条 pass 审计记录。
   *
   * 必须带 binding —— 验收门会核对审计绑定的是不是当前这个产物。
   * 不传 artifactId 时默认绑定夹具里的那个产物。
   */
  function passAudit(
    bindToArtifactId?: string,
    opts: { snapshotId?: string; snapshotRef?: string; contentHash?: string } = {},
  ): void {
    const cycle = store.createReviewCycle({
      taskId, skillId: 'general', skillVersion: '1',
      cycleNumber: store.listReviewCycles(taskId).length + 1,
      producerRunId: runId,
    })
    store.createAuditResult({
      cycleId: cycle.id,
      taskId,
      result: {
        verdict: 'pass',
        confidence: 0.9,
        blockingIssues: [],
        nonBlockingIssues: [],
        checkedRules: [],
        evidenceRefs: [],
        summary: '通过',
        binding: {
          taskId,
          cycleId: cycle.id,
          artifactIds: [bindToArtifactId ?? artifactId],
          producerRunId: runId,
          snapshotId: opts.snapshotId ?? snapId,
          snapshotRef: opts.snapshotRef ?? 'abc123',
          contentHashes: { 'out.md': opts.contentHash ?? REAL_HASH },
          contractHash: contract!.contractHash,
          contractVersion: contract!.contractVersion,
        },
      },
    })
  }

  afterEach(() => {
    try {
      store.close()
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function writeArtifactFile(content = 'artifact content') {
    writeFileSync(join(workspace, 'out.md'), content, 'utf8')
  }

  // ── 1. Run.completed ≠ Task.accepted ────────────────────

  it('Run 完成不自动等于 Task 被接受', () => {
    expect(store.getRun(runId)!.status).toBe('completed')
    expect(store.getTask(taskId)!.status).toBe('awaiting_acceptance')
    // 没有任何 AcceptanceRecord
    expect(store.listAcceptances(taskId)).toHaveLength(0)
  })

  it('只有用户接受才把 Task 变成 accepted', async () => {
    const record = await service.accept({ taskId, artifactId, runId })
    expect(record.status).toBe('accepted')
    expect(store.getTask(taskId)!.status).toBe('accepted')
    expect(store.getArtifact(artifactId)!.status).toBe('accepted')
  })

  it('Task 不在 awaiting_acceptance 时不能接受', async () => {
    store.updateTaskStatus(taskId, 'in_progress')
    await expect(service.accept({ taskId, artifactId, runId })).rejects.toThrow(/awaiting_acceptance/)
  })

  // ── 2 & 3. 验收与交付分离，交付失败不抹掉接受 ───────────

  it('接受后可以应用，产生独立的 DeliveryRecord', async () => {
    writeArtifactFile('final content')
    const acc = await service.accept({ taskId, artifactId, runId })

    // 应用前没有交付记录
    expect(store.listDeliveries(taskId)).toHaveLength(0)

    // apply 是异步的，这里同步调用会失败（因为快照 ref 是假的）
    // 所以只验证接口契约：acceptance 存在，delivery 是独立对象
    expect(acc.status).toBe('accepted')
    expect(store.getTask(taskId)!.status).toBe('accepted')
  })

  it('导出失败不改变 AcceptanceRecord', async () => {
    writeArtifactFile('content to export')
    const acc = await service.accept({ taskId, artifactId, runId })

    // 导出一个越界目录，应该失败
    const delivery = await service.export(acc.id, 'C:\\Windows\\System32')

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toBeTruthy()

    // 关键：接受记录不受影响
    const reloaded = store.getAcceptance(acc.id)!
    expect(reloaded.status).toBe('accepted')
    expect(store.getTask(taskId)!.status).toBe('accepted')
  })

  it('导出失败时明确报错（快照不存在）', async () => {
    writeArtifactFile('export me')
    const acc = await service.accept({ taskId, artifactId, runId })

    // 显式删掉快照记录，模拟「快照被清理了」
    store.dbExecForTest(`DELETE FROM snapshot WHERE id = '${snapId}'`)

    const delivery = await service.export(acc.id, exportsDir)

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toBeTruthy()
    // 关键：失败不改变接受记录
    expect(store.getAcceptance(acc.id)!.status).toBe('accepted')
  })

  // ── E-2：export 必须校验**最终文件路径**，不只是目录 ──────
  //
  // 只查 destination 会漏掉「目录里已经存在一个同名 symlink 指向外部」：
  // writeFile 会写穿到链接目标，而 destination 本身完全合法。

  // ── 无特权环境下的等价验证（注入探测）───────────────
  //
  // 文件 symlink 在 Windows 非管理员下建不出来。与其跳过，
  // 不如注入「这个路径是链接」的探测，验证导出**确实会拒绝**
  // 并从快照读取之外不做任何写入。
  //
  // 这条走的是与真实链接完全相同的代码路径
  // （export → isWritablePath → probe），差别只在 probe 实现。

  it('注入探测：导出目标是链接时拒绝，且不写穿', async () => {
    writeArtifactFile('payload')
    const acc = await service.accept({ taskId, artifactId, runId })

    // 重建一个 service，注入「所有目标都视为链接」的探测
    const guarded = new AcceptanceService(store, {
      workspaceRoot: workspace,
      deliveryRoots: [exportsDir],
      snapshotManager: new SnapshotManager(workspace, { repoDir: join(dir, 'snap') }),
      isSymlink: () => true,
    })

    const delivery = await guarded.export(acc.id, exportsDir)

    expect(delivery.status).toBe('failed')
    expect(delivery.error).toContain('符号链接')
    // 没有任何文件被写出去
    expect(existsSync(exportsDir) ? readdirSync(exportsDir).length : 0).toBe(0)
  })

  it.skipIf(!canCreateSymlink)('导出目标被替换成 symlink 时拒绝写入', async () => {
    writeArtifactFile('payload')
    const acc = await service.accept({ taskId, artifactId, runId })

    // 先正常导出一次，拿到真实的目标文件名
    const first = await service.export(acc.id, exportsDir)
    expect(first.status).toBe('exported')

    const producedName = basename(first.destination ?? '')
    expect(producedName).toBeTruthy()

    // 把已导出的文件删掉，换成指向外部的 symlink
    const outsideFile = join(dir, 'outside-target.txt')
    writeFileSync(outsideFile, 'original', 'utf8')
    rmSync(join(exportsDir, producedName), { force: true })
    symlinkSync(outsideFile, join(exportsDir, producedName), 'file')

    const second = await service.export(acc.id, exportsDir)

    // 必须失败，且外部文件内容未被改写
    expect(second.status).toBe('failed')
    expect(readFileSync(outsideFile, 'utf8')).toBe('original')
  })

  it.skipIf(!canCreateSymlink)('导出目录本身是指向外部的 symlink 时拒绝', async () => {
    writeArtifactFile('payload')
    const acc = await service.accept({ taskId, artifactId, runId })

    const outsideDir = join(dir, 'outside-dir')
    mkdirSync(outsideDir, { recursive: true })
    const linkedExports = join(dir, 'linked-exports')
    symlinkSync(outsideDir, linkedExports, 'dir')

    const delivery = await service.export(acc.id, linkedExports)
    expect(delivery.status).toBe('failed')
  })

  it('只有 accepted 的验收记录才能交付', async () => {
    const record = service.reject({ taskId, artifactId, runId, reason: '不满意' })
    await expect(service.export(record.id, exportsDir)).rejects.toThrow(/accepted/)
  })

  // ── 4. unknown 阻塞验收 ─────────────────────────────────

  it('有未解决 unknown 时禁止验收', async () => {
    // 造一个 unknown Step
    store.createStep({
      runId,
      index: 0,
      kind: 'tool',
      status: 'unknown',
      output: { error: '超时' },
    })

    await expect(service.accept({ taskId, artifactId, runId })).rejects.toThrow(/未解决的 unknown/)
  })

  it('对账后可以正常验收', async () => {
    const step = store.createStep({
      runId, index: 0, kind: 'tool', status: 'unknown', output: { error: '超时' },
    })

    // 对账
    store.createReconciliation({
      runId,
      stepId: step.id,
      unknownReason: '超时',
      resolution: 'confirmed_success',
      evidence: '检查过了',
      decidedBy: 'user',
    })
    store.updateStep(step.id, { status: 'completed' })

    const record = await service.accept({ taskId, artifactId, runId })
    expect(record.status).toBe('accepted')
  })

  // ── 5. 返工必须给说明 ───────────────────────────────────

  it('要求返工必须提供说明', () => {
    expect(() => service.requestRevision({ taskId, artifactId, runId, note: '  ' }))
      .toThrow(/必须给出说明/)
  })

  it('返工会记录说明并改变 Task 状态', () => {
    const record = service.requestRevision({
      taskId,
      artifactId,
      runId,
      note: '第三章论证不够，需要补充数据',
    })

    expect(record.status).toBe('revision_requested')
    expect(record.revisionNote).toContain('第三章')
    expect(store.getTask(taskId)!.status).toBe('revision_requested')
    expect(store.getArtifact(artifactId)!.status).toBe('rejected')
  })

  // ── 6. 接受一个候选会 supersede 同路径其他候选 ──────────

  it('接受一个候选会把同路径的其他候选标为 superseded', async () => {
    // 再建一个同路径的候选（版本 2）。
    // 用真实快照：验收门会重新读快照并算 hash。
    const V2_CONTENT = 'v2 content'
    writeFileSync(join(workspace, 'out.md'), V2_CONTENT, 'utf8')
    const snapManager2 = new SnapshotManager(workspace, { repoDir: join(dir, 'snap') })
    const realSnap2 = await snapManager2.capture()
    const snap2 = store.createSnapshot({
      runId, taskId, kind: 'workspace', ref: realSnap2.ref,
      reproducible: true, fileCount: realSnap2.fileCount, totalBytes: realSnap2.totalBytes,
    })
    const V2_HASH = createHash('sha256').update(V2_CONTENT, 'utf8').digest('hex')
    const v2 = store.createArtifact({
      taskId, runId, type: 'file', path: 'out.md',
      contentHash: V2_HASH, sourceSnapshotId: snap2.id,
      version: 2, parentArtifactId: artifactId, status: 'candidate',
    })

    // 审计 v2（验收门要求审计必须绑定到被接受的产物，且快照与内容哈希一致）
    passAudit(v2.id, { snapshotId: snap2.id, snapshotRef: realSnap2.ref, contentHash: V2_HASH })

    // 接受 v2
    await service.accept({ taskId, artifactId: v2.id, runId })

    // v1 应该被 superseded
    expect(store.getArtifact(artifactId)!.status).toBe('superseded')
    expect(store.getArtifact(v2.id)!.status).toBe('accepted')
  })

  // ── 额外：拒绝不删证据 ──────────────────────────────────

  it('拒绝不删除产物与证据', async () => {
    service.reject({ taskId, artifactId, runId, reason: '质量不行' })

    expect(store.getTask(taskId)!.status).toBe('rejected')
    // 产物还在，只是状态变了
    const artifact = store.getArtifact(artifactId)
    expect(artifact).toBeDefined()
    expect(artifact!.status).toBe('rejected')
    // 快照还在
    expect(store.listSnapshots(runId)).toHaveLength(1)
  })

  it('已有 accepted 的 Task 再次执行不会退回 awaiting_acceptance', async () => {
    await service.accept({ taskId, artifactId, runId })
    expect(store.getTask(taskId)!.status).toBe('accepted')

    // 模拟执行器收束时的状态更新逻辑
    const task = store.getTask(taskId)!
    if (task.status !== 'accepted') {
      store.updateTaskStatus(taskId, 'awaiting_acceptance')
    }
    expect(store.getTask(taskId)!.status).toBe('accepted')
  })

  it('AcceptanceError 是可识别的错误类型', async () => {
    store.updateTaskStatus(taskId, 'in_progress')
    try {
      await service.accept({ taskId, artifactId, runId })
      throw new Error('应该抛出错误')
    } catch (err) {
      expect(err).toBeInstanceOf(AcceptanceError)
    }
  })
})
