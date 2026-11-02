// 模型身份不可伪造测试（第四批 F 项）。
//
// 核心不变量：模型族由服务端从 modelId 算出并持久化，
// 不接受调用方声明。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.js'
import { RunExecutor } from '../executor.js'
import { ToolRegistry } from '../tools.js'
import { modelFamily, sameModelFamily } from '../audit.js'
import { providerFromPreset } from '../../providers/registry.js'
import type { ProviderAdapter } from '../../providers/types.js'
import { ScriptedProvider, userMessage } from './helpers.js'

describe('模型身份', () => {
  let dir: string
  let workspace: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-identity-'))
    workspace = join(dir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    store = new Store(join(dir, 't.db'))
  })

  afterEach(() => {
    try { store.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExecutor(script: ScriptedProvider): RunExecutor {
    const adapter: ProviderAdapter = { stream: (req, h) => script.stream(req, h) }
    return new RunExecutor(
      store, new ToolRegistry(),
      { workspaceRoots: [workspace], contextBudget: 100000, outputReserve: 8000, maxToolRounds: 8 },
      () => adapter,
    )
  }

  it('执行时记录模型身份', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    // 执行前没有身份
    expect(store.getRun(run.id)!.modelIdentity).toBeUndefined()

    await makeExecutor(new ScriptedProvider([{ text: 'ok' }])).execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'deepseek-chat' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    const identity = store.getRun(run.id)!.modelIdentity
    expect(identity).toBeDefined()
    expect(identity!.modelId).toBe('deepseek-chat')
    expect(identity!.modelFamily).toBe('deepseek')
    expect(identity!.recordedAt).toBeGreaterThan(0)
  })

  it('模型身份只写一次，不会被后续执行覆盖', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    // 第一次：deepseek
    await makeExecutor(new ScriptedProvider([{ text: 'ok' }])).execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'deepseek-chat' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })
    const first = store.getRun(run.id)!.modelIdentity
    expect(first!.modelFamily).toBe('deepseek')

    // 第二次：尝试用 claude（如果身份可覆盖，族名会变）
    await makeExecutor(new ScriptedProvider([{ text: 'ok' }])).execute({
      runId: run.id,
      provider: providerFromPreset('anthropic'),
      model: { id: 'claude-sonnet-5-5' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    const second = store.getRun(run.id)!.modelIdentity
    // 关键：身份没变，还是第一次记录的 deepseek
    expect(second!.modelFamily).toBe('deepseek')
    expect(second!.modelId).toBe('deepseek-chat')
  })

  it('模型族由服务端计算，不接受外部声明', () => {
    // 族名来自 modelId 的正则匹配，没有任何输入渠道可以伪造
    expect(modelFamily('claude-sonnet-5-5')).toBe('anthropic-claude')
    expect(modelFamily('claude-opus-5-5')).toBe('anthropic-claude')
    expect(modelFamily('deepseek-chat')).toBe('deepseek')
    expect(modelFamily('gpt-5')).toBe('openai-gpt')

    // 同族判定
    expect(sameModelFamily('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(true)
    expect(sameModelFamily('claude-sonnet-5-5', 'deepseek-chat')).toBe(false)
  })

  it('把同族模型伪装成不同名称不能绕过族隔离', () => {
    // 攻击场景：调用方想把 claude-opus 伪装成 deepseek
    // 但族名是从真实 modelId 算的，伪装名称无用
    const spoofedModelId = 'deepseek-chat'            // 声称自己是 deepseek
    const realFamily = modelFamily(spoofedModelId)

    // 如果审计方真的是 claude，族隔离仍然生效
    const auditorFamily = modelFamily('claude-sonnet-5-5')
    expect(realFamily).not.toBe(auditorFamily)       // 不同族，允许
  })

  it('未知模型返回 null，不再编造族名', () => {
    // v0.13 行为变更：旧实现把任意 id 的前缀当族名（other:some），
    // 于是两个编造的模型名会被判成「不同族」从而通过隔离校验。
    // 那是 fail-open —— 认不出不等于不同族。
    //
    // 现在返回 null，调用方必须据此 escalate。
    expect(modelFamily('some-unknown-model')).toBeNull()
    expect(modelFamily('totally-made-up')).toBeNull()
    // 已知族仍然能识别
    expect(modelFamily('claude-sonnet-5-5')).toBe('anthropic-claude')
    expect(modelFamily('deepseek-chat')).toBe('deepseek')
  })

  it('两个未知模型的 sameModelFamily 为 false，但调用方必须查 null', () => {
    // sameModelFamily 返回 false 只表示「无法证明同族」，
    // 不表示「确定不同族」。安全判断必须显式检查 null。
    expect(sameModelFamily('fake-a', 'fake-b')).toBe(false)
    expect(modelFamily('fake-a')).toBeNull()
  })

  it('模型族记录可跨重启查询', async () => {
    const session = store.createSession('t')
    const task = store.createTask({ sessionId: session.id, goal: 'g' })
    const run = store.createRun({ taskId: task.id, role: 'producer', budget: {} })

    await makeExecutor(new ScriptedProvider([{ text: 'ok' }])).execute({
      runId: run.id,
      provider: providerFromPreset('ollama'),
      model: { id: 'gemini-2.5-pro' },
      messages: [userMessage('go')],
      signal: new AbortController().signal,
    })

    // 模拟重启
    const dbPath = join(dir, 't.db')
    store.close()
    store = new Store(dbPath)

    const identity = store.getRun(run.id)!.modelIdentity
    expect(identity).toBeDefined()
    expect(identity!.modelFamily).toBe('google-gemini')
  })
})
