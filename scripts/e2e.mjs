// 端到端验证脚本。用 Node 直接发请求，避免 Windows 控制台编码问题。
// 用法：node scripts/e2e.mjs [port]
const PORT = process.argv[2] ?? '4783'
const BASE = `http://127.0.0.1:${PORT}`

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return JSON.parse(text)
}

function line(title) {
  console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`)
}

async function main() {
  const health = await api('GET', '/health')
  console.log('工作区:', health.workspace)

  const workspace = health.workspace.replace(/\\/g, '/')

  // ── 场景 1：读文件（只读工具，自动放行） ─────────────────
  line('场景 1 · 读文件（自动放行）')
  const s1 = await api('POST', '/sessions', { title: '读文件' })
  const t1 = await api('POST', '/tasks', { sessionId: s1.id, goal: '读一下 readme.txt' })
  const r1 = await api('POST', '/runs', { taskId: t1.id })

  const out1 = await api('POST', `/runs/${r1.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `读一下 ${workspace}/readme.txt`,
  })
  console.log('Run 状态:', out1.status)
  console.log('步骤:', out1.steps.map((s) => `${s.kind}:${s.status}`).join(' → '))
  console.log('回复:', (out1.text ?? '').split('\n').slice(0, 5).join(' '))

  // ── 场景 2：写文件（触发审批） ───────────────────────────
  line('场景 2 · 写文件（触发审批）')
  const s2 = await api('POST', '/sessions', { title: '写文件' })
  const t2 = await api('POST', '/tasks', { sessionId: s2.id, goal: '写一个文件' })
  const r2 = await api('POST', '/runs', { taskId: t2.id })

  const out2 = await api('POST', `/runs/${r2.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `帮我写个文件 ${workspace}/out.txt`,
  })
  console.log('Run 状态:', out2.status)
  console.log('审批:', out2.approval ? `${out2.approval.toolId} (${out2.approval.id})` : '无')

  if (out2.approval) {
    // ── 场景 3：批准并继续执行 ───────────────────────────
    line('场景 3 · 批准审批并继续执行')
    await api('POST', `/approvals/${out2.approval.id}/approve`, { scope: 'once' })
    console.log('已批准')

    const out3 = await api('POST', `/runs/${r2.id}/execute`, {
      provider: 'demo',
      model: 'demo',
      goal: `帮我写个文件 ${workspace}/out.txt`,
    })
    console.log('继续后状态:', out3.status)
    console.log('步骤:', out3.steps.map((s) => `${s.kind}:${s.status}`).join(' → '))
    console.log('回复:', (out3.text ?? '').split('\n').slice(0, 4).join(' '))
  }

  // ── 场景 4：拒绝审批 ─────────────────────────────────────
  line('场景 4 · 拒绝审批')
  const s4 = await api('POST', '/sessions', { title: '拒绝测试' })
  const t4 = await api('POST', '/tasks', { sessionId: s4.id, goal: '写文件' })
  const r4 = await api('POST', '/runs', { taskId: t4.id })
  const out4 = await api('POST', `/runs/${r4.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `帮我写个文件 ${workspace}/rejected.txt`,
  })

  if (out4.approval) {
    await api('POST', `/approvals/${out4.approval.id}/reject`, { reason: '不要写这个文件' })
    console.log('已拒绝')

    const out5 = await api('POST', `/runs/${r4.id}/execute`, {
      provider: 'demo',
      model: 'demo',
      goal: `帮我写个文件 ${workspace}/rejected.txt`,
    })
    console.log('继续后状态:', out5.status)
    console.log('步骤:', out5.steps.map((s) => `${s.kind}:${s.status}`).join(' → '))
    console.log('回复:', (out5.text ?? '').split('\n').slice(0, 4).join(' '))

    const approvals = await api('GET', '/approvals')
    const forThisRun = approvals.approvals.filter((a) => a.runId === r4.id)
    console.log(`该 Run 的审批记录数: ${forThisRun.length}（应为 1，说明去重生效）`)
  }

  // ── 场景 5：Trace 与用量 ─────────────────────────────────
  line('场景 5 · Trace 与用量')
  const detail = await api('GET', `/runs/${r1.id}`)
  console.log('Run 用量:', JSON.stringify(detail.run.usage))
  console.log('事件流:')
  for (const e of detail.events) console.log(`  ${e.kind}`)
  console.log('工具 Step 的 Trace:')
  const toolStep = detail.steps.find((s) => s.kind === 'tool')
  if (toolStep) console.log(' ', JSON.stringify(toolStep.trace))

  line('完成')
}

main().catch((err) => {
  console.error('失败:', err.message)
  process.exit(1)
})
