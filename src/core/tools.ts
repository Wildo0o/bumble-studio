// 工具注册表 + 内置工具。
import { readFile, writeFile, appendFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import type { ToolDefinition } from '../shared/types.js'
import { isPathAllowed, isWritablePath } from './paths.js'

export interface ToolContext {
  workspaceRoots: string[]
  signal: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** 返回给模型的内容（可能被截断） */
  content: string
  /** 完整原始结果，落盘用 */
  raw?: string
  isError?: boolean
  /** 是否无法确认外部状态 */
  uncertain?: boolean
}

export interface ToolImpl {
  definition: ToolDefinition
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

function mustString(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

/**
 * 把模型给的路径解析成**相对工作区**的意义。
 *
 * 为什么需要（L2 Gate）：
 * 模型几乎总是给相对路径（`readme.txt`、`src/a.ts`）。直接交给
 * `resolve()` 会按 `process.cwd()` 解析——那是服务器进程的启动目录，
 * 不是工作区。结果相对路径全部被判「不在允许范围内」，
 * 每次读写都失败，**模型根本无法操作工作区**。
 *
 * 规则：
 *   · 绝对路径 → 原样交给校验（由它判断是否在工作区内）
 *   · 相对路径 → 拼到**第一个**工作区根下
 *
 * 仍然由 isPathAllowed / isWritablePath 做最终判定：
 * 这里只解决「相对于哪里」，不放松任何边界。
 */
function resolveInWorkspace(raw: string, ctx: ToolContext): string {
  if (isAbsolute(raw)) return raw
  const root = ctx.workspaceRoots[0]
  if (!root) return raw
  return join(root, raw)
}

function requirePath(input: Record<string, unknown>, key: string, ctx: ToolContext): string {
  const raw = mustString(input, key)
  const check = isPathAllowed(resolveInWorkspace(raw, ctx), ctx.workspaceRoots)
  if (!check.allowed) throw new Error(`${check.reason}：${raw}`)
  return check.resolved
}

/**
 * 写操作专用的路径校验。
 *
 * 比 requirePath 多一条：**目标本身不能是符号链接**。
 * 读一个 symlink 只是读到它的目标内容；写一个 symlink 会改写它的目标。
 * 后者是不可逆的破坏，所以写入要更严。
 */
function requireWritablePath(
  input: Record<string, unknown>,
  key: string,
  ctx: ToolContext,
): string {
  const raw = mustString(input, key)
  const check = isWritablePath(resolveInWorkspace(raw, ctx), ctx.workspaceRoots)
  if (!check.allowed) throw new Error(`${check.reason}：${raw}`)
  return check.resolved
}

/**
 * 写入后的落点复核。
 *
 * 为什么需要：realpath 校验与真正的 writeFile 之间存在 TOCTOU 窗口——
 * 校验时 link 还指向工作区内，写入时被换成外部目录。
 * Node 没有暴露 O_NOFOLLOW 的逐段打开，所以这里在写入之后
 * 再次解析实际路径；如果跑到了工作区外，立即报错。
 *
 * 注意这只是**缓解**：外部文件可能已经被写过了。
 * 真正的防线是上层的沙箱 / 权限，这里做到的是「不让它悄悄发生」。
 */
async function verifyAfterWrite(path: string, ctx: ToolContext): Promise<void> {
  const recheck = isPathAllowed(path, ctx.workspaceRoots)
  if (!recheck.allowed) {
    throw new Error(
      `写入后发现目标实际位于允许范围之外（${recheck.resolved}）：` +
      '路径在校验后被改动（可能是符号链接替换）。请检查工作区。',
    )
  }
}

const readFileTool: ToolImpl = {
  definition: {
    id: 'read_file',
    name: 'read_file',
    description: '读取一个文本文件的内容。只能读取工作区允许目录内的文件。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run(input, ctx) {
    const path = requirePath(input, 'path', ctx)
    const content = await readFile(path, 'utf8')
    return { ok: true, content, raw: content }
  },
}

const listDirTool: ToolImpl = {
  definition: {
    id: 'list_dir',
    name: 'list_dir',
    description: '列出目录下的文件和子目录。只能列出工作区允许目录内的内容。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } },
      required: ['path'],
    },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 10_000,
    maxOutputBytes: 32 * 1024,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run(input, ctx) {
    const path = requirePath(input, 'path', ctx)
    const entries = await readdir(path, { withFileTypes: true })
    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`
      return e.name
    })
    const content = lines.join('\n')
    return { ok: true, content, raw: content }
  },
}

const writeFileTool: ToolImpl = {
  definition: {
    id: 'write_file',
    name: 'write_file',
    description: '写入或覆盖一个文本文件。这是危险操作，需要用户授权。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
    source: 'builtin',
    riskLevel: 'write',
    sideEffect: 'filesystem',
    enabled: true,
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run(input, ctx) {
    const path = requireWritablePath(input, 'path', ctx)
    const content = mustString(input, 'content')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    await verifyAfterWrite(path, ctx)
    const bytes = Buffer.byteLength(content, 'utf8')
    return { ok: true, content: `已写入 ${bytes} 字节到 ${path}` }
  },
}

// ── 扩展内置工具 ──────────────────────────────────────────
//
// 只加「只读或可判定副作用」的工具。
// 刻意不提供「执行任意 shell」这类工具：它的副作用无法枚举，
// sideEffect 只能写 'external'，而对账时无从判断「命令到底有没有生效」，
// 会让 unknown 永远无法收敛。需要更强的能力时应该走明确的专用工具。

const fileStatTool: ToolImpl = {
  definition: {
    id: 'file_stat',
    name: 'file_stat',
    description: '查看文件或目录的元信息（大小、是否目录、修改时间）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '目标路径' } },
      required: ['path'],
    },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 10_000,
    maxOutputBytes: 4 * 1024,
    cancellable: true,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run(input, ctx) {
    const path = requirePath(input, 'path', ctx)
    const st = await stat(path)
    const info = {
      path,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      modifiedAt: st.mtimeMs,
    }
    const content = JSON.stringify(info)
    return { ok: true, content, raw: content }
  },
}

const searchFilesTool: ToolImpl = {
  definition: {
    id: 'search_files',
    name: 'search_files',
    description:
      '在允许目录内按文件名子串搜索文件（不搜索文件内容）。' +
      '最多返回 limit 条（默认 50，上限 200）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '搜索起始目录' },
        query: { type: 'string', description: '文件名需包含的子串（大小写不敏感）' },
        limit: { type: 'number', description: '最多返回条数' },
      },
      required: ['path', 'query'],
    },
    source: 'builtin',
    riskLevel: 'read',
    sideEffect: 'none',
    enabled: true,
    timeoutMs: 20_000,
    maxOutputBytes: 32 * 1024,
    cancellable: true,
    reconcile: { idempotent: true, unsafeToRetry: false },
  },
  async run(input, ctx) {
    const root = requirePath(input, 'path', ctx)
    const query = mustString(input, 'query').toLowerCase()
    const rawLimit = input.limit
    // 上限必须服务端夹紧：让模型自己决定「返回多少」等于让它决定
    // 这次调用消耗多少预算和上下文。
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(200, Math.trunc(rawLimit)))
      : 50

    const matches: string[] = []
    const queue: string[] = [root]
    let visited = 0
    const MAX_VISITED = 20_000

    while (queue.length > 0 && matches.length < limit) {
      if (ctx.signal.aborted) break
      const dir = queue.shift()!
      // 每进一个目录就单独校验：符号链接可能把遍历带到允许范围之外
      if (!isPathAllowed(dir, ctx.workspaceRoots).allowed) continue
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        visited++
        if (visited > MAX_VISITED) break
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          queue.push(full)
        } else if (e.name.toLowerCase().includes(query)) {
          matches.push(relative(root, full) || e.name)
          if (matches.length >= limit) break
        }
      }
    }

    const content = matches.length === 0 ? '（没有匹配的文件）' : matches.join('\n')
    return { ok: true, content, raw: content }
  },
}

const appendFileTool: ToolImpl = {
  definition: {
    id: 'append_file',
    name: 'append_file',
    description:
      '在一个文本文件末尾追加内容（不存在则创建）。' +
      '这是危险操作，需要用户授权。注意：追加不是幂等的，重复执行会写两遍。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要追加的内容' },
      },
      required: ['path', 'content'],
    },
    source: 'builtin',
    riskLevel: 'write',
    sideEffect: 'filesystem',
    // 追加不幂等：崩溃后重放会写两遍。
    // 声明成 false 让 Intent 对账把它当作「不可自动重试」，
    // 而不是让模型在恢复后直接再调一次。
    supportsIdempotencyKey: false,
    cancellable: true,
    enabled: true,
    timeoutMs: 15_000,
    maxOutputBytes: 4 * 1024,
    reconcile: { idempotent: false, unsafeToRetry: true },
  },
  async run(input, ctx) {
    const path = requireWritablePath(input, 'path', ctx)
    const content = mustString(input, 'content')
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, content, 'utf8')
    await verifyAfterWrite(path, ctx)
    return { ok: true, content: `已向 ${path} 追加 ${Buffer.byteLength(content, 'utf8')} 字节` }
  },
}

const BUILTINS: ToolImpl[] = [
  readFileTool,
  listDirTool,
  writeFileTool,
  fileStatTool,
  searchFilesTool,
  appendFileTool,
]


/**
 * 把 MCP 工具桥接成本项目的 ToolImpl。
 *
 * 为什么需要这一层：
 *   MCP 暴露的是「工具描述 + 调用接口」，本项目需要的是
 *   `{ definition, run(input, ctx) }`。没有桥接时，MCP 工具只是
 *   一堆躺在 `/meta/capabilities` 里的定义，执行链根本调不到它们——
 *   那就是「有代码、没接线」。
 *
 * 两条安全约定：
 *   · definition 里的 riskLevel / sideEffect 由 McpClient 决定
 *     （默认 external，需审批），这里不重新解释
 *   · 调用失败包装成 { ok: false }，而不是抛出：工具失败是
 *     执行结果的一种，不是执行器崩溃
 */
export function mcpToolImpl(
  definition: ToolDefinition,
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): ToolImpl {
  return {
    definition,
    async run(input) {
      try {
        return await call(definition.name, input as Record<string, unknown>)
      } catch (err) {
        // MCP 侧的错误（超时 / 协议错误）不是「工具返回失败」而是
        // 「这次调用结果未知」——标成 isError 让上层按失败处理，
        // 而 Intent 对账仍会看到这次调用发生过。
        const message = `MCP 工具调用失败：${err instanceof Error ? err.message : String(err)}`
        return { ok: false, content: message, raw: message, isError: true }
      }
    },
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolImpl>()

  constructor(impls: ToolImpl[] = BUILTINS) {
    for (const impl of impls) this.register(impl)
  }

  register(impl: ToolImpl): void {
    if (this.tools.has(impl.definition.id)) {
      throw new Error(`工具 id 冲突：${impl.definition.id}`)
    }

    // ── 能力声明校验（fail-closed）────────────────────────
    //
    // 两条规则：
    //
    // 1. **sideEffect 必须显式声明。**
    //    不允许「没写就按 riskLevel 推断」——那会让一个作者忘了声明、
    //    实际有副作用的工具被当成无副作用，从而跳过 Intent 保护。
    //    配置错误必须在注册时暴露，不能等到运行时。
    //
    // 2. **riskLevel=read 不能配 sideEffect!=none。**
    //    read 表示「不需要审批」，工具在自动放行白名单里。
    //    如果它还有副作用，等于有副作用的操作可以绕过审批。
    //
    // 两个维度必须自洽：
    //   riskLevel  回答「要不要先问用户」
    //   sideEffect 回答「重复执行是否安全」
    const def = impl.definition

    const VALID_SIDE_EFFECTS = ['none', 'filesystem', 'external'] as const
    if (!def.sideEffect) {
      throw new Error(
        `工具 ${def.id} 必须显式声明 sideEffect（none / filesystem / external）。` +
        '不能靠 riskLevel 推断——推断错了会让有副作用的工具绕过 Intent 保护。',
      )
    }
    if (!(VALID_SIDE_EFFECTS as readonly string[]).includes(def.sideEffect)) {
      throw new Error(
        `工具 ${def.id} 的 sideEffect 值非法：'${String(def.sideEffect)}'。` +
        `只允许 ${VALID_SIDE_EFFECTS.join(' / ')}。`,
      )
    }
    if (def.sideEffect !== 'none' && def.riskLevel === 'read') {
      throw new Error(
        `工具 ${def.id} 的能力声明矛盾：` +
        `riskLevel='read' 表示不需要审批，但 sideEffect='${def.sideEffect}' 表示它会改变外部状态。` +
        '有副作用的工具必须声明 riskLevel=\'write\'，否则会绕过用户审批。',
      )
    }

    this.tools.set(impl.definition.id, impl)
  }

  get(id: string): ToolImpl | undefined {
    return this.tools.get(id)
  }

  /** 只有 enabled 的工具暴露给模型 */
  listEnabled(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition).filter((d) => d.enabled)
  }

  listAll(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition)
  }

  /** 转换成本项目使用的工具描述格式，供适配器使用 */
  specs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.listEnabled().map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
    }))
  }
}

/** 极简 JSON Schema 校验：够用即可，不做完整实现。 */
export function validateArgs(schema: Record<string, unknown>, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '参数必须是 JSON 对象' }
  }
  const obj = input as Record<string, unknown>
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>
  const required = (schema.required ?? []) as string[]

  for (const key of required) {
    if (obj[key] === undefined || obj[key] === null) {
      return { ok: false, error: `缺少必需参数：${key}` }
    }
  }
  for (const [key, def] of Object.entries(props)) {
    const v = obj[key]
    if (v === undefined) continue
    if (def.type === 'string' && typeof v !== 'string') {
      return { ok: false, error: `参数 ${key} 必须是字符串` }
    }
    if (def.type === 'number' && typeof v !== 'number') {
      return { ok: false, error: `参数 ${key} 必须是数字` }
    }
    if (def.type === 'boolean' && typeof v !== 'boolean') {
      return { ok: false, error: `参数 ${key} 必须是布尔值` }
    }
  }
  return { ok: true, value: obj }
}

export async function runWithTimeout(
  impl: ToolImpl,
  input: Record<string, unknown>,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<{
  result?: ToolResult
  timedOut: boolean
  /**
   * 晚到的结果（超时之后工具才完成）。
   *
   * 为什么需要它：`Promise.race` 超时返回后，底层 Promise **仍在继续跑**。
   * 对 `await writeFile(...)` 这类调用，它无法被 abort 打断——
   * 也就是说文件最终会被写下去，只是系统已经宣布「不知道结果」。
   *
   * 这不是可以修的 bug，是本地文件系统的固有语义。
   * 能做的只有：
   *   1. 如实告诉调用方「结果未知」（已经做了，记 unknown）
   *   2. 收好晚到的结果，别让它变成 unhandled rejection
   *   3. 让调用方可以把晚到结果关联回同一次操作
   */
  lateResult?: Promise<{ result?: ToolResult; error?: string }>
}> {
  let timer: NodeJS.Timeout | undefined
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  // 先包一层：无论成功失败，都不允许逃逸成 unhandled rejection。
  // 这个 promise 可能在我们已经返回之后才 settle。
  const toolPromise = impl
    .run(input, { ...ctx, signal: controller.signal })
    .then((result) => ({ ok: true as const, result }))
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }))

  const timeout = new Promise<{ ok: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: 'timeout' })
    }, timeoutMs)
  })

  try {
    const raced = await Promise.race([toolPromise, timeout])

    if (raced.ok === 'timeout') {
      // 把底层 promise 交给调用方处理（通常是记日志 + 不重试）。
      // 即使调用方忽略它，上面的 .catch 也已经保证不会崩进程。
      return {
        timedOut: true,
        lateResult: toolPromise.then((r) => (
          r.ok ? { result: r.result } : { error: r.error }
        )),
      }
    }

    if (!raced.ok) throw new Error(raced.error)
    return { result: raced.result, timedOut: false }
  } finally {
    if (timer) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

export { join, relative, stat }
