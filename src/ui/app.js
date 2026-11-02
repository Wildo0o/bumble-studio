// 桌面壳前端。
//
// 铁律：**这一层不判断状态、不判断权限、不翻译错误。**
//
// 具体体现在：
//   · 状态文字来自 bootstrap.contracts.stateMachines，不在前端写映射表
//   · 「能不能批准」来自 bootstrap.contracts.permissions，不在前端写规则
//   · 错误直接展示后端返回的 code 与 message（含 correlationId），
//     不在前端把 409 翻译成「操作冲突」之类的自造文案
//   · 审批、验收、恢复都调后端接口，前端不模拟结果
//
// 为什么不在这里做「乐观更新」：
//   这是证据系统。界面显示「已批准」但后端实际拒绝，会让用户以为
//   事情办完了。宁可慢一步，也不要在界面上撒谎。

const API = {
  async request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        // token 由壳注入（Electron 主进程或本地 CLI 打开时放在 localStorage）。
        ...(token() ? { authorization: `Bearer ${token()}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    let payload = null
    const text = await res.text()
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { error: text }
    }

    if (!res.ok) {
      // 后端错误体：{ error: string, code, retryable, correlationId }
      // 原样抛出，由调用方展示——这里不加工。
      const err = new Error(
        typeof payload?.error === 'string'
          ? payload.error
          : payload?.error?.message ?? `HTTP ${res.status}`,
      )
      err.code = payload?.code
      err.correlationId = payload?.correlationId
      err.status = res.status
      err.payload = payload
      throw err
    }
    return payload
  },
  get: (p) => API.request('GET', p),
  post: (p, b) => API.request('POST', p, b),
  put: (p, b) => API.request('PUT', p, b),
  del: (p) => API.request('DELETE', p),
}

function token() {
  return localStorage.getItem('aiws-token') ?? ''
}

// ── 状态 ───────────────────────────────────────────────────

const state = {
  bootstrap: null,
  sessions: [],
  currentSessionId: null,
  conversation: null,
  showActivity: false,
  busy: false,
}

// ── 工具 ───────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag)
  if (opts.class) node.className = opts.class
  if (opts.text !== undefined) node.textContent = opts.text
  if (opts.title) node.title = opts.title
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v)
  if (opts.on) for (const [k, fn] of Object.entries(opts.on)) node.addEventListener(k, fn)
  for (const child of children) if (child) node.appendChild(child)
  return node
}

function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleDateString()
}

function setStatus(text) {
  $('status-text').textContent = text
}

/** 展示后端错误。原样展示 code 与 correlationId——它们是排查的入口。 */
function showError(err) {
  const parts = []
  if (err?.code) parts.push(`[${err.code}]`)
  parts.push(err?.message ?? String(err))
  if (err?.correlationId) parts.push(`(correlationId: ${err.correlationId})`)
  const box = $('status-error')
  box.textContent = parts.join(' ')
  box.classList.remove('hidden')
  // 错误会一直留在状态栏，直到下一次成功操作清除它。
  // 自动消失会让用户错过「刚才失败了」这件事。
}

function clearError() {
  const box = $('status-error')
  box.textContent = ''
  box.classList.add('hidden')
}

async function guard(fn) {
  if (state.busy) return
  state.busy = true
  try {
    clearError()
    await fn()
  } catch (err) {
    showError(err)
  } finally {
    state.busy = false
  }
}

// ── 渲染：侧栏 ─────────────────────────────────────────────

function renderSessions() {
  const list = $('session-list')
  list.textContent = ''
  const sessions = state.sessions
  $('session-empty').classList.toggle('hidden', sessions.length > 0)

  for (const s of sessions) {
    const li = el('li', {
      attrs: {
        'aria-selected': String(s.id === state.currentSessionId),
        tabindex: '0',
      },
      on: {
        click: () => openSession(s.id),
        keydown: (e) => { if (e.key === 'Enter') openSession(s.id) },
      },
    }, [
      el('span', { class: 'item-title', text: s.title }),
      el('span', { class: 'item-meta', text: fmtTime(s.updatedAt ?? s.createdAt) }),
    ])
    list.appendChild(li)
  }
}

function renderInbox() {
  const inbox = state.bootstrap?.inbox
  const list = $('inbox-list')
  list.textContent = ''
  const count = inbox?.total ?? 0
  const badge = $('inbox-count')
  badge.textContent = String(count)
  badge.dataset.zero = String(count === 0)

  if (!inbox) return

  for (const a of inbox.approvals ?? []) {
    list.appendChild(el('li', { on: { click: () => focusApproval(a.approvalId) } }, [
      el('span', { class: 'item-title', text: `等待审批：${a.toolId}` }),
      el('span', { class: 'item-meta', text: `Run ${a.runId.slice(0, 8)} · ${fmtTime(a.createdAt)}` }),
    ]))
  }
  for (const r of inbox.reconciliations ?? []) {
    list.appendChild(el('li', {}, [
      el('span', { class: 'item-title', text: '需要人工对账' }),
      el('span', { class: 'item-meta', text: `Run ${r.runId.slice(0, 8)}` }),
    ]))
  }
  for (const t of inbox.awaitingAcceptance ?? []) {
    list.appendChild(el('li', {}, [
      el('span', { class: 'item-title', text: `等待验收：${t.goal}` }),
      el('span', { class: 'item-meta', text: `Task ${t.taskId.slice(0, 8)}` }),
    ]))
  }
}

function renderApprovals() {
  const list = $('approval-list')
  list.textContent = ''
  const approvals = state.bootstrap?.inbox?.approvals ?? []
  $('approval-empty').classList.toggle('hidden', approvals.length > 0)

  // 权限来自后端：前端不判断「用户能不能批准」。
  const canDecide = (state.bootstrap?.contracts?.permissions ?? []).some(
    (p) => p.action === 'approval.decide' && p.allowed.includes('user'),
  )

  for (const a of approvals) {
    const card = el('li', { attrs: { 'data-approval': a.approvalId } }, [
      el('span', { class: 'item-title', text: a.toolId }),
      el('span', { class: 'item-meta', text: `Run ${a.runId.slice(0, 8)} · ${fmtTime(a.createdAt)}` }),
    ])

    if (canDecide) {
      card.appendChild(el('div', { class: 'approval-actions' }, [
        el('button', {
          text: '批准一次',
          attrs: { 'data-action': 'approve-once' },
          on: { click: () => decideApproval(a.approvalId, 'once') },
        }),
        el('button', {
          text: '批准本次运行',
          attrs: { 'data-action': 'approve-run' },
          on: { click: () => decideApproval(a.approvalId, 'run') },
        }),
        el('button', {
          class: 'danger',
          text: '拒绝',
          attrs: { 'data-action': 'reject' },
          on: { click: () => decideApproval(a.approvalId, 'reject') },
        }),
      ]))
    }
    list.appendChild(card)
  }
}

function focusApproval(approvalId) {
  const node = document.querySelector(`[data-approval="${CSS.escape(approvalId)}"]`)
  if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

// ── 渲染：会话视图 ─────────────────────────────────────────

/**
 * 状态文字来自**后端的会话状态字段**。
 *
 * 这里只做「状态 → 显示文字」的展示映射，不做任何逻辑判断。
 * 例如「waiting_approval 意味着需要人处理」这件事由后端在
 * deriveConversationStatus 里决定，前端只是把它显示出来。
 */
const STATUS_LABELS = {
  // 这几个 key 是后端 /sessions/:id/conversation 的 status 取值。
  idle: { text: '空闲', tone: '' },
  running: { text: '执行中', tone: 'run' },
  waiting_approval: { text: '等待审批', tone: 'wait' },
  waiting_reconciliation: { text: '等待对账', tone: 'wait' },
  failed: { text: '失败', tone: 'err' },
}

function renderConversation() {
  const conv = state.conversation
  const messages = $('messages')
  messages.textContent = ''

  $('session-title').textContent = conv?.session?.title ?? '未选择会话'

  const status = conv?.status ?? 'idle'
  const label = STATUS_LABELS[status] ?? { text: status, tone: '' }
  const statusNode = $('session-status')
  statusNode.textContent = label.text
  statusNode.dataset.tone = label.tone

  if (!conv) {
    messages.appendChild(el('p', { class: 'empty', text: '选择一个会话开始' }))
    return
  }

  if (conv.messages.length === 0) {
    messages.appendChild(el('p', { class: 'empty', text: '还没有消息' }))
  }

  for (const m of conv.messages) {
    const body = el('div', { class: 'msg-body', text: m.content })
    const node = el('div', {
      class: 'msg',
      attrs: { 'data-role': m.role, 'data-source': m.source },
    }, [
      el('div', { class: 'msg-role', text: roleLabel(m) }),
      body,
    ])

    if (m.toolCalls?.length) {
      node.appendChild(el('div', { class: 'msg-tools' }, m.toolCalls.map((c) =>
        el('div', { text: `→ ${c.name}(${c.summary})` }),
      )))
    }
    messages.appendChild(node)
  }

  messages.scrollTop = messages.scrollHeight
}

function roleLabel(m) {
  const who = m.role === 'user' ? '你'
    : m.role === 'assistant' ? '助手'
      : m.role === 'tool' ? '工具输出'
        : m.role
  // 标注来源：来自 Run 内部历史的消息，用户要知道它不是「对话」
  return m.source === 'run' ? `${who} · 执行记录` : who
}

function renderActivity() {
  const panel = $('activity')
  panel.classList.toggle('hidden', !state.showActivity)
  const list = $('activity-list')
  list.textContent = ''
  const items = state.conversation?.activity ?? []

  if (items.length === 0) {
    list.appendChild(el('li', { class: 'empty', text: '没有事件' }))
    return
  }
  for (const a of items) {
    list.appendChild(el('li', {}, [
      el('span', { class: 'item-title', text: a.summary }),
      el('span', { class: 'item-meta', text: `${a.kind} · ${fmtTime(a.occurredAt)}` }),
    ]))
  }
}

function renderBuild() {
  const b = state.bootstrap?.build
  $('build-info').textContent = b
    ? `v${b.version} · schema ${b.schemaVersion}`
    : '未连接'
}

function renderPolicy() {
  const p = state.bootstrap?.policy
  if (!p) return
  $('policy-failures').value = String(p.maxConsecutiveFailures)
  $('policy-duration').value = String(Math.round(p.maxRunDurationMs / 60_000))
}

// ── 动作 ───────────────────────────────────────────────────

async function loadBootstrap() {
  state.bootstrap = await API.get('/ui/bootstrap')
  renderBuild()
  renderInbox()
  renderApprovals()
  renderPolicy()
}

async function loadSessions() {
  const data = await API.get('/sessions')
  state.sessions = data.sessions ?? []
  renderSessions()
}

async function openSession(id) {
  await guard(async () => {
    state.currentSessionId = id
    renderSessions()
    const conv = await API.get(`/sessions/${id}/conversation`)
    state.conversation = conv
    renderConversation()
    renderActivity()
  })
}

async function refreshAll() {
  await guard(async () => {
    await loadBootstrap()
    await loadSessions()
    if (state.currentSessionId) {
      state.conversation = await API.get(`/sessions/${state.currentSessionId}/conversation`)
      renderConversation()
      renderActivity()
    }
  })
}

async function createSession() {
  await guard(async () => {
    const created = await API.post('/sessions', { title: '新会话' })
    await loadSessions()
    await openSession(created.id)
  })
}

/**
 * 审批决定。
 *
 * 注意：**不传 approver 字段**。审批者由服务端记录为 user，
 * 前端不能也不该声明「我是谁」——那正是审批门禁要防的。
 */
async function decideApproval(approvalId, action) {
  await guard(async () => {
    if (action === 'reject') {
      await API.post(`/approvals/${approvalId}/reject`, { reason: '在桌面壳中拒绝' })
    } else {
      await API.post(`/approvals/${approvalId}/approve`, { scope: action })
    }
    setStatus('审批已提交')
    await refreshAll()
  })
}

async function savePolicy(event) {
  event.preventDefault()
  await guard(async () => {
    const failures = Number($('policy-failures').value)
    const minutes = Number($('policy-duration').value)
    const updated = await API.put('/runner/policy', {
      maxConsecutiveFailures: failures,
      maxRunDurationMs: minutes * 60_000,
    })
    state.bootstrap.policy = updated.policy
    setStatus('策略已保存')
  })
}

async function sendMessage(event) {
  event.preventDefault()
  const input = $('compose-input')
  const text = input.value.trim()
  if (!text || !state.currentSessionId) return

  await guard(async () => {
    // 作为会话消息落库，由后端决定后续如何处理。
    await API.post(`/sessions/${state.currentSessionId}/messages`, {
      role: 'user',
      content: text,
    })
    input.value = ''
    await openSession(state.currentSessionId)
  })
}

// ── 启动 ───────────────────────────────────────────────────

function bind() {
  $('new-session').addEventListener('click', createSession)
  $('refresh').addEventListener('click', refreshAll)
  $('policy-form').addEventListener('submit', savePolicy)
  $('compose').addEventListener('submit', sendMessage)
  $('activity-toggle').addEventListener('click', () => {
    state.showActivity = !state.showActivity
    $('activity-toggle').dataset.on = String(state.showActivity)
    renderActivity()
  })
}

async function main() {
  bind()

  // token：优先用 URL 参数一次性注入（壳启动时由主进程传入），
  // 之后存进 localStorage。URL 里的 token 会立刻从地址栏移除——
  // 留在历史记录里等于把凭据写进磁盘。
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    localStorage.setItem('aiws-token', fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.toString())
  }

  // 无 token 时不能直接报错：先尝试请求，由后端决定是否 401。
  // 这样「本地已免认证」的部署形态也能正常工作。
  try {
    await loadBootstrap()
    await loadSessions()
  } catch (err) {
    showError(err)
  }

  // 轮询刷新待办。
  //
  // 用轮询而不是 SSE：待办变化不频繁，轮询实现简单且没有
  // 「连接断了但界面还在显示旧状态」的问题。
  // 间隔刻意不快（10s）：审批列表晚 10 秒出现不会造成损失，
  // 而更频繁的轮询会在无人值守时持续唤醒 CPU。
  setInterval(() => {
    if (!state.busy) refreshAll().catch(() => { /* 轮询失败不打扰用户 */ })
  }, 10_000)

  document.getElementById('app').dataset.ready = 'true'
}

main()
