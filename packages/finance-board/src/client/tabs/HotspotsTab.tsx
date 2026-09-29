/** 热点 tab: market regime, theme radar, top picks. */

import type { HotspotTheme, Snapshot } from '../api.js'
import { HeatBar } from '../charts.js'
import { C, fmtAge, fmtPct, fmtSigned, pnlColor } from '../format.js'

function ThemeCard({ theme }: { theme: HotspotTheme }): React.ReactElement {
  const bandColor = theme.band === '热' ? C.up : theme.band === '温' ? C.warn : C.down
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10,
      padding: '12px 14px', minWidth: 260, flex: '1 1 260px', fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{theme.name}</strong>
        <span style={{ fontSize: 11, color: C.dim }}>{theme.market}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: bandColor, fontWeight: 600 }}>{theme.band} {theme.heat}</span>
      </div>
      <div style={{ margin: '6px 0' }}><HeatBar pct={theme.heat} width={180} /></div>
      <div style={{ display: 'flex', gap: 14, color: C.dim, flexWrap: 'wrap' }}>
        <span>1日 <b style={{ color: pnlColor(theme.ret1) }}>{fmtPct(theme.ret1)}</b></span>
        <span>5日 <b style={{ color: pnlColor(theme.ret5) }}>{fmtPct(theme.ret5)}</b></span>
        <span>20日 <b style={{ color: pnlColor(theme.ret20) }}>{fmtPct(theme.ret20)}</b></span>
        <span>60日 <b style={{ color: pnlColor(theme.ret60) }}>{fmtPct(theme.ret60)}</b></span>
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 4, color: C.dim, flexWrap: 'wrap' }}>
        <span style={{ color: theme.above_ma20 ? C.up : C.down }}>MA20{theme.above_ma20 ? '上' : '下'}</span>
        <span>距高点 {fmtSigned(theme.dist_high, 1)}%</span>
        <span>位置 {theme.pos_pct != null ? `${theme.pos_pct}%` : '—'}</span>
        <span>广度 {theme.member_breadth != null ? `${Math.round(theme.member_breadth * 100)}%` : '—'}</span>
        {theme.pe_med != null && <span>PE 中位 {theme.pe_med}</span>}
      </div>
      {theme.leaders.length > 0 && (
        <div style={{ marginTop: 6, color: C.dim }}>
          领涨：{theme.leaders.map(l => `${l.name} ${fmtSigned(l.ret20, 0)}%`).join(' · ')}
        </div>
      )}
      {theme.catalysts && theme.catalysts.length > 0 && (
        <div style={{ marginTop: 6, color: C.dim, lineHeight: 1.7 }}>
          {theme.catalysts.map((c, i) => (
            <div key={i}>📌 {c.date ? `${c.date} ` : ''}{c.title}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function HotspotsTab({ snapshot }: { snapshot: Snapshot }): React.ReactElement {
  const hotspot = snapshot.hotspot
  if (!hotspot.data) {
    return (
      <div style={{ padding: '48px 20px', textAlign: 'center', color: C.dim, fontSize: 13, lineHeight: 2 }}>
        热点雷达尚未生成。<br />
        在会话里让 agent 执行 <code>await finance.hotspots()</code>（冷启动需数分钟），
        或使用上方「生成日报」（含全量数据刷新）。
      </div>
    )
  }
  const { market, themes, top_picks: topPicks } = hotspot.data
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 20px' }}>
      <div style={{
        background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 16px',
      }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <strong style={{ fontSize: 14 }}>市场情景：{market.regime}</strong>
          <span style={{ fontSize: 11, color: C.dim }}>
            生成于 {hotspot.data.generated_at}（{fmtAge(hotspot.age_seconds)}）
          </span>
        </div>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 6, lineHeight: 1.8 }}>{market.summary}</div>
        {market.catalysts && market.catalysts.length > 0 && (
          <div style={{ fontSize: 12, color: C.dim, marginTop: 6, lineHeight: 1.8 }}>
            {market.catalysts.slice(0, 5).map((c, i) => (
              <div key={i}>📌 {c.date ? `${c.date} ` : ''}{c.title}</div>
            ))}
          </div>
        )}
      </div>

      <section>
        <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>
          主题雷达（{themes.length}）
        </h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {themes.map(t => <ThemeCard key={t.name} theme={t} />)}
        </div>
      </section>

      {topPicks && topPicks.length > 0 && (
        <section>
          <h3 style={{ fontSize: 13, color: C.dim, margin: '0 0 10px', fontWeight: 600 }}>潜力股</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {topPicks.map((p, i) => (
              <div key={i} style={{
                display: 'flex', gap: 12, alignItems: 'center', fontSize: 12,
                background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 12px',
              }}>
                <span style={{ fontWeight: 600, width: 110 }}>{p.name}</span>
                <span style={{ color: C.dim, width: 110 }}>{p.ticker} · {p.theme}</span>
                <span style={{ color: pnlColor(p.ret20), width: 80 }}>20日 {fmtSigned(p.ret20, 0)}%</span>
                <span style={{ color: C.dim, flex: 1 }}>{p.reason}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
