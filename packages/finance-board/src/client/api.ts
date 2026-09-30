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
  lookthrough: Record<string, unknown> | null
}

export interface BoardStatus {
  dashboard: { exists: boolean; mtime: string | null }
  snapshot: { exists: boolean; mtime: string | null }
  jobs: JobRecord[]
}

export interface JobRecord {
  id: string
  action: string
  status: 'running' | 'success' | 'error'
  error?: string
  result?: unknown
}

export interface OpsResponse {
  status?: string
  warning?: string
  op?: Op
  error?: string
}

export type JobAction = 'daily_job' | 'refresh_dashboard' | 'deep_snapshot' | 'daily_briefing'

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

/** 404 → null（简报未生成，前端降级）。 */
export async function fetchBriefing(): Promise<Briefing | null> {
  const res = await fetch(`/finance/api/briefing?_=${Date.now()}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`/finance/api/briefing → ${res.status}`)
  return (await res.json()) as Briefing
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return (await res.json()) as T
}

export async function fetchSnapshot(): Promise<Snapshot | null> {
  const res = await fetch(`/finance/api/snapshot?_=${Date.now()}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`/finance/api/snapshot → ${res.status}`)
  return (await res.json()) as Snapshot
}

export async function fetchStatus(): Promise<BoardStatus> {
  return getJson(`/finance/api/status?_=${Date.now()}`)
}

export async function startJob(action: JobAction): Promise<{ job: JobRecord }> {
  const res = await fetch('/finance/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const body = (await res.json()) as { job: JobRecord } & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status}`)
  return body
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
  if (!res.ok) throw new Error(body.error ?? `${res.status}`)
  return body
}
