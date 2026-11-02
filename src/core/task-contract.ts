// 任务契约的规范化与哈希。
//
// 为什么单独一个文件：canonical 化规则必须是**固定的、可复算的**。
// 如果它散落在 Store 和 ReviewLoop 里，两边各写一遍，
// 早晚会有一边改了另一边没改——然后 hash 对不上，或者更糟：
// 对不上却没人发现。
//
// 规则（改动即破坏兼容，必须升 CONTRACT_CANON_VERSION）：
//   1. 只取五个字段：taskId / goal / acceptanceCriteria / contractVersion / actor
//   2. 字段名按字典序排列（taskId 之前用固定顺序，见下）
//   3. 字符串不做任何 trim / 归一化——用户写的是什么就 hash 什么
//   4. acceptanceCriteria 保持数组顺序（顺序是契约的一部分）
//   5. JSON.stringify 不带空格，UTF-8 编码
//   6. hash = sha256(canonical) 的小写十六进制
//
// 为什么不用「先 sort 对象键再 stringify」这种通用方案：
// 那依赖 JS 引擎的键序规则。显式拼装字符串更笨，但十年后还能算出一样的值。
import { createHash } from 'node:crypto'
import type { TaskContract } from '../shared/types.js'

/** canonical 格式的版本。改变序列化规则时必须 +1。 */
export const CONTRACT_CANON_VERSION = 1

/** canonical 化需要的字段。刻意不含 createdAt/updatedAt——那是元数据，不是契约内容。 */
export interface ContractContent {
  taskId: string
  goal: string
  acceptanceCriteria: string[]
  contractVersion: number
  actor: string
}

/**
 * 把契约内容序列化成规范文本。
 *
 * 输出形如（单行，无空格）：
 * {"v":1,"taskId":"...","goal":"...","acceptanceCriteria":["..."],"contractVersion":1,"actor":"..."}
 *
 * 注意 `v` 在最前面：将来改规则时可以靠它区分新旧格式，
 * 而不是靠「hash 对不上」这种间接信号。
 */
export function canonicalizeContract(content: ContractContent): string {
  // JSON.stringify 处理转义（引号、反斜杠、换行、Unicode）。
  // 不要手写拼接——那是转义漏洞的温床。
  return JSON.stringify({
    v: CONTRACT_CANON_VERSION,
    taskId: content.taskId,
    goal: content.goal,
    acceptanceCriteria: content.acceptanceCriteria,
    contractVersion: content.contractVersion,
    actor: content.actor,
  })
}

/** sha256(canonical)，小写十六进制。 */
export function hashContract(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** 一次性算出 canonical + hash。 */
export function buildContractContent(content: ContractContent): {
  canonical: string
  contractHash: string
} {
  const canonical = canonicalizeContract(content)
  return { canonical, contractHash: hashContract(canonical) }
}

/**
 * 重新计算一条已存契约的 hash，并与库里的值比对。
 *
 * 为什么必须重算而不是直接信库里的 contract_hash：
 * 数据库可以被直接改（迁移脚本、手工 SQL、文件损坏）。
 * 只读 contract_hash 字段等于「让被审计对象自己证明自己没被改」。
 */
export function verifyContractIntegrity(
  contract: TaskContract,
): { ok: true } | { ok: false; reason: string } {
  const expected = canonicalizeContract({
    taskId: contract.taskId,
    goal: contract.goal,
    acceptanceCriteria: contract.acceptanceCriteria,
    contractVersion: contract.contractVersion,
    actor: contract.actor,
  })
  const actualHash = hashContract(expected)

  if (expected !== contract.canonical) {
    return {
      ok: false,
      reason:
        '契约的 canonical 文本与字段不一致——数据库里的内容被改过，' +
        '或 canonical 规则已变更但版本号没升',
    }
  }
  if (actualHash !== contract.contractHash) {
    return {
      ok: false,
      reason:
        `契约 hash 不一致：库里记的是 ${contract.contractHash.slice(0, 16)}…，` +
        `按当前内容重算是 ${actualHash.slice(0, 16)}…`,
    }
  }
  return { ok: true }
}

/** 审计提示词里契约区的开始 / 结束标记。 */
export const CONTRACT_BLOCK_START = '═══ 系统任务契约（受保护，优先级最高）═══'
export const CONTRACT_BLOCK_END = '═══ 系统任务契约结束 ═══'

/** 契约区块里用到的全部行标记字符（含开始/结束标记）。 */
const BLOCK_MARKER_CHARS = '═'

/**
 * 把不可信的契约文本转成可以安全放进区块里的形式。
 *
 * 契约的 goal / acceptanceCriteria 是**用户输入**，而它们会被原样拼进
 * 受保护区块的正文。如果正文里出现与结束标记相同的字符串，
 * 模型看到的就变成「契约区提前结束了」——后面跟着的是用户写的任意指令。
 *
 * 防御方式是**改字形而不是删内容**：把正文里的 `═` 换成外观相近的 `─`。
 * 为什么不直接删：契约内容参与 hash，删字符会让「用户写的」和
 * 「模型看到的」对不上，事后无法核对。替换后文本仍然可读，
 * 也仍然能一眼看出原字符被处理过。
 */
function neutralizeBlockMarkers(text: string): string {
  if (!text.includes(BLOCK_MARKER_CHARS)) return text
  return text.split(BLOCK_MARKER_CHARS).join('─')
}

/** 契约内容的可读摘要，用于审计提示词。 */
export function renderContractForPrompt(contract: TaskContract): string {
  const criteria = contract.acceptanceCriteria.length > 0
    ? contract.acceptanceCriteria
        .map((c, i) => `  ${i + 1}. ${neutralizeBlockMarkers(c)}`)
        .join('\n')
    : '  （未列出验收标准）'

  return [
    `taskId: ${neutralizeBlockMarkers(contract.taskId)}`,
    `contractVersion: ${contract.contractVersion}`,
    `contractHash: ${contract.contractHash}`,
    '',
    '## 任务目标',
    neutralizeBlockMarkers(contract.goal),
    '',
    '## 验收标准',
    criteria,
  ].join('\n')
}
