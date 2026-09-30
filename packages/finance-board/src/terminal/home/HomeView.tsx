/**
 * AI 首页（默认落地页）：问候 + 提问框 + 快捷建议 + 今日主要指数 + 持仓相关新闻。
 *
 * 数据来自 financeStore（`GET /finance/api/briefing`），首页只负责渲染。
 * 简报 404 → `missing`，降级为「今日简报未生成」卡；主按钮触发
 * daily_briefing job，之后由轮询自动收到落盘的简报——这里不再自建轮询器。
 * 所有可点元素最终都收敛为一次 sendPrompt 并切到对话页。
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/home/HomeView
 */

import { useCallback, useState } from 'react'
import { describeError, isJobConflict, startJob, type BriefingNews } from '../../client/api.js'
import { useFinance } from '../../client/financeStore.js'
import { Composer } from '../ui/Composer.js'

/** 首页建议 chips 的兜底文案（服务端不再自带一份，避免两处时钟/口径漂移）。 */
const FALLBACK_SUGGESTIONS = [
  '生成今日投资日报',
  '今天持仓表现如何？',
  '扫描我持仓的风险敞口',
]

/** 指数涨跌 → 提问 prompt。 */
function indexPrompt(name: string, pct: number): string {
  return `今天${name}为什么${pct >= 0 ? '涨' : '跌'}？对我的持仓有什么影响？`
}

const IMPACT_META = {
  bullish: { label: '偏利好', cls: 'fb-chip fb-chip-up' },
  watch: { label: '关注', cls: 'fb-chip fb-chip-warn' },
  bearish: { label: '偏利空', cls: 'fb-chip fb-chip-down' },
} as const

/** One impact chip, shared with the fund detail view. */
export function ImpactChip({ impact }: { impact: 'bullish' | 'watch' | 'bearish' }): React.ReactElement {
  const meta = IMPACT_META[impact] ?? IMPACT_META.watch
  return <span className={meta.cls}>{meta.label}</span>
}

function greetingByTime(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function IndexCard({ name, value, pct, onClick }: {
  name: string
  value: number
  pct: number
  onClick: () => void
}): React.ReactElement {
  const up = pct >= 0
  return (
    <button
      className="fb-card hoverable fb-fade-up"
      onClick={onClick}
      style={{
        flex: '1 1 150px', minWidth: 150, padding: '12px 14px', textAlign: 'left',
        cursor: 'pointer', fontFamily: 'var(--fb-font-ui)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--fb-text-3)', marginBottom: 6 }}>{name}</div>
      <div className="fb-num" style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>
        {value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <span className={`fb-num ${up ? 'fb-chip fb-chip-up' : 'fb-chip fb-chip-down'}`} style={{ marginTop: 6 }}>
        {up ? '+' : ''}{pct.toFixed(2)}%
      </span>
    </button>
  )
}

function NewsCard({ news, onClick }: {
  news: BriefingNews
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      className="fb-card hoverable fb-fade-up"
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', padding: '13px 16px',
        cursor: 'pointer', fontFamily: 'var(--fb-font-ui)', color: 'var(--fb-text-1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.6 }}>{news.title}</div>
        <ImpactChip impact={news.impact ?? 'watch'} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--fb-text-4)' }}>
          {[news.source, news.time].filter(Boolean).join(' · ')}
        </span>
        {(news.funds ?? []).map(f => (
          <span key={f} className="fb-chip fb-chip-brand">{f}</span>
        ))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fb-brand-hi)', marginTop: 8 }}>
        问问 daimon：这条新闻对我的持仓有什么影响？ →
      </div>
    </button>
  )
}

export function HomeView({ onSend }: { onSend: (text: string) => void }): React.ReactElement {
  const finance = useFinance()
  const briefing = finance.briefing
  const [genError, setGenError] = useState<string | null>(null)

  const generate = useCallback((): void => {
    setGenError(null)
    void startJob('daily_briefing').catch(err => {
      // 409 = 已在跑，不是错误：共享轮询会在简报落盘时把它送进来。
      if (isJobConflict(err)) return
      setGenError(describeError(err))
    })
  }, [])

  const doc = briefing.resource.kind === 'ready' ? briefing.resource.value : null
  const suggestions = doc?.suggestions?.length ? doc.suggestions : FALLBACK_SUGGESTIONS
  const indices = doc?.indices ?? []
  const news = doc?.news ?? []
  // 生成态直接来自 job 记录，不再自建「轮询直到简报出现」的定时器。
  const generating = finance.jobs.some(j => j.action === 'daily_briefing' && j.status === 'running')

  return (
    <div className="fb-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', padding: '48px 24px 40px',
        display: 'flex', flexDirection: 'column', gap: 22,
      }}>
        {/* 问候 */}
        <div className="fb-fade-up">
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {doc?.greeting ?? greetingByTime()}，我是 daimon
          </div>
          <div style={{ fontSize: 13, color: 'var(--fb-text-3)', marginTop: 6 }}>
            你的 AI 投资助手 · 问行情、问持仓、问新闻，直接开口
          </div>
        </div>

        {/* 提问框 */}
        <Composer
          placeholder="问问今天的行情、你的持仓、或者任何投资问题…"
          onSend={onSend}
          autoFocus
        />

        {/* 快捷建议 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {suggestions.map(s => (
            <button key={s} className="fb-suggest" onClick={() => onSend(s)}>{s}</button>
          ))}
        </div>

        {/* 今日主要指数 */}
        {indices.length > 0 && (
          <section>
            <div style={{ fontSize: 12, color: 'var(--fb-text-4)', marginBottom: 10, letterSpacing: '0.04em' }}>
              今日主要指数 · {doc?.date}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {indices.map(ix => (
                <IndexCard
                  key={ix.name}
                  name={ix.name}
                  value={ix.value}
                  pct={ix.pct}
                  onClick={() => onSend(indexPrompt(ix.name, ix.pct))}
                />
              ))}
            </div>
          </section>
        )}

        {/* 与持仓相关的新闻 */}
        <section>
          <div style={{ fontSize: 12, color: 'var(--fb-text-4)', marginBottom: 10, letterSpacing: '0.04em' }}>
            与你的持仓相关
          </div>
          {news.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {news.map(n => (
                <NewsCard key={n.title} news={n} onClick={() => onSend(n.prompt)} />
              ))}
            </div>
          )}
          {briefing.resource.kind === 'missing' && (
            <div className="fb-card" style={{ padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--fb-text-2)', marginBottom: 4 }}>今日简报尚未生成</div>
              <div style={{ fontSize: 12, color: 'var(--fb-text-4)', marginBottom: 14 }}>
                让 daimon 汇总主要指数行情，并根据你的持仓筛选今天的相关新闻
              </div>
              <button
                className="fb-btn fb-btn-primary"
                disabled={generating}
                onClick={generate}
              >
                {generating
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>生成中 <span className="fb-dots"><span /><span /><span /></span></span>
                  : '让 daimon 生成今日简报'}
              </button>
              {genError && <div style={{ fontSize: 12, color: 'var(--fb-up)', marginTop: 10 }}>{genError}</div>}
            </div>
          )}
          {briefing.resource.kind === 'failed' && (
            <div style={{ fontSize: 12, color: 'var(--fb-up)' }}>简报读取失败：{briefing.resource.error}</div>
          )}
          {briefing.resource.kind === 'ready' && news.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--fb-text-4)', padding: '6px 2px' }}>
              今天没有筛选出与持仓强相关的新闻。
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
