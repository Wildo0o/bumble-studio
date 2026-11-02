// 权限原语。
//
// 这一层只回答「谁可以做什么」，不做任何 I/O。
// 真正的执行点（executor / server / 将来的 runner）调用 `checkPermission()`，
// 得到 allow / deny 后再决定是否继续。
//
// 为什么权限必须是**纯函数**：
//   · 权限判定要能穷举测试（每个角色 × 每个动作）。
//   · 如果判定里夹着数据库读取或网络调用，测试只能覆盖到「某一次组合」。
//   · 纯函数也保证「同一个输入永远同一个结论」——没有隐藏状态可以被并发污染。
//
// **核心不变量：模型与外部输入不能授予自己权限。**
//   · 请求体里写「我是 system」「我是 auditor」不改变身份；
//   · 身份由调用点声明（server 层永远声明为 'user'）；
//   · 只有 trusted 的调用点（执行内核内部）才能声明 'system'。
import type { EventActor } from '../shared/types.js'
import { DomainError } from './errors.js'

/** 权限主体。 */
export type PrincipalKind = EventActor

export interface Principal {
  kind: PrincipalKind
  /** 主体标识。user 为 'user'，role 为角色 id，system 为 'system'。 */
  id: string
  /**
   * 是否是可信调用点。
   *
   * 只有执行内核 / 启动清理这类**内部代码路径**可以声明 trusted=true。
   * HTTP 层永远 false：请求体里的任何字段都不能让它变 true。
   */
  trusted: boolean
}

/** 受控动作。新增动作必须同时补充到 `PERMISSION_CATALOG`。 */
export type PermissionAction =
  // Run 生命周期
  | 'run.execute'
  | 'run.cancel'
  | 'run.pause'
  | 'run.resume'
  | 'run.reconcile'
  // 审批与授权
  | 'approval.decide'
  | 'grant.approve'
  // 审计与质量门
  | 'review.audit'
  | 'review.decide_escalation'
  // 验收与交付
  | 'acceptance.accept'
  | 'acceptance.request_revision'
  | 'acceptance.reject'
  | 'delivery.apply'
  | 'delivery.export'
  // 快照与数据
  | 'snapshot.capture'
  | 'snapshot.restore'
  // 契约
  | 'contract.write'
  // 内部维护（启动清理、对账收敛）
  | 'maintenance.recover'

export interface PermissionRule {
  action: PermissionAction
  /** 允许的主体类型。 */
  allowed: PrincipalKind[]
  /** 是否要求 trusted 调用点。 */
  requiresTrusted: boolean
  /** 被拒时的错误码。 */
  denyCode: 'FORBIDDEN' | 'UNAUTHORIZED'
  description: string
}

/**
 * 权限表。
 *
 * 设计取向是**默认最小权限**：
 *   · 用户能做所有影响结果的事（审批、验收、交付、改契约）；
 *   · 模型 / 角色 / 总控只能提交，不能放行自己的成果——
 *     审计和执行是两步，「我审我自己」不在允许范围内；
 *   · 维护类动作只允许 trusted 的内部路径。
 */
export const PERMISSION_CATALOG: Record<PermissionAction, PermissionRule> = {
  'run.execute': {
    action: 'run.execute',
    allowed: ['user', 'role', 'coordinator', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '启动或继续执行一个 Run',
  },
  'run.cancel': {
    action: 'run.cancel',
    allowed: ['user', 'role', 'coordinator', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '取消一个 Run',
  },
  'run.pause': {
    action: 'run.pause',
    allowed: ['user', 'coordinator', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '主动暂停一个 Run',
  },
  'run.resume': {
    action: 'run.resume',
    allowed: ['user', 'coordinator', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '恢复用户暂停的 Run',
  },
  'run.reconcile': {
    action: 'run.reconcile',
    allowed: ['user', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '对 unknown 做出裁决',
  },
  'approval.decide': {
    action: 'approval.decide',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '批准或拒绝一次工具审批',
  },
  'grant.approve': {
    action: 'grant.approve',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '签发授权（Grant）',
  },
  'review.audit': {
    action: 'review.audit',
    allowed: ['user', 'coordinator', 'system'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '对一个 Producer Run 发起审计',
  },
  'review.decide_escalation': {
    action: 'review.decide_escalation',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '处理审计转人工的裁决',
  },
  'acceptance.accept': {
    action: 'acceptance.accept',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '接受候选产物',
  },
  'acceptance.request_revision': {
    action: 'acceptance.request_revision',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '要求返工',
  },
  'acceptance.reject': {
    action: 'acceptance.reject',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '拒绝候选产物',
  },
  'delivery.apply': {
    action: 'delivery.apply',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '把已验收产物应用到目标',
  },
  'delivery.export': {
    action: 'delivery.export',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '导出已验收产物',
  },
  'snapshot.capture': {
    action: 'snapshot.capture',
    allowed: ['user', 'system', 'coordinator', 'role'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '创建工作区快照',
  },
  'snapshot.restore': {
    action: 'snapshot.restore',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '恢复工作区到某个快照',
  },
  'contract.write': {
    action: 'contract.write',
    allowed: ['user'],
    requiresTrusted: false,
    denyCode: 'FORBIDDEN',
    description: '修改任务契约',
  },
  'maintenance.recover': {
    action: 'maintenance.recover',
    allowed: ['system'],
    requiresTrusted: true,
    denyCode: 'UNAUTHORIZED',
    description: '启动恢复、状态修正、unknown 收敛',
  },
}

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; code: 'FORBIDDEN' | 'UNAUTHORIZED'; reason: string }

/** 判定权限。纯函数，无副作用。 */
export function checkPermission(principal: Principal, action: PermissionAction): PermissionDecision {
  const rule = PERMISSION_CATALOG[action]
  if (!rule.allowed.includes(principal.kind)) {
    return {
      allowed: false,
      code: rule.denyCode,
      reason: `${principal.kind} 不能执行 ${action}`,
    }
  }
  if (rule.requiresTrusted && !principal.trusted) {
    return {
      allowed: false,
      code: rule.denyCode,
      reason: `${action} 只允许可信内部路径执行`,
    }
  }
  return { allowed: true }
}

/** 判定并抛错。调用点用它省掉手写分支。 */
export function assertPermission(
  principal: Principal,
  action: PermissionAction,
  opts: { correlationId?: string } = {},
): void {
  const decision = checkPermission(principal, action)
  if (decision.allowed) return
  throw new DomainError(decision.code, decision.reason, { correlationId: opts.correlationId })
}

// ── 主体构造 ─────────────────────────────────────────────

/** HTTP / IPC 的外部调用者。永远是 user，且永远不可信。 */
export function externalUser(id = 'user'): Principal {
  return { kind: 'user', id, trusted: false }
}

/** 执行内核 / 启动清理这类内部路径。 */
export function internalSystem(): Principal {
  return { kind: 'system', id: 'system', trusted: true }
}

/**
 * 从请求 / 事件里的 actor 声明解析主体。
 *
 * **这是最容易出安全漏洞的地方**：如果这里相信调用方声称的 'system'，
 * 任何客户端都可以自称系统去执行维护动作。
 *
 * 规则：
 *   · trusted=true（内部调用点）→ 按声明如实映射
 *   · trusted=false（HTTP/IPC）→ 无论声明什么，一律降到 'user'
 */
export function principalFromClaim(claim: string | undefined, opts: { trusted: boolean }): Principal {
  if (!opts.trusted) return externalUser()
  switch (claim) {
    case 'system':
      return internalSystem()
    case 'coordinator':
      return { kind: 'coordinator', id: 'coordinator', trusted: true }
    case 'role':
      return { kind: 'role', id: 'role', trusted: true }
    case 'provider':
      return { kind: 'provider', id: 'provider', trusted: true }
    default:
      return externalUser()
  }
}

/** 所有受控动作，便于元数据接口与穷举测试。 */
export function permissionActions(): PermissionAction[] {
  return Object.keys(PERMISSION_CATALOG) as PermissionAction[]
}
