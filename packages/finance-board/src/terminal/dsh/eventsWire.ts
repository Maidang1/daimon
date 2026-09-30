/**
 * Wire parsing for the `$events` downlink stream.
 *
 * The stream is untyped JSON over the mux; these frames used to be asserted
 * into shape and then defended with `?.`/`??` at each leaf, so a renamed field
 * turned into `'unknown'` or an empty questions list rather than a
 * diagnosable drop. Frames are validated here and dropped (with a debug line)
 * when they do not match.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/dsh/eventsWire
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** One question inside a user-questions banner. */
export interface UserQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** One pending approval banner for the chat panel. */
export interface ApprovalRequest {
  eventId: string
  toolName: string
  callId?: string
  reason?: string
  displayReason?: string
}

/** One pending user-questions banner for the chat panel. */
export interface UserQuestionsRequest {
  eventId: string
  questions: UserQuestion[]
}

/**
 * A waterfall request, parsed.
 *
 * `approval/request` and `user-questions/request` carry different payloads;
 * both are reduced here to the fields their banner needs, so downstream code
 * never re-derives a shape.
 */
export interface WaterfallRequest {
  toolName: string
  callId?: string
  reason?: string
  displayReason?: string
  questions: UserQuestion[]
}

/** One downlink frame of the `$events` stream. */
export type DownlinkFrame =
  | { type: 'ready'; clientId: string }
  | { type: 'emit'; event: string; args: unknown[] }
  | { type: 'waterfall'; event: string; eventId: string; request: WaterfallRequest }
  | { type: 'cancel'; eventId: string }

/** A waterfall frame, for the handler that dispatches on `event`. */
export type WaterfallFrame = Extract<DownlinkFrame, { type: 'waterfall' }>

function parseQuestions(value: unknown): UserQuestion[] {
  if (!Array.isArray(value)) return []
  const out: UserQuestion[] = []
  for (const item of value) {
    const q = asRecord(item)
    const id = asString(q?.id)
    const question = asString(q?.question)
    if (!q || !id || !question) continue
    out.push({
      id,
      question,
      detail: asString(q.detail) ?? undefined,
      header: asString(q.header) ?? undefined,
      multiSelect: q.multiSelect === true ? true : undefined,
      options: Array.isArray(q.options)
        ? q.options.flatMap(o => {
            const option = asRecord(o)
            const label = asString(option?.label)
            return label ? [{ label, description: asString(option?.description) ?? undefined }] : []
          })
        : undefined,
    })
  }
  return out
}

function parseWaterfallRequest(value: unknown): WaterfallRequest {
  const req = asRecord(value)
  const display = asRecord(req?.displayReason)
  return {
    toolName: asString(req?.toolName) ?? 'unknown',
    callId: asString(req?.callId) ?? undefined,
    reason: asString(req?.reason) ?? undefined,
    displayReason: asString(display?.zh) ?? asString(display?.en) ?? undefined,
    questions: parseQuestions(req?.questions),
  }
}

/** Validate one downlink frame. */
export function parseDownlinkFrame(item: unknown): DownlinkFrame | null {
  const frame = asRecord(item)
  if (!frame) return null
  switch (asString(frame.type)) {
    case 'ready': {
      const clientId = asString(frame.clientId)
      return clientId ? { type: 'ready', clientId } : null
    }
    case 'emit': {
      const event = asString(frame.event)
      return event ? { type: 'emit', event, args: Array.isArray(frame.args) ? frame.args : [] } : null
    }
    case 'waterfall': {
      const event = asString(frame.event)
      const eventId = asString(frame.eventId)
      if (!event || !eventId) return null
      return { type: 'waterfall', event, eventId, request: parseWaterfallRequest(frame.request) }
    }
    case 'cancel': {
      const eventId = asString(frame.eventId)
      return eventId ? { type: 'cancel', eventId } : null
    }
    default:
      console.debug('[events] unrendered downlink frame', frame.type)
      return null
  }
}
