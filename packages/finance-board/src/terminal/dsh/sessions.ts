/**
 * Session store: list / create / follow / prompt / cancel over the dsh session
 * remote.
 *
 * This module is the store only. Wire parsing lives in `wire.ts` and the
 * transcript reducer in `follow.ts`, which leaves this file responsible for
 * one thing: the lifecycle of the active session and its follow stream.
 *
 * Protocol pinned to dsh 0.1.7-rc.2 (see dsh-api-session-controller
 * lib/types/types.d.ts and dsh-session SessionEventMap). Bumping dsh
 * requires re-verifying `wire.ts` and `follow.ts`.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/dsh/sessions
 */

import { mux, type StreamHandle } from './mux.js'
import { call } from './rpc.js'
import { FollowAssembler } from './follow.js'
import { onEvent, startEvents } from './events.js'
import { parseFollowFrame, parseChatEvent } from './wire.js'
import type { ChatMessage } from '../chat/MessageList.js'

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

class SessionStore {
  private state: ChatState = initialState
  private readonly listeners = new Set<Listener>()
  /** The one live follow stream, owned exclusively by `closeFollow`. */
  private followHandle: StreamHandle | null = null
  private assembler = new FollowAssembler()
  private started = false
  /** In-flight session creation, so concurrent prompts share one session. */
  private creating: Promise<string> | null = null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  /** One error path for every await in this store. */
  private fail(err: unknown): void {
    this.set({ error: err instanceof Error ? err.message : String(err) })
  }

  /**
   * First-load wiring: events stream + initial session list.
   *
   * Called exactly once, from each bundle's entry point (the terminal app and
   * the legacy sidebar panel). Not from a component effect: whoever mounted
   * first used to win, which made the `$events` wiring an invisible ordering
   * dependency between `Sidebar`, `ChatPanel` and `App`.
   */
  start(): void {
    if (this.started) return
    this.started = true
    startEvents()
    onEvent({ onSessionsChanged: () => void this.refreshSessions() })
    void this.refreshSessions()
  }

  /**
   * Re-read the session list.
   *
   * Auto-selects the most recent session only when asked (first load). It is
   * not a side effect of every refresh: a caller refreshing while no session
   * is active used to silently hijack the view and open a follow stream.
   */
  async refreshSessions(autoSelect = false): Promise<void> {
    try {
      const value = await call<{ items: SessionInfo[] }>('session/list', { _request: {} })
      const sessions = value.items ?? []
      this.set({ sessions, error: null })
      if (autoSelect && !this.state.activeSessionId && sessions.length > 0) {
        this.selectSession(sessions[0].sessionId)
      }
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Send one prompt, creating a session first if none is active.
   *
   * This is the single "say something" entry point. Home suggestions, fund
   * follow-ups and the chat composer all funnel through it, so the policy is
   * stated once instead of being re-derived (and diverging) per composer.
   */
  async ask(text: string): Promise<void> {
    if (!text.trim()) return
    try {
      await this.prompt(await this.ensureSession(), text)
    } catch (err) {
      this.fail(err)
    }
  }

  /** New chat: create a session (or reuse the active one) and select it. */
  async newSession(): Promise<string> {
    return this.createSession()
  }

  /**
   * The active session, creating one if there is none.
   *
   * The in-flight promise is memoised, so two prompts fired before the first
   * `session/create` resolves share one session instead of racing two and
   * stranding one prompt.
   */
  private ensureSession(): Promise<string> {
    const active = this.state.activeSessionId
    if (active) return Promise.resolve(active)
    this.creating ??= this.createSession().finally(() => {
      this.creating = null
    })
    return this.creating
  }

  /** Create a session and select it. */
  async createSession(): Promise<string> {
    try {
      const value = await call<{ sessionId: string }>('session/create', { request: {} })
      // Select first, then refresh: refreshing first used to auto-select
      // `sessions[0]` and open a follow stream that this line immediately
      // closed and re-opened, so every new chat cost two round-trips.
      this.selectSession(value.sessionId)
      void this.refreshSessions()
      return value.sessionId
    } catch (err) {
      this.fail(err)
      throw err
    }
  }

  /** The one owner of the follow stream's lifetime. */
  private closeFollow(): void {
    this.followHandle?.close()
    this.followHandle = null
  }

  selectSession(sessionId: string): void {
    if (this.state.activeSessionId === sessionId && this.followHandle) return
    this.closeFollow()
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
      // The mux forgets a stream once it ends or errors, so the handle must be
      // released here too — otherwise re-selecting this session was a no-op
      // and the user stayed pinned to a dead stream.
      onError: message => {
        this.closeFollow()
        this.set({ error: message ?? '会话流中断', loading: false })
      },
      onEnd: () => {
        this.closeFollow()
        this.set({ loading: false })
      },
      onReopen: () => {
        // The re-opened stream restarts from a fresh snapshot; drop state.
        this.assembler = new FollowAssembler()
        this.set({ messages: [], loading: true })
      },
    })
  }

  private onFollowFrame(item: unknown): void {
    const frame = parseFollowFrame(item)
    switch (frame.type) {
      case 'snapshot': {
        this.assembler = new FollowAssembler()
        for (const record of frame.records) this.assembler.applyEvent(parseChatEvent(record))
        if (frame.activeAttempt) {
          this.assembler.applyCompactStream(frame.activeAttempt.attemptId, frame.activeAttempt.stream)
        }
        this.set({ messages: [...this.assembler.messages], running: this.assembler.running, loading: false })
        return
      }
      case 'event':
        this.assembler.applyEvent(parseChatEvent(frame.event))
        this.set({ messages: [...this.assembler.messages], running: this.assembler.running })
        return
      case 'assistant-stream':
        this.assembler.applyStreamFrame(frame.frame)
        this.set({ messages: [...this.assembler.messages] })
        return
      case 'unhandled':
        return
    }
  }

  private async prompt(sessionId: string, text: string): Promise<void> {
    await call('session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  }

  async cancelActive(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    try {
      await call('session/cancel', { request: { sessionId } })
    } catch (err) {
      this.fail(err)
    }
  }
}

/** The shared session store for the terminal. */
export const sessions = new SessionStore()
