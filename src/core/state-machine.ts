// 统一状态门。
//
// 两个职责：
//   1. 用声明式表判断「结构上是否允许这次迁移」
//   2. 给每个入口列出「哪些起始状态可以进入执行」
//
// 为什么执行入口必须用这张表而不是各写各的 if：
//   RunExecutor 里原本写着 `['queued','running'].includes(run.status)`，
//   和状态机的声明分离。后来状态机加了 waiting_user / waiting_merge，
//   执行门却没同步——两处对「能不能执行」的说法不一致。
//   现在两者都从这里取，只有一份定义。
import type { RunStatus } from '../shared/types.js'
import type { StatefulKind, TransitionTable } from './state-tables.js'
import {
  ACCEPTANCE_TRANSITIONS,
  APPROVAL_TRANSITIONS,
  ARTIFACT_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  GRANT_TRANSITIONS,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  TASK_TRANSITIONS,
} from './state-tables.js'

const TABLES: Record<StatefulKind, TransitionTable<string>> = {
  run: RUN_TRANSITIONS,
  task: TASK_TRANSITIONS,
  step: STEP_TRANSITIONS,
  approval: APPROVAL_TRANSITIONS,
  grant: GRANT_TRANSITIONS,
  artifact: ARTIFACT_TRANSITIONS,
  acceptance: ACCEPTANCE_TRANSITIONS,
  delivery: DELIVERY_TRANSITIONS,
}

export function tableFor(kind: StatefulKind): TransitionTable<string> {
  return TABLES[kind]
}

/** 这个状态是不是该种类的合法状态。 */
export function isKnownState(kind: StatefulKind, state: string): boolean {
  return TABLES[kind].states.includes(state)
}

/**
 * 结构上是否允许迁移。
 *
 * 自迁移（A → A）视为幂等写入，允许。
 * 理由：`setRunStatus(id, 'running')` 这类「确认当前状态」的写入在恢复路径里
 * 是正常的；把它判成非法，只会迫使调用方到处写特例。
 */
export function canTransition(kind: StatefulKind, from: string, to: string): boolean {
  if (from === to) return true
  const table = TABLES[kind]
  const edges = table.transitions[from as keyof typeof table.transitions] as readonly string[] | undefined
  if (!edges) return false
  return edges.includes(to)
}

/** 是否终态。 */
export function isTerminal(kind: StatefulKind, state: string): boolean {
  return TABLES[kind].terminal.includes(state)
}

/**
 * 允许进入「执行」的 Run 起始状态。
 *
 * 只有两个：
 *   queued  从未执行过
 *   running 上次进程异常退出留下的占用（需要 resumeStale 显式确认）
 *
 * waiting_approval / paused / needs_reconciliation 都**不在**这里：
 * 它们各自有专用入口（审批决定、resume、对账），
 * 从执行入口混进去就绕过了那些入口的前置检查。
 */
export const RUN_EXECUTABLE_FROM: readonly RunStatus[] = ['queued', 'running']

/** Run 是否处于「暂停展示」状态（对外都表现为 paused，但含义不同）。 */
export const RUN_PAUSED_STATES: readonly RunStatus[] = ['paused', 'waiting_approval', 'needs_reconciliation']

/** 状态列表，便于元数据接口与 UI。 */
export function machineSummary(): Array<{ kind: StatefulKind; states: string[]; terminal: string[] }> {
  return (Object.keys(TABLES) as StatefulKind[]).map((kind) => ({
    kind,
    states: [...TABLES[kind].states],
    terminal: [...TABLES[kind].terminal],
  }))
}
