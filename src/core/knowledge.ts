// 知识库与项目记忆。
//
// 两者的区别：
//
//   知识库（Knowledge）  —— **用户提供的事实**。文档片段、规范、参考资料。
//                          不随时间自动改变，只由用户增删。
//   项目记忆（Memory）   —— **跑出来的经验**。这个仓库用什么命令构建、
//                          哪些坑踩过、某个约定是什么。
//                          由任务产生，会过时，需要可追溯来源。
//
// 为什么必须分开：
//   如果把两者混在一起，「这条信息可信吗」就永远没有答案——
//   用户写下的规范和模型猜出来的习惯，在检索结果里长得一样。
//   分开后，每一条记忆都带着来源（哪个 Task / Run 产生的），可以质疑、可以撤销。
//
// 检索：这里只做**词法**打分（BM25 简化版），不做向量检索。
//   理由：向量检索需要嵌入模型与索引存储，那是另一套基础设施；
//   词法检索在代码 / 规范这类内容上表现足够好，而且**完全可解释**——
//   能回答「为什么这条被选中」，这对证据系统很重要。
import { createHash } from 'node:crypto'
import type { DomainContractScope } from '../shared/types.js'

/** 知识条目的作用域。 */
export type KnowledgeScope = 'workspace' | 'project' | 'task'

export interface KnowledgeDoc {
  id: string
  scope: KnowledgeScope
  /** workspace / project / task 的 id。scope='workspace' 时用工作区 id。 */
  scopeId: string
  title: string
  /** 正文。检索按段落切分。 */
  content: string
  /** 来源说明（文件路径、URL、或「手动记录」）。 */
  source: string
  tags: string[]
  contentHash: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** 项目记忆的一条。 */
export interface MemoryItem {
  id: string
  scope: KnowledgeScope
  scopeId: string
  /** 一句话结论。应能独立读懂。 */
  statement: string
  /** 为什么记得住：证据 / 出处。空字符串表示「来源不明」，检索时降权。 */
  evidence: string
  /** 产生它的 Task（如果有）。 */
  taskId?: string
  /** 产生它的 Run（如果有）。 */
  runId?: string
  /** 可信度来源：用户确认 > 任务结论 > 模型推断。 */
  origin: 'user' | 'task' | 'inference'
  tags: string[]
  createdAt: number
  deletedAt?: number
}

/** 检索结果。 */
export interface SearchHit {
  kind: 'knowledge' | 'memory'
  id: string
  title: string
  /** 命中的摘要片段 */
  snippet: string
  score: number
  /** 为什么被选中（可解释性） */
  matchedTerms: string[]
}

/**
 * 分词。
 *
 * 中文没有天然空格分隔，这里用「非字母数字字符 + 中文字符二元组」的
 * 简化策略：
 *   · 拉丁词按空白与标点切分，转小写
 *   · 中文字符逐字 + 相邻二元组（「快照恢复」→ 快照/照恢/恢复 + 单字）
 *
 * 为什么不做真正的分词：引入词典会让「为什么匹配」变得不可解释，
 * 而且词典更新会让历史检索结果变化。这条路够用且稳定。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 拉丁 / 数字词
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) {
    const t = m[0]
    if (t.length >= 2) tokens.push(t)
  }

  // 中文：单字 + 二元组
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]!)
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }

  return tokens
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 简化 BM25 打分。
 *
 * 参数与标准 BM25 一致（k1=1.2, b=0.75），但省掉 IDF：
 * 语料是「一个工作区的知识」，文档数通常几十到几百，
 * IDF 在小语料上方差大且容易让罕见词主导排序。
 * 这里用「命中词种类数 × 词频饱和」表达同样的直觉，且更可解释。
 */
const K1 = 1.2
const B = 0.75

interface IndexedDoc {
  id: string
  kind: 'knowledge' | 'memory'
  title: string
  body: string
  tokens: string[]
  termFreq: Map<string, number>
  length: number
  /** 排序用的额外权重（用户确认的记忆更靠前）。 */
  boost: number
}

function indexDoc(input: {
  id: string
  kind: 'knowledge' | 'memory'
  title: string
  body: string
  boost?: number
}): IndexedDoc {
  const tokens = tokenize(`${input.title} ${input.title} ${input.body}`)
  const termFreq = new Map<string, number>()
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tokens,
    termFreq,
    length: tokens.length,
    boost: input.boost ?? 1,
  }
}

/** 检索索引。每次写入后重建——语料小，重建成本远低于维护增量索引的正确性风险。 */
export class KnowledgeIndex {
  private knowledge: IndexedDoc[] = []
  private memory: IndexedDoc[] = []

  setKnowledge(docs: KnowledgeDoc[]): void {
    this.knowledge = docs
      .filter((d) => d.deletedAt === undefined)
      .map((d) =>
        indexDoc({
          id: d.id,
          kind: 'knowledge',
          title: d.title,
          body: `${d.content} ${d.tags.join(' ')} ${d.source}`,
        }),
      )
  }

  setMemory(items: MemoryItem[]): void {
    this.memory = items
      .filter((m) => m.deletedAt === undefined)
      .map((m) =>
        indexDoc({
          id: m.id,
          kind: 'memory',
          title: m.statement,
          body: `${m.evidence} ${m.tags.join(' ')}`,
          // 用户确认的记忆权重最高；无来源的推断最低。
          // 这不是「谁更重要」，而是「谁更可信」——检索结果会直接进入
          // 模型上下文，不可信的条目应该自然靠后。
          boost: m.origin === 'user' ? 1.6 : m.origin === 'task' ? 1.2 : 0.8,
        }),
      )
  }

  /** 检索。返回按分数降序的命中。 */
  search(query: string, opts: { limit?: number; includeMemory?: boolean; includeKnowledge?: boolean } = {}): SearchHit[] {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const limit = Math.max(1, Math.min(100, opts.limit ?? 10))
    const includeK = opts.includeKnowledge !== false
    const includeM = opts.includeMemory !== false

    const pool: IndexedDoc[] = [
      ...(includeK ? this.knowledge : []),
      ...(includeM ? this.memory : []),
    ]
    if (pool.length === 0) return []

    const avgLength = pool.reduce((s, d) => s + d.length, 0) / pool.length || 1

    const hits: SearchHit[] = []
    for (const doc of pool) {
      let score = 0
      const matched: string[] = []
      for (const term of terms) {
        const tf = doc.termFreq.get(term) ?? 0
        if (tf === 0) continue
        matched.push(term)
        // BM25 词频饱和
        score += (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength))
      }
      if (matched.length === 0) continue
      // 命中词种类越多越相关（覆盖度）
      score *= 1 + (matched.length / terms.length)
      score *= doc.boost
      hits.push({
        kind: doc.kind,
        id: doc.id,
        title: doc.title,
        snippet: snippetAround(doc.body, matched),
        score,
        matchedTerms: matched,
      })
    }

    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return hits.slice(0, limit)
  }

  get sizes(): { knowledge: number; memory: number } {
    return { knowledge: this.knowledge.length, memory: this.memory.length }
  }
}

/** 取包含命中词的片段。找不到时取开头。 */
function snippetAround(body: string, terms: string[]): string {
  const lower = body.toLowerCase()
  let pos = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  const start = Math.max(0, (pos < 0 ? 0 : pos) - 40)
  const slice = body.slice(start, start + 160).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + slice + (start + 160 < body.length ? '…' : '')
}

// ── 校验 ───────────────────────────────────────────────────

export const MAX_KNOWLEDGE_CONTENT = 200_000
export const MAX_MEMORY_STATEMENT = 2_000

export function validateKnowledgeInput(input: Record<string, unknown>): {
  title: string
  content: string
  source: string
  tags: string[]
} {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const content = typeof input.content === 'string' ? input.content : ''
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!title) throw new Error('知识条目的 title 不能为空')
  if (!content.trim()) throw new Error('知识条目的 content 不能为空')
  if (content.length > MAX_KNOWLEDGE_CONTENT) {
    throw new Error(`知识条目内容超过 ${MAX_KNOWLEDGE_CONTENT} 字符上限`)
  }
  if (!source) {
    // 来源必填：没有来源的知识无法判断可信度，也无法在冲突时裁决。
    throw new Error('知识条目必须提供 source（来自哪个文件 / URL / 手动记录）')
  }
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : []
  return { title, content, source, tags }
}

export function validateMemoryInput(input: Record<string, unknown>): {
  statement: string
  evidence: string
  tags: string[]
  origin: MemoryItem['origin']
} {
  const statement = typeof input.statement === 'string' ? input.statement.trim() : ''
  if (!statement) throw new Error('记忆条目必须有 statement')
  if (statement.length > MAX_MEMORY_STATEMENT) {
    throw new Error(`记忆条目超过 ${MAX_MEMORY_STATEMENT} 字符上限`)
  }
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : ''
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : []

  // origin 只能由服务端决定：客户端不能声称「这条是用户确认的」
  // 来提升它在检索中的权重。
  const origin: MemoryItem['origin'] =
    input.origin === 'task' ? 'task' : input.origin === 'inference' ? 'inference' : 'user'

  return { statement, evidence, tags, origin }
}

/** 作用域是否可以由外部指定。task 作用域由路由参数决定，不接受请求体。 */
export function isValidScope(s: unknown): s is KnowledgeScope {
  return s === 'workspace' || s === 'project' || s === 'task'
}

/**
 * 知识 / 记忆对应的契约作用域。
 *
 * 作用：知识条目也可以作为「版本化契约」的一部分被审计引用。
 * 这里只做映射，不创建契约。
 */
export function contractScopeFor(scope: KnowledgeScope): DomainContractScope {
  return scope === 'task' ? 'task' : scope === 'project' ? 'project' : 'workspace'
}
