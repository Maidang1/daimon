import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Fake WebSocket: captures instances so tests can drive server-side frames.
 * The mux module creates sockets through the global `WebSocket`, which vitest
 * replaces here before the module under test is (re)imported.
 */
class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** Test helpers simulating the server side. */
  serverOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  serverClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket)
// crypto.randomUUID exists in the node runtime; location does not.
vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:3180' })

const { mux } = await import('../src/terminal/dsh/mux.ts')

describe('dsh mux', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  it('opens the socket lazily and sends an open frame per stream', () => {
    expect(FakeWebSocket.instances).toHaveLength(0)
    mux.open('session/follow', { sessionId: 's1' }, { onItem: () => {} })
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toBe('ws://127.0.0.1:3180/api/remote.mux')
    expect(ws.sent).toHaveLength(0) // socket not OPEN yet
    ws.serverOpen()
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toMatchObject({ type: 'open', endpoint: 'session/follow', payload: { sessionId: 's1' } })
  })

  it('dispatches item/end frames to the matching stream only', () => {
    const aItems: unknown[] = []
    const bItems: unknown[] = []
    let aEnded = false
    const a = mux.open('$events', {}, { onItem: i => aItems.push(i), onEnd: () => { aEnded = true } })
    const b = mux.open('session/follow', { sessionId: 's2' }, { onItem: i => bItems.push(i) })
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    ws.serverSend({ type: 'item', streamId: a.streamId, value: { hello: 'a' } })
    ws.serverSend({ type: 'item', streamId: b.streamId, value: { hello: 'b' } })
    ws.serverSend({ type: 'end', streamId: a.streamId })
    expect(aItems).toEqual([{ hello: 'a' }])
    expect(bItems).toEqual([{ hello: 'b' }])
    expect(aEnded).toBe(true)
    // Frames for unknown/closed streams are dropped silently.
    ws.serverSend({ type: 'item', streamId: a.streamId, value: 'late' })
    expect(aItems).toHaveLength(1)
  })

  it('reports error frames and removes the stream', () => {
    let error: string | undefined | null = null
    const s = mux.open('session/follow', {}, { onItem: () => {}, onError: m => { error = m ?? null } })
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    ws.serverSend({ type: 'error', streamId: s.streamId, error: { message: 'boom' } })
    expect(error).toBe('boom')
    // The stream is gone: a later item does not throw or reach handlers.
    ws.serverSend({ type: 'item', streamId: s.streamId, value: 1 })
  })

  it('close() removes the stream and notifies the remote when connected', () => {
    const s = mux.open('$events', {}, { onItem: () => {} })
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    s.close()
    const closeFrames = ws.sent.filter((f: any) => f.type === 'cancel')
    expect(closeFrames).toEqual([{ type: 'cancel', streamId: s.streamId }])
  })

  it('reconnects with backoff and re-opens live streams, firing onReopen', () => {
    let reopened = 0
    mux.open('$events', {}, { onItem: () => {}, onReopen: () => { reopened++ } })
    const ws1 = FakeWebSocket.instances[0]
    ws1.serverOpen()
    ws1.serverClose()
    // First retry after 500ms.
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const ws2 = FakeWebSocket.instances[1]
    ws2.serverOpen()
    expect(reopened).toBe(1)
    expect(ws2.sent.filter((f: any) => f.type === 'open')).toHaveLength(1)
    // A successful open reset the backoff, so the next retry is 500ms again.
    ws2.serverClose()
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(3)
    // This attempt never opened, so the backoff grows to 1000ms.
    const ws3 = FakeWebSocket.instances[2]
    ws3.serverClose()
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('drops frames with malformed JSON instead of throwing', () => {
    mux.open('$events', {}, { onItem: () => {} })
    const ws = FakeWebSocket.instances[0]
    ws.serverOpen()
    ws.onmessage?.({ data: '{not json' })
  })
})
