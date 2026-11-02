// 桌面壳的静态资源。
//
// 设计约束（来自 ROADMAP）：
//   **UI 只能消费后端契约，不能重新实现权限、审批或状态机。**
//
// 这条约束在代码里的体现：
//   · 状态显示的文字由 `/ui/bootstrap` 给的 stateMachines 决定，
//     前端不写「waiting_approval = 等待审批」这类映射
//   · 按钮是否显示由 bootstrap 的 permissions 决定，
//     前端不写「用户不能批准自己的」这类规则
//   · 审批通过 / 拒绝调用后端接口，前端不判断能不能批
//   · 所有错误直接展示后端给的 code / message / correlationId，
//     前端不翻译错误
//
// 为什么用单文件内联 HTML/JS 而不是构建链：
//   这一层是**壳**，不是应用框架。引入 bundler 会带来构建产物、
//   版本对齐、sourcemap 泄漏面，而收益只是一个更舒服的写代码体验。
//   等 UI 复杂到需要组件化时再拆，那时拆分边界也更清楚。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface StaticAsset {
  contentType: string
  body: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 解析静态资源请求。
 *
 * 安全要点：
 *   · 只允许白名单内的文件名（不接受任意路径）
 *   · 不拼接用户输入到文件路径——目录穿越在这一层就断掉
 *   · 返回 undefined 表示「这个路径不是静态资源」，交给路由层
 */
export function resolveStaticAsset(uiDir: string, pathname: string): StaticAsset | undefined {
  const name = STATIC_FILES[pathname]
  if (!name) return undefined

  const file = join(uiDir, name)
  if (!existsSync(file)) return undefined

  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  return {
    contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
    body: readFileSync(file, 'utf8'),
  }
}

/**
 * 白名单：URL 路径 → 文件名。
 *
 * 用显式映射而不是「把 pathname 拼到 uiDir 下面」：
 * 拼接需要做规范化、大小写处理、UNC 判断……
 * 而这一层的全部需求只是「三个文件」，白名单最不容易出错。
 */
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
}

export function staticFileNames(): string[] {
  return [...new Set(Object.values(STATIC_FILES))]
}
