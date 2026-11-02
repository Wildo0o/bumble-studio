// 测试环境隔离工具。
//
// 为什么需要它：有一类测试失败**只在全量运行时出现**，
// 因为它们在读真实的进程环境变量。
//
// 典型例子：SecretStore.get() 环境变量优先于文件。
// 如果开发者本机有 ANTHROPIC_API_KEY，那么
// `expect(store.has('anthropic')).toBe(false)` 就会失败——
// 代码是对的，测试却在说代码错了。
//
// 这种测试比没有测试更糟：它教人忽略红色。
//
// 所以凡是读 process.env 的模块，测试必须：
//   1. 进入前把相关变量「标记为受控」并清空
//   2. 退出时**精确恢复**原来是否有值、原来是什么值
//   3. 支持嵌套（多个 describe 各自清空同一个变量）

/** 所有 provider 的密钥环境变量名。与 provider-config 的 envKeyName 同构。 */
const PROVIDER_KEY_ENVS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'OLLAMA_API_KEY',
  'LMSTUDIO_API_KEY',
  'DEMO_API_KEY',
]

/**
 * 清空所有 provider 密钥环境变量，返回恢复函数。
 *
 * 必须在 finally / afterEach 里调用恢复函数——否则后续测试
 * 会看到一个被别的测试改过的环境。
 */
export function isolateProviderEnv(): () => void {
  const saved = new Map<string, string | undefined>()
  for (const key of PROVIDER_KEY_ENVS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 全部受管的环境变量名（测试可以断言清单完整）。 */
export function providerKeyEnvNames(): string[] {
  return [...PROVIDER_KEY_ENVS]
}
