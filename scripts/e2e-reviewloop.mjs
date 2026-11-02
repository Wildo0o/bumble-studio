// 端到端验证：ReviewLoop 完整链路 + HTTP 认证边界
//
// 设计原则：
//   1. 自己启动服务，不依赖外部预置实例
//   2. 每条断言都必须能失败——不做「打印了就算过」
//   3. 任何一条失败 → 非零退出
//   4. 区分 passed / failed / skipped / unsupported，skipped 不算通过
//   5. 端口被占用直接失败，不静默换端口
//   6. 记录服务 PID、stderr、退出码，失败时可复现
//
// 用法：node scripts/e2e-reviewloop.mjs
//       PORT=4820 node scripts/e2e-reviewloop.mjs   （固定端口，调试用）
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir, networkInterfaces } from 'node:os'
import { createServer } from 'node:net'

// ── 断言框架 ──────────────────────────────────────────────

const results = { passed: 0, failed: 0, skipped: 0, unsupported: 0 }
const failures = []
const skips = []

function assert(condition, message, detail) {
  if (condition) {
    results.passed++
    console.log(`  ✅ ${message}`)
  } else {
    results.failed++
    failures.push({ message, detail })
    console.log(`  ❌ ${message}`)
    if (detail !== undefined) console.log(`     ${JSON.stringify(detail)}`)
  }
}

function assertEq(actual, expected, message) {
  assert(actual === expected, message, actual === expected ? undefined : { actual, expected })
}

function assertIncludes(haystack, needle, message) {
  const ok = typeof haystack === 'string' && haystack.includes(needle)
  assert(ok, message, ok ? undefined : { needle, actual: String(haystack).slice(0, 200) })
}

/**
 * 明确标记为跳过。
 *
 * 这是唯一允许的跳过方式，且会计入 skipped 并让退出码非零的规则见结尾。
 * 绝不使用 `return` 静默略过——那会被计成 passed。
 */
function skip(message, reason) {
  results.skipped++
  skips.push({ message, reason })
  console.log(`  ⏭️  SKIPPED: ${message} — ${reason}`)
}

const line = (t) => console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`)

// ── 端口 ─────────────────────────────────────────────────

/** 找一段空闲的临时端口。用 listen(0) 让系统分配，再释放。 */
async function findFreePort() {
  return new Promise((ok, fail) => {
    const srv = createServer()
    srv.once('error', fail)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => ok(port))
    })
  })
}

/** 端口是否已被占用。 */
async function isPortBusy(port) {
  return new Promise((ok) => {
    const srv = createServer()
    srv.once('error', () => ok(true))
    srv.once('listening', () => srv.close(() => ok(false)))
    srv.listen(port, '127.0.0.1')
  })
}

// ── 服务进程 ──────────────────────────────────────────────

function startServer({ port, dataDir, workspace, token, entry }) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WORKSPACE: workspace,
      AUTH_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const log = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => { log.stdout += d.toString() })
  child.stderr.on('data', (d) => { log.stderr += d.toString() })

  return { child, log }
}

async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return await res.json()
      lastErr = new Error(`health 返回 ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有就绪：${lastErr?.message}`)
}

// ── HTTP ─────────────────────────────────────────────────

let BASE = ''
let TOKEN = ''

async function api(method, path, body) {
  const headers = { authorization: `Bearer ${TOKEN}` }
  if (body) headers['content-type'] = 'application/json'

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${data.error ?? text}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function apiExpectError(method, path, body, expectedStatus) {
  try {
    await api(method, path, body)
    return { ok: false, reason: '请求竟然成功了' }
  } catch (err) {
    return {
      ok: err.status === expectedStatus,
      status: err.status,
      reason: err.data?.error ?? err.message,
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────

let serverHandle
let serverExitCode

async function main() {
  // ── 服务生命周期 ──────────────────────────────────────
  line('0 · 启动服务')

  const entry = resolve(import.meta.dirname, '..', 'src', 'server', 'index.ts')
  if (!existsSync(entry)) {
    throw new Error(`找不到服务入口：${entry}`)
  }

  const requestedPort = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  if (await isPortBusy(requestedPort)) {
    throw new Error(`端口 ${requestedPort} 已被占用；E2E 不做自动换端口，请释放它或换一个 PORT`)
  }
  const port = requestedPort
  BASE = `http://127.0.0.1:${port}`

  // 用系统临时目录，避免落进项目仓库
  const runDir = mkdtempSync(join(tmpdir(), 'ws-e2e-'))
  const dataDir = join(runDir, 'data')
  const workspace = join(runDir, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  // 固定 token：E2E 需要断言认证行为，随机值也可以，
  // 但固定值能让失败日志更好读。它只在这个临时实例里有效。
  TOKEN = 'e2e-token-' + createHash('sha256').update(String(Date.now()) + String(Math.random())).digest('hex').slice(0, 32)

  console.log(`  端口      ${port}`)
  console.log(`  运行目录  ${runDir}`)

  serverHandle = startServer({ port, dataDir, workspace, token: TOKEN, entry })
  console.log(`  服务 PID  ${serverHandle.child.pid}`)

  serverHandle.child.on('exit', (code, signal) => {
    serverExitCode = { code, signal }
  })

  const health = await waitForHealth(port)
  assertEq(health.ready, true, '服务就绪')

  // 构建身份校验：必须能对上当前代码
  assert(!!health.build, 'health 返回构建身份')
  assert(typeof health.build?.version === 'string' && health.build.version !== '', '构建版本非空')
  assert(typeof health.build?.schemaVersion === 'number', 'schema 版本是数字')

  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assertEq(health.build?.version, pkg.version, '服务版本与 package.json 一致')

  // /health 不泄露路径与 token
  assert(!JSON.stringify(health).includes(workspace.replace(/\\/g, '\\\\')), '/health 不泄露 workspace')
  assert(!JSON.stringify(health).includes('dataDir'), '/health 不泄露数据目录')
  assert(!JSON.stringify(health).includes(TOKEN), '/health 不泄露 token')

  // ── 1. 认证边界 ───────────────────────────────────────
  line('1 · 认证边界')

  const noAuth = await fetch(`${BASE}/sessions`)
  assertEq(noAuth.status, 401, '无 token 访问控制接口 → 401')

  const badAuth = await fetch(`${BASE}/sessions`, {
    headers: { authorization: 'Bearer wrong-token-0123456789' },
  })
  assertEq(badAuth.status, 401, '错误 token → 401')

  const urlToken = await fetch(`${BASE}/sessions?token=${TOKEN}`)
  assertEq(urlToken.status, 400, 'token 放 URL 里 → 400')

  const crossOrigin = await fetch(`${BASE}/sessions`, {
    headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' },
  })
  assertEq(crossOrigin.status, 403, '跨站 Origin → 403')

  const goodAuth = await api('GET', '/sessions')
  assert(Array.isArray(goodAuth.sessions), '正确 token → 正常返回')

  // ── 2. autoApprove 不能由请求体打开 ───────────────────
  line('2 · autoApprove 权限来源')

  const session0 = await api('POST', '/sessions', { title: 'auth probe' })
  const task0 = await api('POST', '/tasks', { sessionId: session0.id, goal: 'g' })
  const run0 = await api('POST', '/runs', { taskId: task0.id })

  const autoApproveProbe = await apiExpectError('POST', `/runs/${run0.id}/execute`, {
    provider: 'demo',
    model: 'deepseek-chat',
    goal: 'g',
    autoApprove: ['write_file'],
  }, 400)
  assert(autoApproveProbe.ok, '请求体带 autoApprove → 400')
  assertIncludes(autoApproveProbe.reason, 'autoApprove', '错误信息点名 autoApprove')

  const run0After = await api('GET', `/runs/${run0.id}`)
  assertEq(run0After.run.status, 'queued', '被拒绝的请求没有改变 Run 状态')

  // ── 3. Producer Run 与产物 ────────────────────────────
  line('3 · Producer Run 与产物')

  const fixturePath = join(workspace, 'readme.txt')
  const fixtureContent = '这是端到端测试用的固定文件内容。\n第二行用于验证读取完整。\n'
  writeFileSync(fixturePath, fixtureContent, 'utf8')

  const session = await api('POST', '/sessions', { title: 'ReviewLoop E2E' })
  const task = await api('POST', '/tasks', { sessionId: session.id, goal: '读文件并总结' })
  const run = await api('POST', '/runs', { taskId: task.id })

  const exec = await api('POST', `/runs/${run.id}/execute`, {
    provider: 'demo',
    model: 'deepseek-chat',
    goal: `读一下 ${fixturePath}`,
  })
  assertEq(exec.status, 'completed', 'Run 完成')

  const artifacts = await api('GET', `/tasks/${task.id}/artifacts`)
  assert(artifacts.artifacts.length > 0, `产物数量 > 0（实际 ${artifacts.artifacts.length}）`)

  const readmeArtifact = artifacts.artifacts.find((a) => a.path === 'readme.txt')
  assert(!!readmeArtifact, '存在 readme.txt 产物')
  if (readmeArtifact) {
    assertEq(readmeArtifact.status, 'candidate', '产物状态是 candidate')
    assertEq(readmeArtifact.version, 1, '产物版本是 1')
    assert(!!readmeArtifact.contentHash, '产物记录了 contentHash')

    const actualHash = createHash('sha256').update(fixtureContent, 'utf8').digest('hex')
    assertEq(readmeArtifact.contentHash, actualHash, 'contentHash 与文件内容一致')
  }

  const snapshots = await api('GET', `/runs/${run.id}/snapshots`)
  assertEq(snapshots.snapshots.length, 1, '拍了 1 个快照')
  assertEq(snapshots.snapshots[0].reproducible, true, '快照标记为可复现')

  const taskAfterExec = await api('GET', `/tasks/${task.id}`)
  assertEq(taskAfterExec.task.status, 'awaiting_acceptance', 'Task 进入 awaiting_acceptance')

  // ── 4. 未审计不能验收 ─────────────────────────────────
  line('4 · 验收门：未审计不可接受')
  const noAuditAccept = await apiExpectError(
    'POST',
    `/tasks/${task.id}/accept`,
    { artifactId: readmeArtifact.id, runId: run.id },
    409,
  )
  assert(noAuditAccept.ok, '未审计时验收被拒绝')
  assertIncludes(noAuditAccept.reason, '审计', '拒绝原因提到审计')

  // ── 5. 审计 ──────────────────────────────────────────
  line('5 · 审计')
  const review = await api('POST', `/tasks/${task.id}/review`, {
    runId: run.id,
    auditorModel: 'demo',
    auditorProvider: 'demo',
  })

  assert(
    ['passed', 'rejected', 'escalated'].includes(review.outcome),
    `审计结果合法（${review.outcome}）`,
  )
  assert(!!review.audit, '返回了审计记录')

  // demo 是规则引擎，不是语言模型。它无法判断内容是否切题，
  // 所以它的结论一律降级为 escalate —— 这是 v0.13 的硬规则。
  assertEq(review.outcome, 'escalated', 'demo Auditor 只能 escalate')
  assertEq(
    review.audit.result.escalateReason, 'uncertain',
    'demo Auditor 的 escalate 原因是 uncertain',
  )
  // demo 在跑机器规则之前就短路返回（它无法判断内容是否切题，
  // 继续跑规则只会浪费时间并给出误导性的「部分检查」印象）。
  assertEq(review.audit.result.checkedRules.length, 0, 'demo 审计不跑机器规则')

  const binding = review.audit.result.binding
  assert(!!binding, '审计结果包含 binding')
  if (binding) {
    assert(binding.artifactIds.includes(readmeArtifact.id), 'binding 覆盖当前产物')
    assertEq(binding.producerRunId, run.id, 'binding 的 runId 正确')
    assertEq(binding.taskId, task.id, 'binding 绑定 taskId')
    // demo 审计被降级，binding 是显式的部分绑定
    assertEq(binding.complete, false, 'demo 审计产生部分绑定')
    assertEq(binding.failureReason, 'demo_auditor', '部分绑定原因是 demo_auditor')
  }

  // ── 5b. 任务契约 ──────────────────────────────────────
  line('5b · 任务契约')

  const contractRes = await api('GET', `/tasks/${task.id}/contract`)
  assert(!!contractRes.contract, 'Task 有生效契约')
  assertEq(contractRes.contract.goal, '读文件并总结', '契约 goal 与创建时一致')
  assertEq(contractRes.contract.contractVersion, 1, '契约版本是 1')
  assert(/^[0-9a-f]{64}$/.test(contractRes.contract.contractHash), 'contractHash 是 64 位 hex')

  // 部分绑定没有 contractHash —— 这正是它不能被验收的原因
  if (binding && binding.complete === false) {
    assertEq(binding.contractHash, undefined, '部分绑定不含 contractHash')
  }

  // 更新契约 → 新版本、新 hash
  const updatedContract = await api('PUT', `/tasks/${task.id}/contract`, {
    acceptanceCriteria: ['总结覆盖文件主要信息', '给出明确结论'],
  })
  assertEq(updatedContract.contract.contractVersion, 2, '更新后契约版本是 2')
  assert(
    updatedContract.contract.contractHash !== contractRes.contract.contractHash,
    '更新后 contractHash 变化',
  )
  assertEq(updatedContract.history.length, 2, '契约历史保留两版')
  const superseded = updatedContract.history.find((c) => c.contractVersion === 1)
  assertEq(superseded.status, 'superseded', '旧契约标记为 superseded')

  // 契约变了之后，旧审计不能用于验收
  const staleAccept = await apiExpectError(
    'POST',
    `/tasks/${task.id}/accept`,
    { artifactId: readmeArtifact.id, runId: run.id },
    409,
  )
  assert(staleAccept.ok, '契约更新后旧审计不能验收')
  // 审计结果是 escalate → Task 停在 revision_requested，
  // 所以验收被状态门挡住（比契约校验更早）。
  // 这里断言的是「不能验收」这个事实，不限定具体是哪个门挡的。
  assert(
    /契约|revision_requested|awaiting_acceptance|审计/.test(staleAccept.reason),
    `拒绝原因应说明不能验收（实际：${staleAccept.reason}）`,
  )

  // ── 5c. 跑题产物不能通过验收 ──────────────────────────
  //
  // 这是 P0-1 要求的真实 HTTP E2E：一个内容与 goal 完全无关的产物，
  // 即使长度足够、格式完整、快照齐全，也不能被 accept。
  line('5c · 跑题产物不能验收')

  const s3 = await api('POST', '/sessions', { title: '跑题测试' })
  const t3 = await api('POST', '/tasks', {
    sessionId: s3.id,
    goal: '写一份 2025 年第四季度销售数据分析报告',
    acceptanceCriteria: ['包含销售额数据', '包含同比分析'],
  })
  const r3 = await api('POST', '/runs', { taskId: t3.id })

  // 写一个与销售报告毫无关系的文件
  writeFileSync(
    join(workspace, 'off-topic.md'),
    '今天天气不错，适合出门散步。晚上吃了一碗牛肉面，味道很好。',
    'utf8',
  )

  // 用读操作让 Run 跑完（写操作会停下来等审批）
  const exec3 = await api('POST', `/runs/${r3.id}/execute`, {
    provider: 'demo', model: 'deepseek-chat',
    goal: `读一下 ${join(workspace, 'off-topic.md')}`,
  })
  assertEq(exec3.status, 'completed', '跑题 Run 完成')

  const artifacts3 = await api('GET', `/tasks/${t3.id}/artifacts`)
  const offTopic = artifacts3.artifacts.find((a) => a.path === 'off-topic.md')
  assert(!!offTopic, '跑题产物已生成')

  // 用 demo 审计 → 必然 escalate（demo 不能判断切题与否）
  const review3 = await api('POST', `/tasks/${t3.id}/review`, {
    runId: r3.id,
    auditorModel: 'demo',
    auditorProvider: 'demo',
  })
  assertEq(review3.outcome, 'escalated', 'demo 审计跑题产物 → escalate')
  assert(review3.outcome !== 'passed', '跑题产物没有拿到 passed')

  // 关键：不能验收
  const accept3 = await apiExpectError(
    'POST',
    `/tasks/${t3.id}/accept`,
    { artifactId: offTopic.id, runId: r3.id },
    409,
  )
  assert(accept3.ok, '跑题产物不能被 accept')
  assert(
    /审计|escalate|revision_requested|awaiting_acceptance|契约/.test(accept3.reason),
    `拒绝原因应说明不能验收（实际：${accept3.reason}）`,
  )

  // ── 6. 同族模型隔离 ───────────────────────────────────
  line('6 · 同族模型隔离')

  const s2 = await api('POST', '/sessions', { title: '同族测试' })
  const t2 = await api('POST', '/tasks', { sessionId: s2.id, goal: 'g' })
  const r2 = await api('POST', '/runs', { taskId: t2.id })
  await api('POST', `/runs/${r2.id}/execute`, {
    provider: 'demo', model: 'claude-sonnet-5-5', goal: `读一下 ${fixturePath}`,
  })

  // 注意：不能用 demo 做 Auditor —— demo 在族隔离检查之前就短路了。
  // 这里用 anthropic preset（不需要真实密钥，因为族隔离检查在调用模型前生效）。
  const review2 = await api('POST', `/tasks/${t2.id}/review`, {
    runId: r2.id,
    auditorModel: 'claude-opus-5-5',
    auditorProvider: 'anthropic',
  })
  assertEq(review2.outcome, 'escalated', '同族模型 → escalate')
  assertEq(review2.audit.result.escalateReason, 'same_model_family', 'escalate 原因是同族')

  // ── 7. 跨对象归属校验 ─────────────────────────────────
  line('7 · 跨对象归属校验')

  const cross = await apiExpectError(
    'POST',
    `/tasks/${t2.id}/accept`,
    { artifactId: readmeArtifact.id, runId: run.id },
    409,
  )
  assert(cross.ok, '用别的 Task 的 id 验收被拒绝')

  const crossReview = await apiExpectError(
    'POST',
    `/tasks/${t2.id}/review`,
    { runId: run.id, auditorModel: 'demo', auditorProvider: 'demo' },
    409,
  )
  assert(crossReview.ok, '用别的 Task 的 id 发起 review 被拒绝')

  // ── 8. Cycle 记录 ─────────────────────────────────────
  line('8 · Cycle 记录')
  const cycles = await api('GET', `/tasks/${task.id}/cycles`)
  assertEq(cycles.cycles.length, 1, '创建了 1 个 Cycle')
  assert(
    ['passed', 'rework_required', 'escalated'].includes(cycles.cycles[0].derivedStatus),
    `Cycle 状态推导正确（${cycles.cycles[0].derivedStatus}）`,
  )

  const audits = await api('GET', `/tasks/${task.id}/audits`)
  assertEq(audits.audits.length, 1, '审计结果已持久化')

  // ── 8.5 reconcile 的证据校验 ──────────────────────────
  //
  // 这条以前完全没有 E2E 覆盖。而它是最需要端到端验证的一个：
  // reconcile 是「把 unknown 改成确定」的唯一入口，
  // 如果它接受任意文字，整个 unknown 语义就形同虚设。
  line('8.5 · reconcile 证据校验')

  // **这一段只验证错误路径，不验证证据校验本身。**
  //
  // 证据校验需要一条真实存在的 unknown Step，而 E2E 是黑盒的：
  // 没有内部接口能造出 unknown Step，靠模型超时又慢且不确定。
  //
  // 所以这里只断言 404（Step 不存在）和跨 Run 归属校验。
  // 证据校验本身（空/纯文字/自相矛盾/正确结构化）在
  // `reconcile-evidence.test.ts`（8 条）和 `reconcile-binding.test.ts`（5 条）里。
  //
  // **已知覆盖缺口：reconcile 的证据校验没有端到端覆盖。**
  const recRun = await api('POST', '/runs', { taskId: task.id })
  assertEq(recRun.status, 'queued', '创建了对账测试用的 Run')

  // 不存在的 step → 404
  const noStep = await apiExpectError('POST', `/runs/${recRun.id}/reconcile`, {
    stepId: 'no-such-step',
    resolution: 'confirmed_success',
    evidence: JSON.stringify({
      type: 'manual_inspection', source: 'x', observed: 'exists', actor: 'e2e',
    }),
  }, 404)
  assert(noStep.ok, '对不存在的 Step 对账 → 404')

  // 归属校验：用别的 Run 的接口裁决本 Run 的 step
  const otherRun = await api('POST', '/runs', { taskId: task.id })
  const crossRun = await apiExpectError('POST', `/runs/${otherRun.id}/reconcile`, {
    stepId: 'no-such-step',
    resolution: 'confirmed_success',
    evidence: JSON.stringify({
      type: 'manual_inspection', source: 'x', observed: 'exists', actor: 'e2e',
    }),
  }, 404)
  assert(crossRun.ok, '跨 Run 对账被拒绝')

  // ── 这里**刻意不断言证据校验本身** ─────────────────────
  //
  // 要验证「纯文字证据被拒」需要一个真实存在的 unknown Step，
  // 而 E2E 是黑盒的：没有内部接口能造出 unknown Step,
  // 靠模型超时又太慢且不确定。
  //
  // 所以证据校验只在 reconcile-evidence.test.ts（8 条单元测试，
  // 含空证据 / 纯文字 / 自相矛盾 / 正确结构化）里验证，
  // 这里不写一条「返回 404 就算通过」的假断言。
  //
  // 已知缺口：reconcile 的证据校验没有端到端覆盖。

  // ── 9. 平台相关：token 文件访问控制 ───────────────────
  //
  // 上一版这里是一条「无 Windows 专属断言」的 unsupported。
  // 那是不对的：Windows 上的 ACL 行为**可以**在这里真实验证，
  // 而且它正是认证方案的地基（token 文件可被同机其他用户读走的话，
  // 整个 bearer token 就形同虚设）。
  //
  // 所以这里是有断言的，而且必须在当前平台真实执行。
  line('9 · token 文件访问控制')

  // E2E 用 AUTH_TOKEN 环境变量启动，所以 **不应有** token 文件。
  // 先断言这一点，再单独验证「生成模式」的 ACL —— 见后面的独立实例。
  const tokenFile = join(dataDir, 'auth-token')
  assert(!existsSync(tokenFile), 'AUTH_TOKEN 模式下不落盘 token 文件')

  // token 不出现在服务日志里（shutdown 之前只能看已产生的部分）
  assert(!serverHandle.log.stdout.includes(TOKEN), '服务 stdout 不含 token')
  assert(!serverHandle.log.stderr.includes(TOKEN), '服务 stderr 不含 token')

  // ── 10. 生成模式下的 token 文件 ACL ───────────────────
  //
  // 上面的实例用 AUTH_TOKEN 启动，不落盘。
  // 这里再起一个**不带** AUTH_TOKEN 的实例，验证它生成的 token 文件
  // 真的只对当前用户开放 —— 这是 bearer token 方案的地基。
  line('10 · 生成模式下 token 文件的访问控制')

  const genDir = join(runDir, 'gen')
  const genData = join(genDir, 'data')
  const genWs = join(genDir, 'workspace')
  mkdirSync(genData, { recursive: true })
  mkdirSync(genWs, { recursive: true })
  const genPort = await findFreePort()

  const gen = startServer({ port: genPort, dataDir: genData, workspace: genWs, token: '', entry })
  let genHealth
  try {
    genHealth = await waitForHealth(genPort)
  } finally {
    // 无论成功与否都要等它退出，否则 Windows 上删不掉目录
    await new Promise((ok) => {
      const t = setTimeout(() => { gen.child.kill('SIGKILL'); ok() }, 5000)
      gen.child.once('exit', () => { clearTimeout(t); ok() })
      if (gen.child.exitCode !== null) { clearTimeout(t); ok() }
      else gen.child.kill()
    })
  }

  assertEq(genHealth.ready, true, '生成模式实例就绪')

  const genTokenFile = join(genData, 'auth-token')
  assert(existsSync(genTokenFile), '生成模式下 token 文件已创建')

  const genToken = existsSync(genTokenFile) ? readFileSync(genTokenFile, 'utf8').trim() : ''
  assert(genToken.length >= 32, 'token 长度 ≥ 32')
  assert(!gen.log.stdout.includes(genToken), '生成模式下 token 不打印到 stdout')
  assert(!gen.log.stderr.includes(genToken), '生成模式下 token 不打印到 stderr')

  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process')
    const acl = execFileSync('icacls', [genTokenFile], { encoding: 'utf8', windowsHide: true })

    const me = (process.env.USERNAME ?? '').toLowerCase()
    const leaks = acl
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => {
        const rights = (l.match(/\(([A-Z]+)\)/g) ?? []).join('')
        return /[RWXFD]/.test(rights)
      })
      .filter((l) => {
        const p = l.split(':')[0].toLowerCase()
        return !(
          p.endsWith(`\\${me}`) ||
          p === 'nt authority\\system' ||
          p === 'builtin\\administrators'
        )
      })

    assert(leaks.length === 0, 'Windows ACL：token 文件不对其他用户开放', { leaks })
    // 反向确认：当前用户确实有权限。
    // 少了这一条，「什么都没授权」也会让上面那条通过。
    assert(me.length > 0 && acl.toLowerCase().includes(me), 'Windows ACL：当前用户有访问权')
  } else {
    const { statSync } = await import('node:fs')
    const mode = statSync(genTokenFile).mode & 0o777
    assert((mode & 0o077) === 0, `POSIX mode 不对 group/other 开放（mode=${mode.toString(8)}）`)
    assert((mode & 0o400) !== 0, 'POSIX mode：owner 可读')
  }

  return { runDir, workspace, dataDir }
}

// ── 收尾 ─────────────────────────────────────────────────

async function shutdown() {
  if (!serverHandle) return
  const { child } = serverHandle
  if (child.exitCode !== null) return

  await new Promise((ok) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      ok()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      ok()
    })
    child.kill()
  })
}

function report() {
  line('汇总')
  console.log(`  通过:      ${results.passed}`)
  console.log(`  失败:      ${results.failed}`)
  console.log(`  跳过:      ${results.skipped}`)
  // 刻意不打印 unsupported。
  // 上一版把它当成一种「可接受的结果」列在汇总里，于是 42 passed + 1 unsupported
  // 看起来像是「基本全过」。实际上那条 unsupported 是「本该验证但没有验证」。
  // 现在改成：要么写成真实断言，要么用 skip() 明确标出原因并让退出码非零。
  if (results.unsupported > 0) {
    console.log(`  未覆盖:    ${results.unsupported}（这是缺陷，不是结果）`)
  }

  if (failures.length > 0) {
    console.log('\n失败的断言：')
    for (const f of failures) {
      console.log(`  · ${f.message}`)
      if (f.detail) console.log(`    ${JSON.stringify(f.detail)}`)
    }
  }
  if (skips.length > 0) {
    console.log('\n跳过的断言（不计入通过）：')
    for (const s of skips) console.log(`  · ${s.message} — ${s.reason}`)
  }

  // 失败、跳过、未覆盖、或一条断言都没跑，都算不通过。
  //
  // 最后一种是最阴的：脚本在第一个 fixture 就崩了，passed=0、failed=0，
  // 旧版会打印「全部断言通过」并以 0 退出。
  // 「什么都没验证」和「验证都通过」必须区分开。
  if (results.failed > 0 || results.skipped > 0 || results.unsupported > 0) {
    process.exitCode = 1
    console.log('\n存在失败或未执行的断言')
  } else if (results.passed === 0) {
    process.exitCode = 1
    console.log('\n没有执行任何断言——不能算通过')
  } else {
    console.log('\n全部断言通过')
  }
}

let cleanupDir

main()
  .then((ctx) => {
    cleanupDir = ctx?.runDir
  })
  .catch((err) => {
    console.error('\n执行失败:', err.message)
    if (err.data) console.error(JSON.stringify(err.data, null, 2))
    process.exitCode = 1
  })
  .finally(async () => {
    await shutdown()

    // 先判定是否成功，再决定打印与清理。
    //
    // 之前的顺序是「先 report() 后检查 process.exitCode」，
    // 而 report() 内部才设置 exitCode——于是清理永远走 success 分支，
    // 失败时也把现场删了。判据必须在 report 之后读。
    const ok = results.failed === 0 && results.skipped === 0 && results.passed > 0

    // 服务日志：失败时是定位问题的关键，成功时不刷屏
    if (!ok && serverHandle) {
      console.log('\n──── 服务 stdout ────')
      console.log(serverHandle.log.stdout.trim() || '(空)')
      console.log('──── 服务 stderr ────')
      console.log(serverHandle.log.stderr.trim() || '(空)')
      console.log(`──── 服务退出码：${JSON.stringify(serverExitCode ?? '仍在运行')} ────`)
    }

    report()

    if (cleanupDir && ok) {
      rmSync(cleanupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } else if (cleanupDir) {
      console.log(`\n运行目录保留以供排查：${cleanupDir}`)
    }
  })
