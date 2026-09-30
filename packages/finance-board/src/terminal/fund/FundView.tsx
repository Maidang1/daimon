/**
 * 基金详情·下钻页：单只基金的完整视图（持仓 KPI / 净值走势 / 预测与信号 /
 * RBSA 跟踪篮子 / 相关新闻），底部常驻「追问 dock」——输入发送时自动携带
 * 基金上下文，下钻分析沉淀在当前会话里。
 *
 * 数据与派生在 `useFundDetail.ts`，本文件只做呈现。
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/fund/FundView
 */

import { LineChart } from '../../client/charts.js'
import { C, fmtMoney, fmtPct, fmtSigned, pnlColor } from '../../client/format.js'
import { Composer } from '../ui/Composer.js'
import { ImpactChip } from '../home/HomeView.js'
import { useFundDetail } from './useFundDetail.js'

function Kpi({ label, value, valueColor, sub, accent }: {
  label: string
  value: string
  valueColor?: string
  sub?: string
  accent?: boolean
}): React.ReactElement {
  return (
    <div className={`fb-kpi${accent ? ' accent' : ''}`} style={{ padding: '12px 14px', flex: '1 1 130px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginBottom: 6, letterSpacing: '0.04em' }}>{label}</div>
      <div className="fb-num" style={{ fontSize: 20, fontWeight: 700, color: valueColor ?? 'var(--fb-text-1)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function WeightBar({ name, pct, maxPct }: { name: string; pct: number; maxPct: number }): React.ReactElement {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '3px 0',
    }}>
      <span style={{ width: 110, color: 'var(--fb-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--fb-skeleton)' }}>
        <div style={{
          width: `${Math.max((pct / (maxPct || 1)) * 100, 2)}%`, height: '100%', borderRadius: 3,
          background: 'var(--fb-grad)',
        }} />
      </div>
      <span className="fb-num" style={{ width: 52, textAlign: 'right' }}>{fmtPct(pct, false)}</span>
    </div>
  )
}

/** 追问 dock 的基金专属建议。 */
const FOLLOW_UPS = ['为什么最近跑输/跑赢基准？', '继续定投还是止损？', '现在加仓合适吗？']

export function FundView({ code, onBack, onSend }: {
  code: string
  onBack: () => void
  /** 发送一条 prompt（上层负责确保会话存在并切到对话页）。 */
  onSend: (text: string) => void
}): React.ReactElement {
  const { snapshot, fund, holding, name, navSeries, relatedNews } = useFundDetail(code)

  /** 追问：prompt 自动携带基金上下文。 */
  const ask = (text: string): void => onSend(`关于 ${name}(${code})：${text}`)

  if (snapshot.kind === 'loading') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>
        载入基金…
      </div>
    )
  }

  const maxWeight = fund?.weights?.length ? Math.max(...fund.weights.map(w => w.pct)) : 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="fb-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '18px 24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 返回 */}
          <button className="fb-link" onClick={onBack} style={{
            alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
            fontSize: 12, fontFamily: 'var(--fb-font-ui)',
          }}>
            ← 返回金融看板
          </button>

          {!fund && !holding && snapshot.kind === 'ready' && (
            <div className="fb-banner warn">未在当前快照中找到基金 {code}，可能已清仓或数据未刷新。</div>
          )}
          {snapshot.kind === 'missing' && (
            <div className="fb-banner warn">看板尚未生成——先在 daimon 会话里跑一次 <code>run_daily_job()</code>。</div>
          )}

          {/* 基金头部 */}
          <div className="fb-fade-up" style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 19, fontWeight: 700 }}>{name}</span>
                <span className="fb-mono" style={{ fontSize: 12, color: 'var(--fb-text-4)' }}>{code}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {fund?.pred_label && <span className="fb-chip fb-chip-brand">{fund.pred_label}</span>}
                {fund?.intraday && <span className="fb-chip fb-chip-warn">待收盘 · 盘中估算</span>}
                {fund?.weights && fund.weights.length > 0 && <span className="fb-chip fb-chip-plain">RBSA 已配置</span>}
              </div>
            </div>
            {fund?.official_nav != null && (
              <div style={{ textAlign: 'right' }}>
                <div className="fb-num" style={{ fontSize: 24, fontWeight: 700 }}>
                  {fmtMoney(fund.official_nav, 4)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginTop: 2 }}>
                  最新净值{fund.official_date ? ` · ${fund.official_date}` : ''}
                </div>
              </div>
            )}
          </div>

          {/* 持仓 KPI */}
          {holding && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Kpi label="持有份额" value={fmtMoney(holding.shares)} />
              <Kpi label="持仓成本" value={`¥ ${fmtMoney(holding.cost, 0)}`}
                sub={holding.avg != null ? `均价 ${fmtMoney(holding.avg, 4)}` : undefined} />
              <Kpi label="持仓收益" accent
                value={holding.pnl != null ? `${fmtSigned(holding.pnl, 0)} 元` : '—'}
                valueColor={pnlColor(holding.pnl)}
                sub={fmtPct(holding.pnl_pct)} />
              <Kpi label="今日估算"
                value={fund?.intraday ? fmtPct(fund.intraday.estRet) : '—'}
                valueColor={fund?.intraday ? pnlColor(fund.intraday.estRet) : undefined}
                sub={fund?.intraday ? `≈ ${fmtMoney(fund.intraday.estNav, 4)}` : '等待行情'} />
            </div>
          )}

          {/* 净值走势 */}
          <div className="fb-card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>净值走势</strong>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--fb-text-4)' }}>
                <span style={{ width: 14, borderTop: '2px dashed #f59e0b', display: 'inline-block' }} />
                MA20 {fund?.signals ? fmtMoney(fund.signals.ma20, 4) : ''}
              </span>
              <span style={{ flex: 1 }} />
              {/* 区间切换：snapshot 目前只带单一窗口（约 1 个月 nav_tail）。长窗口
                  的数据通路落地后，再把这里换成受控的区间状态。 */}
              <span className="fb-seg">
                <span className="fb-seg-item active">1月</span>
                <span className="fb-seg-item" style={{ opacity: 0.4 }} title="更长区间的数据通路后补">3月</span>
                <span className="fb-seg-item" style={{ opacity: 0.4 }} title="更长区间的数据通路后补">6月</span>
                <span className="fb-seg-item" style={{ opacity: 0.4 }} title="更长区间的数据通路后补">1年</span>
              </span>
            </div>
            <LineChart values={navSeries} height={170} ma20={fund?.signals?.ma20 ?? undefined} />
          </div>

          {/* 双列：预测与信号 / RBSA 跟踪篮子 */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="fb-card" style={{ flex: '1 1 320px', minWidth: 320, padding: '14px 16px' }}>
              <strong style={{ fontSize: 13 }}>预测与信号</strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fb-text-3)' }}>预测涨跌幅{fund?.pred_date ? `（${fund.pred_date}）` : ''}</span>
                  <b className="fb-num" style={{ color: pnlColor(fund?.pred_ret ?? null) }}>
                    {fmtPct(fund?.pred_ret)}{fund?.pred_nav != null ? ` → ${fmtMoney(fund.pred_nav, 4)}` : ''}
                  </b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fb-text-3)' }}>拟合优度 R²</span>
                  <b className="fb-num">{fund?.r2 ?? '—'}</b>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--fb-text-3)' }}>预测命中率</span>
                  <b className="fb-num">
                    {fund?.accuracy?.hit_rate != null ? `${fund.accuracy.hit_rate}%（${fund.accuracy.n} 次）` : '—'}
                  </b>
                </div>
              </div>
              {fund?.signals && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  <span className={fund.signals.above_ma20 ? 'fb-chip fb-chip-up' : 'fb-chip fb-chip-down'}>
                    MA20 {fund.signals.above_ma20 ? '之上' : '之下'}
                  </span>
                  {fund.signals.below_trough && <span className="fb-chip fb-chip-warn">跌破前低</span>}
                  <span className="fb-chip fb-chip-plain">距高点 {fmtSigned(fund.signals.dd_from_ath, 1)}%</span>
                </div>
              )}
            </div>

            <div className="fb-card" style={{ flex: '1 1 320px', minWidth: 320, padding: '14px 16px' }}>
              <strong style={{ fontSize: 13 }}>RBSA 跟踪篮子</strong>
              {fund?.weights && fund.weights.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  {fund.weights.map(w => (
                    <WeightBar key={w.name} name={w.name} pct={w.pct} maxPct={maxWeight} />
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginTop: 8, lineHeight: 1.6 }}>
                    约束回归（45 交易日滚动）拟合出的风格因子权重，盘中估算与净值预测都基于它。
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '18px 8px' }}>
                  <div style={{ fontSize: 12, color: 'var(--fb-text-3)', marginBottom: 4 }}>跟踪篮子待配置</div>
                  <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginBottom: 12, lineHeight: 1.6 }}>
                    配置后 daimon 才能做盘中估算、净值预测与行业穿透
                  </div>
                  <button className="fb-btn fb-btn-ghost"
                    onClick={() => ask(`帮我为 ${name}(${code}) 配置 RBSA 跟踪篮子（register_fund），并说明每个因子的含义`)}>
                    让 daimon 现在配置
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 相关新闻 */}
          {relatedNews.length > 0 && (
            <section>
              <div style={{ fontSize: 12, color: 'var(--fb-text-4)', marginBottom: 10, letterSpacing: '0.04em' }}>
                相关新闻
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {relatedNews.map(n => (
                  <button key={n.title} className="fb-card hoverable" onClick={() => ask(n.prompt)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textAlign: 'left',
                      cursor: 'pointer', fontFamily: 'var(--fb-font-ui)', color: 'var(--fb-text-1)',
                    }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6 }}>{n.title}</span>
                    {n.impact && <ImpactChip impact={n.impact} />}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* 追问 dock：常驻底部，自动携带基金上下文 */}
      <div style={{
        flexShrink: 0, borderTop: '1px solid var(--fb-line-1)', background: 'var(--fb-bg-1)',
        padding: '10px 24px 14px',
      }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FOLLOW_UPS.map(s => (
              <button key={s} className="fb-suggest" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
          <Composer
            placeholder={`对 ${name}(${code}) 继续追问…`}
            onSend={ask}
          />
        </div>
      </div>
    </div>
  )
}
