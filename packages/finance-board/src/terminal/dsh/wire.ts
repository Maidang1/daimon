/**
 * Wire parsing for the `session/follow` and `assistant-stream` frames.
 *
 * Protocol pinned to dsh 0.1.7-rc.2 (see dsh-api-session-controller
 * lib/types/types.d.ts and dsh-session SessionEventMap); bumping dsh
 * requires re-verifying this module.
 *
 * Everything arriving on the socket used to be asserted into shape —
 * `event.data as Record<string, never>`, then re-cast per branch — which
 * meant a renamed field failed *silently and partially*: `undefined` fell
 * through the `?.`/`??` chain and surfaced as `'tool'`, `'（完成）'` or an
 * empty string instead of a diagnosable error. Frames are now validated
 * field-by-field here and dropped (with a debug line) when they do not
 * match, the same discipline `rlm-kernel/src/protocol.ts` uses. Downstream,
 * `follow.ts` consumes a parsed union and contains no casts at all.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/dsh/wire
 */

/** One durable session event, as it arrives off the wire. */
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/* ---------- small readers ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** One content block of a message. */
export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
}

/** Validate a content-block array; anything else is no blocks. */
export function parseContentBlocks(value: unknown): ContentBlock[] {
  const arr = Array.isArray(value) ? value : []
  const out: ContentBlock[] = []
  for (const item of arr) {
    const block = asRecord(item)
    const type = asString(block?.type)
    if (!block || !type) continue
    out.push({
      type,
      text: asString(block.text) ?? undefined,
      id: asString(block.id) ?? undefined,
      name: asString(block.name) ?? undefined,
      arguments: asString(block.arguments) ?? undefined,
    })
  }
  return out
}

/** The text a message renders as. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/** One-line preview of a tool call's arguments. */
export function argsSummary(raw: string | undefined): string {
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > 90 ? `${compact.slice(0, 90)}…` : compact
}

/* ---------- event parsing ---------- */

/**
 * One durable event, normalised into what the chat UI consumes.
 *
 * `unhandled` is a real outcome, not a silence: dsh emits event types this
 * v1 does not render, and a protocol change that adds a new one should be
 * visible in the console rather than degrade the transcript invisibly.
 */
export type ChatEvent = { seq: number } & (
  | { type: 'turn/start' }
  | { type: 'turn/end'; reason: 'error' | 'aborted' | null; message: string | null }
  | { type: 'user/message'; id: string; text: string }
  | { type: 'assistant/message'; id: string; text: string; interrupted: boolean }
  | { type: 'tool/call'; id: string; name: string; argsSummary: string }
  | { type: 'tool/result'; id: string; output: string; isError: boolean }
  | { type: 'unhandled'; raw: string })

/** Validate one `{type, seq, time, data}` event. */
export function parseWireEvent(item: unknown): WireEvent | null {
  const event = asRecord(item)
  if (!event) return null
  const type = asString(event.type)
  const seq = asNumber(event.seq)
  if (type === null || seq === null) return null
  return { type, seq, time: asNumber(event.time) ?? 0, data: event.data }
}

/** Normalise one durable event for the chat transcript. */
export function parseChatEvent(event: WireEvent): ChatEvent {
  const data = asRecord(event.data)
  // `seq` is on every member: the transcript derives stable ids from it.
  const seq = { seq: event.seq }
  switch (event.type) {
    case 'turn/start':
      return { ...seq, type: 'turn/start' }

    case 'turn/end': {
      const reason = asRecord(data?.reason)
      if (asString(reason?.kind) === 'error') {
        return { ...seq, type: 'turn/end', reason: 'error', message: asString(asRecord(reason?.error)?.message) }
      }
      if (asString(reason?.kind) === 'aborted') return { ...seq, type: 'turn/end', reason: 'aborted', message: null }
      return { ...seq, type: 'turn/end', reason: null, message: null }
    }

    case 'user/message': {
      const source = asRecord(data?.source)
      // Synthetic injections stay hidden in v1.
      if (source !== null && asString(source.kind) !== 'user') return { ...seq, type: 'unhandled', raw: event.type }
      const text = textOf(parseContentBlocks(data?.content))
      if (!text.trim()) return { ...seq, type: 'unhandled', raw: event.type }
      return { ...seq, type: 'user/message', id: asString(data?.id) ?? `u-${event.seq}`, text }
    }

    case 'assistant/message': {
      const message = asRecord(data?.message)
      const text = textOf(parseContentBlocks(message?.content))
      if (!text.trim()) return { ...seq, type: 'unhandled', raw: event.type }
      return {
        ...seq,
        type: 'assistant/message',
        id: asString(message?.id) ?? `a-${event.seq}`,
        text,
        interrupted: data?.interrupted === true,
      }
    }

    case 'tool/call': {
      const callId = asString(data?.callId)
      if (!callId) return { ...seq, type: 'unhandled', raw: event.type }
      return {
        ...seq,
        type: 'tool/call',
        id: callId,
        name: asString(data?.name) ?? 'tool',
        argsSummary: argsSummary(asString(data?.arguments) ?? undefined),
      }
    }

    case 'tool/result': {
      const message = asRecord(data?.message)
      const callId = asString(message?.toolCallId)
      if (!callId) return { ...seq, type: 'unhandled', raw: event.type }
      const output = textOf(parseContentBlocks(message?.content))
      const isError = message?.isError === true
      return { ...seq, type: 'tool/result', id: callId, output: output || (isError ? '（无输出）' : '（完成）'), isError }
    }

    default:
      // step/*, request/*, system/message, compaction/* … not rendered in v1.
      console.debug('[wire] unrendered event type', event.type)
      return { ...seq, type: 'unhandled', raw: event.type }
  }
}

/* ---------- follow-frame parsing ---------- */

/** One increment of a live assistant stream. */
export type StreamFrame =
  | { type: 'start'; attemptId: string }
  | { type: 'chunk'; attemptId: string; index: number; text: string }
  | { type: 'end'; attemptId: string }

/** One frame of the `session/follow` stream. */
export type FollowFrame =
  | { type: 'snapshot'; records: WireEvent[]; activeAttempt: { attemptId: string; stream: unknown[] } | null }
  | { type: 'event'; event: WireEvent }
  | { type: 'assistant-stream'; frame: StreamFrame }
  | { type: 'unhandled' }

/** Per-block accumulated text from a compact assistant stream. */
export interface CompactChunk {
  index: number
  texts: string[]
}

/** Validate the compact `text-chunks` records of an in-flight attempt. */
export function parseCompactStream(stream: unknown): CompactChunk[] {
  if (!Array.isArray(stream)) return []
  const out: CompactChunk[] = []
  for (const item of stream) {
    const rec = asRecord(item)
    const index = asNumber(rec?.index)
    if (asString(rec?.type) !== 'text-chunks' || index === null || !Array.isArray(rec?.texts)) continue
    out.push({ index, texts: (rec.texts as unknown[]).filter(t => typeof t === 'string') as string[] })
  }
  return out
}

function parseStreamFrame(item: unknown): StreamFrame | null {
  const frame = asRecord(item)
  const attemptId = asString(frame?.attemptId)
  if (!frame || !attemptId) return null
  switch (asString(frame.type)) {
    case 'start':
      return { type: 'start', attemptId }
    case 'chunk': {
      const chunk = asRecord(frame.chunk)
      const index = asNumber(chunk?.index)
      if (asString(chunk?.type) !== 'text-delta' || index === null) return null
      return { type: 'chunk', attemptId, index, text: asString(chunk?.text) ?? '' }
    }
    case 'end':
      return { type: 'end', attemptId }
    default:
      console.debug('[wire] unrendered stream frame', frame.type)
      return null
  }
}

/** Parse the in-flight attempt a snapshot carries: `assistantStream.activeAttempt`. */
function parseActiveAttempt(value: unknown): { attemptId: string; stream: unknown[] } | null {
  const attempt = asRecord(asRecord(value)?.activeAttempt)
  const attemptId = asString(attempt?.attemptId)
  if (!attemptId) return null
  const raw = attempt?.stream
  return { attemptId, stream: Array.isArray(raw) ? raw : [] }
}

/** Validate one follow frame. */
export function parseFollowFrame(item: unknown): FollowFrame {
  const frame = asRecord(item)
  if (!frame) return { type: 'unhandled' }
  switch (asString(frame.type)) {
    case 'snapshot': {
      // Each record wraps its event: `{event: WireEvent}`.
      const records = Array.isArray(frame.records)
        ? frame.records.flatMap(record => {
            const event = parseWireEvent(asRecord(record)?.event)
            return event ? [event] : []
          })
        : []
      return { type: 'snapshot', records, activeAttempt: parseActiveAttempt(frame.assistantStream) }
    }
    case 'event': {
      const event = parseWireEvent(frame.event)
      return event ? { type: 'event', event } : { type: 'unhandled' }
    }
    case 'assistant-stream': {
      const inner = parseStreamFrame(frame.frame)
      return inner ? { type: 'assistant-stream', frame: inner } : { type: 'unhandled' }
    }
    default:
      console.debug('[wire] unrendered follow frame', frame.type)
      return { type: 'unhandled' }
  }
}
