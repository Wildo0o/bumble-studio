// 工作区知识与快照生命周期（区块 3）。
//
// 重点不是「功能有没有」，而是**不可逆操作的保护**：
//   · 快照并发锁挡住「恢复时的快照」
//   · 配额挡住「把磁盘写满」
//   · GC 只给计划，删除需要显式确认，且被引用的永不删
//   · 知识 / 记忆分开，检索可解释
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { DomainError } from '../errors.js'
import {
  DEFAULT_QUOTA,
  ResourceLock,
  checkQuota,
  formatBytes,
  planGc,
  type GcCandidate,
} from '../snapshot-lifecycle.js'
import {
  KnowledgeIndex,
  contentHashOf,
  tokenize,
  validateKnowledgeInput,
  validateMemoryInput,
} from '../knowledge.js'

describe('快照并发锁', () => {
  it('同一资源的第二个写操作立即失败（不排队）', () => {
    const lock = new ResourceLock()
    const release = lock.acquire('ws', 'capture')

    let caught: unknown
    try {
      lock.acquire('ws', 'restore')
    } catch (e) {
      caught = e
    }
    const err = caught as DomainError
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('STATE_CONFLICT')
    // 错误里要说明「正在做什么」，否则用户不知道在等什么
    expect(err.message).toContain('capture')

    release()
    expect(lock.isLocked('ws')).toBe(false)
  })

  it('不同资源互不影响', () => {
    const lock = new ResourceLock()
    const r1 = lock.acquire('a', 'capture')
    const r2 = lock.acquire('b', 'capture')
    expect(lock.isLocked('a')).toBe(true)
    expect(lock.isLocked('b')).toBe(true)
    r1()
    r2()
  })

  it('重复释放是安全的', () => {
    const lock = new ResourceLock()
    const release = lock.acquire('ws', 'capture')
    release()
    expect(() => release()).not.toThrow()
  })

  it('释放不成功的获取不会误放别人的锁', () => {
    // 场景：A 超时后假设自己还持锁，去释放；此时 B 已经拿到。
    const lock = new ResourceLock()
    const releaseA = lock.acquire('ws', 'capture', 'A')
    releaseA()
    const releaseB = lock.acquire('ws', 'capture', 'B')
    // 再调一次 A 的释放（模拟 finally 重入）
    releaseA()
    expect(lock.isLocked('ws'), 'B 的锁不应被 A 的释放误删').toBe(true)
    releaseB()
    expect(lock.isLocked('ws')).toBe(false)
  })
})

describe('快照配额', () => {
  const quota = { ...DEFAULT_QUOTA, maxTotalBytes: 1000, maxSnapshotBytes: 400, maxCount: 3, reservedFreeBytes: 0 }

  it('正常范围内允许', () => {
    expect(checkQuota({ totalBytes: 100, count: 1 }, 200, quota).allowed).toBe(true)
  })

  it('单个快照超过上限 → 拒绝，并报告超出量', () => {
    const d = checkQuota({ totalBytes: 0, count: 0 }, 500, quota)
    expect(d.allowed).toBe(false)
    expect(d.shortfallBytes).toBe(100)
  })

  it('数量已达上限 → 拒绝', () => {
    const d = checkQuota({ totalBytes: 0, count: 3 }, 10, quota)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('数量')
  })

  it('总量超限 → 拒绝，并报告还需要多少空间', () => {
    const d = checkQuota({ totalBytes: 900, count: 1 }, 200, quota)
    expect(d.allowed).toBe(false)
    expect(d.shortfallBytes).toBe(100)
  })

  it('边界值恰好等于上限时允许', () => {
    expect(checkQuota({ totalBytes: 600, count: 1 }, 400, quota).allowed).toBe(true)
  })

  it('formatBytes 对常见值可读', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB')
  })
})

describe('快照 GC 计划', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_000 * DAY

  function c(id: string, runId: string, ageDays: number, bytes = 100): GcCandidate {
    return { id, runId, createdAt: now - ageDays * DAY, totalBytes: bytes }
  }

  it('被引用的快照永不删除（即使很旧）', () => {
    const plan = planGc([c('old', 'r1', 30)], {
      olderThan: 7 * DAY,
      keepIds: new Set(['old']),
      keepPerRun: 1,
    }, now)
    expect(plan.deletable).toEqual([])
    expect(plan.keptBecauseReferenced).toEqual(['old'])
  })

  it('太新的快照不删', () => {
    const plan = planGc([c('fresh', 'r1', 1)], {
      olderThan: 7 * DAY,
      keepIds: new Set(),
      keepPerRun: 0,
    }, now)
    expect(plan.deletable).toEqual([])
    expect(plan.keptBecauseRecent).toEqual(['fresh'])
  })

  it('每个 Run 最近 N 个保留', () => {
    const plan = planGc(
      [c('a', 'r1', 30), c('b', 'r1', 20), c('z', 'r1', 10)],
      { olderThan: 7 * DAY, keepIds: new Set(), keepPerRun: 2 },
      now,
    )
    // z(10天) 与 b(20天) 是最近两个，a(30天) 可删
    expect(plan.keptBecausePerRun.sort()).toEqual(['b', 'z'])
    expect(plan.deletable).toEqual(['a'])
    expect(plan.reclaimableBytes).toBe(100)
  })

  it('已软删除的不重复出现在计划里', () => {
    const cand = { ...c('gone', 'r1', 30), deletedAt: now - DAY }
    const plan = planGc([cand], { olderThan: 7 * DAY, keepIds: new Set(), keepPerRun: 0 }, now)
    expect(plan.deletable).toEqual([])
  })

  it('计划是纯函数：不修改输入', () => {
    const input = [c('a', 'r1', 30), c('b', 'r1', 40)]
    const snapshot = JSON.stringify(input)
    planGc(input, { olderThan: 7 * DAY, keepIds: new Set(), keepPerRun: 1 }, now)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('知识库与项目记忆', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-know-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('Store 上真的挂载了知识方法（安装失败会在这里暴露）', () => {
    expect(typeof store.createKnowledge).toBe('function')
    expect(typeof store.listKnowledge).toBe('function')
    expect(typeof store.createMemory).toBe('function')
    expect(typeof store.listMemory).toBe('function')
  })

  it('原型的全部挂载方法都真实存在（安装自检）', () => {
    // store.ts 里有模块加载期的自检，这里再从使用方确认一遍：
    // 挂载是「运行时契约」，缺一个方法只会在调用时炸，
    // 所以用穷举断言把它逼到测试里暴露。
    const methods = [
      'createKnowledge', 'getKnowledge', 'listKnowledge', 'updateKnowledge', 'deleteKnowledge',
      'createMemory', 'listMemory', 'deleteMemory',
      'upsertRole', 'getRole', 'listRoles',
      'listPackages', 'getPackage', 'insertPackage', 'casPackage',
      'insertChangeSet', 'listChangeSets', 'getChangeSet', 'casChangeSet',
      'requestCancel', 'hasCancelIntent', 'clearCancelIntent',
      'listCancelIntents', 'pruneCancelIntents',
      'inspectLease', 'tryClaimLease', 'releaseLease', 'casRunStatus',
    ] as const
    for (const m of methods) {
      expect(typeof (store as unknown as Record<string, unknown>)[m], `缺少方法 ${m}`).toBe('function')
    }
  })

  it('创建知识条目并保留来源', () => {
    const doc = store.createKnowledge({
      scope: 'workspace', scopeId: 'w1',
      title: '构建约定', content: '用 pnpm build', source: 'README.md',
      tags: ['build'],
    })
    expect(doc.id).toBeTruthy()
    expect(doc.contentHash).toBe(contentHashOf('构建约定\u0000用 pnpm build'))
    expect(store.listKnowledge('workspace', 'w1')).toHaveLength(1)
  })

  it('同作用域同内容重复导入是幂等的', () => {
    const a = store.createKnowledge({
      scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: 's', tags: [],
    })
    const b = store.createKnowledge({
      scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: 's', tags: [],
    })
    expect(b.id).toBe(a.id)
    expect(store.listKnowledge('workspace', 'w1')).toHaveLength(1)
  })

  it('不同作用域的同内容互不冲突', () => {
    store.createKnowledge({
      scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: 's', tags: [],
    })
    store.createKnowledge({
      scope: 'project', scopeId: 'p1', title: 'T', content: 'C', source: 's', tags: [],
    })
    expect(store.listKnowledge('workspace', 'w1')).toHaveLength(1)
    expect(store.listKnowledge('project', 'p1')).toHaveLength(1)
  })

  it('知识条目必须提供来源（无来源无法判断可信度）', () => {
    expect(() =>
      store.createKnowledge({
        scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: '', tags: [],
      }),
    ).toThrow(/source/)
  })

  it('删除是软删除：列表里消失，但行仍在', () => {
    const doc = store.createKnowledge({
      scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: 's', tags: [],
    })
    store.deleteKnowledge(doc.id)
    expect(store.listKnowledge('workspace', 'w1')).toHaveLength(0)
    const raw = store.getKnowledge(doc.id)
    expect(raw).toBeDefined()
    expect(raw!.deletedAt).toBeTypeOf('number')
  })

  it('重复删除已删除的条目返回 NOT_FOUND', () => {
    const doc = store.createKnowledge({
      scope: 'workspace', scopeId: 'w1', title: 'T', content: 'C', source: 's', tags: [],
    })
    store.deleteKnowledge(doc.id)
    let caught: unknown
    try {
      store.deleteKnowledge(doc.id)
    } catch (e) {
      caught = e
    }
    expect((caught as DomainError).code).toBe('NOT_FOUND')
  })

  it('更新后内容与其他条目重复 → VERSION_CONFLICT', () => {
    const a = store.createKnowledge({
      scope: 'workspace', scopeId: 'w', title: 'A', content: '1', source: 's', tags: [],
    })
    store.createKnowledge({
      scope: 'workspace', scopeId: 'w', title: 'B', content: '2', source: 's', tags: [],
    })
    expect(() =>
      store.updateKnowledge(a.id, { title: 'B', content: '2' }),
    ).toThrow(/已存在相同内容/)
  })

  it('记忆条目携带来源 Task / Run 与可信度', () => {
    const item = store.createMemory({
      scope: 'workspace', scopeId: 'w',
      statement: '这个仓库用 pnpm',
      evidence: 'package.json 里有 pnpm-lock.yaml',
      tags: ['build'], origin: 'task', taskId: 't1', runId: 'r1',
    })
    expect(item.origin).toBe('task')
    expect(item.taskId).toBe('t1')
    expect(store.listMemory('workspace', 'w')).toHaveLength(1)
  })

  it('记忆的 origin 只能是封闭集合里的值', () => {
    const v = validateMemoryInput({ statement: 'x', origin: 'admin' })
    expect(v.origin).toBe('user')   // 非法值降级为最保守的来源
    expect(validateMemoryInput({ statement: 'x', origin: 'inference' }).origin).toBe('inference')
  })

  it('validateKnowledgeInput 拒绝空标题 / 空正文 / 超长', () => {
    expect(() => validateKnowledgeInput({ title: '', content: 'c', source: 's' })).toThrow(/title/)
    expect(() => validateKnowledgeInput({ title: 't', content: '  ', source: 's' })).toThrow(/content/)
    expect(() =>
      validateKnowledgeInput({ title: 't', content: 'x'.repeat(200_001), source: 's' }),
    ).toThrow(/上限/)
  })
})

describe('检索索引', () => {
  it('tokenize 处理中英文混合', () => {
    const t = tokenize('用 pnpm 构建 snapshot')
    expect(t).toContain('pnpm')
    expect(t).toContain('snapshot')
    // 中文按「单字 + 相邻二元组」切分
    expect(t).toContain('构建')
    expect(t).toContain('构')
    expect(t).toContain('建')
    // 原文里没有的字不应出现在词表里
    expect(t).not.toContain('快')
    // 单字母不作为拉丁词（噪声太大）
    expect(t).not.toContain('p')
  })

  it('按相关度排序，且给出命中词（可解释）', () => {
    const idx = new KnowledgeIndex()
    idx.setKnowledge([
      {
        id: 'k1', scope: 'workspace', scopeId: 'w', title: '快照恢复',
        content: '快照恢复需要并发锁', source: 's', tags: [], contentHash: 'h1',
        createdAt: 1, updatedAt: 1,
      },
      {
        id: 'k2', scope: 'workspace', scopeId: 'w', title: '构建流程',
        content: '先安装依赖再构建', source: 's', tags: [], contentHash: 'h2',
        createdAt: 2, updatedAt: 2,
      },
    ])

    const hits = idx.search('快照恢复')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('k1')
    expect(hits[0]!.matchedTerms.length).toBeGreaterThan(0)
    // 第二条不应因为「构建」被误命中
    expect(hits.every((h) => h.id === 'k1')).toBe(true)
  })

  it('用户确认的记忆权重高于推断', () => {
    const idx = new KnowledgeIndex()
    idx.setMemory([
      {
        id: 'u', scope: 'workspace', scopeId: 'w', statement: '用 pnpm',
        evidence: '', origin: 'user', tags: [], createdAt: 1,
      },
      {
        id: 'i', scope: 'workspace', scopeId: 'w', statement: '用 pnpm',
        evidence: '', origin: 'inference', tags: [], createdAt: 2,
      },
    ])
    const hits = idx.search('pnpm')
    expect(hits[0]!.id).toBe('u')
    expect(hits[1]!.id).toBe('i')
  })

  it('软删除的条目不出现在检索结果里', () => {
    const idx = new KnowledgeIndex()
    idx.setKnowledge([
      {
        id: 'gone', scope: 'workspace', scopeId: 'w', title: 'x',
        content: 'x', source: 's', tags: [], contentHash: 'h',
        createdAt: 1, updatedAt: 1, deletedAt: 2,
      },
    ])
    expect(idx.search('x')).toEqual([])
  })

  it('空查询返回空结果（不是全部）', () => {
    const idx = new KnowledgeIndex()
    idx.setKnowledge([
      {
        id: 'k', scope: 'workspace', scopeId: 'w', title: 't', content: 'c',
        source: 's', tags: [], contentHash: 'h', createdAt: 1, updatedAt: 1,
      },
    ])
    expect(idx.search('   ')).toEqual([])
  })

  it('可以只检索知识或只检索记忆', () => {
    const idx = new KnowledgeIndex()
    idx.setKnowledge([
      {
        id: 'k', scope: 'workspace', scopeId: 'w', title: 'pnpm', content: 'pnpm',
        source: 's', tags: [], contentHash: 'h', createdAt: 1, updatedAt: 1,
      },
    ])
    idx.setMemory([
      { id: 'm', scope: 'workspace', scopeId: 'w', statement: 'pnpm', evidence: '', origin: 'user', tags: [], createdAt: 1 },
    ])
    expect(idx.search('pnpm', { includeMemory: false }).map((h) => h.kind)).toEqual(['knowledge'])
    expect(idx.search('pnpm', { includeKnowledge: false }).map((h) => h.kind)).toEqual(['memory'])
  })
})
