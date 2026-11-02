// Vitest 配置。
//
// testTimeout 提高的原因：
//   审计 / 快照相关用例会真实调用 git 与多层存储，单个用例本来就
//   需要 2–5 秒。默认的 5 秒在**全量并行**时会因为磁盘与 CPU 竞争
//   偶尔超时——那不是逻辑错误，而是资源等待。
//
//   把超时调高是诚实的做法：失败必须代表「行为不对」，
//   而不是「这台机器这一次慢了」。如果某个用例真的变成了死循环，
//   20 秒仍然会把它抓出来。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
