import { describe, expect, it } from 'vitest'
import { FollowAssembler } from '../src/terminal/dsh/follow.ts'
import { parseChatEvent, parseWireEvent, type ChatEvent } from '../src/terminal/dsh/wire.ts'

/** One durable event, from raw JSON as it arrives on the socket. */
const ev = (type: string, seq: number, data: unknown): ChatEvent =>
  parseChatEvent(parseWireEvent({ type, seq, time: 0, data })!)

describe('FollowAssembler', () => {
  it('renders a turn: user bubble, live stream, then the settled message', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('turn/start', 1, {}))
    expect(a.running).toBe(true)

    a.applyStreamFrame({ type: 'start', attemptId: 'at1' })
    a.applyStreamFrame({ type: 'chunk', attemptId: 'at1', index: 0, text: 'Hel' })
    a.applyStreamFrame({ type: 'chunk', attemptId: 'at1', index: 0, text: 'lo' })
    expect(a.messages).toEqual([{ kind: 'assistant', id: 'stream-at1', text: 'Hello', streaming: true }])

    // The durable event supersedes the live bubble — exactly one settled bubble.
    a.applyEvent(ev('assistant/message', 2, { message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } }))
    expect(a.messages).toEqual([{ kind: 'assistant', id: 'm1', text: 'Hello', streaming: false }])

    a.applyEvent(ev('turn/end', 3, {}))
    expect(a.running).toBe(false)
  })

  it('leaves a user bubble out of the transcript for synthetic injections', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }))
    expect(a.messages).toEqual([{ kind: 'user', id: 'u-1', text: 'hi' }])
  })

  it('updates a tool card in place, so consumers see a new object not a mutation', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('tool/call', 1, { callId: 'c1', name: 'python', arguments: '{}' }))
    const before = a.messages[0]
    a.applyEvent(ev('tool/result', 2, { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }))
    expect(a.messages[0]).toEqual({
      kind: 'tool', id: 'c1', name: 'python', argsSummary: '{}', output: 'ok', status: 'done',
    })
    // The previous message object is untouched: this is why the card map was removed.
    expect(before).toEqual({ kind: 'tool', id: 'c1', name: 'python', argsSummary: '{}', status: 'running' })
  })

  it('ignores a result whose call never appeared', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('tool/result', 1, { message: { toolCallId: 'nope', content: [] } }))
    expect(a.messages).toEqual([])
  })

  it('replays a compact stream snapshot into one settled bubble', () => {
    const a = new FollowAssembler()
    a.applyCompactStream('at1', [{ type: 'text-chunks', index: 0, texts: ['ab'] }, { type: 'text-chunks', index: 1, texts: ['cd'] }])
    expect(a.messages).toEqual([{ kind: 'assistant', id: 'stream-at1', text: 'abcd', streaming: true }])
    a.applyStreamFrame({ type: 'end', attemptId: 'at1' })
    expect(a.messages).toEqual([])
  })

  it('keeps a running flag across an aborted turn and records the notice', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('turn/start', 1, {}))
    a.applyEvent(ev('turn/end', 2, { reason: { kind: 'aborted' } }))
    expect(a.running).toBe(false)
    expect(a.messages).toEqual([{ kind: 'notice', id: 'stop-2', tone: 'info', text: '已停止' }])
  })

  it('surfaces an error turn as a notice', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('turn/end', 1, { reason: { kind: 'error', error: { message: 'boom' } } }))
    expect(a.messages).toEqual([{ kind: 'notice', id: 'err-1', tone: 'error', text: '出错了：boom' }])
  })

  it('marks an interrupted assistant message', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('assistant/message', 1, {
      message: { id: 'm1', content: [{ type: 'text', text: 'partial' }] },
      interrupted: true,
    }))
    expect(a.messages).toEqual([{ kind: 'assistant', id: 'm1', text: 'partial\n\n*（中断）*', streaming: false }])
  })

  it('drops the live bubble for one attempt without touching other attempts', () => {
    const a = new FollowAssembler()
    a.applyStreamFrame({ type: 'start', attemptId: 'at1' })
    a.applyStreamFrame({ type: 'start', attemptId: 'at2' })
    a.applyStreamFrame({ type: 'chunk', attemptId: 'at1', index: 0, text: 'one' })
    a.applyStreamFrame({ type: 'chunk', attemptId: 'at2', index: 0, text: 'two' })
    expect(a.messages.map(m => m.id)).toEqual(['stream-at1', 'stream-at2'])
    a.applyStreamFrame({ type: 'end', attemptId: 'at1' })
    expect(a.messages.map(m => m.id)).toEqual(['stream-at2'])
  })

  it('does nothing for an event type this v1 does not render', () => {
    const a = new FollowAssembler()
    a.applyEvent(ev('system/message', 1, { text: 'x' }))
    a.applyEvent(ev('compaction/start', 2, {}))
    expect(a.messages).toEqual([])
    expect(a.running).toBe(false)
  })
})
