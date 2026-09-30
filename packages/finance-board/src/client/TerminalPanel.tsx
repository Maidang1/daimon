/**
 * The interactive 看板 panel: KPI row, fund grid and four tabs, rendered from
 * `state/ui_snapshot.json` by the shared finance store.
 *
 * This component owns job *orchestration* (starting them, announcing
 * completions, retrying) — the documents themselves come from
 * `client/financeStore.ts`, so there is exactly one poll in the app.
 *
 * @module @deepseek-ai/dsh-finance-board/client/TerminalPanel
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { describeError, startJob, type JobAction, type JobRecord } from './api.js'
import { finance } from './financeStore.js'
import { fmtDateTime } from './format.js'
import { C } from './format.js'
import { QuickOpModal } from './QuickOpModal.js'
import { HotspotsTab } from './tabs/HotspotsTab.js'
import { HoldingsTab } from './tabs/HoldingsTab.js'
import { OpsTab } from './tabs/OpsTab.js'
import { OverviewTab } from './tabs/OverviewTab.js'

export type BoardTab = 'overview' | 'holdings' | 'hotspots' | 'ops'

const TABS: { key: BoardTab; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'holdings', label: '持仓' },
  { key: 'hotspots', label: '热点' },
  { key: 'ops', label: '交易流水' },
]

/** Total by construction, so a label lookup can never render `undefined`. */
const JOB_LABELS: Record<JobAction, string> = {
  daily_job: '每日流水线',
  refresh_dashboard: '刷新看板',
  deep_snapshot: '深度快照（含行业穿透）',
  daily_briefing: '每日简报',
}

/** 记一笔 with no holdings has nothing to record. */
const NO_HOLDINGS_HINT = '还没有持仓——先让 daimon 建仓（set_holding）再记一笔'

const GRAD = 'var(--fb-grad)'

/** One skeleton placeholder; the seven previous copies were identical. */
const skeleton = (height: number, flex: string, minWidth: number): React.CSSProperties => ({
  height, flex, minWidth, borderRadius: 12, background: 'var(--fb-skeleton, #ffffff14)',
})

export function TerminalPanel({ tab, onTabChange, onFundClick }: {
  /** Which tab is showing. Owned by the host view, so there is one source. */
  tab: BoardTab
  onTabChange: (tab: BoardTab) => void
  /** 基金卡/持仓行点击 → 上层切到下钻视图。 */
  onFundClick?: (code: string) => void
}): React.ReactElement {
  const state = useSyncExternalStore(finance.subscribe, finance.getState)
  const [jobError, setJobError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [quickOp, setQuickOp] = useState<string | null>(null)
  const [busyJob, setBusyJob] = useState<JobAction | null>(null)
  /** Mount time, so only jobs that finished after it are announced. */
  const mountedAt = useRef(Date.now())

  const resource = state.snapshot.resource
  const snapshot = resource.kind === 'ready' ? resource.value : null
  const loaded = resource.kind !== 'loading'
  const jobs = state.jobs
  const updatedAt = state.updatedAt

  // Announce a completion once. Diffing on the record's own `updatedAt` (rather
  // than pre-marking everything already terminal at the first poll) means a job
  // that finishes between mount and that poll is still announced.
  const announced = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === 'running' || announced.current.has(job.id)) continue
      if (Date.parse(job.updatedAt) < mountedAt.current) continue
      announced.current.add(job.id)
      if (job.status === 'success') {
        const funds = job.result?.funds
        setToast(`✅ ${JOB_LABELS[job.action]} 完成${funds !== undefined ? `（${funds} 只基金）` : ''}`)
      } else {
        setToast(`✗ ${JOB_LABELS[job.action]} 失败：${job.error ?? '未知错误'}`)
      }
    }
  }, [jobs])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6_000)
    return () => clearTimeout(t)
  }, [toast])

  const runJob = (action: JobAction): void => {
    setJobError(null)
    setBusyJob(action)
    // The shared poll picks the result up within one interval; no second
    // round-trip is needed to refresh the job list.
    void startJob(action)
      .then(() => setToast(`已启动：${JOB_LABELS[action]}`))
      .then(() => finance.refresh(), describeError)
      .catch(err => setJobError(describeError(err)))
      .finally(() => setBusyJob(null))
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
          onClick={() => runJob('daily_job')}>
          {actionRunning('daily_job') ? '运行中…' : '生成日报'}
        </button>
        <button style={{ ...ghostBtn, opacity: actionRunning('deep_snapshot') ? 0.55 : 1 }}
          disabled={actionRunning('deep_snapshot')} onClick={() => runJob('deep_snapshot')}>
          {actionRunning('deep_snapshot') ? '运行中…' : '深度快照'}
        </button>
        <button style={ghostBtn} disabled={!snapshot?.holdings.length}
          title={snapshot?.holdings.length ? undefined : NO_HOLDINGS_HINT}
          onClick={() => setQuickOp(snapshot?.holdings[0]?.code ?? '')}>
          记一笔
        </button>
      </div>

      <div style={{
        display: 'flex', gap: 2, padding: '0 16px', borderBottom: `1px solid ${C.line}`,
        flexShrink: 0, overflowX: 'auto',
      }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => onTabChange(t.key)} style={{
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
          {runningJob && <span>⏳ {JOB_LABELS[runningJob.action]} 运行中…</span>}
          {failedJob && <span>✗ {JOB_LABELS[failedJob.action]} 失败：{failedJob.error ?? '未知错误'}</span>}
          {jobError && <span>✗ {jobError}</span>}
          <span style={{ flex: 1 }} />
          {(failedJob || jobError) && (
            <button onClick={() => { setJobError(null); runJob(failedJob?.action ?? 'refresh_dashboard') }}
              style={{ ...ghostBtn, fontSize: 11, padding: '3px 10px' }}>
              重试
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!loaded ? (          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="fb-skeleton" style={skeleton(76, '1 1 140px', 140)} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className="fb-skeleton" style={skeleton(150, '1 1 240px', 240)} />
              ))}
            </div>
          </div>
        ) : resource.kind === 'missing' ? (
          <div style={{ margin: '80px auto', maxWidth: 520, padding: '0 24px', lineHeight: 1.9, fontSize: 13 }}>
            <h2 style={{ fontSize: 18 }}>Finance 终端尚未初始化</h2>
            <p style={{ color: C.dim }}>
              还没有任何快照数据。点击下方按钮运行每日流水线（拉行情 → RBSA 预测 → 生成数据），
              或在会话里让 agent 执行：
            </p>
            <pre style={{ background: C.panel, padding: 12, borderRadius: 8, fontSize: 12 }}>
              {'import finance\nawait finance.set_holding("008401", shares=1000, cost_amount=1234.5)\npath = await finance.run_daily_job()'}
            </pre>
            <button style={{ ...primaryBtn(false), padding: '8px 20px' }} onClick={() => runJob('daily_job')}>
              启动每日流水线
            </button>
          </div>
        ) : resource.kind === 'failed' ? (
          <div style={{ margin: '80px auto', maxWidth: 520, padding: '0 24px', lineHeight: 1.9, fontSize: 13 }}>
            <h2 style={{ fontSize: 18 }}>快照读取失败</h2>
            <p style={{ color: C.dim }}>{resource.error}</p>
          </div>
        ) : (
          <>
            {tab === 'overview' && <OverviewTab snapshot={resource.value} onFundClick={onFundClick} />}
            {tab === 'holdings' && (
              <HoldingsTab snapshot={resource.value} onQuickOp={code => setQuickOp(code)} onFundClick={onFundClick} />
            )}
            {tab === 'hotspots' && <HotspotsTab snapshot={resource.value} />}
            {tab === 'ops' && <OpsTab snapshot={resource.value} />}
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
            finance.refresh()
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
