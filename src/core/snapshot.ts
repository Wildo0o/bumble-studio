// 快照。用 git 的 stash 机制做增量快照，不自己实现内容寻址。
//
// 设计要点（参考 Cline 的 checkpoint-hooks，自己实现）：
//   1. git stash create 不改变工作区、不改变 HEAD
//   2. 私有 ref 防止对象被 GC
//   3. 每会话独立 GIT_INDEX_FILE，避免并发冲突
//   4. 恢复前先保存当前状态（事务保护）——否则「回滚」本身会丢数据
//
// 与 Cline 的差异：
//   · 不处理未跟踪文件的三父提交合成（v1 只快照已跟踪 + 显式加入的文件）
//   · 快照与 Artifact 显式关联，而不是整个工作区的隐式历史
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, rm, writeFile, readFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)

/** 影子仓库归属标记文件名（放在 repoDir 根下）。 */
const SHADOW_MARKER = 'AI-WORKSTATION-SNAPSHOT-REPO'
const SHADOW_MARKER_CONTENT = '本目录由 AI 工作站创建，用于存放快照影子仓库。\n'
/** ensureRepo 初始化时写入的固定 git 身份，用于识别升级前创建的老影子仓库。 */
/**
 * 快照的排除列表。
 *
 * 这份列表是**契约**：它决定了「快照里有什么」。
 * 之前用 `git add --all --force .` 时，--force 会忽略
 * .git/info/exclude，于是这份列表形同虚设——
 * node_modules 与构建产物照样进快照，把磁盘撑爆，
 * 而用户还以为排除生效了。
 *
 * 现在 capture 用 `--all`（不加 --force），并另外做一次显式过滤，双保险。
 */
export const SNAPSHOT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.git/',
  '.next/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.log',
  '*.tmp',
  '.DS_Store',
  'Thumbs.db',
]

const SHADOW_EMAIL = 'snapshot@ai-workstation.local'

export interface SnapshotResult {
  /** git commit SHA */
  ref: string
  fileCount: number
  totalBytes: number
}

export interface RestoreResult {
  ok: boolean
  error?: string
  /** 恢复失败时，是否已成功回滚到操作前状态 */
  rolledBack?: boolean
}

/**
 * 快照管理器。
 *
 * 每个工作区对应一个影子 git 仓库（放在工作区之外的临时目录）。
 * 为什么不在工作区里用 git：
 *   · 用户的工作区可能不是 git 仓库
 *   · 即使用户是 git 仓库，我们也不该污染他的历史、分支和 stash 列表
 */
export class SnapshotManager {
  private repoDir: string
  private workspaceRoot: string
  private initialized = false

  constructor(workspaceRoot: string, opts: { repoDir?: string } = {}) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.repoDir = resolve(
      opts.repoDir ?? join(tmpdir(), 'ai-workstation-snapshots', hashPath(this.workspaceRoot)),
    )
    this.assertRepoOutsideWorkspace()
  }

  /**
   * 影子仓库绝不能落在工作区内。
   *
   * 不检查会怎样：影子仓库的 git 命令用 `cwd: repoDir`，
   * 如果 repoDir 恰好是工作区的上级或工作区自身，
   * 我们就会在用户的项目根目录里 init 一个 git 仓库、
   * 覆盖他的 .git、把源码当成快照提交进去。
   *
   * 这个 bug 真实发生过：项目根目录下的 main 分支被三个 snapshot 提交
   * 删光了所有源码。
   */
  private assertRepoOutsideWorkspace(): void {
    const ws = normalizeForCompare(this.workspaceRoot)
    const repo = normalizeForCompare(this.repoDir)

    if (repo === ws) {
      throw new Error(
        `快照仓库目录不能与工作区相同：${this.repoDir}。` +
        '这会导致快照操作污染用户的项目仓库。',
      )
    }
    if (repo.startsWith(ws + sep) || repo.startsWith(ws + '/')) {
      throw new Error(
        `快照仓库目录不能位于工作区内部：${this.repoDir}（工作区 ${this.workspaceRoot}）。` +
        '这会导致快照操作污染用户的项目仓库。',
      )
    }
    // 反向：工作区在 repoDir 内部也不行（repoDir 是工作区的祖先）
    if (ws.startsWith(repo + sep) || ws.startsWith(repo + '/')) {
      throw new Error(
        `工作区不能位于快照仓库目录内部：工作区 ${this.workspaceRoot}，仓库 ${this.repoDir}。`,
      )
    }

    // repoDir 不能落在任何已有的 git 仓库内部。
    //
    // 这个检查是必须的，而且比前两条更根本：
    // 我们执行 git 命令时用 cwd=repoDir。如果 repoDir 是某个 git 仓库的子目录
    // （哪怕不是工作区那个），git 会向上查找 .git 并找到它，
    // 然后在那个仓库里执行 commit / update-ref。
    //
    // 真实事故：
    //   repoDir = <项目>/.e2e-run3/data/snapshots
    //   工作区 = <项目>/.e2e-run3/workspace
    //   两者不重叠，前两条检查都通过。
    //   但 git 从 repoDir 向上找到了 <项目>/.git，
    //   于是在项目仓库里创建了 snapshot 提交，把 main 分支的源码删光。
    const existingRepoRoot = findGitRepoRoot(this.repoDir)
    if (existingRepoRoot && !this.isOwnShadowRepo(existingRepoRoot)) {
      throw new Error(
        `快照仓库目录不能位于任何已有的 git 仓库内部：` +
        `${this.repoDir} 位于仓库 ${existingRepoRoot} 内。` +
        '这会让快照操作污染那个仓库。请把快照目录放到 git 仓库之外（例如系统临时目录）。',
      )
    }
  }

  /**
   * 判断 `repoRoot` 是不是我们自己上次运行留下的影子仓库。
   *
   * 为什么需要这个判断：上面那条检查不能无脑执行。
   * 第一次运行拍完快照后，repoDir 本身会变成一个 git 仓库；
   * 第二次启动时 findGitRepoRoot(repoDir) 找到的就是它自己，
   * 于是检查把服务永久锁死 —— 起不来，也修不了。
   *
   * 判据是归属标记文件：只有我们自己初始化时才写这个文件。
   * 不靠目录名、不靠 remote、不靠 commit message ——
   * 那些都可能被用户碰巧撞上。
   */
  private isOwnShadowRepo(repoRoot: string): boolean {
    if (normalizeForCompare(repoRoot) !== normalizeForCompare(this.repoDir)) return false

    // 主判据：本次及以后创建的影子仓库都带标记文件
    if (existsSync(join(this.repoDir, SHADOW_MARKER))) return true

    // 升级路径：标记文件是后加的，之前创建的影子仓库没有。
    // 退回到 git 身份 —— ensureRepo 初始化时固定写入这个 email，
    // 用户自己的仓库几乎不可能正好用它。
    try {
      const config = readFileSync(join(this.repoDir, '.git', 'config'), 'utf8')
      if (config.includes(SHADOW_EMAIL)) return true
    } catch {
      /* 读不到就按「不是自己的」处理，宁可拒绝也不要认错 */
    }
    return false
  }

  /** 惰性初始化影子仓库。第一次拍快照时才建，不影响启动速度。 */
  private async ensureRepo(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.repoDir, { recursive: true })

    const hasGit = await this.git(['rev-parse', '--git-dir'], { allowFail: true })
    if (!hasGit) {
      await this.git(['init', '--quiet'])
      await this.git(['config', 'user.email', SHADOW_EMAIL])
      await this.git(['config', 'user.name', 'AI Workstation Snapshot'])
      // 忽略巨大的目录，避免快照把磁盘撑爆
      await writeFile(
        join(this.repoDir, '.git', 'info', 'exclude'),
        SNAPSHOT_EXCLUDES.join('\n'),
        'utf8',
      )
      // 归属标记：下次启动时据此认出「这是自己的仓库」，否则会被位置检查锁死
      await writeFile(join(this.repoDir, SHADOW_MARKER), SHADOW_MARKER_CONTENT, 'utf8')
    } else if (!existsSync(join(this.repoDir, SHADOW_MARKER))) {
      // 已有 .git 但没有标记：可能是用户手动指向的仓库，也可能是升级前的老影子仓库。
      // 构造阶段已经拦下了「别人的仓库」，能走到这里说明 repoRoot 就是 repoDir 自己。
      // 补写标记，让后续启动不再需要第二次判断。
      await writeFile(join(this.repoDir, SHADOW_MARKER), SHADOW_MARKER_CONTENT, 'utf8')
    }
    this.initialized = true
  }

  private async git(
    args: string[],
    opts: { allowFail?: boolean; env?: Record<string, string>; raw?: boolean } = {},
  ): Promise<string | null> {
    try {
      const { stdout } = await exec('git', args, {
        cwd: this.repoDir,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...(opts.env ?? {}) },
      })
      // raw: true 时不 trim。
      //
      // 读文件内容（git show）必须用 raw —— trim() 会吃掉文件末尾的换行，
      // 导致读回来的内容与原始文件不一致，哈希校验也会失败。
      // 这是实测发现的：'line1\nline2\n' 读回来变成 'line1\nline2'。
      return opts.raw ? stdout : stdout.trim()
    } catch (err) {
      if (opts.allowFail) return null
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`git ${args[0]} 失败：${message}`)
    }
  }

  /**
   * 拍一个快照。
   *
   * 做法：把工作区的当前文件内容写进影子仓库的索引，然后 commit。
   * 不用 stash 的原因：影子仓库的工作区就是空的，
   * 我们只需要「当前工作区的文件树」这棵树对象。
   */
  async capture(): Promise<SnapshotResult> {
    await this.ensureRepo()

    const indexFile = join(this.repoDir, `.index-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: indexFile }

    try {
      // 清空索引，确保快照反映的是「此刻」而不是累积
      await this.git(['read-tree', '--empty'], { env })

      // 把工作区文件加入索引。
      //
      // **不加 --force**：--force 会让 git 忽略 .git/info/exclude，
      // 于是 node_modules / dist 等被排除目录照样进快照。
      // 那既会撑爆磁盘，也让「排除规则」变成一句空话。
      //
      // cwd 是影子仓库、--work-tree 是真实工作区：
      // .git/info/exclude 属于影子仓库，作用于这次 add。
      const workTreeArgs = ['--work-tree', this.workspaceRoot, 'add', '--all', '.']
      await this.git(workTreeArgs, { env })

      // 写出树对象
      const tree = await this.git(['write-tree'], { env })
      if (!tree) throw new Error('write-tree 没有返回树对象')

      // 创建 commit（父提交是上一次快照，形成历史链）
      const parent = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })
      const message = `snapshot ${new Date().toISOString()}`
      const commitArgs = parent
        ? ['commit-tree', tree, '-p', parent, '-m', message]
        : ['commit-tree', tree, '-m', message]
      const commit = await this.git(commitArgs)
      if (!commit) throw new Error('commit-tree 没有返回提交对象')

      // 移动 HEAD 和 refs/heads/main 到新快照
      await this.git(['update-ref', 'refs/heads/main', commit])
      await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true })

      // 统计
      const { fileCount, totalBytes } = await this.statTree(commit)

      return { ref: commit, fileCount, totalBytes }
    } finally {
      await unlink(indexFile).catch(() => {
        /* 清理失败不影响正确性 */
      })
    }
  }

  private async statTree(ref: string): Promise<{ fileCount: number; totalBytes: number }> {
    const out = await this.git(['ls-tree', '-r', '-l', ref])
    if (!out) return { fileCount: 0, totalBytes: 0 }
    let fileCount = 0
    let totalBytes = 0
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      fileCount++
      // 格式：<mode> <type> <sha> <size>\t<path>
      const parts = line.split('\t')[0]!.split(/\s+/)
      const size = Number(parts[3])
      if (Number.isFinite(size)) totalBytes += size
    }
    return { fileCount, totalBytes }
  }

  /**
   * 从快照恢复到工作区。
   *
   * 事务保护：先把当前状态拍成一个「回滚点」，
   * 恢复失败时从回滚点还原。没有这个，「回滚」会成为最危险的操作。
   */
  async restore(ref: string): Promise<RestoreResult> {
    await this.ensureRepo()

    // 1. 验证目标快照真实存在
    //
    // 不能用 rev-parse --verify：它对全 0 的 SHA 也会返回成功，
    // 等 checkout 执行到一半才报「unable to read tree」——
    // 那时工作区已经被改动了。必须用 cat-file -e 确认对象真的在库里。
    const verified = await this.git(['cat-file', '-e', `${ref}^{commit}`], { allowFail: true })
    if (verified === null) {
      return { ok: false, error: `快照不存在：${ref}` }
    }

    // 2. 保存当前状态作为回滚点
    let rollbackRef: string
    try {
      const current = await this.capture()
      rollbackRef = current.ref
    } catch (err) {
      return { ok: false, error: `无法创建回滚点，已中止恢复：${err instanceof Error ? err.message : String(err)}` }
    }

    // 3. 用 git checkout 把文件写到工作区
    try {
      // -f 覆盖本地改动；--work-tree 指向真实工作区
      await this.git(['--work-tree', this.workspaceRoot, 'checkout', ref, '--', '.'], {})
      // 删除快照里不存在、但工作区里有的文件
      await this.removeExtraFiles(ref)
      return { ok: true }
    } catch (err) {
      // 4. 失败则回滚
      try {
        await this.git(['--work-tree', this.workspaceRoot, 'checkout', rollbackRef, '--', '.'])
        await this.removeExtraFiles(rollbackRef)
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          rolledBack: true,
        }
      } catch (rollbackErr) {
        return {
          ok: false,
          error: `恢复失败：${err instanceof Error ? err.message : String(err)}；` +
            `回滚也失败：${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          rolledBack: false,
        }
      }
    }
  }

  /** 删除工作区里存在但快照里没有的文件（checkout 不会删）。 */
  private async removeExtraFiles(ref: string): Promise<void> {
    const inSnapshot = new Set<string>()
    const listing = await this.git(['ls-tree', '-r', '--name-only', ref])
    if (listing) {
      for (const p of listing.split('\n')) {
        if (p.trim()) inSnapshot.add(p.trim().replace(/\\/g, '/'))
      }
    }

    const present = await this.listWorkspaceFiles()
    for (const rel of present) {
      if (!inSnapshot.has(rel)) {
        await unlink(resolve(this.workspaceRoot, rel)).catch(() => {
          /* 文件可能已被其他进程删除 */
        })
      }
    }
  }

  private async listWorkspaceFiles(): Promise<string[]> {
    const out: string[] = []
    const skip = new Set(['node_modules', 'dist', 'build', '.git'])
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (skip.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          out.push(relative(this.workspaceRoot, full).replace(/\\/g, '/'))
        }
      }
    }
    await walk(this.workspaceRoot)
    return out
  }

  /** 计算两个快照之间的差异。 */
  async diff(fromRef: string, toRef: string): Promise<{ patch: string; filesChanged: number }> {
    await this.ensureRepo()
    const out = await this.git(['diff', '--no-color', `${fromRef}..${toRef}`], { allowFail: true })
    const patch = out ?? ''
    const filesChanged = (patch.match(/^diff --git /gm) ?? []).length
    return { patch, filesChanged }
  }

  /** 列出快照里的文件清单。 */
  async listFiles(ref: string): Promise<string[]> {
    await this.ensureRepo()
    const out = await this.git(['ls-tree', '-r', '--name-only', ref], { allowFail: true })
    if (!out) return []
    return out.split('\n').filter((p) => p.trim()).map((p) => p.trim())
  }

  /**
   * 读取快照里某个文件的内容。
   *
   * 必须用 raw 模式：文件末尾的换行是内容的一部分，
   * trim() 掉会导致「读回来的内容 ≠ 原始内容」，
   * 进而让哈希校验失败、导出内容缺一个换行。
   */
  async readFileAt(ref: string, relPath: string): Promise<string | null> {
    await this.ensureRepo()
    return this.git(['show', `${ref}:${relPath.replace(/\\/g, '/')}`], {
      allowFail: true,
      raw: true,
    })
  }

  /** 计算文件内容哈希，用于 Artifact 去重与比对。 */
  async hashFile(relPath: string): Promise<string | null> {
    try {
      const buf = await readFile(join(this.workspaceRoot, relPath))
      return createHash('sha256').update(buf).digest('hex')
    } catch {
      return null
    }
  }

  /** 清理整个影子仓库。用于「删除工作区」这类场景。 */
  async destroy(): Promise<void> {
    await rm(this.repoDir, { recursive: true, force: true })
    this.initialized = false
  }

  /**
   * 回收不可达的 Git 对象。
   *
   * 为什么必须有这一步：软删除数据库记录**不会**释放磁盘。
   *
   *   快照是一条 commit 链（每个 committed 指向它的父提交）。
   *   只要链上还有任何一个提交可达，它的整棵历史树都会被保留。
   *   所以「删掉最新几个快照」几乎不回收任何空间——
   *   旧提交仍被更早的 ref 引用着。
   *
   * 正确做法：
   *   1. 用一个临时的孤立 ref（refs/snapshots/keep）指向
   *      **所有仍需要保留的**快照 ref
   *   2. 删掉原来的 refs/heads/main（它是整条链的锚点）
   *   3. `git gc --prune=now` 回收所有不再可达的对象
   *   4. 把 keep ref 的内容写回 refs/heads/main（如果有需要保留的）
   *   5. 删掉临时 ref
   *
   * 关键约束：**必须由调用方给出 keepRefs**。
   * 这个方法不做「猜哪些该留」的决定——那就是数据丢失。
   *
   * @param keepRefs 仍然必须可达的快照 commit ref
   * @returns 回收前后的对象数与体积（用于验证「真的回收了」）
   */
  async reclaimObjects(keepRefs: string[]): Promise<{
    before: { count: number; sizeKb: number }
    after: { count: number; sizeKb: number }
  }> {
    await this.ensureRepo()

    const before = await this.repoStats()

    // ── 临时 keep ref 的命名 ────────────────────────────
    //
    // 必须全部是**扁平**名字（refs/snapshots/keep/0、/1 …），
    // 不能出现「refs/snapshots/keep」与「refs/snapshots/keep/1」并存：
    // git 的 ref 存储里前者是文件、后者是目录，会冲突
    // （fatal: cannot lock ref ...）。
    //
    // 早期的实现正是这样错的：第一个 ref 用 KEEP，后续用 KEEP/i，
    // 于是只要有超过一个 keepRefs 就直接失败——而失败是
    // allowFail 吞掉的，表现为「回收了什么都没做」。
    const keepRefName = (i: number): string => `refs/snapshots/keep/${i}`

    const allKeepRefs: string[] = []
    for (let i = 0; i < keepRefs.length; i++) allKeepRefs.push(keepRefName(i))

    // 先清掉上一轮可能残留的临时 ref（旧版本可能留下过不同命名）
    await this.git(['update-ref', '-d', 'refs/snapshots/keep'], { allowFail: true })
    for (const r of allKeepRefs) {
      await this.git(['update-ref', '-d', r], { allowFail: true })
    }

    // 1. 用临时 ref 指住所有要保留的提交。
    //
    // keepRefs 为空时不创建任何 ref —— gc 会回收全部对象。
    // 这是危险但合法的用法（整体重置），风险由调用方承担；
    // 不在这里做「至少留一个」的猜测。
    // ── keep ref 创建必须 fail-closed（审计二轮 P1-9）────────
    //
    // 旧实现用 allowFail: true，失败静默返回 null 然后继续 gc。
    // 后果是**数据丢失**：没建起来的 ref 保护不了对应提交，
    // gc 会把它们回收，而调用方以为「已经保留了」。
    //
    // 现在：任何一个 keep ref 建不起来就整体放弃，抛出错误。
    // 宁可这次回收不执行（磁盘暂时不释放），也不能删掉应该保留的快照。
    for (let i = 0; i < keepRefs.length; i++) {
      const wanted = keepRefs[i]!
      // 先确认这个 ref 指向的对象确实存在且是提交
      const exists = await this.git(['cat-file', '-e', `${wanted}^{commit}`], { allowFail: true })
      if (exists === null) {
        throw new Error(
          `keepRef ${wanted} 不是有效提交（可能已被回收）。` +
          '拒绝继续回收：继续执行会把其它应保留的对象一并删除。',
        )
      }
      await this.git(['update-ref', keepRefName(i), wanted])
    }

    // 2. 摘掉主引用：它是整条提交链的锚点。
    await this.git(['update-ref', '-d', 'refs/heads/main'], { allowFail: true })
    await this.git(['symbolic-ref', '--delete', 'HEAD'], { allowFail: true })

    // 3. 回收不可达对象。
    await this.git(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true })
    await this.git(['gc', '--prune=now', '--quiet'], { allowFail: true })

    // 4. 恢复：把 keep refs 的内容重新做成一条链写回 main。
    //
    // 为什么不能只写 keepRefs[0]：其余提交虽然此刻仍被临时 ref 指着，
    // 但第 5 步删掉临时 ref 后就不可达了——下一次 gc 会把它们回收。
    // 也就是说「保留了两个快照，只剩一个能用」。
    //
    // 做法：把每个 keep commit 用 commit-tree 串成一条新链，
    // 让它们互为祖先，从而在单条 main 上全部可达。
    if (keepRefs.length === 1) {
      await this.git(['update-ref', 'refs/heads/main', keepRefs[0]!], { allowFail: true })
      await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true })
    } else if (keepRefs.length > 1) {
      // 用第一个作为基底，其余逐个叠加为它的子提交。
      // 每个新提交复用原提交的树，消息标注来源，便于人工追溯。
      let tip = keepRefs[0]!
      for (let i = 1; i < keepRefs.length; i++) {
        const tree = await this.git(['rev-parse', `${keepRefs[i]}^{tree}`], { allowFail: true })
        if (!tree) continue
        const created = await this.git(
          ['commit-tree', tree.trim(), '-p', tip, '-m', `snapshot keep: ${keepRefs[i]}`],
          { allowFail: true },
        )
        if (created) tip = created.trim()
      }
      await this.git(['update-ref', 'refs/heads/main', tip], { allowFail: true })
      await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true })
    }

    // 5. 清掉临时 ref。
    for (const r of allKeepRefs) {
      await this.git(['update-ref', '-d', r], { allowFail: true })
    }

    const after = await this.repoStats()
    return { before, after }
  }

  /** 影子仓库的对象统计。 */
  private async repoStats(): Promise<{ count: number; sizeKb: number }> {
    const raw = await this.git(['count-objects', '-v'], { allowFail: true })
    if (!raw) return { count: 0, sizeKb: 0 }
    const get = (key: string): number => {
      const m = new RegExp(`^${key}:\\s*(\\d+)$`, 'm').exec(raw)
      return m ? Number(m[1]) : 0
    }
    // count = 松散对象 + 打包内对象
    return {
      count: get('count') + get('in-pack'),
      sizeKb: get('size') + get('size-pack'),
    }
  }
}

function hashPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

/**
 * 从 path 开始向上查找最近的 git 仓库根目录。
 *
 * 找到返回根目录路径，没找到返回 undefined。
 *
 * 用途：防止快照仓库落在别的 git 仓库内部——那样 git 会向上找到那个 .git
 * 并在里面执行 commit，污染别人的仓库。
 */
function findGitRepoRoot(path: string): string | undefined {
  let current = resolve(path)
  // 最多向上 64 层，防止死循环
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, '.git'))) return current
    const parent = resolve(current, '..')
    if (parent === current) break   // 已经到根
    current = parent
  }
  return undefined
}

/** 路径比较用的归一化：Windows 下大小写不敏感、统一分隔符。 */
function normalizeForCompare(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32'
    ? abs.replace(/\//g, '\\').toLowerCase()
    : abs
}

/** 检查 git 是否可用。不可用时快照功能必须显式禁用，不能静默降级。 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await exec('git', ['--version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export { stat }
