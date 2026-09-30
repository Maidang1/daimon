import { describe, expect, it } from 'vitest'
import {
  parseChatEvent,
  parseCompactStream,
  parseFollowFrame,
  parseWireEvent,
} from '../src/terminal/dsh/wire.ts'
import { parseDownlinkFrame } from '../src/terminal/dsh/eventsWire.ts'

describe('wire event parsing', () => {
  it('accepts a well-formed event and defaults a missing time', () => {
    expect(parseWireEvent({ type: 'turn/start', seq: 3 })).toEqual({ type: 'turn/start', seq: 3, time: 0, data: undefined })
  })

  it('drops frames that are not objects or lack the required fields', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { type: 'turn/start' }, { seq: 3 }]) {
      expect(parseWireEvent(bad)).toBeNull()
    }
  })

  it('normalises a user message and hides synthetic injections', () => {
    const ev = (data: unknown): unknown => ({ type: 'user/message', seq: 1, time: 0, data })
    expect(parseChatEvent(parseWireEvent(ev({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }))!))
      .toEqual({ seq: 1, type: 'user/message', id: 'u-1', text: 'hi' })
    // A non-user source must not render — and must not silently become one either.
    expect(parseChatEvent(parseWireEvent(ev({ source: { kind: 'tool' }, content: [{ type: 'text', text: 'x' }] }))!))
      .toEqual({ seq: 1, type: 'unhandled', raw: 'user/message' })
    expect(parseChatEvent(parseWireEvent(ev({ source: { kind: 'user' }, content: [{ type: 'text', text: '  ' }] }))!))
      .toEqual({ seq: 1, type: 'unhandled', raw: 'user/message' })
  })

  it('reads turn/end reason without casting through unknown leaves', () => {
    const err = parseWireEvent({ type: 'turn/end', seq: 7, time: 0, data: { reason: { kind: 'error', error: { message: 'boom' } } } })!
    expect(parseChatEvent(err)).toEqual({ seq: 7, type: 'turn/end', reason: 'error', message: 'boom' })
    const aborted = parseWireEvent({ type: 'turn/end', seq: 8, time: 0, data: { reason: { kind: 'aborted' } } })!
    expect(parseChatEvent(aborted)).toEqual({ seq: 8, type: 'turn/end', reason: 'aborted', message: null })
    // A renamed field degrades to "no reason", not to a crash deeper in.
    const odd = parseWireEvent({ type: 'turn/end', seq: 9, time: 0, data: { reason: { kind: 'weird' } } })!
    expect(parseChatEvent(odd)).toEqual({ seq: 9, type: 'turn/end', reason: null, message: null })
  })

  it('normalises tool call and result payloads', () => {
    const call = parseChatEvent(parseWireEvent({
      type: 'tool/call', seq: 2, time: 0,
      data: { callId: 'c1', name: 'python', arguments: '{"a":\n 1}' },
    })!)
    expect(call).toEqual({ seq: 2, type: 'tool/call', id: 'c1', name: 'python', argsSummary: '{"a": 1}' })

    const result = parseChatEvent(parseWireEvent({
      type: 'tool/result', seq: 3, time: 0,
      data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'done' }], isError: true } },
    })!)
    expect(result).toEqual({ seq: 3, type: 'tool/result', id: 'c1', output: 'done', isError: true })

    // An empty result falls back to a label derived from isError, not from a guess.
    const empty = parseChatEvent(parseWireEvent({
      type: 'tool/result', seq: 4, time: 0, data: { message: { toolCallId: 'c1' } },
    })!)
    expect(empty).toEqual({ seq: 4, type: 'tool/result', id: 'c1', output: '（完成）', isError: false })
  })

  it('marks event types this v1 does not render, instead of dropping them silently', () => {
    expect(parseChatEvent(parseWireEvent({ type: 'system/message', seq: 5, time: 0, data: {} })!))
      .toEqual({ seq: 5, type: 'unhandled', raw: 'system/message' })
  })
})

describe('follow-frame parsing', () => {
  it('parses a snapshot with its records and active attempt', () => {
    const frame = parseFollowFrame({
      type: 'snapshot',
      records: [{ event: { type: 'turn/start', seq: 1, time: 0, data: {} } }, { event: null }, 'junk'],
      assistantStream: { activeAttempt: { attemptId: 'a1', stream: [{ type: 'text-chunks', index: 0, texts: ['x'] }] } },
    })
    expect(frame.type).toBe('snapshot')
    if (frame.type !== 'snapshot') throw new Error('unreachable')
    expect(frame.records).toHaveLength(1)
    expect(frame.activeAttempt).toEqual({ attemptId: 'a1', stream: [{ type: 'text-chunks', index: 0, texts: ['x'] }] })
  })

  it('validates assistant-stream increments and rejects unknown shapes', () => {
    expect(parseFollowFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', index: 1, text: 'hi' } } }))
      .toEqual({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', index: 1, text: 'hi' } })
    expect(parseFollowFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'reasoning-delta', index: 1, text: 'hi' } } }))
      .toEqual({ type: 'unhandled' })
    expect(parseFollowFrame({ type: 'assistant-stream', frame: { type: 'mystery', attemptId: 'a' } }))
      .toEqual({ type: 'unhandled' })
  })

  it('parses an event frame and drops a frame with no valid event', () => {
    expect(parseFollowFrame({ type: 'event', event: { type: 'turn/start', seq: 1, time: 0, data: {} } }).type).toBe('event')
    expect(parseFollowFrame({ type: 'event', event: { seq: 1 } })).toEqual({ type: 'unhandled' })
    expect(parseFollowFrame(null)).toEqual({ type: 'unhandled' })
    expect(parseFollowFrame({ type: 'some-new-frame' })).toEqual({ type: 'unhandled' })
  })

  it('reads only well-formed compact chunks', () => {
    expect(parseCompactStream([
      { type: 'text-chunks', index: 0, texts: ['a', 'b'] },
      { type: 'text-chunks', index: 'nope', texts: ['x'] },
      { type: 'reasoning-chunks', index: 1, texts: ['y'] },
      'junk',
    ])).toEqual([{ index: 0, texts: ['a', 'b'] }])
    expect(parseCompactStream('not a list')).toEqual([])
  })
})

describe('$events downlink parsing', () => {
  it('parses a ready frame, an emit, a waterfall and a cancel', () => {
    expect(parseDownlinkFrame({ type: 'ready', clientId: 'gen-1' })).toEqual({ type: 'ready', clientId: 'gen-1' })
    expect(parseDownlinkFrame({ type: 'emit', event: 'api-session/added', args: [1] }))
      .toEqual({ type: 'emit', event: 'api-session/added', args: [1] })
    expect(parseDownlinkFrame({ type: 'cancel', eventId: 'e1' })).toEqual({ type: 'cancel', eventId: 'e1' })
  })

  it('reduces both waterfall payload shapes to the fields the banners need', () => {
    const approval = parseDownlinkFrame({
      type: 'waterfall', event: 'approval/request', eventId: 'e1',
      request: { toolName: 'python', displayReason: { zh: '跑代码' }, reason: 'en' },
    })
    expect(approval).toEqual({
      type: 'waterfall', event: 'approval/request', eventId: 'e1',
      request: { toolName: 'python', callId: undefined, reason: 'en', displayReason: '跑代码', questions: [] },
    })

    const questions = parseDownlinkFrame({
      type: 'waterfall', event: 'user-questions/request', eventId: 'e2',
      request: { questions: [{ id: 'q1', question: 'which?', options: [{ label: 'A' }, { nope: 1 }] }] },
    })
    expect(questions).toEqual({
      type: 'waterfall', event: 'user-questions/request', eventId: 'e2',
      request: {
        toolName: 'unknown',
        callId: undefined, reason: undefined, displayReason: undefined,
        questions: [{ id: 'q1', question: 'which?', detail: undefined, header: undefined, multiSelect: undefined, options: [{ label: 'A', description: undefined }] }],
      },
    })
  })

  it('drops frames it cannot validate rather than asserting a shape', () => {
    for (const bad of [null, 'x', {}, { type: 'ready' }, { type: 'waterfall', event: 'approval/request' }, { type: 'nope' }]) {
      expect(parseDownlinkFrame(bad)).toBeNull()
    }
  })
})
