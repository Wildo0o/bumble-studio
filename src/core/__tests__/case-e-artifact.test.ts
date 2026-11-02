// 用例 E：产物与快照（P0-B 验收）
//
// 验证：
//   1. Run 完成时自动拍快照
//   2. 为每个文件生成 Artifact
//   3. 产物不原地覆盖，返工产生新版本
//   4. 版本链可追溯
//   5. 快照失败被显式记录，不静默
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor, type SnapshotHook } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { SnapshotManager } from '../snapshot.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

describe('用例 E：产物与快照', () => {
  let dir: string
  let dbPath: string
  let workspace: string
  let store: Store
  let snapshot: SnapshotManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-artifact-'))
    dbPath = join(dir, 'test.db')
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(dbPath)
    snapshot = new SnapshotManager(workspace, { repoDir: join(dir, 'snaprepo') })
  })

  afterEach(() => {
    try {
      store.close()
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider, snap?: SnapshotHook): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, handlers) => script.stream(req, handlers) }
    return new RunExecutor(
      store,
      new ToolRegistry(),
      {
        workspaceRoots: [workspace],
        contextBudget: 100_000,
        outputReserve: 8_000,
        maxToolRounds: 8,
        snapshot: snap,
      },
      () => adapter,
    )
  }

  it('Run 完成时自动拍快照并为文件生成 Artifact', async () => {
    writeFileSync(join(workspace, 'report.md'), '# 报告\n内容\n', 'utf8')
    writeFileSync(join(workspace, 'data.txt'), 'some data', 'utf8')

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const script = new ScriptedProvider([{ text: '完成了' }])
    const executor = makeExecutor(script, snapshot)

    const outcome = await executor.execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('做点什么')],
      signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('completed')

    // 快照
    const snapshots = store.listSnapshots(run.id)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.kind).toBe('workspace')
    expect(snapshots[0]!.fileCount).toBe(2)
    expect(snapshots[0]!.reproducible).toBe(true)
    expect(snapshots[0]!.ref).toMatch(/^[0-9a-f]{40}$/)

    // Artifact
    const artifacts = store.listArtifacts(run.id)
    expect(artifacts).toHaveLength(2)
    expect(artifacts.map((a) => a.path).sort()).toEqual(['data.txt', 'report.md'])
    expect(artifacts.every((a) => a.status === 'candidate')).toBe(true)
    expect(artifacts.every((a) => a.version === 1)).toBe(true)
    expect(artifacts.every((a) => a.sourceSnapshotId === snapshots[0]!.id)).toBe(true)
    expect(artifacts.every((a) => a.contentHash)).toBe(true)

    // 事件流
    const events = store.listEvents(run.id)
    expect(events.some((e) => e.kind === 'snapshot.captured')).toBe(true)
  })

  it('返工产生新版本，不原地覆盖', async () => {
    writeFileSync(join(workspace, 'doc.md'), 'version 1', 'utf8')

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })

    // 第一次 Run
    const run1 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    const exec1 = makeExecutor(new ScriptedProvider([{ text: '第一版完成' }]), snapshot)
    await exec1.execute({
      runId: run1.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('做')],
      signal: new AbortController().signal,
    })

    const v1 = store.listArtifacts(run1.id).find((a) => a.path === 'doc.md')!
    expect(v1.version).toBe(1)
    expect(v1.parentArtifactId).toBeUndefined()

    // 改内容，第二次 Run（返工）
    writeFileSync(join(workspace, 'doc.md'), 'version 2', 'utf8')
    const run2 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 }, parentRunId: run1.id })
    const exec2 = makeExecutor(new ScriptedProvider([{ text: '第二版完成' }]), snapshot)
    await exec2.execute({
      runId: run2.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('改一下')],
      signal: new AbortController().signal,
    })

    const v2 = store.listArtifacts(run2.id).find((a) => a.path === 'doc.md')!
    expect(v2.version).toBe(2)
    expect(v2.parentArtifactId).toBe(v1.id)
    expect(v2.contentHash).not.toBe(v1.contentHash)

    // 旧版本仍然存在，未被覆盖
    const stillThere = store.getArtifact(v1.id)
    expect(stillThere).toBeDefined()
    expect(stillThere!.version).toBe(1)
    expect(stillThere!.status).toBe('candidate')
  })

  it('内容未变时不产生重复 Artifact', async () => {
    writeFileSync(join(workspace, 'stable.txt'), 'unchanged', 'utf8')

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })

    const run1 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    await makeExecutor(new ScriptedProvider([{ text: 'ok' }]), snapshot).execute({
      runId: run1.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    const run2 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    await makeExecutor(new ScriptedProvider([{ text: 'ok again' }]), snapshot).execute({
      runId: run2.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    // 第一个 Run 有 1 个 artifact，第二个 Run 因为内容未变不应新增
    expect(store.listArtifacts(run1.id)).toHaveLength(1)
    expect(store.listArtifacts(run2.id)).toHaveLength(0)
  })

  it('快照失败被显式记录，Run 仍然完成', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'x', 'utf8')

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const failingSnapshot: SnapshotHook = {
      async capture() {
        throw new Error('磁盘空间不足')
      },
      async readFileAt() {
        return null
      },
    }

    const outcome = await makeExecutor(new ScriptedProvider([{ text: '完成' }]), failingSnapshot).execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    // Run 仍然完成——快照失败不应让任务失败
    expect(outcome.status).toBe('completed')

    // 但必须留下记录
    const events = store.listEvents(run.id)
    const failEvent = events.find((e) => e.kind === 'snapshot.failed')
    expect(failEvent).toBeDefined()
    expect(JSON.stringify(failEvent!.payload)).toContain('磁盘空间不足')

    // 没有快照，也没有 artifact
    expect(store.listSnapshots(run.id)).toHaveLength(0)
    expect(store.listArtifacts(run.id)).toHaveLength(0)
  })

  it('没有配置快照钩子时不拍快照，不报错', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'x', 'utf8')

    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })

    const outcome = await makeExecutor(new ScriptedProvider([{ text: 'ok' }])).execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    expect(outcome.status).toBe('completed')
    expect(store.listSnapshots(run.id)).toHaveLength(0)
    expect(store.listArtifacts(run.id)).toHaveLength(0)
  })

  it('Task 下的产物可以跨 Run 查询并保持版本链', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })

    writeFileSync(join(workspace, 'f.txt'), 'v1', 'utf8')
    const run1 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    await makeExecutor(new ScriptedProvider([{ text: 'ok' }]), snapshot).execute({
      runId: run1.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    writeFileSync(join(workspace, 'f.txt'), 'v2', 'utf8')
    const run2 = store.createRun({ taskId: task.id, role: 'producer', budget: { maxSteps: 10 } })
    await makeExecutor(new ScriptedProvider([{ text: 'ok' }]), snapshot).execute({
      runId: run2.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'test' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    const all = store.listTaskArtifacts(task.id).filter((a) => a.path === 'f.txt')
    expect(all).toHaveLength(2)
    expect(all.map((a) => a.version).sort()).toEqual([1, 2])

    const v2 = all.find((a) => a.version === 2)!
    const v1 = all.find((a) => a.version === 1)!
    expect(v2.parentArtifactId).toBe(v1.id)
  })
})
