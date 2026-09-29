/**
 * `$events` subscription: the Gateway-internal forwarded-event stream on the
 * mux (protocol pinned to dsh 0.1.7-rc.2, see dsh-api-gateway
 * stream-protocol.d.ts).
 *
 * Lifecycle: open the `$events` stream with payload `{args:{}}`; the first
 * item is a `ready` frame binding this generation's `clientId`. Later items
 * are `emit` notifications (logged; session added/removed trigger a list
 * refresh) and `waterfall` invocations that MUST be answered through
 * `POST /api/$events/result` — an unanswered waterfall parks the agent
 * forever. Known waterfall types (approval/request, user-questions/request)
 * surface as UI banners; unknown types are answered `{kind:'next'}`
 * (delegate, i.e. fail-open down the answerer chain) without disturbing the
 * user. A `cancel` frame withdraws a pending waterfall.
 */

import { mux } from './mux.js'
import { call } from './rpc.js'

/** One pending approval banner for the chat drawer. */
export interface ApprovalRequest {
  eventId: string
  toolName: string
  callId?: string
  reason?: string
  displayReason?: string
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

/** One pending user-questions banner for the chat drawer. */
export interface UserQuestionsRequest {
  eventId: string
  questions: UserQuestion[]
}

export interface EventsListener {
  /** A session was added or removed on the Host — refresh the list. */
  onSessionsChanged?: () => void
  /** A new approval or questions request needs an answer. */
  onApproval?: (req: ApprovalRequest) => void
  onQuestions?: (req: UserQuestionsRequest) => void
  /** A pending request was withdrawn by the Host. */
  onWithdrawn?: (eventId: string) => void
}

type DownlinkFrame =
  | { type: 'ready'; clientId: string }
  | { type: 'emit'; event: string; args: unknown[] }
  | { type: 'waterfall'; event: string; eventId: string; request: Record<string, unknown> }
  | { type: 'cancel'; eventId: string }

const listeners = new Set<EventsListener>()

/** Subscribe to `$events` notifications; returns an unsubscribe fn. */
export function onEvent(listener: EventsListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let clientId: string | null = null
/** eventIds the user is currently being asked about (survive reconnects only until the socket drops). */
const pending = new Set<string>()
let started = false

/** Answer one waterfall. Unanswered waterfalls park the agent — never drop. */
async function answer(eventId: string, outcome: Record<string, unknown>): Promise<void> {
  if (!clientId) return
  try {
    // The $events/result interceptor reads payload.args verbatim (not the
    // typert {request} convention).
    await call('$events/result', { clientId, eventId, outcome } as unknown as Record<string, unknown>)
  } catch (err) {
    console.warn('[events] failed to answer', eventId, err)
  } finally {
    pending.delete(eventId)
  }
}

/** User decision helpers used by the chat drawer banners. */
export function answerApproval(eventId: string, outcome: 'allowed-once' | 'rejected'): void {
  void answer(eventId, { kind: 'result', value: outcome })
}

export function answerQuestions(eventId: string, answers: { id: string; selected: string[]; custom?: string }[]): void {
  void answer(eventId, { kind: 'result', value: { answers } })
}

function handleWaterfall(frame: Extract<DownlinkFrame, { type: 'waterfall' }>): void {
  pending.add(frame.eventId)
  const req = frame.request ?? {}
  if (frame.event === 'approval/request') {
    const display = req.displayReason as { zh?: string; en?: string } | undefined
    for (const l of listeners) {
      l.onApproval?.({
        eventId: frame.eventId,
        toolName: String(req.toolName ?? 'unknown'),
        callId: req.callId as string | undefined,
        reason: req.reason as string | undefined,
        displayReason: display?.zh ?? display?.en,
      })
    }
    return
  }
  if (frame.event === 'user-questions/request') {
    const questions = (req.questions ?? []) as UserQuestion[]
    for (const l of listeners) {
      l.onQuestions?.({ eventId: frame.eventId, questions })
    }
    return
  }
  // Unknown waterfall: delegate down the answerer chain instead of parking
  // the agent on a request this UI cannot present.
  console.debug('[events] unanswered waterfall, delegating:', frame.event)
  void answer(frame.eventId, { kind: 'next' })
}

function handleFrame(item: unknown): void {
  const frame = item as DownlinkFrame
  if (!frame || typeof frame !== 'object') return
  switch (frame.type) {
    case 'ready':
      clientId = frame.clientId
      console.debug('[events] ready, clientId', clientId)
      return
    case 'emit':
      console.debug('[events] emit', frame.event)
      if (frame.event === 'api-session/added' || frame.event === 'api-session/removed') {
        for (const l of listeners) l.onSessionsChanged?.()
      }
      return
    case 'waterfall':
      handleWaterfall(frame)
      return
    case 'cancel':
      pending.delete(frame.eventId)
      for (const l of listeners) l.onWithdrawn?.(frame.eventId)
      return
  }
}

/**
 * Start the `$events` stream (idempotent). On a mux reconnect the stream is
 * re-opened by the mux itself; the fresh `ready` frame hands us a new
 * clientId (the Host keys results to the live generation, so answers always
 * use the latest one). Waterfalls that were pending across the drop died
 * with their generation; the Host re-delivers still-pending requests on the
 * new generation.
 */
export function startEvents(): void {
  if (started) return
  started = true
  mux.open('$events', { args: {} }, {
    onItem: handleFrame,
    onError: message => console.warn('[events] stream error:', message),
    onEnd: () => console.debug('[events] stream ended'),
    onReopen: () => {
      clientId = null
      console.debug('[events] reopened, awaiting ready')
    },
  })
}
