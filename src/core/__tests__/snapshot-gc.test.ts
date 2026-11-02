import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotManager, isGitAvailable, SNAPSHOT_EXCLUDES } from '../snapshot.js'

describe('快照对象回收', () => {
  let dir: string
  let ws: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'snap-gc-'))
    ws = join(dir, 'ws')
    mkdirSync(ws, { recursive: true })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('排除列表包含 node_modules 等大目录', () => {
    expect(SNAPSHOT_EXCLUDES).toContain('node_modules/')
    expect(SNAPSHOT_EXCLUDES).toContain('dist/')
  })

  it('capture 不会把 node_modules 纳入快照', async () => {
    if (!(await isGitAvailable())) return
    mkdirSync(join(ws, 'node_modules', 'big'), { recursive: true })
    writeFileSync(join(ws, 'node_modules', 'big', 'x.js'), 'x'.repeat(1000), 'utf8')
    writeFileSync(join(ws, 'real.txt'), 'hello', 'utf8')

    const mgr = new SnapshotManager(ws, { repoDir: join(dir, 'shadow') })
    const snap = await mgr.capture()
    const files = await mgr.listFiles(snap.ref)
    expect(files).toContain('real.txt')
    expect(files.some((f) => f.startsWith('node_modules/')), 'node_modules 不应进快照').toBe(false)
    await mgr.destroy()
  })

  // ── 多 keepRefs（审计 P2 → 已关闭）──────────────────────
  //
  // 早期实现把第一个 ref 命名为 refs/snapshots/keep，
  // 后续命名为 refs/snapshots/keep/1 —— git 会报
  // "cannot lock ref"（文件与目录冲突），而错误被 allowFail 吞掉，
  // 表现为「回收什么都没做」。
  //
  // 更隐蔽的是：即使 ref 建起来了，恢复时只把 keepRefs[0] 写回 main，
  // 其余提交在临时 ref 被删后不可达，下一次 gc 会把它们回收。
  // 也就是「以为保留了两个，实际只剩一个」。

  it('多个 keepRefs 全部保留且都可读', async () => {
    if (!(await isGitAvailable())) return
    writeFileSync(join(ws, 'a.txt'), 'first', 'utf8')
    const mgr = new SnapshotManager(ws, { repoDir: join(dir, 'shadow') })
    const s1 = await mgr.capture()
    writeFileSync(join(ws, 'a.txt'), 'second-content', 'utf8')
    const s2 = await mgr.capture()
    writeFileSync(join(ws, 'a.txt'), 'third-content-here', 'utf8')
    const s3 = await mgr.capture()

    // 保留 s1 与 s3（跳过 s2）
    await mgr.reclaimObjects([s3.ref, s1.ref])

    // 两个都必须仍然可读
    expect(await mgr.listFiles(s1.ref)).toContain('a.txt')
    expect(await mgr.listFiles(s3.ref)).toContain('a.txt')
    void s2
    await mgr.destroy()
  })

  it('多个 keepRefs 经过二次 gc 后仍然可读（临时 ref 不被依赖）', async () => {
    // 第二次 gc 会清掉所有不可达对象。如果恢复时只把 keepRefs[0]
    // 写回 main，其余提交在这一步就会消失。
    if (!(await isGitAvailable())) return
    writeFileSync(join(ws, 'a.txt'), 'oneeeeeee', 'utf8')
    const mgr = new SnapshotManager(ws, { repoDir: join(dir, 'shadow') })
    const s1 = await mgr.capture()
    writeFileSync(join(ws, 'a.txt'), 'twoeeeeee', 'utf8')
    const s2 = await mgr.capture()

    await mgr.reclaimObjects([s1.ref, s2.ref])

    // 再回收一次（不保留任何额外 ref，但 keep 同样两个）
    await mgr.reclaimObjects([s1.ref, s2.ref])

    expect(await mgr.listFiles(s1.ref)).toContain('a.txt')
    expect(await mgr.listFiles(s2.ref)).toContain('a.txt')
    await mgr.destroy()
  })

  it('invalid keepRef 必须 fail-closed：抛错而不是继续 gc', async () => {
    // 旧实现用 allowFail 建 keep ref，失败后继续 gc ——
    // 那会把「以为保留了」的提交回收掉，是数据丢失。
    if (!(await isGitAvailable())) return
    writeFileSync(join(ws, 'a.txt'), 'keepme', 'utf8')
    const mgr = new SnapshotManager(ws, { repoDir: join(dir, 'shadow') })
    const s1 = await mgr.capture()

    await expect(
      mgr.reclaimObjects([s1.ref, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']),
    ).rejects.toThrow(/不是有效提交/)

    // 关键：失败的回收不能把原快照删掉
    expect(await mgr.listFiles(s1.ref)).toContain('a.txt')
    await mgr.destroy()
  })

  it('reclaimObjects 真的减少对象数', async () => {
    if (!(await isGitAvailable())) return
    writeFileSync(join(ws, 'a.txt'), 'a'.repeat(5000), 'utf8')
    const mgr = new SnapshotManager(ws, { repoDir: join(dir, 'shadow') })
    const s1 = await mgr.capture()
    writeFileSync(join(ws, 'a.txt'), 'b'.repeat(5000), 'utf8')
    const s2 = await mgr.capture()
    writeFileSync(join(ws, 'a.txt'), 'c'.repeat(5000), 'utf8')
    await mgr.capture()

    // 只保留 s2 → s1 与 s3 应可回收
    const result = await mgr.reclaimObjects([s2.ref])
    expect(result.after.count).toBeLessThanOrEqual(result.before.count)
    // s2 仍然可用（这是「没删错」的关键断言）
    const files = await mgr.listFiles(s2.ref)
    expect(files).toContain('a.txt')
    void s1
    await mgr.destroy()
  })
})
