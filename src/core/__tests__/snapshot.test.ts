// 用例 E：快照与恢复
//
// 验证：
//   1. 快照能捕获当前工作区状态
//   2. 恢复能还原到快照时刻
//   3. 恢复失败能回滚（事务保护）
//   4. 还原会删除快照里不存在的文件
//   5. diff 能算出两次快照的差异
//   6. 不污染用户的 git 仓库
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotManager, isGitAvailable } from '../snapshot.js'

describe('快照与恢复', () => {
  let dir: string
  let workspace: string
  let snapRepo: string
  let manager: SnapshotManager

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-snap-'))
    workspace = join(dir, 'workspace')
    snapRepo = join(dir, 'snaprepo')
    mkdirSync(workspace, { recursive: true })
    manager = new SnapshotManager(workspace, { repoDir: snapRepo })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('git 可用（前置条件）', async () => {
    expect(await isGitAvailable()).toBe(true)
  })

  // ── 影子仓库位置防护 ──────────────────────────────────
  //
  // 这是一个真实发生过的严重 bug：
  // 当 repoDir 落在工作区内（或等于工作区）时，
  // 影子仓库的 git 命令会用工作区当 cwd，
  // 结果在用户的项目根目录里 init 了一个仓库、
  // 覆盖了他的 .git、把源码当成快照提交进去，
  // 最后 main 分支被三个 snapshot 提交删光了所有源码。

  it('repoDir 等于工作区时必须拒绝构造', () => {
    expect(() => new SnapshotManager(workspace, { repoDir: workspace }))
      .toThrow(/不能与工作区相同/)
  })

  it('repoDir 位于工作区内部时必须拒绝构造', () => {
    expect(() => new SnapshotManager(workspace, { repoDir: join(workspace, '.snapshots') }))
      .toThrow(/不能位于工作区内部/)
  })

  it('工作区位于 repoDir 内部时必须拒绝构造', () => {
    expect(() => new SnapshotManager(workspace, { repoDir: dir }))
      .toThrow(/工作区不能位于快照仓库目录内部/)
  })

  it('repoDir 在工作区外部且不在 git 仓库内时可以正常构造', () => {
    // dir 是 mkdtemp 创建的临时目录，不是 git 仓库
    expect(() => new SnapshotManager(workspace, { repoDir: join(dir, 'outside') }))
      .not.toThrow()
  })

  it('repoDir 位于已有 git 仓库内部时必须拒绝构造', async () => {
    // 这是第二次真实事故的根因：
    // repoDir 和 workspace 不重叠（前两条检查都通过），
    // 但 repoDir 在某个 git 仓库的子目录里，git 会向上找到那个 .git
    // 并在里面创建 snapshot 提交，把主分支源码删光。
    const { execFileSync } = await import('node:child_process')

    const fakeRepo = join(dir, 'fake-project')
    mkdirSync(fakeRepo, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: fakeRepo })
    execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: fakeRepo })
    execFileSync('git', ['config', 'user.name', 'x'], { cwd: fakeRepo })

    const ws2 = join(fakeRepo, 'ws')
    mkdirSync(ws2, { recursive: true })

    // repoDir 在 fakeRepo 内部，且不在 ws2 内 → 前两条检查通过
    // 但必须被「不能位于已有 git 仓库内」拦下
    expect(() =>
      new SnapshotManager(ws2, { repoDir: join(fakeRepo, 'snapshots') }),
    ).toThrow(/不能位于任何已有的 git 仓库内部/)
  })

  it('repoDir 在 git 仓库之外时可以正常构造', async () => {
    const { execFileSync } = await import('node:child_process')

    const fakeRepo = join(dir, 'repo2')
    mkdirSync(fakeRepo, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: fakeRepo })

    const ws3 = join(fakeRepo, 'ws')
    mkdirSync(ws3, { recursive: true })

    // repoDir 完全在 fakeRepo 外面 → 允许
    const outside = join(dir, 'snapshots-outside')
    expect(() => new SnapshotManager(ws3, { repoDir: outside })).not.toThrow()
  })

  // ── 影子仓库不能被误认成「别人的仓库」 ───────────────
  //
  // 真实缺陷：服务第一次启动正常；第一次拍完快照后 repoDir 变成 git 仓库；
  // 第二次启动时 findGitRepoRoot(repoDir) 找到的正是这个影子仓库自己，
  // 于是构造抛错 —— 服务再也起不来。
  //
  // 这不是理论问题：上面的 e2e 用 ~/.ai-workstation/snapshots 当快照目录，
  // 跑过一次之后就永久启动失败。

  it('影子仓库已经存在时，再次构造必须成功（服务重启）', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'v1', 'utf8')
    await manager.capture()          // 这一步把 snapRepo 变成了 git 仓库

    // 模拟进程重启：同一个 repoDir 重新构造
    expect(() => new SnapshotManager(workspace, { repoDir: snapRepo })).not.toThrow()
  })

  it('重启后的实例能继续拍快照并沿用历史链', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'v1', 'utf8')
    const first = await manager.capture()

    const restored = new SnapshotManager(workspace, { repoDir: snapRepo })
    writeFileSync(join(workspace, 'a.txt'), 'v2', 'utf8')
    const second = await restored.capture()

    expect(second.ref).not.toBe(first.ref)
    // 历史链没断：第二个快照能读到第一个快照的内容
    expect(await restored.readFileAt(first.ref, 'a.txt')).toBe('v1')
    expect(await restored.readFileAt(second.ref, 'a.txt')).toBe('v2')
  })

  it('指认的仓库是影子仓库自己时放行，是别人的仓库时仍要拒绝', async () => {
    const { execFileSync } = await import('node:child_process')

    // 别人的仓库：repoDir 是它的子目录 → 拒绝
    const foreign = join(dir, 'foreign-repo')
    mkdirSync(foreign, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: foreign })
    const wsForeign = join(dir, 'ws-foreign')
    mkdirSync(wsForeign, { recursive: true })
    expect(() =>
      new SnapshotManager(wsForeign, { repoDir: join(foreign, 'snapshots') }),
    ).toThrow(/不能位于任何已有的 git 仓库内部/)

    // 自己的仓库：上次运行留下的 repoDir → 放行
    writeFileSync(join(workspace, 'b.txt'), 'x', 'utf8')
    await manager.capture()
    expect(() => new SnapshotManager(workspace, { repoDir: snapRepo })).not.toThrow()
  })

  it('快照能捕获文件并记录数量与大小', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'world!!', 'utf8')

    const snap = await manager.capture()
    expect(snap.ref).toMatch(/^[0-9a-f]{40}$/)
    expect(snap.fileCount).toBe(2)
    expect(snap.totalBytes).toBe(5 + 7)
  })

  it('恢复能还原到快照时刻', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'original', 'utf8')
    const snap = await manager.capture()

    // 改坏它
    writeFileSync(join(workspace, 'a.txt'), 'corrupted', 'utf8')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('corrupted')

    // 恢复
    const result = await manager.restore(snap.ref)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')
  })

  it('恢复会删除快照里不存在的文件', async () => {
    writeFileSync(join(workspace, 'keep.txt'), 'yes', 'utf8')
    const snap = await manager.capture()

    // 新增一个快照里没有的文件
    writeFileSync(join(workspace, 'extra.txt'), 'should be deleted', 'utf8')
    expect(existsSync(join(workspace, 'extra.txt'))).toBe(true)

    await manager.restore(snap.ref)

    expect(existsSync(join(workspace, 'keep.txt'))).toBe(true)
    expect(existsSync(join(workspace, 'extra.txt'))).toBe(false)
  })

  it('恢复不存在的快照会失败而不是破坏工作区', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'safe', 'utf8')
    const result = await manager.restore('0000000000000000000000000000000000000000')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
    // 工作区未被破坏
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('safe')
  })

  it('diff 能算出两次快照的差异', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'line1\nline2\n', 'utf8')
    const s1 = await manager.capture()

    writeFileSync(join(workspace, 'a.txt'), 'line1\nCHANGED\n', 'utf8')
    writeFileSync(join(workspace, 'new.txt'), 'brand new\n', 'utf8')
    const s2 = await manager.capture()

    const { patch, filesChanged } = await manager.diff(s1.ref, s2.ref)
    expect(filesChanged).toBe(2)
    expect(patch).toContain('-line2')
    expect(patch).toContain('+CHANGED')
    expect(patch).toContain('new.txt')
  })

  it('能读取快照里某个文件的历史内容', async () => {
    writeFileSync(join(workspace, 'v.txt'), 'version-1', 'utf8')
    const snap = await manager.capture()

    writeFileSync(join(workspace, 'v.txt'), 'version-2', 'utf8')

    const old = await manager.readFileAt(snap.ref, 'v.txt')
    expect(old).toBe('version-1')

    const missing = await manager.readFileAt(snap.ref, 'nope.txt')
    expect(missing).toBeNull()
  })

  it('读取文件时必须保留末尾换行', async () => {
    // 这是一个真实踩过的坑：git() 无条件 trim() 会吃掉文件末尾的换行，
    // 导致读回的内容与原始内容不一致，哈希校验失败、导出少一个换行。
    const withTrailing = 'line1\nline2\n'
    const withoutTrailing = 'line1\nline2'
    writeFileSync(join(workspace, 'with.txt'), withTrailing, 'utf8')
    writeFileSync(join(workspace, 'without.txt'), withoutTrailing, 'utf8')

    const snap = await manager.capture()

    expect(await manager.readFileAt(snap.ref, 'with.txt')).toBe(withTrailing)
    expect(await manager.readFileAt(snap.ref, 'without.txt')).toBe(withoutTrailing)
  })

  it('读取文件时必须保留前导空白与空行', async () => {
    const content = '\n\n  indented\n\n\ttabbed\n\n'
    writeFileSync(join(workspace, 'ws.txt'), content, 'utf8')
    const snap = await manager.capture()

    expect(await manager.readFileAt(snap.ref, 'ws.txt')).toBe(content)
  })

  it('listFiles 返回快照内的文件清单', async () => {
    writeFileSync(join(workspace, 'x.txt'), 'x', 'utf8')
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    writeFileSync(join(workspace, 'sub', 'y.txt'), 'y', 'utf8')

    const snap = await manager.capture()
    const files = await manager.listFiles(snap.ref)

    expect(files).toContain('x.txt')
    expect(files).toContain('sub/y.txt')
  })

  it('不污染工作区自身的 git 仓库', async () => {
    // 在工作区里初始化一个用户自己的 git 仓库
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '--quiet'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'user@example.com'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'User'], { cwd: workspace })
    writeFileSync(join(workspace, 'tracked.txt'), 'v1', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: workspace })
    execFileSync('git', ['commit', '-m', 'user commit'], { cwd: workspace })

    // 拍快照
    writeFileSync(join(workspace, 'tracked.txt'), 'v2', 'utf8')
    await manager.capture()

    // 用户仓库的历史不应该被我们的快照改动
    const log = execFileSync('git', ['log', '--oneline'], { cwd: workspace, encoding: 'utf8' })
    expect(log.trim().split('\n')).toHaveLength(1)
    expect(log).toContain('user commit')

    // 工作区的文件内容保持不变
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('v2')
  })

  it('连续快照形成可比较的历史链', async () => {
    writeFileSync(join(workspace, 'n.txt'), '0', 'utf8')
    const s1 = await manager.capture()

    writeFileSync(join(workspace, 'n.txt'), '1', 'utf8')
    const s2 = await manager.capture()

    writeFileSync(join(workspace, 'n.txt'), '2', 'utf8')
    const s3 = await manager.capture()

    // 三个快照的 ref 都不同
    expect(new Set([s1.ref, s2.ref, s3.ref]).size).toBe(3)

    // 任意两两之间都能 diff
    const d12 = await manager.diff(s1.ref, s2.ref)
    expect(d12.patch).toContain('-0')
    expect(d12.patch).toContain('+1')

    const d13 = await manager.diff(s1.ref, s3.ref)
    expect(d13.patch).toContain('-0')
    expect(d13.patch).toContain('+2')
  })

  it('恢复后再次快照，内容与目标快照一致', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'target', 'utf8')
    const target = await manager.capture()

    writeFileSync(join(workspace, 'a.txt'), 'drifted', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'extra', 'utf8')

    await manager.restore(target.ref)
    const after = await manager.capture()

    // 内容树应该一致（ref 不同因为父提交和消息不同，但文件内容相同）
    const targetFiles = await manager.listFiles(target.ref)
    const afterFiles = await manager.listFiles(after.ref)
    expect(afterFiles.sort()).toEqual(targetFiles.sort())

    expect(await manager.readFileAt(after.ref, 'a.txt')).toBe('target')
    expect(await manager.readFileAt(after.ref, 'b.txt')).toBeNull()
  })
})
