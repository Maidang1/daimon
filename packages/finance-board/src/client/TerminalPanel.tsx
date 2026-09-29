/**
 * Finance 终端 main panel: tab bar + quick-action toolbar over the live
 * snapshot. Polls `/finance/api/status` every 5s and reloads the snapshot
 * only when its mtime changed, so scroll state survives refreshes.
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

type Tab = 'overview' | 'holdings' | 'hotspots' | 'ops'

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'holdings', label: '持仓' },
  { key: 'hotspots', label: '热点' },
  { key: 'ops', label: '交易流水' },
]

const JOB_LABELS: Record<string, string> = {
  daily_job: '每日流水线',
  refresh_dashboard: '刷新看板',
  deep_snapshot: '深度快照（含行业穿透）',
}

export function TerminalPanel(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('overview')
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
        <button style={actionBtn} disabled={actionRunning('daily_job')} onClick={() => void runJob('daily_job')}>
          {actionRunning('daily_job') ? '运行中…' : '生成日报'}
        </button>
        <button style={actionBtn} disabled={actionRunning('deep_snapshot')} onClick={() => void runJob('deep_snapshot')}>
          {actionRunning('deep_snapshot') ? '运行中…' : '深度快照'}
        </button>
        <button style={actionBtn} onClick={() => setQuickOp(snapshot?.holdings[0]?.code ?? '')}>
          记一笔
        </button>
      </div>

      <div style={{
        display: 'flex', gap: 2, padding: '0 12px', borderBottom: `1px solid ${C.line}`,
        flexShrink: 0, overflowX: 'auto',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13,
            padding: '9px 14px', color: tab === t.key ? C.accent : C.dim,
            borderBottom: tab === t.key ? `2px solid ${C.accent}` : '2px solid transparent',
            fontWeight: tab === t.key ? 600 : 400, whiteSpace: 'nowrap',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {(runningJob || failedJob || jobError) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px',
          fontSize: 12, flexShrink: 0,
          background: failedJob || jobError ? 'rgba(255,92,108,0.10)' : 'rgba(77,159,255,0.08)',
          borderBottom: `1px solid ${C.line}`,
          color: failedJob || jobError ? C.up : C.accent,
        }}>
          {runningJob && <span>⏳ {JOB_LABELS[runningJob.action] ?? runningJob.action} 运行中…</span>}
          {failedJob && <span>✗ {JOB_LABELS[failedJob.action]} 失败：{failedJob.error ?? '未知错误'}</span>}
          {jobError && <span>✗ {jobError}</span>}
          <span style={{ flex: 1 }} />
          {(failedJob || jobError) && (
            <button onClick={() => { setJobError(null); void runJob((failedJob?.action as JobAction | undefined) ?? 'refresh_dashboard') }}
              style={{ ...actionBtn, fontSize: 11 }}>
              重试
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loaded ? (
          <div style={{ padding: 48, textAlign: 'center', color: C.dim }}>加载中…</div>
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
            <button style={{ ...actionBtn, padding: '8px 20px' }} onClick={() => void runJob('daily_job')}>
              启动每日流水线
            </button>
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab snapshot={snapshot} />}
            {tab === 'holdings' && (
              <HoldingsTab snapshot={snapshot} onQuickOp={code => setQuickOp(code)} />
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
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: C.panel, border: `1px solid ${C.accent}`, borderRadius: 8,
          padding: '8px 18px', fontSize: 13, zIndex: 1001, color: C.text,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

const actionBtn: React.CSSProperties = {
  border: `1px solid ${C.line}`, borderRadius: 6, background: 'transparent',
  color: C.text, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
}
