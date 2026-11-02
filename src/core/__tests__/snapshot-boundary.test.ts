// 第三组（审计二轮 P1）：Snapshot 与路径边界。
//
// 三条最明确的问题：
//   1. getSnapshot / listSnapshots 不过滤 deleted_at ——已删除的快照
//      仍能被 restore / apply / export 拿到，等于「删除」没生效
//   2. dangling symlink（指向不存在的目标）会让 realpath 抛错，
//      旧实现继续向上找祖先，可能把「坏链接」当成普通目录放行
//   3. 256 层上限：超过深度直接返回词法路径，等于绕过全部校验
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { isPathAllowed } from '../paths.js'

const canLink = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'probe-'))
    try {
      mkdirSync(join(d, 'a'))
      mkdirSync(join(d, 'b'))
      try {
        symlinkSync(join(d, 'b'), join(d, 'a', 'l'), 'junction')
      } catch {
        symlinkSync(join(d, 'b'), join(d, 'a', 'l'), 'dir')
      }
      return true
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  } catch {
    return false
  }
})()

describe('已删除快照的可见性（审计二轮）', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-snapdel-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function seed(): { runId: string; snapId: string } {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    const snap = store.createSnapshot({
      runId: run.id,
      taskId: task.id,
      kind: 'workspace',
      ref: 'abc123',
      reproducible: true,
      fileCount: 1,
      totalBytes: 10,
    })
    return { runId: run.id, snapId: snap.id }
  }

  it('软删除后 getSnapshot 不应再返回它', () => {
    const { snapId } = seed()
    store.softDeleteSnapshot(snapId)

    // 已删除的快照不该被 restore / apply / export 拿到
    expect(store.getSnapshot(snapId)).toBeUndefined()
  })

  it('软删除后 listSnapshots 不应再包含它', () => {
    const { runId, snapId } = seed()
    store.softDeleteSnapshot(snapId)
    expect(store.listSnapshots(runId).map((s) => s.id)).not.toContain(snapId)
  })

  it('需要时仍可取到已删除记录（显式 includeDeleted）', () => {
    // GC / 审计需要看到「曾经有过这个快照」
    const { snapId } = seed()
    store.softDeleteSnapshot(snapId)
    const all = store.listAllSnapshots({ includeDeleted: true })
    expect(all.map((s) => s.id)).toContain(snapId)
  })
})

describe('dangling symlink 与深度上限（审计二轮）', () => {
  let root: string
  let allowed: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-dangle-'))
    allowed = join(root, 'allowed')
    outside = join(root, 'outside')
    mkdirSync(allowed, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!canLink)('指向不存在目标的链接不能变成「允许」', () => {
    // dangling：目标不存在
    const link = join(allowed, 'dangling')
    try {
      symlinkSync(join(outside, 'does-not-exist'), link, 'junction')
    } catch {
      symlinkSync(join(outside, 'does-not-exist'), link, 'dir')
    }

    // 穿过这个坏链接的路径必须被拒（无法确认它最终指向哪里）
    const check = isPathAllowed(join(link, 'sub', 'file.txt'), [allowed])
    expect(check.allowed).toBe(false)
  })

  it('超过祖先扫描上限时必须 fail-closed，不能回退到词法路径', () => {
    // 造一个远超 256 段的路径；目标不存在。
    // 旧实现扫到上限后用词法路径返回，若词法上「在工作区内」就会被放行。
    const deep = join(allowed, ...Array.from({ length: 300 }, (_, i) => `d${i}`), 'f.txt')
    const check = isPathAllowed(deep, [allowed])
    // 关键：不能因为「算不完」就默认允许
    expect(check.allowed).toBe(false)
    expect(check.reason).toBeTruthy()
  })

  it('正常深度的不存在路径仍然允许（不能误伤）', () => {
    const normal = join(allowed, 'a', 'b', 'c', 'new.txt')
    expect(isPathAllowed(normal, [allowed]).allowed).toBe(true)
  })
})
