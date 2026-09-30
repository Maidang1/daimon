/**
 * Finance 终端 main panel: tab bar + quick-action toolbar over the live
 * snapshot. Polls `/finance/api/status` every 5s and reloads the snapshot
 * only when its mtime changed, so scroll state survives refreshes.
 *
 * This component is shared by two hosts: the new terminal UI (src/terminal/,
 * terminal.css loaded — fb-* classes resolve) and the legacy client bundle
 * injected into the official SPA sidebar (no terminal.css — inline fallbacks
 * carry the same dsw values). Keep base styles inline; classes only enhance.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchSnapshot, fetchStatus, startJob,
  type BoardStatus, type JobAction, type JobRecord, type Snapshot,
} from './api.js'
import { QuickOpModal } from './QuickOpModal.js'
import { OverviewTab } from './tabs/OverviewTab.js'
import { HoldingsTab } from './tabs/HoldingsTab.js'
import { HotspotsTab } from './tabs/HotspotsTab.js'
import { OpsTab } from './tabs/OpsTab.js'
import { C, fmtDateTime } from './format.js'

export type BoardTab = 'overview' | 'holdings' | 'hotspots' | 'ops'

const TABS: { key: BoardTab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'holdings', label: '持仓' },
  { key: 'hotspots', label: '热点' },
  { key: 'ops', label: '交易流水' },
]

const JOB_LABELS: Record<string, string> = {
  daily_job: '每日流水线',
  refresh_dashboard: '刷新看板',
  deep_snapshot: '深度快照（含行业穿透）',
  daily_briefing: '每日简报',
}

const GRAD = 'linear-gradient(135deg,#5686fe,#7aaaff)'

export function TerminalPanel({ tab: tabProp, onTabChange, onFundClick }: {
  /** Controlled tab (optional — defaults to internal state). */
  tab?: BoardTab
  onTabChange?: (tab: BoardTab) => void
  /** 基金卡/持仓行点击 → 上层切到下钻视图。缺省时卡片不可点。 */
  onFundClick?: (code: string) => void
} = {}): React.ReactElement {
  const [tabInternal, setTabInternal] = useState<BoardTab>(tabProp ?? 'overview')
  const tab = tabProp ?? tabInternal
  const setTab = (t: BoardTab): void => {
    setTabInternal(t)
    onTabChange?.(t)
  }
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [jobError, setJobError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [quickOp, setQuickOp] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<string | null>(null)
  const snapshotMtime = useRef<string | null>(null)
  /** Finished job ids already announced — seeded on first poll so historical jobs stay silent. */
  const announcedJobs = useRef<Set<string> | null>(null)

  const loadSnapshot = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await fetchSnapshot())
    } catch {
      // Keep the previous frame on transient read failures.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const status: BoardStatus = await fetchStatus()
        if (stopped) return
        const next = status.jobs
        if (announcedJobs.current === null) {
          // First poll: only jobs that finished after mount may announce.
          announcedJobs.current = new Set(next.filter(j => j.status !== 'running').map(j => j.id))
        } else {
          for (const j of next) {
            if (j.status === 'running' || announcedJobs.current.has(j.id)) continue
            announcedJobs.current.add(j.id)
            const label = JOB_LABELS[j.action] ?? j.action
            if (j.status === 'success') {
              const funds = (j.result as { funds?: number } | undefined)?.funds
              setToast(`✅ ${label} 完成${funds !== undefined ? `（${funds} 只基金）` : ''}`)
            } else {
              setToast(`✗ ${label} 失败：${j.error ?? '未知错误'}`)
            }
          }
        }
        setJobs(next)
        setUpdatedAt(status.snapshot.mtime ?? status.dashboard.mtime)
        if (status.snapshot.mtime !== snapshotMtime.current) {
          snapshotMtime.current = status.snapshot.mtime
          await loadSnapshot()
        }
      } catch {
        // Keep the previous frame on transient read failures.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [loadSnapshot])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(t)
  }, [toast])

  const runJob = async (action: JobAction): Promise<void> => {
    setJobError(null)
    setBusyJob(action)
    try {
      await startJob(action)
      setToast(`已启动：${JOB_LABELS[action] ?? action}`)
      const status = await fetchStatus()
      setJobs(status.jobs)
    } catch (err) {
      setJobError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusyJob(null)
    }
  }

  /** An action button is disabled while its own job is in flight. */
  const actionRunning = (action: JobAction): boolean =>
    busyJob === action || jobs.some(j => j.action === action && j.status === 'running')

  const runningJob = jobs.find(j => j.status === 'running')
  // Jobs arrive newest-first. Only flag an action whose LATEST run failed —
  // an old error followed by a success must not keep the banner up.
  const latestByAction = new Map<string, JobRecord>()
  for (const j of jobs) {
    if (!latestByAction.has(j.action)) latestByAction.set(j.action, j)
  }
  const failedJob = [...latestByAction.values()].find(j => j.status === 'error')

  const primaryBtn = (running: boolean): React.CSSProperties => ({
    border: 'none', borderRadius: 8, background: GRAD, color: '#fff',
    padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer',
    opacity: running ? 0.55 : 1, fontFamily: 'inherit', whiteSpace: 'nowrap',
  })
  const ghostBtn: React.CSSProperties = {
    border: `1px solid ${C.line2}`, borderRadius: 8, background: 'transparent',
    color: C.text, padding: '6px 14px', fontSize: 12, cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px',
        borderBottom: `1px solid ${C.line}`, fontSize: 13, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <strong>📈 Finance 终端</strong>
        <span style={{ opacity: 0.55, fontSize: 12 }}>
          {updatedAt ? `数据更新于 ${fmtDateTime(updatedAt)}` : snapshot ? '等待首次生成' : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button style={primaryBtn(actionRunning('daily_job'))} disabled={actionRunning('daily_job')}
          onClick={() => void runJob('daily_job')}>
          {actionRunning('daily_job') ? '运行中…' : '生成日报'}
        </button>
        <button style={{ ...ghostBtn, opacity: actionRunning('deep_snapshot') ? 0.55 : 1 }}
          disabled={actionRunning('deep_snapshot')} onClick={() => void runJob('deep_snapshot')}>
          {actionRunning('deep_snapshot') ? '运行中…' : '深度快照'}
        </button>
        <button style={ghostBtn} onClick={() => setQuickOp(snapshot?.holdings[0]?.code ?? '')}>
          记一笔
        </button>
      </div>

      <div style={{
        display: 'flex', gap: 2, padding: '0 16px', borderBottom: `1px solid ${C.line}`,
        flexShrink: 0, overflowX: 'auto',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 13, padding: '10px 4px', marginRight: 20, fontFamily: 'inherit',
            color: tab === t.key ? C.text : C.dim,
            fontWeight: tab === t.key ? 600 : 400, whiteSpace: 'nowrap',
          }}>
            {t.label}
            {tab === t.key && (
              <span style={{
                position: 'absolute', left: 0, right: 0, bottom: -1, height: 2,
                borderRadius: 2, background: GRAD,
              }} />
            )}
          </button>
        ))}
      </div>

      {(runningJob || failedJob || jobError) && (
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 16px 8px 19px', fontSize: 12, flexShrink: 0,
          background: failedJob || jobError ? C.upDim : C.accentDim,
          borderBottom: `1px solid ${C.line}`,
          color: failedJob || jobError ? C.up : C.accentHi,
        }}>
          <span style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
            background: failedJob || jobError ? C.up : C.accent,
          }} />
          {runningJob && <span>⏳ {JOB_LABELS[runningJob.action] ?? runningJob.action} 运行中…</span>}
          {failedJob && <span>✗ {JOB_LABELS[failedJob.action]} 失败：{failedJob.error ?? '未知错误'}</span>}
          {jobError && <span>✗ {jobError}</span>}
          <span style={{ flex: 1 }} />
          {(failedJob || jobError) && (
            <button onClick={() => { setJobError(null); void runJob((failedJob?.action as JobAction | undefined) ?? 'refresh_dashboard') }}
              style={{ ...ghostBtn, fontSize: 11, padding: '3px 10px' }}>
              重试
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loaded ? (
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="fb-skeleton" style={{
                  height: 76, flex: '1 1 140px', minWidth: 140, borderRadius: 12,
                  background: 'var(--fb-skeleton, #ffffff14)',
                }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className="fb-skeleton" style={{
                  height: 150, flex: '1 1 240px', minWidth: 240, borderRadius: 12,
                  background: 'var(--fb-skeleton, #ffffff14)',
                }} />
              ))}
            </div>
          </div>
        ) : !snapshot ? (
          <div style={{ margin: '80px auto', maxWidth: 520, padding: '0 24px', lineHeight: 1.9, fontSize: 13 }}>
            <h2 style={{ fontSize: 18 }}>Finance 终端尚未初始化</h2>
            <p style={{ color: C.dim }}>
              还没有任何快照数据。点击下方按钮运行每日流水线（拉行情 → RBSA 预测 → 生成数据），
              或在会话里让 agent 执行：
            </p>
            <pre style={{ background: C.panel, padding: 12, borderRadius: 8, fontSize: 12 }}>
              {'import finance\nawait finance.set_holding("008401", shares=1000, cost_amount=1234.5)\npath = await finance.run_daily_job()'}
            </pre>
            <button style={{ ...primaryBtn(false), padding: '8px 20px' }} onClick={() => void runJob('daily_job')}>
              启动每日流水线
            </button>
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab snapshot={snapshot} onFundClick={onFundClick} />}
            {tab === 'holdings' && (
              <HoldingsTab snapshot={snapshot} onQuickOp={code => setQuickOp(code)} onFundClick={onFundClick} />
            )}
            {tab === 'hotspots' && <HotspotsTab snapshot={snapshot} />}
            {tab === 'ops' && <OpsTab snapshot={snapshot} />}
          </>
        )}
      </div>

      {quickOp !== null && snapshot && (
        <QuickOpModal
          holdings={snapshot.holdings}
          initialCode={quickOp}
          onClose={() => setQuickOp(null)}
          onDone={msg => {
            setQuickOp(null)
            setToast(msg)
            void loadSnapshot()
          }}
        />
      )}

      {toast && (
        <div className="fb-toast" style={{
          position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(44,44,46,0.85)', border: `1px solid ${C.line2}`, borderRadius: 999,
          padding: '10px 18px', fontSize: 13, zIndex: 1200, color: C.text,
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
