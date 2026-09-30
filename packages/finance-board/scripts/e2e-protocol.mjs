/**
 * End-to-end protocol verification against the live dsh host:
 * session/list → session/create → WS session/follow (snapshot) →
 * session/prompt("用 finance.status() 自检") → assistant-stream chunks and
 * tool events. Exercises every wire assumption of src/terminal/dsh/*.
 *
 * Usage: node scripts/e2e-protocol.mjs <cookie-header> [cwd]
 *   cookie-header: value of the dsh-auth-* cookie (see the token exchange).
 *   cwd: working directory new sessions get (defaults to this repo).
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const BASE = process.env.FINANCE_E2E_BASE ?? 'http://127.0.0.1:3180'
/** The repo root, relative to this script — never a hardcoded absolute path. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const cookie = process.argv[2]
if (!cookie) {
  console.error('usage: node scripts/e2e-protocol.mjs <cookie-header> [cwd]')
  process.exit(2)
}
const cwd = process.argv[3] ?? REPO_ROOT

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function unary(endpoint, args) {
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  if (res.status !== 200) throw new Error(`${endpoint}: HTTP ${res.status}`)
  const body = await res.json()
  if (body.type !== 'server-response') throw new Error(`${endpoint}: bad envelope`)
  if (!body.result?.ok) throw new Error(`${endpoint}: ${body.result?.error?.message ?? 'failed'}`)
  return body.result.value
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 1. session/list
const list = await unary('session/list', { _request: {} })
check('session/list', Array.isArray(list.items), `${list.items.length} sessions`)

// 2. session/create
const created = await unary('session/create', { request: { cwd } })
check('session/create', typeof created.sessionId === 'string', created.sessionId)
const sessionId = created.sessionId

// 3. WS session/follow
const frames = []
let snapshot = null
const ws = new WebSocket('ws://127.0.0.1:3180/api/remote.mux', { headers: { cookie } })
const streamId = randomUUID()
const eventsStreamId = randomUUID()
let eventsReady = null

ws.onmessage = ev => {
  const frame = JSON.parse(ev.data)
  if (frame.type === 'item' && frame.streamId === eventsStreamId && frame.value?.type === 'ready') {
    eventsReady = frame.value
  }
  if (frame.streamId !== streamId) return
  if (frame.type === 'item') {
    frames.push(frame.value)
    if (frame.value?.type === 'snapshot') snapshot = frame.value
  }
  if (frame.type === 'error') {
    console.error('stream error:', frame.error)
    process.exit(1)
  }
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
check('remote.mux open', true)

ws.send(JSON.stringify({
  type: 'open', streamId, endpoint: 'session/follow',
  payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } },
}))
ws.send(JSON.stringify({ type: 'open', streamId: eventsStreamId, endpoint: '$events', payload: { args: {} } }))

for (let i = 0; i < 50 && !snapshot; i++) await sleep(100)
check('follow snapshot', snapshot !== null,
  snapshot ? `cursor=${snapshot.cursor} records=${snapshot.records.length} hasMore=${snapshot.hasMore}` : 'timeout')
check('$events ready frame', eventsReady !== null, eventsReady ? `clientId=${eventsReady.clientId.slice(0, 8)}…` : 'timeout')

// 4. session/prompt
await unary('session/prompt', {
  request: {
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '在 REPL 里运行 import finance 然后 await finance.status()，把结果简要告诉我。' }],
    clientTimeZone: 'Asia/Shanghai',
  },
})
check('session/prompt accepted', true)

// 5. collect frames for up to 120s: expect user/message, assistant-stream chunks, tool/call+result, turn/end
const seen = { userMsg: false, streamChunk: false, toolCall: false, toolResult: false, turnEnd: false, assistantMsg: false }
const deadline = Date.now() + 180_000
while (Date.now() < deadline && !seen.turnEnd) {
  await sleep(200)
  for (const f of frames) {
    if (f.type === 'event') {
      if (f.event.type === 'user/message') seen.userMsg = true
      if (f.event.type === 'tool/call') seen.toolCall = true
      if (f.event.type === 'tool/result') seen.toolResult = true
      if (f.event.type === 'assistant/message') seen.assistantMsg = true
      if (f.event.type === 'turn/end') seen.turnEnd = true
    }
    if (f.type === 'assistant-stream' && f.frame?.type === 'chunk') seen.streamChunk = true
  }
}
for (const [name, ok] of Object.entries(seen)) check(`live frame: ${name}`, ok)

const lastAssistant = [...frames].reverse().find(f => f.type === 'event' && f.event.type === 'assistant/message')
if (lastAssistant) {
  const text = (lastAssistant.event.data.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  console.log('\n—— assistant 回复摘要 ——\n' + text.slice(0, 400))
}

ws.close()
const failed = results.filter(r => !r.ok)
console.log(failed.length === 0 ? '\n全部协议假设验证通过' : `\n${failed.length} 项失败`)
process.exit(failed.length === 0 ? 0 : 1)
