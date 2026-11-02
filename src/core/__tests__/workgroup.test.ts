// 工作组协调（区块 5）。
//
// 重点测「并发下会不会错」和「冲突会不会被静默吞掉」：
//   · 两个总控同时派活 → 只有一个成功，另一个如实报告被抢占
//   · 两个变更集改同一文件 → 第二阶段合并时被拦下
//   · 依赖成环 → 创建时拒绝，而不是永远等待
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { DomainError } from '../errors.js'
import { WorkgroupCoordinator } from '../workgroup-coordinator.js'
import {
  canRoleUseTool,
  canTransitionWorkPackage,
  detectConflicts,
  detectConflictsAgainst,
  normalizeChangePath,
  readyPackages,
  validateChangePath,
  validateChangeSetInput,
  validateGraph,
  validateWorkPackageInput,
  type ChangeSet,
  type RoleDefinition,
  type WorkPackage,
} from '../workgroup.js'

describe('路径规范化', () => {
  it('统一分隔符、去 ./ 与重复斜杠', () => {
    expect(normalizeChangePath('src\\a.ts')).toBe('src/a.ts')
    expect(normalizeChangePath('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeChangePath('src//a.ts')).toBe('src/a.ts')
    expect(normalizeChangePath('/src/a.ts')).toBe('src/a.ts')
  })

  it('Windows 大小写不敏感：a.ts 与 A.ts 视为同一文件', () => {
    expect(normalizeChangePath('src/A.TS')).toBe(normalizeChangePath('src/a.ts'))
  })
})

describe('冲突检测', () => {
  function cs(id: string, wp: string, changes: Array<{ path: string; hash?: string; kind?: 'added' | 'modified' | 'deleted' }>): ChangeSet {
    return {
      id,
      taskId: 't1',
      workPackageId: wp,
      roleId: 'r',
      changes: changes.map((c) => ({
        path: c.path,
        kind: c.kind ?? 'modified',
        ...(c.hash ? { contentHash: c.hash } : {}),
      })),
      status: 'submitted',
      createdAt: 1,
    }
  }

  it('不同文件不算冲突', () => {
    expect(detectConflicts(cs('a', 'w1', [{ path: 'x.ts', hash: 'h1' }]), cs('b', 'w2', [{ path: 'y.ts', hash: 'h2' }]))).toEqual([])
  })

  it('同一文件不同内容 → 真冲突', () => {
    const c = detectConflicts(cs('a', 'w1', [{ path: 'x.ts', hash: 'h1' }]), cs('b', 'w2', [{ path: 'x.ts', hash: 'h2' }]))
    expect(c).toHaveLength(1)
    expect(c[0]!.differentContent).toBe(true)
    expect(c[0]!.workPackageIds).toEqual(['w1', 'w2'])
  })

  it('同一文件相同内容 → 不算需要处理的冲突', () => {
    const c = detectConflicts(cs('a', 'w1', [{ path: 'x.ts', hash: 'same' }]), cs('b', 'w2', [{ path: 'x.ts', hash: 'same' }]))
    expect(c).toHaveLength(1)
    expect(c[0]!.differentContent).toBe(false)
  })

  it('路径写法不同但指向同一文件也能检出', () => {
    const c = detectConflicts(
      cs('a', 'w1', [{ path: 'src\\a.ts', hash: 'h1' }]),
      cs('b', 'w2', [{ path: './src/A.ts', hash: 'h2' }]),
    )
    expect(c).toHaveLength(1)
    expect(c[0]!.path).toBe('src/a.ts')
  })

  it('同一个工作包的两个变更集不互判冲突', () => {
    expect(detectConflicts(cs('a', 'w1', [{ path: 'x.ts', hash: 'h1' }]), cs('b', 'w1', [{ path: 'x.ts', hash: 'h2' }]))).toEqual([])
  })

  it('已拒绝的变更集不参与冲突判定', () => {
    const rejected = { ...cs('b', 'w2', [{ path: 'x.ts', hash: 'h2' }]), status: 'rejected' as const }
    expect(detectConflictsAgainst(cs('a', 'w1', [{ path: 'x.ts', hash: 'h1' }]), [rejected])).toEqual([])
  })
})

describe('依赖图校验', () => {
  function wp(id: string, dependsOn: string[] = [], status: WorkPackage['status'] = 'planned'): WorkPackage {
    return {
      id, taskId: 't1', kind: 'implementation', title: id,
      deliverable: 'x', status, dependsOn, createdAt: 1,
    }
  }

  it('合法图通过', () => {
    const r = validateGraph([wp('a'), wp('b', ['a'])])
    expect(r.ok).toBe(true)
  })

  it('依赖不存在被报告', () => {
    const r = validateGraph([wp('a', ['nope'])])
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([{ packageId: 'a', dependsOn: 'nope' }])
  })

  it('环被报告', () => {
    const r = validateGraph([wp('a', ['c']), wp('b', ['a']), wp('c', ['b'])])
    expect(r.ok).toBe(false)
    expect(r.cycles.length).toBeGreaterThan(0)
  })

  it('自依赖是环', () => {
    const r = validateGraph([wp('a', ['a'])])
    expect(r.ok).toBe(false)
  })
})

describe('就绪判定', () => {
  function wp(id: string, deps: string[], status: WorkPackage['status']): WorkPackage {
    return { id, taskId: 't1', kind: 'implementation', title: id, deliverable: 'x', status, dependsOn: deps, createdAt: 1 }
  }

  it('依赖都 merged 才能开始', () => {
    const list = [wp('a', [], 'merged'), wp('b', ['a'], 'ready')]
    expect(readyPackages(list).map((p) => p.id)).toEqual(['b'])
  })

  it('依赖只 submitted 不算满足（提交但未合并）', () => {
    const list = [wp('a', [], 'submitted'), wp('b', ['a'], 'planned')]
    expect(readyPackages(list)).toEqual([])
  })

  it('running / merged 的包不算「可以开始」', () => {
    const list = [wp('a', [], 'running'), wp('b', [], 'merged')]
    expect(readyPackages(list)).toEqual([])
  })
})

describe('工作包状态机', () => {
  it('planned → ready → running → submitted → merged', () => {
    expect(canTransitionWorkPackage('planned', 'ready')).toBe(true)
    expect(canTransitionWorkPackage('ready', 'running')).toBe(true)
    expect(canTransitionWorkPackage('running', 'submitted')).toBe(true)
    expect(canTransitionWorkPackage('submitted', 'merged')).toBe(true)
  })

  it('不能从 planned 直接 running（依赖未确认）', () => {
    expect(canTransitionWorkPackage('planned', 'running')).toBe(false)
  })

  it('merged 是终态', () => {
    expect(canTransitionWorkPackage('merged', 'running')).toBe(false)
    expect(canTransitionWorkPackage('merged', 'blocked')).toBe(false)
  })

  it('submitted 不能回到 running（要回到 running 必须先 blocked）', () => {
    expect(canTransitionWorkPackage('submitted', 'running')).toBe(false)
  })
})

describe('角色工具边界', () => {
  const role: RoleDefinition = {
    id: 'reviewer', name: '审查者', responsibility: '审',
    allowedTools: ['read_file'], produces: ['review'],
  }

  it('允许列表内的工具', () => {
    expect(canRoleUseTool(role, { id: 'read_file', riskLevel: 'read' }).allowed).toBe(true)
  })

  it('列表外的工具被拒绝', () => {
    expect(canRoleUseTool(role, { id: 'write_file', riskLevel: 'write' }).allowed).toBe(false)
  })

  it('external 工具任何角色都不能直接用（需要用户审批）', () => {
    const open: RoleDefinition = { ...role, allowedTools: [] }
    const r = canRoleUseTool(open, { id: 'send_email', riskLevel: 'external' })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('审批')
  })
})

describe('输入校验', () => {
  it('工作包必须有 title 与 deliverable', () => {
    expect(() => validateWorkPackageInput({ deliverable: 'x' })).toThrow(/title/)
    expect(() => validateWorkPackageInput({ title: 't' })).toThrow(/deliverable/)
  })

  it('变更集中未删除的文件必须有 contentHash', () => {
    expect(() =>
      validateChangeSetInput({ changes: [{ path: 'a.ts', kind: 'modified' }] }),
    ).toThrow(/contentHash/)
  })

  it('删除的文件不需要 contentHash', () => {
    const changes = validateChangeSetInput({ changes: [{ path: 'a.ts', kind: 'deleted' }] })
    expect(changes[0]!.contentHash).toBeUndefined()
  })

  it('路径穿越一律拒绝（.. / 绝对路径 / UNC / 盘符 / 家目录）', () => {
    for (const bad of [
      '../../victim',
      'src/../../secret',
      '/etc/passwd',
      'C:\\Windows\\System32',
      '\\\\server\\share\\f',
      '\\\\?\\C:\\x',
      '~/secret',
      'a\u0000b',
      'a\nb',
    ]) {
      const r = validateChangePath(bad)
      expect(r.ok, `${JSON.stringify(bad)} 应被拒绝`).toBe(false)
    }
  })

  it('正常相对路径被接受并规范化', () => {
    expect(validateChangePath('src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' })
    expect(validateChangePath('./src\\A.TS')).toEqual({ ok: true, path: 'src/a.ts' })
  })

  it('变更集里的穿越路径在入口就被拒绝', () => {
    expect(() =>
      validateChangeSetInput({
        changes: [{ path: '../../victim', kind: 'modified', contentHash: 'h' }],
      }),
    ).toThrow(/不合法/)
  })

  it('同一变更集内重复路径被拒绝', () => {
    expect(() =>
      validateChangeSetInput({
        changes: [
          { path: 'a.ts', kind: 'modified', contentHash: 'h1' },
          { path: './a.ts', kind: 'modified', contentHash: 'h2' },
        ],
      }),
    ).toThrow(/重复/)
  })
})

describe('编排器（持久化 + CAS）', () => {
  let dir: string
  let store: Store
  let coord: WorkgroupCoordinator
  let taskId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-wg-'))
    store = new Store(join(dir, 't.db'))
    coord = new WorkgroupCoordinator(store)

    for (const r of [
      { id: 'impl', name: '实现者', responsibility: '做', allowedTools: [], produces: ['implementation'] },
      { id: 'test', name: '测试者', responsibility: '测', allowedTools: [], produces: ['test'] },
    ] as RoleDefinition[]) {
      store.upsertRole(r)
    }

    const s = store.createSession('t')
    taskId = store.createTask({ sessionId: s.id, goal: 'g' }).id
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makePkg(title: string, deps: string[] = [], kind: 'implementation' | 'test' = 'implementation'): WorkPackage {
    return coord.createPackage({
      taskId, id: `p-${title}`, title, kind,
      deliverable: '完成 ' + title, dependsOn: deps,
    })
  }

  it('创建工作包并保留依赖', () => {
    const a = makePkg('a')
    const b = makePkg('b', [a.id])
    expect(a.status).toBe('planned')
    expect(b.dependsOn).toEqual([a.id])
    expect(store.listPackages(taskId)).toHaveLength(2)
  })

  it('依赖不存在时拒绝创建', () => {
    expect(() => makePkg('b', ['nope'])).toThrow(DomainError)
  })

  it('自依赖被拒绝', () => {
    expect(() =>
      coord.createPackage({
        taskId, id: 'self', title: 's', kind: 'implementation',
        deliverable: 'x', dependsOn: ['self'],
      }),
    ).toThrow(DomainError)
  })

  it('角色不能产出其职责外的包类型', () => {
    const p = makePkg('x', [], 'test')
    // test 包必须由 test 角色做
    const r = coord.startPackage({ packageId: p.id, roleId: 'impl' })
    expect(r.ok).toBe(false)
  })

  it('依赖未满足时不能开始', () => {
    const a = makePkg('a')
    const b = makePkg('b', [a.id])
    const r = coord.startPackage({ packageId: b.id, roleId: 'impl' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('依赖')
  })

  it('依赖合并后才能开始', () => {
    const a = makePkg('a')
    coord.refreshReadiness(taskId)
    expect(coord.startPackage({ packageId: a.id, roleId: 'impl' }).ok).toBe(true)

    // 提交并合并 a
    const cs = coord.submitChangeSet({
      id: 'cs-a', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'a.ts', kind: 'added', contentHash: 'h-a' }],
    })
    expect(cs.conflicts).toEqual([])
    expect(coord.mergeChangeSet('cs-a').ok).toBe(true)
    expect(coord.finalizePackage(a.id).ok).toBe(true)

    const b = makePkg('b', [a.id])
    coord.refreshReadiness(taskId)
    expect(coord.startPackage({ packageId: b.id, roleId: 'impl' }).ok).toBe(true)
  })

  it('两个总控同时派同一个包：只有一个成功', () => {
    const p = makePkg('a')
    const first = coord.startPackage({ packageId: p.id, roleId: 'impl' })
    const second = coord.startPackage({ packageId: p.id, roleId: 'impl' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('抢占')
  })

  it('CAS 在并发下不产生两次成功（顺序调用模拟）', () => {
    const p = makePkg('a')
    // 直接对存储层连续 CAS：第二次必须失败
    expect(store.casPackage(p.id, ['planned', 'ready'], 'running', { roleId: 'impl' })).toBe(true)
    expect(store.casPackage(p.id, ['planned', 'ready'], 'running', { roleId: 'impl' })).toBe(false)
  })

  it('变更集归属不匹配被拒绝', () => {
    const p = makePkg('a')
    coord.startPackage({ packageId: p.id, roleId: 'impl' })
    expect(() =>
      coord.submitChangeSet({
        id: 'cs-x', taskId: 'other-task', workPackageId: p.id, roleId: 'impl',
        changes: [{ path: 'a.ts', kind: 'added', contentHash: 'h' }],
      }),
    ).toThrow(/OWNERSHIP_MISMATCH|属于 Task/)
  })

  it('角色不是执行者时变更集被拒绝', () => {
    const p = makePkg('a')
    coord.startPackage({ packageId: p.id, roleId: 'impl' })
    expect(() =>
      coord.submitChangeSet({
        id: 'cs-y', taskId, workPackageId: p.id, roleId: 'test',
        changes: [{ path: 'a.ts', kind: 'added', contentHash: 'h' }],
      }),
    ).toThrow(/OWNERSHIP_MISMATCH|执行/)
  })

  it('未开始的工作包不能提交变更集', () => {
    const p = makePkg('a')
    expect(() =>
      coord.submitChangeSet({
        id: 'cs-z', taskId, workPackageId: p.id, roleId: 'impl',
        changes: [{ path: 'a.ts', kind: 'added', contentHash: 'h' }],
      }),
    ).toThrow(DomainError)
  })

  it('两个工作包改同一文件不同内容 → 第二个变更集标 conflict', () => {
    const a = makePkg('a')
    const b = makePkg('b')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    coord.startPackage({ packageId: b.id, roleId: 'impl' })

    const first = coord.submitChangeSet({
      id: 'cs-1', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'shared.ts', kind: 'modified', contentHash: 'h1' }],
    })
    expect(first.conflicts).toEqual([])

    const second = coord.submitChangeSet({
      id: 'cs-2', taskId, workPackageId: b.id, roleId: 'impl',
      changes: [{ path: 'shared.ts', kind: 'modified', contentHash: 'h2' }],
    })
    expect(second.conflicts).toHaveLength(1)
    expect(second.changeSet.status).toBe('conflict')

    // 有冲突时工作包被标 blocked，避免继续基于未合并版本工作
    expect(store.getPackage(b.id)!.status).toBe('blocked')
    // 但变更集**被保存了**——用户需要看到两边改了什么
    expect(store.getChangeSet('cs-2')).toBeDefined()
  })

  it('内容相同的重叠不阻塞合并', () => {
    const a = makePkg('a')
    const b = makePkg('b')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    coord.startPackage({ packageId: b.id, roleId: 'impl' })

    coord.submitChangeSet({
      id: 'cs-1', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'same.ts', kind: 'modified', contentHash: 'identical' }],
    })
    const second = coord.submitChangeSet({
      id: 'cs-2', taskId, workPackageId: b.id, roleId: 'impl',
      changes: [{ path: 'same.ts', kind: 'modified', contentHash: 'identical' }],
    })
    expect(second.conflicts).toEqual([])
    expect(second.changeSet.status).toBe('submitted')
  })

  it('合并时再次检查冲突：后合并的会被拦下', () => {
    // 场景：两个变更集先在不同时间提交（都通过），然后先后合并。
    // 只在提交时检查会静默覆盖。
    const a = makePkg('a')
    const b = makePkg('b')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    coord.startPackage({ packageId: b.id, roleId: 'impl' })

    // 先让 a 提交并合并
    coord.submitChangeSet({
      id: 'cs-1', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'x.ts', kind: 'modified', contentHash: 'h1' }],
    })
    expect(coord.mergeChangeSet('cs-1').ok).toBe(true)

    // b 的变更集没有在提交时看到 a（因为直接插入了），
    // 模拟「提交时检查通过、合并时才发现」的情况。
    store.insertChangeSet({
      id: 'cs-late', taskId, workPackageId: b.id, roleId: 'impl',
      changes: [{ path: 'x.ts', kind: 'modified', contentHash: 'h2' }],
      status: 'submitted', createdAt: Date.now(),
    })
    const merged = coord.mergeChangeSet('cs-late')
    expect(merged.ok).toBe(false)
    if (!merged.ok) expect(merged.reason).toContain('覆盖')
    // 被拦下的变更集改成 conflict，等待人工处理
    expect(store.getChangeSet('cs-late')!.status).toBe('conflict')
  })

  it('冲突的变更集不能被合并', () => {
    const a = makePkg('a')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    store.insertChangeSet({
      id: 'cs-c', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'x.ts', kind: 'modified', contentHash: 'h' }],
      status: 'conflict', createdAt: Date.now(),
    })
    const r = coord.mergeChangeSet('cs-c')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('冲突')
  })

  it('没有变更集的工作包不能标记 merged', () => {
    const a = makePkg('a')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    const r = coord.finalizePackage(a.id)
    expect(r.ok).toBe(false)
  })

  it('apply 两次合并只会成功一次（CAS）', () => {
    const a = makePkg('a')
    coord.startPackage({ packageId: a.id, roleId: 'impl' })
    coord.submitChangeSet({
      id: 'cs-1', taskId, workPackageId: a.id, roleId: 'impl',
      changes: [{ path: 'a.ts', kind: 'added', contentHash: 'h' }],
    })
    expect(coord.mergeChangeSet('cs-1').ok).toBe(true)
    const again = coord.mergeChangeSet('cs-1')
    expect(again.ok).toBe(false)
  })

  it('角色写入是幂等 upsert', () => {
    store.upsertRole({ id: 'impl', name: '改名', responsibility: '做', allowedTools: [], produces: ['implementation'] })
    expect(store.getRole('impl')!.name).toBe('改名')
    expect(store.listRoles()).toHaveLength(2)
  })
})
