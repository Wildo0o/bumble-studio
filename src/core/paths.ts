// 路径校验。
//
// 核心原则：**先把符号链接解析成真实路径，再按路径段比对**——
// 不能做字符串前缀匹配（`/a` 会匹配 `/ab`），也不能相信词法路径
// （`../` 与符号链接都能让「看起来在里面」的路径实际指向外面）。
//
// 所有解析失败的情形一律 fail-closed：无法确认路径最终落在哪里时，
// 拒绝比猜测安全。
import { realpathSync, lstatSync } from 'node:fs'
import { resolve, sep, dirname, basename, join } from 'node:path'

const isWin = process.platform === 'win32'

function normalizePath(p: string): string {
  const abs = resolve(p)
  return isWin ? abs.replace(/\//g, '\\').toLowerCase() : abs
}

/**
 * 解析符号链接后的真实路径。**解析不出来时返回 undefined**。
 *
 * 两条审计要求（二轮 P1-1 / P1-2）：
 *
 * 1. **dangling symlink 必须 fail-closed**
 *
 *    工作区/link -> /外部/不存在
 *
 *    旧实现遇到「存在但 realpath 抛错」的段会**继续向上找祖先**，
 *    于是坏链接被当成普通目录跳过，词法拼回去之后「看起来在工作区里」。
 *    正确做法：lstat 是链接但 realpath 失败 → 无法确认目标 → undefined。
 *
 * 2. **深度超限必须 fail-closed**
 *
 *    旧实现在 256 段后 break，然后返回词法路径 abs。
 *    那等于「算不完就当作合法」——刻意构造的超深路径可以绕过全部校验。
 *    正确做法：超限时返回 undefined，由调用方拒绝。
 *
 * @returns 解析成功的真实路径；无法可靠解析时 undefined。
 */
function safeRealpath(p: string): string | undefined {
  const abs = resolve(p)

  let probe = abs
  const missing: string[] = []
  const MAX_DEPTH = 256

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    let info: ReturnType<typeof lstatSync> | undefined
    try {
      info = lstatSync(probe)
    } catch {
      info = undefined
    }

    if (info) {
      if (info.isSymbolicLink()) {
        // 是链接：必须能解析到真实目标。解析失败（dangling / 权限）
        // 意味着无法确认最终位置 —— 一律拒绝，不能跳过它继续向上。
        try {
          const real = realpathSync(probe)
          return missing.length === 0 ? real : join(real, ...missing.slice().reverse())
        } catch {
          return undefined
        }
      }

      // 普通存在段：realpath 规范化（8.3 短名、大小写等）
      try {
        const real = realpathSync(probe)
        return missing.length === 0 ? real : join(real, ...missing.slice().reverse())
      } catch {
        return undefined
      }
    }

    const parent = dirname(probe)
    if (parent === probe) return undefined
    missing.push(basename(probe))
    probe = parent
  }

  // 超过深度上限：不能「算不完就算合法」
  return undefined
}

/**
 * 判断路径的最后一段是否本身是一个符号链接。
 *
 * 用于写操作：如果目标已经是一个指向外部（或内部其它文件）的链接，
 * 直接 writeFile 会改写它指向的文件。调用方应拒绝这种目标。
 */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(resolve(p)).isSymbolicLink()
  } catch {
    return false
  }
}

export interface PathCheck {
  allowed: boolean
  resolved: string
  reason?: string
}

export interface PathCheckOptions {
  /**
   * 符号链接探测。默认用 lstatSync。
   *
   * 之所以可注入：部分环境无法创建**文件**符号链接（Windows 非管理员），
   * 于是「写穿 symlink」这条防护无法用真实文件链接验证。
   * 注入让这段**逻辑**仍可被完整测试，而不是靠「本机没权限所以跳过」。
   */
  isSymlink?: (path: string) => boolean
}

/**
 * 判断 requested 是否落在任一 allowedRoot 内。
 *
 * 拒绝的情况：无允许目录、含 NUL、UNC、Windows 设备路径、
 * 符号链接解析失败（含 dangling 与深度超限）、解析后不在任何 root 下。
 * 防护重点：路径穿越、符号链接（含中间祖先）、Windows 大小写不敏感、
 * 路径前缀假阳性（`/a` 不能匹配 `/ab`）。
 */
export function isPathAllowed(
  requested: string,
  allowedRoots: string[],
  opts: PathCheckOptions = {},
): PathCheck {
  if (!allowedRoots.length) {
    return { allowed: false, resolved: requested, reason: '没有配置允许的目录' }
  }

  // 空字节会截断底层系统调用，让「看起来在允许范围内」的路径
  // 实际指向别处（`a\0/b` 在某些层被截成 `a`）。
  if (requested.includes('\u0000')) {
    return { allowed: false, resolved: requested, reason: '路径包含非法字符' }
  }

  // UNC 路径必须在 realpath 之前拦掉：解析 \\server\share 会发起网络请求，
  // 攻击者可以用一个不存在的服务器把执行器卡住数秒甚至数十秒。
  if (/^[\\/]{2}/.test(requested)) {
    return { allowed: false, resolved: requested, reason: 'UNC 路径不被允许' }
  }

  // Windows 设备路径（\\?\, \\.\）同样不解析
  if (/^[\\/]{1}[?.][\\/]/.test(requested) || /^\\\\[?.]\\/.test(requested)) {
    return { allowed: false, resolved: requested, reason: '设备路径不被允许' }
  }

  // 符号链接探测可选注入：仅用于「目标本身」这一段，
  // 中间祖先由 safeRealpath 统一处理。
  const probe = opts.isSymlink

  const target = safeRealpath(requested)
  if (target === undefined) {
    // ⚠️ fail-closed：无法解析（dangling 链接 / 深度超限 / 权限）
    // 时拒绝，而不是回退到词法路径。回退正是越权的来源。
    const linked = probe ? probe(requested) : false
    return {
      allowed: false,
      resolved: requested,
      reason: linked
        ? '目标是符号链接（符号链接），写入会实际改变它指向的文件；请直接指定真实路径'
        : '路径无法可靠解析（符号链接悬空、层级过深或权限不足）',
    }
  }

  if (/^[\\/]{2}/.test(target)) {
    return { allowed: false, resolved: target, reason: 'UNC 路径不被允许' }
  }

  const normTarget = normalizePath(target)

  for (const root of allowedRoots) {
    const rootReal = safeRealpath(root)
    if (rootReal === undefined) {
      // 允许目录本身解析不了 → 跳过这个 root（无法做包含判断）。
      //
      // 取舍说明：如果所有 root 都解析失败，整个判定会落到「不在允许范围内」
      // ——也就是**全部拒绝**。这会误伤一种场景：workspace 本身是个符号链接
      // 且它指向的目标暂时不可达（例如挂载盘未就绪）。
      //
      // 那个场景下继续放行才是危险的：路径解析不出来时，
      // 「允许」等于放弃全部边界检查。宁可让服务暂时不可用，
      // 也不要在一个无法验证的工作区上执行写操作。
      continue
    }
    const normRoot = normalizePath(rootReal)
    if (normTarget === normRoot) return { allowed: true, resolved: target }
    // 按路径段比对：root 后必须紧跟分隔符，杜绝 /allowed 匹配 /allowed-evil
    const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep
    if (normTarget.startsWith(prefix)) return { allowed: true, resolved: target }
  }

  return { allowed: false, resolved: target, reason: '路径不在允许范围内' }
}

/**
 * 写入前的严格校验。
 *
 * 与 isPathAllowed 的区别：**先**判断目标本身是不是符号链接，
 * 再判断是否在允许范围内。
 *
 * 为什么顺序不能反：`allowed/evil.txt` 是指向 `outside/real.txt` 的链接时，
 * 先跑 isPathAllowed 会得到「不在允许范围内」——用户会以为「换个路径就行」，
 * 于是换一个指向工作区内部的链接；那个会通过范围检查，但仍然会改到别的文件。
 *
 * 先判链接能给出准确的原因：写符号链接本身就是错的，与它指向哪里无关。
 */
export function isWritablePath(
  requested: string,
  allowedRoots: string[],
  opts: PathCheckOptions = {},
): PathCheck {
  const linked = (opts.isSymlink ?? isSymlink)(requested)
  const check = isPathAllowed(requested, allowedRoots, opts)

  if (linked) {
    return {
      allowed: false,
      resolved: check.resolved,
      // 明确写出「符号链接」：调用方与用户都要能识别这个关键词。
      reason: '目标是符号链接（符号链接），写入会实际改变它指向的文件；请直接指定真实路径',
    }
  }

  return check
}

/** 参数哈希，用于拒绝去重。稳定排序，避免键序不同导致漏判。 */
export function hashArguments(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj).sort()) out[key] = stable(obj[key])
      return out
    }
    return v
  }
  const json = JSON.stringify(stable(value) ?? null)
  let h = 0
  for (let i = 0; i < json.length; i++) {
    h = (h * 31 + json.charCodeAt(i)) | 0
  }
  return `${h.toString(16)}:${json.length}`
}
