/**
 * Session store: list/create/follow/prompt/cancel over the dsh session
 * remote (protocol pinned to dsh 0.1.7-rc.2 — see
 * dsh-api-session-controller lib/types/types.d.ts and dsh-session
 * SessionEventMap). Durable events and live assistant-stream frames are
 * normalised into the ChatMessage model consumed by chat/MessageList.tsx.
 *
 * Wire notes:
 * - unary payloads are `{args:{request:{...}}}` (`session/list` names its
 *   parameter `_request`);
 * - follow frames: one `snapshot` (records + hasMore), then durable
 *   `{type:'event', event:{type,seq,time,data}}` entries and, with
 *   `assistantStream:true`, `{type:'assistant-stream', frame}` increments;
 * - live chunk frames carry raw StreamChunks, while a snapshot's
 *   activeAttempt carries the compact record form (`text-chunks` etc.).
 */

import { mux, type StreamHandle } from './mux.js'
import { call } from './rpc.js'
import { onEvent, startEvents } from './events.js'
import type { ChatMessage } from '../chat/MessageList.js'

/** New sessions default to the daimon repository checkout. */
const DEFAULT_CWD = '/Users/bytedance/codes/open-source/daimon'

export interface SessionInfo {
  sessionId: string
  running: boolean
  updatedAt: number
  cwd?: string
}

export interface ChatState {
  sessions: SessionInfo[]
  activeSessionId: string | null
  messages: ChatMessage[]
  /** Whether the active session has an open turn (stop button visible). */
  running: boolean
  /** Follow established but snapshot not yet received. */
  loading: boolean
  error: string | null
}

const initialState: ChatState = {
  sessions: [],
  activeSessionId: null,
  messages: [],
  running: false,
  loading: false,
  error: null,
}

type Listener = () => void

/* ---------- event → message normalisation ---------- */

interface WireEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
}

function textOf(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

function argsSummary(raw: string | undefined): string {
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > 90 ? `${compact.slice(0, 90)}…` : compact
}

/** Streaming bubble state for one in-flight assistant attempt. */
interface LiveAttempt {
  attemptId: string
  /** text-delta fragments keyed by content-block index. */
  blocks: Map<number, string>
}

/** Mutable follow state; rebuilt from scratch on every snapshot. */
class FollowAssembler {
  messages: ChatMessage[] = []
  running = false
  private toolCards = new Map<string, Extract<ChatMessage, { kind: 'tool' }>>()
  private attempts = new Map<string, LiveAttempt>()

  private push(msg: ChatMessage): void {
    this.messages.push(msg)
  }

  /** Compact baseline records (`text-chunks`/`reasoning-chunks`/`chunk`). */
  applyCompactStream(attemptId: string, stream: readonly unknown[]): void {
    const attempt = this.attemptFor(attemptId)
    for (const rec of stream as { type?: string; index?: number; texts?: string[] }[]) {
      if (rec?.type === 'text-chunks' && typeof rec.index === 'number' && Array.isArray(rec.texts)) {
        attempt.blocks.set(rec.index, rec.texts.join(''))
      }
    }
    this.syncAttempt(attempt)
  }

  applyStreamFrame(frame: { type: string; attemptId?: string; chunk?: { type: string; index?: number; text?: string } }): void {
    if (frame.type === 'start' && frame.attemptId) {
      this.attempts.set(frame.attemptId, { attemptId: frame.attemptId, blocks: new Map() })
      return
    }
    if (frame.type === 'chunk' && frame.attemptId && frame.chunk) {
      const attempt = this.attemptFor(frame.attemptId)
      if (frame.chunk.type === 'text-delta' && typeof frame.chunk.index === 'number') {
        const prev = attempt.blocks.get(frame.chunk.index) ?? ''
        attempt.blocks.set(frame.chunk.index, prev + (frame.chunk.text ?? ''))
        this.syncAttempt(attempt)
      }
      return
    }
    if (frame.type === 'end' && frame.attemptId) {
      // The durable assistant/message event supersedes the live bubble.
      this.attempts.delete(frame.attemptId)
      this.messages = this.messages.filter(m => m.id !== `stream-${frame.attemptId}`)
    }
  }

  applyEvent(event: WireEvent): void {
    const data = event.data as Record<string, never>
    switch (event.type) {
      case 'turn/start':
        this.running = true
        return
      case 'turn/end': {
        this.running = false
        const reason = (data as { reason?: { kind?: string; error?: { message?: string } } }).reason
        if (reason?.kind === 'error') {
          this.push({ kind: 'notice', id: `err-${event.seq}`, tone: 'error', text: `出错了：${reason.error?.message ?? '未知错误'}` })
        } else if (reason?.kind === 'aborted') {
          this.push({ kind: 'notice', id: `stop-${event.seq}`, tone: 'info', text: '已停止' })
        }
        return
      }
      case 'user/message': {
        const msg = data as { id?: string; source?: { kind?: string }; content?: ContentBlock[] }
        if (msg.source?.kind !== 'user') return // synthetic injections stay hidden in v1
        const text = textOf(msg.content)
        if (!text.trim()) return
        this.push({ kind: 'user', id: msg.id ?? `u-${event.seq}`, text })
        return
      }
      case 'assistant/message': {
        const { message, interrupted } = data as { message?: { id?: string; content?: ContentBlock[] }; interrupted?: true }
        const text = textOf(message?.content)
        if (!text.trim()) return
        // Replace any live bubble for this settlement.
        this.messages = this.messages.filter(m => !(m.kind === 'assistant' && m.streaming))
        this.push({
          kind: 'assistant',
          id: message?.id ?? `a-${event.seq}`,
          text: interrupted ? `${text}\n\n*（中断）*` : text,
          streaming: false,
        })
        return
      }
      case 'tool/call': {
        const d = data as { callId?: string; name?: string; arguments?: string }
        if (!d.callId) return
        const card: Extract<ChatMessage, { kind: 'tool' }> = {
          kind: 'tool',
          id: d.callId,
          name: d.name ?? 'tool',
          argsSummary: argsSummary(d.arguments),
          status: 'running',
        }
        this.toolCards.set(d.callId, card)
        this.push(card)
        return
      }
      case 'tool/result': {
        const d = data as { message?: { toolCallId?: string; content?: ContentBlock[]; isError?: boolean } }
        const callId = d.message?.toolCallId
        if (!callId) return
        const card = this.toolCards.get(callId)
        if (!card) return
        card.output = textOf(d.message?.content) || (d.message?.isError ? '（无输出）' : '（完成）')
        card.status = d.message?.isError ? 'error' : 'done'
        return
      }
      default:
        return // step/*, request/*, system/message, compaction/* … not rendered in v1
    }
  }

  private attemptFor(attemptId: string): LiveAttempt {
    let attempt = this.attempts.get(attemptId)
    if (!attempt) {
      attempt = { attemptId, blocks: new Map() }
      this.attempts.set(attemptId, attempt)
    }
    return attempt
  }

  /** Materialise the live bubble for one attempt from its block map. */
  private syncAttempt(attempt: LiveAttempt): void {
    const id = `stream-${attempt.attemptId}`
    const text = [...attempt.blocks.keys()].sort((a, b) => a - b).map(k => attempt.blocks.get(k) ?? '').join('')
    const existing = this.messages.findIndex(m => m.id === id)
    if (existing >= 0) {
      const prev = this.messages[existing]
      if (prev.kind === 'assistant') this.messages[existing] = { ...prev, text, streaming: true }
    } else {
      this.push({ kind: 'assistant', id, text, streaming: true })
    }
  }
}

/* ---------- the store ---------- */

class SessionStore {
  private state: ChatState = initialState
  private readonly listeners = new Set<Listener>()
  private followHandle: StreamHandle | null = null
  private assembler = new FollowAssembler()
  private started = false

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  /** First-load wiring: events stream + initial session list. */
  start(): void {
    if (this.started) return
    this.started = true
    startEvents()
    onEvent({ onSessionsChanged: () => void this.refreshSessions() })
    void this.refreshSessions()
  }

  async refreshSessions(): Promise<void> {
    try {
      const value = await call<{ items: SessionInfo[] }>('session/list', { _request: {} })
      const sessions = value.items ?? []
      this.set({ sessions, error: null })
      // Auto-select the most recent session on first load.
      if (!this.state.activeSessionId && sessions.length > 0) {
        this.selectSession(sessions[0].sessionId)
      }
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async createSession(): Promise<void> {
    try {
      const value = await call<{ sessionId: string }>('session/create', { request: { cwd: DEFAULT_CWD } })
      await this.refreshSessions()
      this.selectSession(value.sessionId)
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  selectSession(sessionId: string): void {
    if (this.state.activeSessionId === sessionId && this.followHandle) return
    this.followHandle?.close()
    this.followHandle = null
    this.assembler = new FollowAssembler()
    this.set({ activeSessionId: sessionId, messages: [], running: false, loading: true, error: null })
    this.followHandle = mux.open('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
        },
      },
    }, {
      onItem: item => this.onFollowFrame(item),
      onError: message => this.set({ error: message ?? '会话流中断', loading: false }),
      onEnd: () => this.set({ loading: false }),
      onReopen: () => {
        // The re-opened stream restarts from a fresh snapshot; drop state.
        this.assembler = new FollowAssembler()
        this.set({ messages: [], loading: true })
      },
    })
  }

  private onFollowFrame(item: unknown): void {
    const frame = item as {
      type: string
      records?: { event: WireEvent }[]
      event?: WireEvent
      frame?: { type: string; attemptId?: string; chunk?: { type: string; index?: number; text?: string } }
      assistantStream?: { activeAttempt?: { attemptId: string; stream: unknown[] } }
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'snapshot') {
      this.assembler = new FollowAssembler()
      for (const record of frame.records ?? []) {
        if (record?.event) this.assembler.applyEvent(record.event)
      }
      const active = frame.assistantStream?.activeAttempt
      if (active) this.assembler.applyCompactStream(active.attemptId, active.stream)
      this.set({ messages: [...this.assembler.messages], running: this.assembler.running, loading: false })
      return
    }
    if (frame.type === 'event' && frame.event) {
      this.assembler.applyEvent(frame.event)
      this.set({ messages: [...this.assembler.messages], running: this.assembler.running })
      return
    }
    if (frame.type === 'assistant-stream' && frame.frame) {
      this.assembler.applyStreamFrame(frame.frame)
      this.set({ messages: [...this.assembler.messages] })
    }
  }

  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId || !text.trim()) return
    try {
      await call('session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async cancelActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    try {
      await call('session/cancel', { request: { sessionId } })
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** The shared session store for the chat drawer. */
export const sessions = new SessionStore()
