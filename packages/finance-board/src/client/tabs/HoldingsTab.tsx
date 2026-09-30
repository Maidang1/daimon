/** 持仓 tab: positions table with live P&L and per-fund factor weights. */

import type { Snapshot } from '../api.js'
import { fmtMoney, fmtPct, pnlColor, C } from '../format.js'
import { tableStyle, thStyle, tdStyle } from '../table.js'

export function HoldingsTab({ snapshot, onQuickOp, onFundClick }: {
  snapshot: Snapshot
  onQuickOp: (code: string) => void
  /** 持仓行点击 → 基金下钻（新终端 UI 提供；旧 client bundle 缺省则不可点）。 */
  onFundClick?: (code: string) => void
}): React.ReactElement {
  const holdings = [...snapshot.holdings].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const totalValue = snapshot.summary.total_value

  if (holdings.length === 0) {
    return (
      <div style={{ padding: '48px 20px', textAlign: 'center', color: C.dim, fontSize: 13, lineHeight: 2 }}>
        暂无持仓基线。<br />
        在会话里让 agent 执行 <code>finance.set_holding(code, shares, cost_amount)</code> 建仓。
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 20px', overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>基金</th>
            <th style={thStyle}>份额</th>
            <th style={thStyle}>成本</th>
            <th style={thStyle}>平均净值</th>
            <th style={thStyle}>最新净值</th>
            <th style={thStyle}>市值</th>
            <th style={thStyle}>占比</th>
            <th style={thStyle}>盈亏</th>
            <th style={{ ...thStyle, textAlign: 'center' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map(h => (
            <tr key={h.code}
              onClick={onFundClick ? () => onFundClick(h.code) : undefined}
              title={onFundClick ? '点击下钻到基金详情' : undefined}
              style={{ cursor: onFundClick ? 'pointer' : undefined }}>
              <td style={{ ...tdStyle, textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{h.name}</div>
                <div style={{ fontSize: 10, color: C.faint }}>{h.code}{h.navDate ? ` · ${h.navDate}` : ''}</div>
              </td>
              <td style={tdStyle} className="fb-num">{fmtMoney(h.shares)}</td>
              <td style={tdStyle} className="fb-num">{fmtMoney(h.cost)}</td>
              <td style={tdStyle} className="fb-num">{h.avg != null ? fmtMoney(h.avg, 4) : '—'}</td>
              <td style={tdStyle} className="fb-num">{h.nav != null ? fmtMoney(h.nav, 4) : '—'}</td>
              <td style={tdStyle} className="fb-num">{h.value != null ? fmtMoney(h.value) : '—'}</td>
              <td style={tdStyle} className="fb-num">
                {h.value != null && totalValue ? fmtPct(h.value / totalValue * 100, false) : '—'}
              </td>
              <td style={{ ...tdStyle, color: pnlColor(h.pnl) }} className="fb-num">
                {h.pnl != null ? fmtMoney(h.pnl) : '—'}
                <div style={{ fontSize: 10 }}>{fmtPct(h.pnl_pct)}</div>
              </td>
              <td style={{ ...tdStyle, textAlign: 'center' }}>
                <button onClick={ev => { ev.stopPropagation(); onQuickOp(h.code) }} style={{
                  border: `1px solid ${C.line2}`, borderRadius: 6, background: 'transparent',
                  color: C.accentHi, fontSize: 11, padding: '3px 10px', cursor: 'pointer',
                  fontFamily: 'inherit',
                }}>
                  记一笔
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <WeightsSection snapshot={snapshot} />
    </div>
  )
}

function WeightsSection({ snapshot }: { snapshot: Snapshot }): React.ReactElement {
  const withWeights = snapshot.funds.filter(f => f.weights.length > 0)
  if (withWeights.length === 0) return <></>
  return (
    <section style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>RBSA 风格因子（前 5）</h3>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {withWeights.map(f => (
          <div key={f.code} style={{
            background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
            padding: '10px 14px', minWidth: 200, fontSize: 12,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{f.name}</div>
            {f.weights.map(w => (
              <div key={w.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: C.dim }}>
                <span>{w.name}</span>
                <span style={{ color: C.text }}>{fmtPct(w.pct, false)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}
