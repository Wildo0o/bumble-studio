// 稳定领域错误码。
//
// 为什么需要一份目录，而不是各模块随手 `new Error('...')`：
//
//   · HTTP 层曾经靠**正则匹配中文错误文案**来映射状态码。
//     改一句措辞就换了状态码，忘了同步就变成 500。
//   · `unknown` 类和 `completed` 类错误的区别必须机器可读——
//     「结果未知」和「明确失败」在重试语义上完全相反。
//   · 将来的 desktop / IPC 层要和 HTTP 表达同样的语义，只能靠 code。
//
// 规则（改动即破坏兼容）：
//   1. code 一经发布**不能改名**。语义变了就加新 code。
//   2. 每个 code 的 httpStatus / retryable 是契约的一部分。
//   3. 私有实现细节（堆栈、第三方响应、密钥）不得进入 message 或 details。
import { randomUUID } from 'node:crypto'
import type { DomainErrorBody } from '../shared/types.js'

export type DomainErrorCode =
  // 通用
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'STATE_CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'
  /** 版本号 / 幂等键冲突：同一个 key 配了不同内容 */
  | 'VERSION_CONFLICT'
  // 归属与绑定
  | 'OWNERSHIP_MISMATCH'
  | 'BINDING_MISMATCH'
  // 审计与验收
  | 'NO_PASSING_AUDIT'
  | 'CONTENT_MISMATCH'
  | 'CONTRACT_MISMATCH'
  | 'CONTRACT_INVALID'
  | 'SNAPSHOT_NOT_REPRODUCIBLE'
  // 未知与预算
  | 'UNRESOLVED_UNKNOWN'
  | 'BUDGET_EXCEEDED'
  // 能力未就绪（不是错误用法，而是「现在做不到」）
  | 'CAPABILITY_UNAVAILABLE'

export interface DomainErrorSpec {
  code: DomainErrorCode
  httpStatus: number
  /**
   * 重试是否有意义。
   *
   * 注意 429（预算耗尽）**不是** retryable：重试只会继续失败，
   * 调用方需要的是改预算或改请求，不是重试。
   */
  retryable: boolean
  description: string
}

export const ERROR_CATALOG: Record<DomainErrorCode, DomainErrorSpec> = {
  NOT_FOUND: { code: 'NOT_FOUND', httpStatus: 404, retryable: false, description: '目标对象不存在' },
  INVALID_INPUT: { code: 'INVALID_INPUT', httpStatus: 400, retryable: false, description: '请求参数不合法' },
  STATE_CONFLICT: {
    code: 'STATE_CONFLICT',
    httpStatus: 409,
    retryable: false,
    description: '对象存在，但当前状态不允许这个操作',
  },
  UNAUTHORIZED: { code: 'UNAUTHORIZED', httpStatus: 401, retryable: false, description: '未认证或凭据不正确' },
  FORBIDDEN: { code: 'FORBIDDEN', httpStatus: 403, retryable: false, description: '已认证但无权执行该操作' },
  PAYLOAD_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    httpStatus: 413,
    retryable: false,
    description: '请求体超过上限',
  },
  INTERNAL: { code: 'INTERNAL', httpStatus: 500, retryable: false, description: '服务端故障（无更具体分类）' },
  VERSION_CONFLICT: {
    code: 'VERSION_CONFLICT',
    httpStatus: 409,
    retryable: false,
    description: '版本号或幂等键与已有记录冲突',
  },
  OWNERSHIP_MISMATCH: {
    code: 'OWNERSHIP_MISMATCH',
    httpStatus: 409,
    retryable: false,
    description: '对象之间的归属关系不成立（跨 Task / 跨 Run）',
  },
  BINDING_MISMATCH: {
    code: 'BINDING_MISMATCH',
    httpStatus: 409,
    retryable: false,
    description: '审计绑定不完整或与当前对象不一致',
  },
  NO_PASSING_AUDIT: {
    code: 'NO_PASSING_AUDIT',
    httpStatus: 409,
    retryable: false,
    description: '没有可用于验收的通过审计',
  },
  CONTENT_MISMATCH: {
    code: 'CONTENT_MISMATCH',
    httpStatus: 409,
    retryable: false,
    description: '内容哈希与记录不一致',
  },
  CONTRACT_MISMATCH: {
    code: 'CONTRACT_MISMATCH',
    httpStatus: 409,
    retryable: false,
    description: '契约已变更或与审计时不一致',
  },
  CONTRACT_INVALID: {
    code: 'CONTRACT_INVALID',
    httpStatus: 409,
    retryable: false,
    description: '契约内容损坏（canonical 与 hash 对不上）',
  },
  SNAPSHOT_NOT_REPRODUCIBLE: {
    code: 'SNAPSHOT_NOT_REPRODUCIBLE',
    httpStatus: 409,
    retryable: false,
    description: '快照不可复现，需要人工放行',
  },
  UNRESOLVED_UNKNOWN: {
    code: 'UNRESOLVED_UNKNOWN',
    httpStatus: 409,
    retryable: false,
    description: '存在未解决的外部操作 unknown',
  },
  BUDGET_EXCEEDED: {
    code: 'BUDGET_EXCEEDED',
    httpStatus: 429,
    retryable: false,
    description: '预算 / 轮次 / 配额已耗尽',
  },
  CAPABILITY_UNAVAILABLE: {
    code: 'CAPABILITY_UNAVAILABLE',
    httpStatus: 503,
    retryable: true,
    description: '所需能力当前不可用（例如 git、provider 未就绪）',
  },
}

/** 所有 code，便于测试与元数据接口。 */
export function errorCodes(): DomainErrorCode[] {
  return Object.keys(ERROR_CATALOG) as DomainErrorCode[]
}

/**
 * 判断一个值是不是已定义的 code。
 *
 * 用 `Object.hasOwn` 而不是 `in`/`obj[code]`：
 * `'toString' in ERROR_CATALOG` 是 true，`ERROR_CATALOG['toString']` 也不是 undefined。
 * 那会让一个任意字符串被当成合法 code 并拿到 httpStatus=undefined。
 */
export function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CATALOG, value)
}

/**
 * 领域错误。
 *
 * 与普通 `Error` 的区别：
 *   · 必然带 code / retryable / correlationId
 *   · 序列化成 HTTP 或 IPC 响应时形状一致（`toBody()`）
 *   · 不会把 cause 的堆栈或原始响应放进 message
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly retryable: boolean
  readonly correlationId: string
  readonly details?: unknown

  constructor(
    code: DomainErrorCode,
    message: string,
    opts: { correlationId?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'DomainError'
    this.code = code
    this.retryable = ERROR_CATALOG[code].retryable
    this.correlationId = opts.correlationId ?? randomUUID()
    this.details = opts.details
  }

  get httpStatus(): number {
    return ERROR_CATALOG[this.code].httpStatus
  }

  toBody(): DomainErrorBody {
    const body: DomainErrorBody = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
      correlationId: this.correlationId,
    }
    /**
     * 让错误体也能被当字符串用（`String(body)` → message）。
     *
     * 为什么：响应里的 `error` 从字符串变成了对象，
     * 任何 `String(res.body.error)` 的调用方都会得到 `[object Object]`。
     *
     * 必须用 defineProperty 而不是对象字面量里的方法：
     * 字面量里的方法**可枚举**，会被 JSON.stringify 写进响应体，
     * 客户端会收到一个多出来的 `toString` 字段。
     */
    Object.defineProperty(body, 'toString', {
      value: () => this.message,
      enumerable: false,
      writable: false,
      configurable: false,
    })
    return body
  }
}

/** 从任意抛出的值里取 code（领域错误或有 `code` 字段的错误）。 */
export function codeOf(err: unknown): DomainErrorCode | undefined {
  if (err instanceof DomainError) return err.code
  const code = (err as { code?: unknown } | null)?.code
  return isDomainErrorCode(code) ? code : undefined
}

/**
 * 某条错误规范的只读视图。
 *
 * 传入的还是 code 字符串（响应体里就是字符串），
 * 用 `isDomainErrorCode` 收窄。未定义的 code 一律按 INTERNAL 处理：
 * 不认识的 code 意味着「映射关系未知」，返回 200 或 400 都是猜。
 */
export function specFor(code: string): DomainErrorSpec {
  return Object.hasOwn(ERROR_CATALOG, code)
    ? ERROR_CATALOG[code as DomainErrorCode]
    : ERROR_CATALOG.INTERNAL
}

/**
 * 把任意抛出的值归一化成可返回给客户端的错误体。
 *
 * **脱敏规则**：
 *   · 有 code 的错误 → 用它的 message（core 层的 message 是可读文案）
 *   · 没有 code 的错误 → 返回通用文案，真实原因只进日志
 *
 * 为什么不直接把 `err.message` 回给客户端：
 * 未分类的错误常常是底层库抛的，里面可能有路径、SQL、甚至凭据片段。
 */
export function normalizeError(
  err: unknown,
  opts: { correlationId?: string; fallbackMessage?: string } = {},
): DomainErrorBody {
  const correlationId = opts.correlationId ?? randomUUID()
  if (err instanceof DomainError) {
    return { ...err.toBody(), correlationId: opts.correlationId ?? err.correlationId }
  }
  const code = codeOf(err)
  if (code) {
    return {
      code,
      message: err instanceof Error ? err.message : String(err),
      retryable: ERROR_CATALOG[code].retryable,
      correlationId,
    }
  }
  return {
    code: 'INTERNAL',
    message: opts.fallbackMessage ?? '服务端内部错误',
    retryable: false,
    correlationId,
  }
}

/** code → HTTP 状态码。未定义 code 一律 500（fail-closed，不猜）。 */
export function httpStatusFor(err: unknown): number {
  const code = codeOf(err)
  return code ? ERROR_CATALOG[code].httpStatus : 500
}
