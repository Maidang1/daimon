/** 总览 tab: portfolio KPIs, fund prediction grid, accuracy track record. */

import type { FundInfo, Snapshot } from '../api.js'
import { BarRow, LineChart } from '../charts.js'
import { C, fmtAge, fmtMoney, fmtPct, fmtSigned, pnlColor } from '../format.js'

function Kpi({ label, value, valueColor, sub }: {
  label: string
  value: string
  valueColor?: string
  sub?: string
}): React.ReactElement {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
      padding: '12px 16px', minWidth: 140, flex: '1 1 140px',
    }}>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: valueColor ?? C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function FundCard({ fund }: { fund: FundInfo }): React.ReactElement {
  const navSeries = fund.nav_tail
    ? Object.entries(fund.nav_tail).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
    : []
  const dev = fund.pred_ret
  const hit = fund.accuracy.hit_rate
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
      padding: '12px 14px', minWidth: 240, flex: '1 1 240px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{fund.name}</strong>
        <span style={{ fontSize: 11, color: C.dim }}>{fund.code}</span>
        <span style={{ flex: 1 }} />
        {fund.pred_label && (
          <span style={{ fontSize: 11, color: C.accent }}>{fund.pred_label}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: C.dim, flexWrap: 'wrap' }}>
        <span>净值 <b style={{ color: C.text }}>{fund.official_nav ?? '—'}</b>{fund.official_date ? ` (${fund.official_date})` : ''}</span>
        <span>预测 <b style={{ color: pnlColor(dev ?? null) }}>{fmtPct(dev)}</b>{fund.pred_nav != null ? ` → ${fund.pred_nav}` : ''}</span>
        {fund.intraday && (
          <span title={fund.intraday.note}>
            盘中估算 <b style={{ color: pnlColor(fund.intraday.estRet) }}>{fmtPct(fund.intraday.estRet)}</b>
            {` → ${fund.intraday.estNav}`}
          </span>
        )}
        <span>R² {fund.r2 ?? '—'}</span>
        {hit != null && <span>命中 <b style={{ color: C.text }}>{hit}%</b>（{fund.accuracy.n} 次）</span>}
      </div>
      {navSeries.length >= 2 && (
        <div style={{ marginTop: 8 }}><LineChart values={navSeries} height={56} /></div>
      )}
      {fund.signals && (
        <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11, color: C.dim }}>
          <span style={{ color: fund.signals.above_ma20 ? C.up : C.down }}>
            MA20 {fund.signals.above_ma20 ? '上' : '下'}
          </span>
          <span style={{ color: fund.signals.below_trough ? C.up : C.dim }}>
            {fund.signals.below_trough ? '跌破前低' : '未破前低'}
          </span>
          <span>距高点 {fmtSigned(fund.signals.dd_from_ath, 1)}%</span>
        </div>
      )}
    </div>
  )
}

export function OverviewTab({ snapshot }: { snapshot: Snapshot }): React.ReactElement {
  const { summary, meta, funds, accuracy, hotspot } = snapshot
  const pending = meta.pending_artifact

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
          background: 'rgba(226,163,54,0.10)', border: `1px solid ${C.warn}`,
          borderRadius: 10, padding: '12px 16px', fontSize: 13, color: C.warn, lineHeight: 1.7,
        }}>
          预测数据尚未生成。让 agent 先 <code>register_fund</code> 再 <code>run_daily_job()</code>，
          或直接点上方「生成日报」按钮。
        </div>
      )}

      {hotspot.data && (
        <div style={{
          background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 16px',
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
          {funds.map(f => <FundCard key={f.code} fund={f} />)}
        </div>
      </section>

      {accuracy.recent.length > 0 && (
        <section>
          <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>近期预测核对</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {accuracy.recent.map((r, i) => {
              const maxAbs = Math.max(...accuracy.recent.map(x => Math.abs(x.dev ?? 0)), 0.5)
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                  <span style={{ color: C.dim, width: 90 }}>{r.navDate}</span>
                  <span style={{ width: 110, color: C.text }}>{r.code}</span>
                  <BarRow label="" value={r.dev ?? 0} maxAbs={maxAbs} />
                  <span style={{ color: pnlColor(r.dev), width: 70, textAlign: 'right' }}>
                    {fmtSigned(r.dev)}%
                  </span>
                  <span style={{ color: C.dim }}>预测 {fmtPct(r.predRet)} / 实际 {fmtPct(r.actualRet)}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
