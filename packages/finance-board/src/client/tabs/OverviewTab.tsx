/** 总览 tab: portfolio KPIs, fund prediction grid, accuracy track record. */

import type { FundInfo, Snapshot } from '../api.js'
import { BarRow, LineChart } from '../charts.js'
import { C, fmtAge, fmtMoney, fmtPct, fmtSigned, navSeriesOf, pnlColor } from '../format.js'

function Kpi({ label, value, valueColor, sub }: {
  label: string
  value: string
  valueColor?: string
  sub?: string
}): React.ReactElement {
  return (
    <div className="fb-kpi" style={{
      position: 'relative', overflow: 'hidden',
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12,
      padding: '12px 16px', minWidth: 140, flex: '1 1 140px',
    }}>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, letterSpacing: '0.04em' }}>{label}</div>
      <div className="fb-num" style={{ fontSize: 24, fontWeight: 700, color: valueColor ?? C.text, letterSpacing: '-0.01em' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function FundCard({ fund, onFundClick }: {
  fund: FundInfo
  onFundClick?: (code: string) => void
}): React.ReactElement {
  const navSeries = navSeriesOf(fund)
  const dev = fund.pred_ret
  const hit = fund.accuracy?.hit_rate
  const clickable = onFundClick !== undefined
  return (
    <div
      className={clickable ? 'fb-card hoverable fb-fade-up' : 'fb-card fb-fade-up'}
      onClick={clickable ? () => onFundClick(fund.code) : undefined}
      title={clickable ? '点击下钻到基金详情' : undefined}
      style={{
        background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12,
        padding: '12px 14px', minWidth: 240, flex: '1 1 240px',
        cursor: clickable ? 'pointer' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{fund.name}</strong>
        <span style={{ fontSize: 11, color: C.dim }}>{fund.code}</span>
        <span style={{ flex: 1 }} />
        {fund.pred_label && <span className="fb-chip fb-chip-brand">{fund.pred_label}</span>}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: C.dim, flexWrap: 'wrap' }}>
        <span>净值 <b className="fb-num" style={{ color: C.text }}>{fund.official_nav ?? '—'}</b>{fund.official_date ? ` (${fund.official_date})` : ''}</span>
        <span>预测 <b className="fb-num" style={{ color: pnlColor(dev ?? null) }}>{fmtPct(dev)}</b>{fund.pred_nav != null ? ` → ${fund.pred_nav}` : ''}</span>
        {fund.intraday && (
          <span title={fund.intraday.note}>
            盘中估算 <b className="fb-num" style={{ color: pnlColor(fund.intraday.estRet) }}>{fmtPct(fund.intraday.estRet)}</b>
            {` → ${fund.intraday.estNav}`}
          </span>
        )}
        <span>R² {fund.r2 ?? '—'}</span>
        {hit != null && <span>命中 <b className="fb-num" style={{ color: C.text }}>{hit}%</b>（{fund.accuracy.n} 次）</span>}
      </div>
      {navSeries.length >= 2 && (
        <div style={{ marginTop: 8 }}><LineChart values={navSeries} height={56} /></div>
      )}
      {fund.signals && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span className={fund.signals.above_ma20 ? 'fb-chip fb-chip-up' : 'fb-chip fb-chip-down'}>
            MA20 {fund.signals.above_ma20 ? '上' : '下'}
          </span>
          {fund.signals.below_trough && <span className="fb-chip fb-chip-warn">跌破前低</span>}
          <span className="fb-chip fb-chip-plain">距高点 {fmtSigned(fund.signals.dd_from_ath, 1)}%</span>
        </div>
      )}
    </div>
  )
}

export function OverviewTab({ snapshot, onFundClick }: {
  snapshot: Snapshot
  onFundClick?: (code: string) => void
}): React.ReactElement {
  const { summary, meta, funds, accuracy, hotspot } = snapshot
  const pending = meta.pending_artifact
  // Hoisted: the previous version recomputed this per-row inside `.map`, an
  // O(n²) pass over the same constant on every render.
  const maxAbs = Math.max(...accuracy.recent.map(r => Math.abs(r.dev ?? 0)), 0.5)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 20px' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Kpi label="持仓成本" value={`¥ ${fmtMoney(summary.total_cost, 0)}`}
          sub={`${summary.positions_count} 只持仓`} />
        <Kpi label="总市值" value={summary.total_value != null ? `¥ ${fmtMoney(summary.total_value, 0)}` : '—'}
          sub={summary.nav_asof ? `净值日期 ${summary.nav_asof}` : '等待行情数据'} />
        <Kpi label="累计盈亏"
          value={summary.total_pnl != null ? `${fmtSigned(summary.total_pnl, 0)} 元` : '—'}
          valueColor={pnlColor(summary.total_pnl)}
          sub={fmtPct(summary.total_pnl_pct)} />
        <Kpi label="预测命中率" value={accuracy.hit_rate != null ? `${accuracy.hit_rate}%` : '—'}
          sub={`${accuracy.n} 条核对记录${accuracy.avg_dev != null ? ` · 平均偏差 ${fmtSigned(accuracy.avg_dev)}%` : ''}`} />
        {hotspot.data && (
          <Kpi label="市场情景" value={hotspot.data.market.regime}
            valueColor={hotspot.data.market.regime === 'risk-on' ? C.up : hotspot.data.market.regime === 'risk-off' ? C.down : C.dim}
            sub={`广度 ${hotspot.data.market.breadth ?? '—'} · ${fmtAge(hotspot.age_seconds)}更新`} />
        )}
      </div>

      {pending && (
        <div style={{
          position: 'relative', overflow: 'hidden',
          background: C.warnDim, border: `1px solid ${C.line}`,
          borderRadius: 8, padding: '10px 14px 10px 17px', fontSize: 13, color: C.warn, lineHeight: 1.7,
        }}>
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: C.warn }} />
          预测数据尚未生成。让 agent 先 <code>register_fund</code> 再 <code>run_daily_job()</code>，
          或直接点上方「生成日报」按钮。
        </div>
      )}

      {hotspot.data && (
        <div style={{
          background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 16px',
          fontSize: 12, color: C.dim, lineHeight: 1.8,
        }}>
          <b style={{ color: C.text }}>市场归因</b> · {hotspot.data.generated_at}
          <div>{hotspot.data.market.summary}</div>
        </div>
      )}

      <section>
        <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>基金预测</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {funds.length === 0 && <span style={{ color: C.dim, fontSize: 13 }}>暂无基金数据</span>}
          {funds.map(f => <FundCard key={f.code} fund={f} onFundClick={onFundClick} />)}
        </div>
      </section>

      {accuracy.recent.length > 0 && (
        <section>
          <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>近期预测核对</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {accuracy.recent.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <span style={{ color: C.dim, width: 90 }}>{r.navDate}</span>
                <span style={{ width: 110, color: C.text }}>{r.code}</span>
                <BarRow value={r.dev ?? 0} maxAbs={maxAbs} />
                <span className="fb-num" style={{ color: pnlColor(r.dev), width: 70, textAlign: 'right' }}>
                  {fmtSigned(r.dev)}%
                </span>
                <span style={{ color: C.dim }}>预测 {fmtPct(r.predRet)} / 实际 {fmtPct(r.actualRet)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
