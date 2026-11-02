// 稳定错误码与权限的契约测试。
//
// 这两块都是「公共契约」：客户端按 code 分支、按 retryable 决定是否重试，
// 按 permission 表判断按钮该不该亮。任何漂移都会让调用方做出错误决定。
import { describe, it, expect } from 'vitest'
import {
  ERROR_CATALOG,
  DomainError,
  codeOf,
  errorCodes,
  httpStatusFor,
  isDomainErrorCode,
  normalizeError,
  specFor,
} from '../errors.js'
import {
  PERMISSION_CATALOG,
  assertPermission,
  checkPermission,
  externalUser,
  internalSystem,
  permissionActions,
  principalFromClaim,
} from '../permissions.js'

describe('错误码契约', () => {
  it('每个 code 都有自己的 spec，且 code 字段与键一致', () => {
    for (const code of errorCodes()) {
      const spec = ERROR_CATALOG[code]
      expect(spec.code).toBe(code)
      expect(spec.httpStatus).toBeGreaterThanOrEqual(400)
      expect(spec.httpStatus).toBeLessThan(600)
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })

  it('4xx 不可重试，只有明确「暂时性」的才算可重试', () => {
    // 这条不是形式主义：客户端会用 retryable 做自动重试循环。
    // 一个 409 被标成可重试，就会无限重放同一份被拒绝的请求。
    expect(ERROR_CATALOG.NOT_FOUND.retryable).toBe(false)
    expect(ERROR_CATALOG.STATE_CONFLICT.retryable).toBe(false)
    expect(ERROR_CATALOG.FORBIDDEN.retryable).toBe(false)
    expect(ERROR_CATALOG.BUDGET_EXCEEDED.retryable).toBe(false)
    expect(ERROR_CATALOG.UNRESOLVED_UNKNOWN.retryable).toBe(false)
    // 能力暂不可用是唯一可重试的（git 暂时不可用、provider 未就绪）
    expect(ERROR_CATALOG.CAPABILITY_UNAVAILABLE.retryable).toBe(true)
  })

  it('HTTP 状态码映射与既有行为一致（不能破坏已有客户端）', () => {
    expect(ERROR_CATALOG.NOT_FOUND.httpStatus).toBe(404)
    expect(ERROR_CATALOG.STATE_CONFLICT.httpStatus).toBe(409)
    expect(ERROR_CATALOG.INVALID_INPUT.httpStatus).toBe(400)
    expect(ERROR_CATALOG.OWNERSHIP_MISMATCH.httpStatus).toBe(409)
    expect(ERROR_CATALOG.NO_PASSING_AUDIT.httpStatus).toBe(409)
    expect(ERROR_CATALOG.BUDGET_EXCEEDED.httpStatus).toBe(429)
    expect(ERROR_CATALOG.UNAUTHORIZED.httpStatus).toBe(401)
    expect(ERROR_CATALOG.FORBIDDEN.httpStatus).toBe(403)
  })

  it('未知 code 不会被当成合法 code（原型链污染防护）', () => {
    // `'toString' in {}` 为 true，用 `in` 判断会让任意字符串拿到
    // httpStatus=undefined，然后返回一个没有状态码的响应。
    expect(isDomainErrorCode('toString')).toBe(false)
    expect(isDomainErrorCode('constructor')).toBe(false)
    expect(isDomainErrorCode('__proto__')).toBe(false)
    expect(isDomainErrorCode('STATE_CONFLICT')).toBe(true)
    // specFor 对未知 code 一律降级为 INTERNAL（500），不猜
    expect(specFor('toString').code).toBe('INTERNAL')
  })

  it('DomainError 自带 code / retryable / correlationId，且可序列化', () => {
    const err = new DomainError('STATE_CONFLICT', '状态不对')
    expect(err.code).toBe('STATE_CONFLICT')
    expect(err.httpStatus).toBe(409)
    expect(err.retryable).toBe(false)
    expect(err.correlationId).toMatch(/\S/)

    const body = err.toBody()
    expect(body).toMatchObject({ code: 'STATE_CONFLICT', message: '状态不对', retryable: false })
    // toString 不可枚举：不能出现在 JSON 里
    expect(Object.keys(JSON.parse(JSON.stringify(body))).sort()).toEqual(
      ['code', 'correlationId', 'message', 'retryable'],
    )
  })

  it('normalizeError 不泄露未分类错误的原始文案', () => {
    // 底层库的报错可能含路径 / SQL / 凭据片段。
    const raw = normalizeError(new Error('ECONNREFUSED postgres://user:pw@host/db'))
    expect(raw.code).toBe('INTERNAL')
    expect(raw.message).not.toContain('postgres://')
    expect(raw.message).not.toContain('pw')
  })

  it('normalizeError 保留领域错误的可读文案', () => {
    const body = normalizeError(new DomainError('NOT_FOUND', 'Task 不存在'))
    expect(body.code).toBe('NOT_FOUND')
    expect(body.message).toBe('Task 不存在')
  })

  it('codeOf 能识别领域错误与带 code 的普通错误', () => {
    expect(codeOf(new DomainError('FORBIDDEN', 'x'))).toBe('FORBIDDEN')
    const e = Object.assign(new Error('x'), { code: 'STATE_CONFLICT' })
    expect(codeOf(e)).toBe('STATE_CONFLICT')
    expect(codeOf(new Error('x'))).toBeUndefined()
    expect(codeOf(null)).toBeUndefined()
  })

  it('httpStatusFor：有 code 用表，没有则 500', () => {
    expect(httpStatusFor(new DomainError('NOT_FOUND', 'x'))).toBe(404)
    expect(httpStatusFor(Object.assign(new Error(), { code: 'BUDGET_EXCEEDED' }))).toBe(429)
    expect(httpStatusFor(new Error('unknown'))).toBe(500)
  })
})

describe('权限契约', () => {
  it('每个动作都有规则，且规则自身一致', () => {
    for (const action of permissionActions()) {
      const rule = PERMISSION_CATALOG[action]
      expect(rule.action).toBe(action)
      expect(rule.allowed.length).toBeGreaterThan(0)
      expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(rule.denyCode)
    }
  })

  it('外部调用者永远是 user 且不可信', () => {
    const p = externalUser()
    expect(p).toEqual({ kind: 'user', id: 'user', trusted: false })
  })

  it('不可信的主体即使声称 system 也不会获得维护权限', () => {
    // 这是最关键的一条：如果这里放行，任何客户端都能自称系统去
    // 执行启动恢复 / 状态修正。
    const claimed = principalFromClaim('system', { trusted: false })
    expect(claimed.kind).toBe('user')
    expect(claimed.trusted).toBe(false)

    const decision = checkPermission(claimed, 'maintenance.recover')
    expect(decision.allowed).toBe(false)
  })

  it('可信路径声明 system 才拿到维护权限', () => {
    const p = principalFromClaim('system', { trusted: true })
    expect(p.kind).toBe('system')
    expect(checkPermission(p, 'maintenance.recover').allowed).toBe(true)
  })

  it('模型 / 角色 / 总控不能做质量决定', () => {
    // 「我审我自己」「我自己批我的工具调用」不在允许范围内。
    for (const kind of ['role', 'coordinator', 'provider'] as const) {
      const p = principalFromClaim(kind, { trusted: true })
      for (const action of [
        'approval.decide',
        'acceptance.accept',
        'acceptance.reject',
        'delivery.apply',
        'contract.write',
      ] as const) {
        expect(
          checkPermission(p, action).allowed,
          `${kind} 不能执行 ${action}`,
        ).toBe(false)
      }
    }
  })

  it('用户可以审批、验收、交付、写契约', () => {
    const user = externalUser()
    for (const action of [
      'approval.decide',
      'acceptance.accept',
      'acceptance.request_revision',
      'acceptance.reject',
      'delivery.apply',
      'delivery.export',
      'contract.write',
      'snapshot.restore',
    ] as const) {
      expect(checkPermission(user, action).allowed, `user 应能执行 ${action}`).toBe(true)
    }
  })

  it('assertPermission 抛带 code 的领域错误', () => {
    let caught: unknown
    try {
      assertPermission(externalUser(), 'maintenance.recover')
    } catch (e) {
      caught = e
    }
    const err = caught as DomainError
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.httpStatus).toBe(401)
  })

  it('internalSystem 是唯一 trusted 的 system 入口', () => {
    const p = internalSystem()
    expect(p).toEqual({ kind: 'system', id: 'system', trusted: true })
  })

  it('checkPermission 是纯函数：同样输入永远同样结论', () => {
    const user = externalUser()
    const a = checkPermission(user, 'acceptance.accept')
    const b = checkPermission(user, 'acceptance.accept')
    expect(a).toEqual(b)
    // 调用不修改主体
    expect(user).toEqual({ kind: 'user', id: 'user', trusted: false })
  })
})
