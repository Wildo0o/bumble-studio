// 会话壳（区块 4）。
//
// 投影规则的重点是「不给用户看内部细节」：
//   · system prompt 不能出现在会话里
//   · 工具结果要截断
//   · 工具参数只留摘要
// 活动流重点是「用户能知道它在等我什么」。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import {
  MAX_TOOL_RESULT_PREVIEW,
  deriveConversationStatus,
  projectRunMessage,
  safeAttachmentName,
  summarizeEvent,
  validateAttachmentMeta,
} from '../conversation.js'

const meta = { runId: 'r1', seq: 3, createdAt: 1000 }

describe('run_message → message 投影', () => {
  it('system 消息不投影（那是给模型的指令）', () => {
    expect(projectRunMessage({ role: 'system', content: '你是个助手' }, meta)).toBeUndefined()
  })

  it('用户与助手消息原样保留', () => {
    const u = projectRunMessage({ role: 'user', content: '帮我改文件' }, meta)
    expect(u?.role).toBe('user')
    expect(u?.content).toBe('帮我改文件')
    expect(u?.source).toBe('run')
    expect(u?.id).toBe('run:r1:3')

    const a = projectRunMessage({ role: 'assistant', content: '好的' }, meta)
    expect(a?.role).toBe('assistant')
  })

  it('空的助手消息（无内容、无工具调用）被跳过', () => {
    expect(projectRunMessage({ role: 'assistant', content: '   ' }, meta)).toBeUndefined()
  })

  it('工具调用只保留名字与参数摘要', () => {
    const bigContent = 'x'.repeat(500)
    const p = projectRunMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.md', content: bigContent }) },
        ],
      },
      meta,
    )
    expect(p?.role).toBe('assistant')
    expect(p?.toolCalls).toHaveLength(1)
    expect(p?.toolCalls![0]!.name).toBe('write_file')
    // 摘要被截断，不含完整内容
    expect(p!.toolCalls![0]!.summary.length).toBeLessThan(200)
    expect(p!.toolCalls![0]!.summary).not.toContain(bigContent)
  })

  it('工具结果被截断，并注明总长度', () => {
    const long = 'y'.repeat(MAX_TOOL_RESULT_PREVIEW + 500)
    const p = projectRunMessage({ role: 'tool', toolCallId: 'c1', content: long }, meta)
    expect(p?.role).toBe('tool')
    expect(p!.content.length).toBeLessThan(long.length)
    expect(p!.content).toContain('已截断')
    expect(p!.content).toContain(String(long.length))
  })

  it('空工具结果被跳过（避免空白气泡）', () => {
    expect(projectRunMessage({ role: 'tool', toolCallId: 'c1', content: '' }, meta)).toBeUndefined()
  })

  it('非法输入不会抛错', () => {
    expect(projectRunMessage(null, meta)).toBeUndefined()
    expect(projectRunMessage('not-an-object', meta)).toBeUndefined()
    expect(projectRunMessage({ role: 'unknown-role', content: 'x' }, meta)).toBeUndefined()
  })
})

describe('活动流摘要', () => {
  it('已知事件给中文短句', () => {
    expect(summarizeEvent('run.started', {}).summary).toBe('开始执行')
    expect(summarizeEvent('approval.expired', {}).summary).toContain('自动拒绝')
    expect(summarizeEvent('run.blocked_by_unknown', {}).summary).toContain('对账')
  })

  it('工具事件带工具名', () => {
    expect(summarizeEvent('tool.done', { toolName: 'write_file' }).summary).toContain('write_file')
    expect(summarizeEvent('tool.unknown', { toolName: 'send_email' }).summary).toContain('send_email')
  })

  it('未知 kind 用原文展示，不隐藏', () => {
    const r = summarizeEvent('future.new_event', {})
    expect(r.summary).toBe('future.new_event')
  })

  it('提取引用 id 便于 UI 跳转', () => {
    const r = summarizeEvent('approval.approved', { approvalId: 'ap1', taskId: 't1' })
    expect(r.refs.approvalId).toBe('ap1')
    expect(r.refs.taskId).toBe('t1')
  })
})

describe('会话状态推导', () => {
  it('没有 Run → idle', () => {
    expect(deriveConversationStatus([])).toBe('idle')
  })

  it('等待审批优先级最高', () => {
    expect(
      deriveConversationStatus([{ status: 'running' }, { status: 'waiting_approval' }]),
    ).toBe('waiting_approval')
  })

  it('等待对账高于运行中', () => {
    expect(
      deriveConversationStatus([{ status: 'running' }, { status: 'needs_reconciliation' }]),
    ).toBe('waiting_reconciliation')
  })

  it('全部结束 → 失败优先于空闲', () => {
    expect(deriveConversationStatus([{ status: 'completed' }, { status: 'failed' }])).toBe('failed')
    expect(deriveConversationStatus([{ status: 'completed' }])).toBe('idle')
  })

  it('运行中 / 排队 / 审计中 / 暂停都算 running', () => {
    for (const s of ['running', 'queued', 'auditing', 'paused']) {
      expect(deriveConversationStatus([{ status: s }])).toBe('running')
    }
  })
})

describe('附件', () => {
  it('文件名被安全化：去掉路径成分与控制字符', () => {
    expect(safeAttachmentName('../../etc/passwd')).not.toContain('..')
    expect(safeAttachmentName('..\\..\\windows\\x')).not.toContain('..')
    expect(safeAttachmentName('a\u0000b<c>.txt')).toBe('a_b_c_.txt')
  })

  it('文件名不会变成空字符串', () => {
    expect(safeAttachmentName('')).toBe('attachment')
    expect(safeAttachmentName('   ')).toBe('attachment')
  })

  it('超长文件名被截断', () => {
    expect(safeAttachmentName('a'.repeat(500)).length).toBeLessThanOrEqual(200)
  })

  it('非法大小被拒绝', () => {
    expect(() => validateAttachmentMeta({ name: 'a', bytes: 0 })).toThrow(/正数/)
    expect(() => validateAttachmentMeta({ name: 'a', bytes: -1 })).toThrow(/正数/)
    expect(() => validateAttachmentMeta({ name: 'a', bytes: NaN })).toThrow(/正数/)
  })

  it('超过上限被拒绝', () => {
    expect(() =>
      validateAttachmentMeta({ name: 'a', bytes: 21 * 1024 * 1024 }),
    ).toThrow(/上限/)
  })

  it('缺省 mimeType 用 octet-stream', () => {
    expect(validateAttachmentMeta({ name: 'a', bytes: 10 }).mimeType).toBe('application/octet-stream')
  })
})

describe('会话持久化', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-conv-'))
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('会话按最近活动排序，而不是创建时间', () => {
    const a = store.createSession('先建的')
    const b = store.createSession('后建的')
    // 给 a 追加消息 → a 变成最近活动的
    store.appendMessage({ id: 'm1', sessionId: a.id, role: 'user', content: 'hi' })
    const list = store.listSessions()
    expect(list[0]!.id).toBe(a.id)
    expect(list[1]!.id).toBe(b.id)
  })

  it('归档的会话默认不出现，可显式取回', () => {
    const s = store.createSession('要归档的')
    store.archiveSession(s.id, true)
    expect(store.listSessions().some((x) => x.id === s.id)).toBe(false)
    expect(store.listSessions({ includeArchived: true }).some((x) => x.id === s.id)).toBe(true)
    // 归档不删消息
    store.appendMessage({ id: 'm2', sessionId: s.id, role: 'user', content: 'still here' })
    expect(store.listMessages(s.id)).toHaveLength(1)
  })

  it('取消归档后重新出现', () => {
    const s = store.createSession('x')
    store.archiveSession(s.id, true)
    store.archiveSession(s.id, false)
    expect(store.listSessions().some((x) => x.id === s.id)).toBe(true)
  })

  it('附件元信息持久化，内容不落库', () => {
    const s = store.createSession('t')
    const att = store.createAttachment({
      sessionId: s.id,
      name: 'a.txt',
      mimeType: 'text/plain',
      bytes: 12,
      storagePath: '/tmp/x',
      contentHash: 'abc',
    })
    const list = store.listAttachments(s.id)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(att.id)
    // 只有元信息，没有内容字段
    expect(Object.keys(list[0]!)).not.toContain('data')
    expect(Object.keys(list[0]!)).not.toContain('content')
  })

  it('附件软删除后不出现在列表里', () => {
    const s = store.createSession('t')
    const att = store.createAttachment({
      sessionId: s.id, name: 'a', mimeType: 'text/plain', bytes: 1,
      storagePath: '/tmp/x', contentHash: 'h',
    })
    store.deleteAttachment(att.id)
    expect(store.listAttachments(s.id)).toHaveLength(0)
    expect(store.getAttachment(att.id)?.deletedAt).toBeTypeOf('number')
  })

  it('listRunMessagesWithMeta 保留 seq 与时间戳（投影需要稳定 id）', () => {
    const s = store.createSession('t')
    const task = store.createTask({ sessionId: s.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })
    store.appendRunMessage(run.id, { role: 'assistant', content: 'a' })
    store.appendRunMessage(run.id, { role: 'assistant', content: 'b' })

    const withMeta = store.listRunMessagesWithMeta(run.id)
    expect(withMeta.map((m) => m.seq)).toEqual([0, 1])
    expect(withMeta.every((m) => typeof m.createdAt === 'number')).toBe(true)
  })
})
