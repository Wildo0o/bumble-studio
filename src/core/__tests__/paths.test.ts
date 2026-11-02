// 用例 H：路径越权防护（评审补丁 4）
//
// 路径校验是这类系统的经典翻车点。必须验证：
//   路径穿越 / 符号链接 / Windows 大小写 / 短文件名 / UNC / 前缀假阳性
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isPathAllowed, isWritablePath, hashArguments } from '../paths.js'

const isWin = process.platform === 'win32'

/**
 * 当前环境能否创建符号链接。
 *
 * Windows 非管理员默认不能（需要 SeCreateSymbolicLinkPrivilege 或开发者模式）。
 * 用 `it.skipIf` 显式标注比「try/catch 后 return」好：
 *   · 后者会让测试「通过」，看起来这条防护被验证了，其实没跑到
 *   · 前者在报告里显示 skipped，审计一眼能看出覆盖缺口
 */
/**
 * 目录链接方式。
 *
 * Windows 上 'dir' 需要管理员特权，'junction' 不需要，
 * 但 lstatSync().isSymbolicLink() 对两者都返回 true。
 * 用 junction 能让目录类防护在普通用户环境下也被真实验证。
 */
const linkType = (): 'dir' | 'junction' => (isWin ? 'junction' : 'dir')

/** 建目录链接总是可行（junction 无需特权）。 */
const canDirLink = true

/** 建文件 symlink 需要特权（Windows 非管理员不可用）。 */
const canFileLink = (() => {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'symlink-file-probe-'))
    try {
      writeFileSync(join(probe, 't'), 'x', 'utf8')
      symlinkSync(join(probe, 't'), join(probe, 'l'), 'file')
      return true
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  } catch {
    return false
  }
})()

/**
 * 明确跳过的断言。
 *
 * 用一个独立的 describe 收集，结尾统一报告。
 * 绝不用裸 `return` —— vitest 会把那种用例记成 passed，
 * 结果就是「8 种攻击防护 ✅」，而其中 2 种其实从没跑过。
 */
const skipped: string[] = []
function ctxSkip(reason: string): void {
  skipped.push(reason)
}



describe('路径校验', () => {
  let root: string
  let allowed: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-paths-'))
    allowed = join(root, 'allowed')
    outside = join(root, 'outside')
    mkdirSync(allowed, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), '机密', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('允许目录内的路径通过', () => {
    expect(isPathAllowed(join(allowed, 'a.txt'), [allowed]).allowed).toBe(true)
    expect(isPathAllowed(allowed, [allowed]).allowed).toBe(true)
  })

  it('拒绝目录外的绝对路径', () => {
    const check = isPathAllowed(join(outside, 'secret.txt'), [allowed])
    expect(check.allowed).toBe(false)
    expect(check.reason).toBeTruthy()
  })

  it('拒绝路径穿越（../）', () => {
    const sneaky = join(allowed, '..', 'outside', 'secret.txt')
    expect(isPathAllowed(sneaky, [allowed]).allowed).toBe(false)
  })

  it('拒绝前缀假阳性（/allowed vs /allowed-evil）', () => {
    const evil = `${allowed}-evil`
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, 'x.txt'), 'x', 'utf8')
    // 字符串前缀匹配会误判为允许，按路径段比对才能拒绝
    expect(isPathAllowed(join(evil, 'x.txt'), [allowed]).allowed).toBe(false)
  })

  it.skipIf(!canDirLink)('拒绝符号链接逃逸', () => {
    const linkPath = join(allowed, 'link')
    // canSymlink 为 true 时这条一定能建出来；建不出来说明环境变了，
    // 让测试直接失败比静默跳过更诚实。
    symlinkSync(outside, linkPath, linkType())
    expect(isPathAllowed(join(linkPath, 'secret.txt'), [allowed]).allowed).toBe(false)
  })

  it('Windows 大小写不敏感：不同大小写指向同一路径', (ctx) => {
    if (!isWin) {
      // 大小写语义是平台属性：Linux 上 /A 和 /a 确实是两个目录。
      // 这条不能算通过，只能算「本平台不适用」。
      ctx.skip()
      return
    }
    const upper = allowed.toUpperCase()
    const lower = allowed.toLowerCase()
    // 大写形式必须同样被允许（不能因为大小写不同就拒绝合法路径）
    expect(isPathAllowed(join(upper, 'x.txt'), [lower]).allowed).toBe(true)
    // 同时，大写形式的越权路径也必须被拒绝
    const evilUpper = join(outside, 'secret.txt').toUpperCase()
    expect(isPathAllowed(evilUpper, [lower]).allowed).toBe(false)
  })

  it('拒绝 UNC 路径', (ctx) => {
    if (!isWin) {
      // UNC 是 Windows 概念。但在 POSIX 上仍然要拒绝 '//server/share'，
      // 所以这里保留一条跨平台断言，Windows 专属部分再单独 skip。
      expect(isPathAllowed('//server/share/file.txt', [allowed]).allowed).toBe(false)
      ctx.skip()
      return
    }
    expect(isPathAllowed('\\\\server\\share\\file.txt', [allowed]).allowed).toBe(false)
    // POSIX 风格的双斜杠在 Windows 上同样是 UNC
    expect(isPathAllowed('//server/share/file.txt', [allowed]).allowed).toBe(false)
  })

  it('空允许列表一律拒绝', () => {
    expect(isPathAllowed(join(allowed, 'a.txt'), []).allowed).toBe(false)
  })

  it('多个允许目录时，命中任一即可', () => {
    const second = join(root, 'second')
    mkdirSync(second, { recursive: true })
    expect(isPathAllowed(join(second, 'f.txt'), [allowed, second]).allowed).toBe(true)
  })

  it('将要创建的文件（尚不存在）也能正确校验', () => {
    const future = join(allowed, 'sub', 'new.txt')
    expect(isPathAllowed(future, [allowed]).allowed).toBe(true)
    const badFuture = join(outside, 'new.txt')
    expect(isPathAllowed(badFuture, [allowed]).allowed).toBe(false)
  })

  // ── 中间祖先是 symlink，且后缀路径不存在 ──────────────
  //
  // 这是 P0 级的越权写入：旧的 safeRealpath 只解析一层父目录，
  // 多级不存在时回退到词法路径，于是「工作区内」的判定成立，
  // 而 mkdir/writeFile 会跟随 symlink 写到工作区外部。
  it.skipIf(!canDirLink)('中间祖先是 symlink、后缀不存在 → 判定为不允许', () => {
    const linkPath = join(allowed, 'link')
    symlinkSync(outside, linkPath, linkType())

    // newdir 与 file.txt 都不存在
    const evil = join(linkPath, 'newdir', 'file.txt')
    const check = isPathAllowed(evil, [allowed])
    expect(check.allowed, 'symlink 祖先必须被解析出来，不能回退到词法路径').toBe(false)
    expect(check.resolved).toContain('outside')
  })

  it.skipIf(!canDirLink)('多层 symlink 祖先（link/link2/新目录/新文件）同样被拦下', () => {
    const l1 = join(allowed, 'l1')
    const l2 = join(outside, 'l2')
    symlinkSync(outside, l1, linkType())
    symlinkSync(outside, l2, linkType())
    expect(isPathAllowed(join(l1, 'l2', 'x', 'y.txt'), [allowed]).allowed).toBe(false)
  })

  it.skipIf(!canDirLink)('symlink 指向工作区内部时允许（不是所有 symlink 都拒绝）', () => {
    const inner = join(allowed, 'inner')
    mkdirSync(inner, { recursive: true })
    const linkPath = join(allowed, 'safe-link')
    symlinkSync(inner, linkPath, linkType())
    expect(isPathAllowed(join(linkPath, 'new', 'f.txt'), [allowed]).allowed).toBe(true)
  })
})

describe('写入路径校验', () => {
  let root: string
  let allowed: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-wpath-'))
    allowed = join(root, 'allowed')
    outside = join(root, 'outside')
    mkdirSync(allowed, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // ── 无特权环境下的等价验证 ──────────────────────────
  //
  // 文件 symlink 在 Windows 非管理员下建不出来。与其「跳过」，
  // 不如验证**判定逻辑**：注入探测器告诉函数「这个路径是链接」，
  // 断言它给出的原因优先于「不在允许范围内」。
  //
  // 这与真实链接走的是同一段代码路径（isWritablePath 先 probe 再 check），
  // 差别只在 probe 的实现。

  it('注入探测器：目标被识别为链接时，原因优先报「符号链接」', () => {
    // 路径本身在允许范围内，所以 isPathAllowed 会放行——
    // 只有「链接」这一条能拦住它。
    const target = join(allowed, 'evil.txt')
    const check = isWritablePath(target, [allowed], { isSymlink: () => true })
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('符号链接')
  })

  it('注入探测器：目标是链接且同时指向范围外时，仍报「符号链接」', () => {
    // 这条锁定顺序：不能先被「不在允许范围内」覆盖
    const target = join(outside, 'real.txt')
    const check = isWritablePath(target, [allowed], { isSymlink: () => true })
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('符号链接')
  })

  it('注入探测器返回 false 时行为与默认一致', () => {
    const target = join(allowed, 'normal.txt')
    const check = isWritablePath(target, [allowed], { isSymlink: () => false })
    expect(check.allowed).toBe(true)
  })

  it.skipIf(!canFileLink)('目标本身是 symlink 时拒绝写入，且原因是「符号链接」', () => {
    const target = join(outside, 'real.txt')
    writeFileSync(target, 'secret', 'utf8')
    const linkPath = join(allowed, 'evil.txt')
    symlinkSync(target, linkPath, 'file')
    const check = isWritablePath(linkPath, [allowed])
    expect(check.allowed).toBe(false)
    // 关键：符号链接的原因必须优先于「不在允许范围内」——
    // 后者只说「这里不许写」，前者告诉用户「你在写一个链接，
    // 实际会改到别处」。两者的处理方式完全不同。
    expect(check.reason).toContain('符号链接')
  })

  it.skipIf(!canFileLink)('指向允许目录内部的 symlink 也不能写入', () => {
    // 这个链接的目标在工作区内，所以 isPathAllowed 会放行——
    // 但写入仍然会改到另一个文件，必须拒绝。
    const realFile = join(allowed, 'real-inside.txt')
    writeFileSync(realFile, 'x', 'utf8')
    const linkPath = join(allowed, 'link-inside.txt')
    symlinkSync(realFile, linkPath, 'file')
    const check = isWritablePath(linkPath, [allowed])
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('符号链接')
  })

  it.skipIf(!canDirLink)('目录 symlink 作为写入目标也拒绝（避免 mkdir 到外部）', () => {
    const linkPath = join(allowed, 'dirlink')
    symlinkSync(outside, linkPath, linkType())
    const check = isWritablePath(join(linkPath, 'new.txt'), [allowed])
    expect(check.allowed).toBe(false)
    // 中间祖先是链接：原因可能是「不在范围内」或「符号链接」，
    // 但必须拒绝。
  })

  it('普通新文件允许写入', () => {
    expect(isWritablePath(join(allowed, 'dir', 'new.txt'), [allowed]).allowed).toBe(true)
  })

  it('空字节路径被拒绝', () => {
    expect(isPathAllowed(join(allowed, 'a\u0000b'), [allowed]).allowed).toBe(false)
  })
})

describe('参数哈希（拒绝去重用）', () => {
  it('键顺序不同但内容相同，哈希一致', () => {
    const a = hashArguments({ path: '/x', content: 'y' })
    const b = hashArguments({ content: 'y', path: '/x' })
    expect(a).toBe(b)
  })

  it('内容不同则哈希不同', () => {
    expect(hashArguments({ path: '/x', content: 'a' })).not.toBe(hashArguments({ path: '/x', content: 'b' }))
  })

  it('嵌套对象的键顺序也归一化', () => {
    const a = hashArguments({ outer: { b: 2, a: 1 } })
    const b = hashArguments({ outer: { a: 1, b: 2 } })
    expect(a).toBe(b)
  })

  it('数组顺序是有意义的，不应归一化', () => {
    expect(hashArguments([1, 2])).not.toBe(hashArguments([2, 1]))
  })
})
