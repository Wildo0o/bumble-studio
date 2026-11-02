// 与文件系统和网络位置相关的共享判断。
//
// 抽出来的原因：服务端启动时要用它决定快照目录，
// 快照管理器内部也要用它防止污染别人的仓库。
// 两处必须用同一套判断，否则会出现「启动时认为不在仓库内、
// 构造时认为在仓库内」这种自相矛盾的局面。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 路径是否落在某个 git 仓库内部（含自身）。
 *
 * 注意：git 命令用 cwd 指向某个目录时会**向上查找** .git，
 * 所以子目录里的仓库同样会污染祖先仓库。必须逐级向上检查。
 */
export function isInsideGitRepo(path: string): boolean {
  let current = resolve(path)
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, '.git'))) return true
    const parent = resolve(current, '..')
    if (parent === current) return false
    current = parent
  }
  return false
}
