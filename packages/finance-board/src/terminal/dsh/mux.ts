/**
 * WebSocket multiplexer for the dsh streaming transport (dsh 0.1.7-rc.2).
 *
 * A single WS at `/api/remote.mux` carries every stream. The client opens a
 * stream with `{type:"open", streamId, endpoint, payload}`; the server then
 * sends `{type:"item"|"end"|"error", streamId, ...}` frames until the stream
 * terminates. Both `$events` and `session/follow` ride on this socket.
 *
 * Reconnects use exponential backoff (500ms → 10s, mirroring the official
 * SPA's connection-recovery semantics). Live streams are re-opened after a
 * reconnect and their `onReopen` hook fires so stateful consumers (e.g.
 * session/follow) can resynchronise from a fresh snapshot.
 */

/** One frame received from the mux socket, narrowed by `type`. */
export type MuxFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error?: { code?: string; message?: string } }

/** Handlers for one logical stream on the mux. */
export interface StreamHandlers {
  /** One item frame for this stream. */
  onItem: (item: unknown) => void
  /** The stream ended normally. */
  onEnd?: () => void
  /** The stream failed; `message` may be undefined for transport failures. */
  onError?: (message: string | undefined) => void
  /** Fired after a reconnect re-opened this stream — resynchronise state. */
  onReopen?: () => void
}

/** Handle over one open stream; `close` ends it locally and remotely. */
export interface StreamHandle {
  readonly streamId: string
  close: () => void
}

/** The mux socket's connection state, as the UI indicator consumes it. */
export type ConnectionState = 'connecting' | 'open' | 'closed'

type ConnectionListener = (state: ConnectionState) => void

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 10_000

interface ActiveStream extends StreamHandlers {
  endpoint: string
  payload: unknown
  streamId: string
  closed: boolean
  /** True once an open frame actually went out on a live socket. */
  openedOnce: boolean
}

/**
 * The mux singleton. Streams opened while the socket is down are queued and
 * sent once the connection (re)establishes.
 */
class Mux {
  private ws: WebSocket | null = null
  private readonly streams = new Map<string, ActiveStream>()
  private readonly listeners = new Set<ConnectionListener>()
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  /** Current socket state, for the connection indicator in the UI. */
  state: ConnectionState = 'closed'

  /** Subscribe to connection-state changes; returns an unsubscribe fn. */
  onStateChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  /** Open the socket if needed and register a stream on it. */
  open(endpoint: string, payload: unknown, handlers: StreamHandlers): StreamHandle {
    this.ensureConnected()
    const streamId = crypto.randomUUID()
    const stream: ActiveStream = { endpoint, payload, streamId, closed: false, openedOnce: false, ...handlers }
    this.streams.set(streamId, stream)
    this.sendOpen(stream)
    return {
      streamId,
      close: () => this.closeStream(streamId, true),
    }
  }

  /** Tear down every stream and stop reconnecting (page teardown only). */
  dispose(): void {
    this.started = false
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.streams.clear()
    this.setState('closed')
  }

  private ensureConnected(): void {
    if (this.started) return
    this.started = true
    this.connect()
  }

  private connect(): void {
    if (!this.started) return
    this.setState('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/remote.mux`)
    this.ws = ws
    ws.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS
      this.setState('open')
      // Re-open every live stream; stateful consumers resync via onReopen.
      for (const stream of this.streams.values()) {
        if (!stream.closed) this.sendOpen(stream)
      }
    }
    ws.onmessage = (ev: MessageEvent) => {
      let frame: MuxFrame
      try {
        frame = JSON.parse(String(ev.data)) as MuxFrame
      } catch {
        return
      }
      const stream = this.streams.get(frame.streamId)
      if (!stream) return
      if (frame.type === 'item') {
        stream.onItem(frame.value)
      } else if (frame.type === 'end') {
        this.streams.delete(frame.streamId)
        stream.onEnd?.()
      } else if (frame.type === 'error') {
        this.streams.delete(frame.streamId)
        stream.onError?.(frame.error?.message)
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.setState('closed')
      if (!this.started) return
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, delay)
    }
    ws.onerror = () => {
      // onclose follows and drives the reconnect; nothing to report per stream.
    }
  }

  private sendOpen(stream: ActiveStream): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'open',
        streamId: stream.streamId,
        endpoint: stream.endpoint,
        payload: stream.payload,
      }))
      // onReopen signals a resync, so it fires only when this stream had
      // already been opened on a previous connection — not on its first open.
      if (stream.openedOnce) stream.onReopen?.()
      stream.openedOnce = true
    }
    // Otherwise the stream stays queued until onopen re-opens it.
  }

  private closeStream(streamId: string, notifyRemote: boolean): void {
    const stream = this.streams.get(streamId)
    if (!stream) return
    stream.closed = true
    this.streams.delete(streamId)
    // The wire verb for a client-initiated stream shutdown is `cancel`.
    if (notifyRemote && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel', streamId }))
    }
  }
}

/** The shared mux connection for this page. */
export const mux = new Mux()
