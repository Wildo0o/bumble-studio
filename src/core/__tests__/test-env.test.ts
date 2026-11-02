// 测试环境隔离工具自身的测试。
//
// 为什么要测「测试工具」：这个模块的存在就是为了让别的测试可靠。
// 如果它有 bug（比如恢复时丢掉变量、或对某个 key 名拼错），
// 那些依赖它的测试会**以难以察觉的方式**变绿或变红。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateProviderEnv, providerKeyEnvNames } from './test-env.js'
import { SecretStore, envKeyName } from '../provider-config.js'

describe('provider 环境变量隔离', () => {
  const restores: Array<() => void> = []

  afterEach(() => {
    // 无论测试怎么失败，都要把环境恢复干净。
    for (const r of restores.splice(0)) r()
  })

  it('受管清单覆盖所有已知 provider 的 env 名', () => {
    const managed = new Set(providerKeyEnvNames())
    for (const preset of ['openai', 'anthropic', 'deepseek', 'openrouter', 'gemini', 'ollama', 'lmstudio', 'demo']) {
      expect(managed.has(envKeyName(preset)), `${preset} 的 env 名未纳入隔离清单`).toBe(true)
    }
  })

  it('清空后 SecretStore.has 返回 false（不受本机真实密钥影响）', () => {
    process.env.ANTHROPIC_API_KEY = 'real-key-on-this-machine'
    const restore = isolateProviderEnv()
    restores.push(restore)

    const dir = mkdtempSync(join(tmpdir(), 'iso-'))
    try {
      const store = new SecretStore(join(dir, 'secrets.json'))
      // 这就是审计发现的失败点：不清空时这里会是 true
      expect(store.has('anthropic')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('恢复时还原**原来的值**，而不是简单地删除', () => {
    process.env.OPENAI_API_KEY = 'original-value'
    const restore = isolateProviderEnv()

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    restore()

    // 关键：恢复的是原值，不是「删掉」
    expect(process.env.OPENAI_API_KEY).toBe('original-value')
  })

  it('原来没有值时，恢复后也不留下空字符串', () => {
    delete process.env.GEMINI_API_KEY
    const restore = isolateProviderEnv()
    restore()
    // 不能变成 ''：很多代码用 `if (process.env.X)` 判断，
    // 空字符串与 undefined 在语义上都算「没有」，但混用会让人困惑。
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })

  it('可嵌套：内外两层各自恢复自己的快照', () => {
    process.env.DEEPSEEK_API_KEY = 'outer'
    const restoreOuter = isolateProviderEnv()

    process.env.DEEPSEEK_API_KEY = 'inner'
    const restoreInner = isolateProviderEnv()
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined()

    restoreInner()
    expect(process.env.DEEPSEEK_API_KEY).toBe('inner')

    restoreOuter()
    expect(process.env.DEEPSEEK_API_KEY).toBe('outer')
  })
})
