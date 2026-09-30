/**
 * The board's data layer: one poll, one owner.
 *
 * Three views used to each re-implement the same loop — load once on mount,
 * `setInterval` every 5s, fetch a cheap status, reload the heavy document
 * only when its mtime moved — and each copy diverged in the ways that matter:
 * one checked its `stopped` flag after the first await only, one not at all,
 * and none guarded against tick N+1 overlapping tick N-1's in-flight read,
 * which is exactly how a stale frame overwrites a newer one. Switching views
 * unmounted everything, so the same bytes were re-hydrated three times over.
 *
 * So the documents now live in one module-level store (the same
 * `subscribe`/`getState` + `useSyncExternalStore` shape `dsh/sessions.ts`
 * already established), the views are renderers, and the refresh policy
 * exists exactly once. Because the store outlives every view, there is no
 * post-unmount `setState` left to guard against.
 *
 * @module @deepseek-ai/dsh-finance-board/client/financeStore
 */

import { useSyncExternalStore } from 'react'
import {
  describeError,
  fetchBriefing,
  fetchSnapshot,
  fetchStatus,
  type BoardStatus,
  type Briefing,
  type JobRecord,
  type Resource,
  type Snapshot,
} from './api.js'

/** How often the cheap status document is re-read. */const POLL_MS = 5_000

/** One fetched document, plus the mtime the loaded frame corresponds to. */
interface DocState<T> {
  resource: Resource<T>
  /** `undefined` = never read; `null` = read, and the file is absent. */
  mtime: string | null | undefined
}

export interface FinanceState {
  /** `missing` = never generated (fresh install); `failed` = unreadable. */
  snapshot: DocState<Snapshot>
  /** `missing` = the agent has not generated today's briefing yet. */
  briefing: DocState<Briefing>
  /** Job records, newest first. */
  jobs: JobRecord[]
  /** When the underlying data last changed — the client's "updated at". */
  updatedAt: string | null
  /** Last transient read error. Cleared by the next successful poll, and kept
   *  alongside a good frame rather than replacing it. */
  error: string | null
}

type DocOutcome<T> = { ok: true; value: T | null } | { ok: false; error: string }

/** `mtime: undefined` is a real state: "not read yet" must differ from "read,
 *  and the file is not there", or a document that is missing on the first poll
 *  would never be fetched and the skeleton would stay up forever.
 */
const unread = <T,>(): DocState<T> => ({ resource: { kind: 'loading' }, mtime: undefined })

let state: FinanceState = {
  snapshot: unread(),
  briefing: unread(),
  jobs: [],
  updatedAt: null,
  error: null,
}

const listeners = new Set<() => void>()
let started = false
/** The pass currently in flight, so a slow one cannot overlap the next tick. */
let inFlight: Promise<void> | null = null

function set(patch: Partial<FinanceState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Read one document, turning a throw into a value `nextDoc` can branch on. */
async function readDoc<T>(read: () => Promise<T | null>): Promise<DocOutcome<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  }
}

/**
 * The next state for one document read.
 *
 * A transient failure keeps the previous frame — the board keeps working with
 * slightly stale data, which is far better than blanking — and only records a
 * `failed` resource when there is no frame to keep. The mtime advances only
 * on success, so a failed read is retried on the next tick.
 *
 * The error is *returned* rather than applied here: documents are read
 * concurrently, so two folds both writing a single `error` field would let the
 * later one erase the earlier one's failure.
 */
function nextDoc<T>(doc: DocState<T>, outcome: DocOutcome<T>, mtime: string | null): DocState<T> {
  if (outcome.ok) {
    return {
      mtime,
      resource: outcome.value ? { kind: 'ready', value: outcome.value } : { kind: 'missing' },
    }
  }
  if (doc.resource.kind === 'ready') return doc
  return { mtime, resource: { kind: 'failed', error: outcome.error } }
}

/** Read one document into the store; resolves to its error, if any. */
async function loadDoc<T>(
  current: () => DocState<T>,
  read: () => Promise<T | null>,
  mtime: string | null,
  apply: (doc: DocState<T>) => void,
): Promise<string | null> {
  const outcome = await readDoc(read)
  apply(nextDoc(current(), outcome, mtime))
  return outcome.ok ? null : outcome.error
}

function loadSnapshot(mtime: string | null): Promise<string | null> {
  return loadDoc(() => state.snapshot, fetchSnapshot, mtime, doc => set({ snapshot: doc }))
}

function loadBriefing(mtime: string | null): Promise<string | null> {
  return loadDoc(() => state.briefing, fetchBriefing, mtime, doc => set({ briefing: doc }))
}

/** One pass: the cheap status, then only the documents whose mtime moved. */
async function pass(): Promise<void> {
  let status: BoardStatus
  try {
    status = await fetchStatus()
  } catch (err) {
    // Without a status there are no mtimes to compare; surface it and keep
    // whatever frames we already hold.
    set({ error: describeError(err) })
    return
  }
  set({
    jobs: status.jobs,
    updatedAt: status.snapshot.mtime ?? status.dashboard.mtime,
    error: null,
  })
  // Independent documents, so they are fetched together. Their errors are
  // combined once, here, rather than each fold writing the shared field.
  const reloads: Promise<string | null>[] = []
  if (status.snapshot.mtime !== state.snapshot.mtime) reloads.push(loadSnapshot(status.snapshot.mtime))
  if (status.briefing.mtime !== state.briefing.mtime) reloads.push(loadBriefing(status.briefing.mtime))
  const errors = await Promise.all(reloads)
  set({ error: errors.find(e => e !== null) ?? null })
}

/** The polling loop. Serialized through `inFlight`, never overlapped. */
function tick(): Promise<void> {
  inFlight ??= pass().finally(() => {
    inFlight = null
  })
  return inFlight
}

function start(): void {
  if (started) return
  started = true
  setInterval(() => void tick(), POLL_MS)
  void tick()
}

/**
 * Subscribe to finance state; returns an unsubscribe fn.
 *
 * Starting on first subscribe means the data layer has no owner to forget: no
 * view has to remember to start it, and the legacy sidebar bundle and the
 * terminal share one poll instead of each running their own. The interval is
 * deliberately left running after the last unsubscribe, because views unmount
 * and remount constantly and restarting the poll on every switch would be
 * both wasteful and a fresh mount race each time.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) start()
  return () => {
    listeners.delete(listener)
  }
}

/** Force a pass now — used after an action the user just triggered. */
function refresh(): void {
  void tick()
}

export const finance = { subscribe, getState: (): FinanceState => state, refresh }

/** React binding for the finance store. */
export function useFinance(): FinanceState {
  return useSyncExternalStore(finance.subscribe, finance.getState)
}
