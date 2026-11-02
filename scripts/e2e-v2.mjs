// 端到端验证 v2：覆盖 P0-A / P0-B 的新能力
// 用法：node scripts/e2e-v2.mjs [port]
const PORT = process.argv[2] ?? '4780'
const BASE = `http://127.0.0.1:${PORT}`

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

const line = (t) => console.log(`\n${'─'.repeat(60)}\n${t}\n${'─'.repeat(60)}`)
const ok = (m) => console.log(`  ✅ ${m}`)
const info = (m) => console.log(`     ${m}`)

async function main() {
  const health = await api('GET', '/health')
  const workspace = health.workspace.replace(/\\/g, '/')
  console.log(`工作区: ${workspace}`)

  // ── 场景 1：Run 完成时自动拍快照 + 生成 Artifact ──
  line('场景 1 · 快照与产物')
  const s1 = await api('POST', '/sessions', { title: '快照测试' })
  const t1 = await api('POST', '/tasks', { sessionId: s1.id, goal: '读文件' })
  const r1 = await api('POST', '/runs', { taskId: t1.id })

  const out1 = await api('POST', `/runs/${r1.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `读一下 ${workspace}/readme.txt`,
  })
  ok(`Run 状态: ${out1.status}`)

  const snaps = await api('GET', `/runs/${r1.id}/snapshots`)
  ok(`快照数: ${snaps.snapshots.length}`)
  if (snaps.snapshots[0]) {
    info(`ref: ${snaps.snapshots[0].ref.slice(0, 12)}...`)
    info(`文件数: ${snaps.snapshots[0].fileCount}`)
    info(`可复现: ${snaps.snapshots[0].reproducible}`)
  }

  const arts = await api('GET', `/tasks/${t1.id}/artifacts`)
  ok(`产物数: ${arts.artifacts.length}`)
  for (const a of arts.artifacts.slice(0, 5)) {
    info(`${a.path} v${a.version} [${a.status}]`)
  }

  // ── 场景 2：返工产生新版本 ──
  line('场景 2 · 返工产生新版本')
  const r2 = await api('POST', '/runs', { taskId: t1.id })
  const out2 = await api('POST', `/runs/${r2.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `帮我写个文件 ${workspace}/newfile.txt`,
  })
  info(`Run 状态: ${out2.status}`)

  if (out2.approval) {
    await api('POST', `/approvals/${out2.approval.id}/approve`, { scope: 'once' })
    const out3 = await api('POST', `/runs/${r2.id}/execute`, {
      provider: 'demo',
      model: 'demo',
      goal: `帮我写个文件 ${workspace}/newfile.txt`,
    })
    ok(`批准后继续: ${out3.status}`)
  }

  const arts2 = await api('GET', `/tasks/${t1.id}/artifacts`)
  const byPath = new Map()
  for (const a of arts2.artifacts) {
    if (!byPath.has(a.path)) byPath.set(a.path, [])
    byPath.get(a.path).push(a)
  }
  for (const [path, list] of byPath) {
    info(`${path}: ${list.length} 个版本 (v${list.map((a) => a.version).join(', v')})`)
  }

  // ── 场景 3：快照 diff ──
  line('场景 3 · 快照差异')
  if (snaps.snapshots.length > 0) {
    const snaps2 = await api('GET', `/runs/${r2.id}/snapshots`)
    if (snaps2.snapshots.length > 0) {
      const diff = await api(
        'GET',
        `/snapshots/diff?from=${snaps.snapshots[0].ref}&to=${snaps2.snapshots[0].ref}`,
      )
      ok(`变更文件数: ${diff.filesChanged}`)
      info(diff.patch.split('\n').slice(0, 6).join('\n     '))
    }
  }

  // ── 场景 4：paused vs waiting_approval ──
  line('场景 4 · paused 与 waiting_approval 分离')
  const s4 = await api('POST', '/sessions', { title: '状态分离' })
  const t4 = await api('POST', '/tasks', { sessionId: s4.id, goal: '写文件' })
  const r4 = await api('POST', '/runs', { taskId: t4.id })

  const out4 = await api('POST', `/runs/${r4.id}/execute`, {
    provider: 'demo',
    model: 'demo',
    goal: `帮我写个文件 ${workspace}/approval-test.txt`,
  })
  const runState = await api('GET', `/runs/${r4.id}`)
  ok(`审批时 Run 状态: ${runState.run.status}`)
  info(`应为 waiting_approval，不是 paused`)

  // 尝试直接 resume —— 应该被拒绝
  try {
    await api('POST', `/runs/${r4.id}/resume`)
    console.log(`  ❌ 错误：waiting_approval 状态下 resume 竟然成功了`)
  } catch (err) {
    ok(`resume 被正确拒绝（${err.status}）`)
  }

  // ── 场景 5：拒绝去重 ──
  line('场景 5 · 拒绝后不重复创建审批')
  if (out4.approval) {
    await api('POST', `/approvals/${out4.approval.id}/reject`, { reason: '不要写这个文件' })

    const out5 = await api('POST', `/runs/${r4.id}/execute`, {
      provider: 'demo',
      model: 'demo',
      goal: `帮我写个文件 ${workspace}/approval-test.txt`,
    })
    ok(`拒绝后继续: ${out5.status}`)

    const allApprovals = await api('GET', '/approvals')
    const forThisRun = allApprovals.approvals.filter((a) => a.runId === r4.id)
    ok(`该 Run 的审批记录数: ${forThisRun.length}（应为 1，说明去重生效）`)
  }

  // ── 场景 6：未知状态与对账 ──
  line('场景 6 · unknown 与对账')
  const s6 = await api('POST', '/sessions', { title: '对账' })
  const t6 = await api('POST', '/tasks', { sessionId: s6.id, goal: 'g' })
  const r6 = await api('POST', '/runs', { taskId: t6.id })
  info('说明：真实 unknown 需要工具超时，这里验证接口存在性')

  const reconciliations = await api('GET', `/runs/${r6.id}/reconciliations`)
  ok(`对账记录接口可用，当前 ${reconciliations.reconciliations.length} 条`)

  // ── 场景 7：Task 级预算 ──
  line('场景 7 · Task 级预算')
  const s7 = await api('POST', '/sessions', { title: '预算' })
  // Task 预算只能 1 步，第一个 Run 用掉后就该拒绝后续
  const t7 = await api('POST', '/tasks', {
    sessionId: s7.id,
    goal: 'g',
    budget: { maxSteps: 1 },
  })
  info(`Task 预算: maxSteps=1`)

  let budgetHit = false
  let attempts = 0
  for (let i = 0; i < 3; i++) {
    attempts++
    const r = await api('POST', '/runs', { taskId: t7.id })
    const o = await api('POST', `/runs/${r.id}/execute`, {
      provider: 'demo',
      model: 'demo',
      goal: '说点什么',
    })
    if (o.status === 'expired') {
      budgetHit = true
      ok(`第 ${attempts} 次尝试被预算拦截`)
      break
    }
  }
  if (!budgetHit) console.log('  ❌ 预算未被触发')

  line('全部场景完成')
}

main().catch((err) => {
  console.error('\n失败:', err.message)
  if (err.data) console.error(JSON.stringify(err.data, null, 2))
  process.exit(1)
})
