/**
 * Finance 终端 data types and fetch wrappers. Shapes mirror
 * `py/skills/finance/snapshot.py` (`state/ui_snapshot.json`) — keep the two
 * in sync when either side changes.
 */

export interface SnapshotMeta {
  finance_home: string
  pending_artifact: boolean
  artifact_updated_at: string | null
  artifact_job_kind: string | null
  artifact_summary: string | null
}

export interface SnapshotSummary {
  total_cost: number
  total_value: number | null
  total_pnl: number | null
  total_pnl_pct: number | null
  nav_asof: string
  positions_count: number
  valued_count: number
  ops_count: number
  funds_count: number
}

export interface Holding {
  code: string
  name: string
  shares: number
  cost: number
  avg: number | null
  nav: number | null
  navDate: string
  value: number | null
  pnl: number | null
  pnl_pct: number | null
}

export interface Op {
  index: number
  date: string
  code: string
  type: 'buy' | 'sell'
  shares: number
  price: number
  amount: number
  note: string
}

export interface FundSignal {
  ma20: number
  above_ma20: boolean
  trough: number
  below_trough: boolean
  ath: number
  dd_from_ath: number
}

export interface FundInfo {
  code: string
  name: string
  official_nav: number | null
  official_date: string | null
  pred_nav: number | null
  pred_ret: number | null
  pred_date: string | null
  pred_label: string | null
  pred_note: string | null
  /** Live-quote estimate for today when the locked prediction isn't out yet. */
  intraday: {
    date: string
    estRet: number
    estNav: number
    detail: { name: string; live: number; w: number }[]
    note: string
  } | null
  r2: number | null
  mae: number | null
  mae60: number | null
  p10: number | null
  p90: number | null
  weights: { name: string; pct: number }[]
  signals: FundSignal | null
  nav_tail: Record<string, number> | null
  result_updated_at: string | null
  accuracy: { n: number; avg_dev?: number; hit_rate?: number }
}

export interface TrackRec {
  code: string
  navDate: string
  predRet: number | null
  actualRet: number | null
  dev: number | null
}

export interface AccuracyBlock {
  n: number
  avg_dev?: number
  hit_rate?: number
  recent: TrackRec[]
}

export interface HotspotTheme {
  name: string
  market: string
  heat: number
  band: '热' | '温' | '冷'
  live: number
  ret1: number | null
  ret5: number | null
  ret20: number | null
  ret60: number | null
  ma20_dev: number | null
  dist_high: number | null
  vol20: number | null
  maxdd60: number | null
  pos_pct: number | null
  member_breadth: number | null
  vol_ratio: number | null
  above_ma20: boolean
  pe_med: number | null
  leaders: { ticker: string; name: string; ret20: number }[]
  laggards: { ticker: string; name: string; ret20: number }[]
  catalysts?: { date: string | null; title: string; source: string | null }[]
}

export interface HotspotData {
  generated_at: string
  market: {
    regime: string
    breadth: number | null
    summary: string
    catalysts?: { date: string | null; title: string; source: string | null }[]
  }
  themes: HotspotTheme[]
  top_picks?: {
    ticker: string
    name: string
    theme: string
    ret20: number
    heat: number
    reason: string
  }[]
}

export interface HotspotBlock {
  data: HotspotData | null
  age_seconds: number | null
}

export interface Snapshot {
  version: number
  generated_at: string
  meta: SnapshotMeta
  summary: SnapshotSummary
  holdings: Holding[]
  ops: Op[]
  funds: FundInfo[]
  accuracy: AccuracyBlock
  hotspot: HotspotBlock
  /** Sector look-through. Emitted by `ui_snapshot(include_lookthrough=True)` and
   *  mirrored here so the type matches the file; no view renders it yet. */
  lookthrough: Record<string, unknown> | null
}

export interface BoardStatus {
  dashboard: { exists: boolean; mtime: string | null }
  snapshot: { exists: boolean; mtime: string | null }
  briefing: { exists: boolean; mtime: string | null }
  jobs: JobRecord[]
}

export interface JobRecord {
  id: string
  action: JobAction
  status: 'running' | 'success' | 'error'
  /** When the record last changed (ISO); the UI announces completions on it. */
  updatedAt: string
  error?: string
  result?: JobResult
}

/** Fields of a job result the UI is allowed to read. */
export interface JobResult {
  /** Number of funds the pipeline fitted. */
  funds?: number
  /** One-line summary the job wrote for the artifact header. */
  summary?: string
}

export interface OpsResponse {
  status?: string
  warning?: string
  op?: Op
  error?: string
}

/**
 * The job actions, in one place.
 *
 * The host owns the authoritative registry (`python-actions.ts`), and this
 * bundle cannot import it — so the type and the runtime list are derived from
 * a single declaration here, and `tests/api.spec.ts` asserts the two lists
 * still match. Splitting the type from the list is how they drift.
 */
export const JOB_ACTIONS = ['daily_job', 'refresh_dashboard', 'deep_snapshot', 'daily_briefing'] as const

export type JobAction = (typeof JOB_ACTIONS)[number]

/* ---------- 每日简报（agent 生成，briefing.json） ---------- */

export interface BriefingIndex {
  name: string
  value: number
  pct: number
}

export interface BriefingNews {
  title: string
  source?: string
  time?: string
  impact?: 'bullish' | 'watch' | 'bearish'
  funds?: string[]
  prompt: string
}

export interface Briefing {
  date: string
  greeting?: string
  indices: BriefingIndex[]
  news: BriefingNews[]
  suggestions?: string[]
}

/**
 * Finance 终端 data types and fetch wrappers.
 *
 * The document shapes mirror `py/skills/finance/contracts.py` — that module
 * is the single source of truth for the keys the Python side writes, and this
 * file declares the fields the UI reads. `parseSnapshot` / `parseBriefing`
 * check the invariants the UI depends on at the boundary, so a half-shaped
 * document fails here rather than as `undefined` three components away.
 */

/** A failure that carries the HTTP status that produced it.
 *
 * The host answers 409 when an action is already running. The UI used to
 * recover that intent by substring-matching the server's English error
 * prose, so a rewording silently turned "keep polling, it's fine" into
 * "show an error and stop". The status is the structured signal; it is no
 * longer discarded before the caller can see it.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** True when a job start was refused because that action is already running. */
export function isJobConflict(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409
}

/**
 * The four states of a fetched document.
 *
 * These used to collapse into `T | null`, which made a transient network
 * failure indistinguishable from "the artifact does not exist" — so a failed
 * fetch rendered the "not generated yet" call-to-action and offered a button
 * that would fail again.
 */
export type Resource<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'missing' }
  | { kind: 'failed'; error: string }

/** One error stringifier for every catch block in the SPA. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** How `getJson` treats a 404. */
type OnNotFound = 'null' | 'throw'

/** GET one JSON document; the single transport for every read in this package. */
async function getJson<T>(url: string, onNotFound: OnNotFound): Promise<T | null> {
  const res = await fetch(url)
  if (res.status === 404) {
    if (onNotFound === 'null') return null
    throw new ApiError(404, `${url} is missing`)
  }
  if (!res.ok) throw new ApiError(res.status, `${url} → ${res.status}`)
  return (await res.json()) as T
}

/** Check the arrays the UI iterates unguarded, and fail loudly otherwise. */
function parseSnapshot(value: unknown): Snapshot {
  const doc = value as Snapshot | null
  if (!doc || !Array.isArray(doc.funds) || !Array.isArray(doc.holdings) || !Array.isArray(doc.ops)) {
    throw new ApiError(200, 'ui_snapshot.json is not the expected shape')
  }
  return doc
}

function parseBriefing(value: unknown): Briefing {
  const doc = value as Briefing | null
  if (!doc || !Array.isArray(doc.indices) || !Array.isArray(doc.news)) {
    throw new ApiError(200, 'briefing.json is not the expected shape')
  }
  return doc
}

/**
 * The daily briefing. A 404 means the agent has not generated today's
 * briefing yet — the home view degrades to a "generate it" call-to-action —
 * while a transient failure throws. Callers must not conflate the two.
 */
export async function fetchBriefing(): Promise<Briefing | null> {
  const doc = await getJson<Briefing>(`/finance/api/briefing?_=${Date.now()}`, 'null')
  return doc === null ? null : parseBriefing(doc)
}

/**
 * The board snapshot. A 404 means it has never been generated (a fresh
 * install before the first `run_daily_job`); a transient failure throws.
 */
export async function fetchSnapshot(): Promise<Snapshot | null> {
  const doc = await getJson<Snapshot>(`/finance/api/snapshot?_=${Date.now()}`, 'null')
  return doc === null ? null : parseSnapshot(doc)
}

export async function fetchStatus(): Promise<BoardStatus> {
  const status = await getJson<BoardStatus>(`/finance/api/status?_=${Date.now()}`, 'throw')
  // `throw` above makes this unreachable in practice; the type still has to
  // be narrowed because the transport returns `T | null`.
  return status as BoardStatus
}

export async function startJob(action: JobAction): Promise<JobRecord> {
  const res = await fetch('/finance/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const body = (await res.json()) as { job: JobRecord } & { error?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status}`)
  return body.job
}

export async function recordOp(input: {
  code: string
  side: 'buy' | 'sell'
  shares: number
  price: number
  date?: string
  note?: string
}): Promise<OpsResponse> {
  const res = await fetch('/finance/api/ops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as OpsResponse
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status}`)
  return body
}
