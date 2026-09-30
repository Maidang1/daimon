/**
 * AI 首页（默认落地页）：问候 + 提问框 + 快捷建议 + 今日主要指数 + 持仓相关新闻。
 *
 * 数据来自 agent 每日生成的 briefing.json（GET /finance/api/briefing）；
 * 404 时降级为「今日简报未生成」卡，主按钮触发 daily_briefing job 并每 5 秒
 * 轮询直到简报落盘。所有可点元素最终都收敛为一次 sendPrompt 并切到对话页。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchBriefing, startJob, type Briefing } from '../../client/api.js'
import { Composer } from '../chat/ChatPanel.js'

const DEFAULT_SUGGESTIONS = [
  '生成今日投资日报',
  '今天持仓表现如何？',
  '扫描我持仓的风险敞口',
]

const IMPACT_META: Record<string, { label: string; cls: string }> = {
  bullish: { label: '偏利好', cls: 'fb-chip fb-chip-up' },
  watch: { label: '关注', cls: 'fb-chip fb-chip-warn' },
  bearish: { label: '偏利空', cls: 'fb-chip fb-chip-down' },
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
  news: NonNullable<Briefing['news']>[number]
  onClick: () => void
}): React.ReactElement {
  const impact = IMPACT_META[news.impact ?? 'watch'] ?? IMPACT_META.watch
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
        <span className={impact.cls}>{impact.label}</span>
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
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const b = await fetchBriefing()
      setBriefing(b)
      if (b) {
        setGenerating(false)
        if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
      }
    } catch {
      // 读取失败保留当前帧
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
  }, [load])

  const generate = async (): Promise<void> => {
    setGenError(null)
    setGenerating(true)
    try {
      await startJob('daily_briefing')
    } catch (err) {
      // 409 = 已在跑，继续轮询即可
      if (!String(err instanceof Error ? err.message : err).includes('already running')) {
        setGenError(String(err instanceof Error ? err.message : err))
        setGenerating(false)
        return
      }
    }
    if (!pollTimer.current) pollTimer.current = setInterval(() => void load(), 5_000)
  }

  const suggestions = briefing?.suggestions?.length ? briefing.suggestions : DEFAULT_SUGGESTIONS
  const indices = briefing?.indices ?? []
  const news = briefing?.news ?? []

  return (
    <div className="fb-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', padding: '48px 24px 40px',
        display: 'flex', flexDirection: 'column', gap: 22,
      }}>
        {/* 问候 */}
        <div className="fb-fade-up">
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {briefing?.greeting ?? greetingByTime()}，我是 daimon
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
              今日主要指数 · {briefing?.date}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {indices.map(ix => (
                <IndexCard
                  key={ix.name}
                  name={ix.name}
                  value={ix.value}
                  pct={ix.pct}
                  onClick={() => onSend(`今天${ix.name}为什么${ix.pct >= 0 ? '涨' : '跌'}？对我的持仓有什么影响？`)}
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
          {loaded && !briefing && (
            <div className="fb-card" style={{ padding: '20px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--fb-text-2)', marginBottom: 4 }}>今日简报尚未生成</div>
              <div style={{ fontSize: 12, color: 'var(--fb-text-4)', marginBottom: 14 }}>
                让 daimon 汇总主要指数行情，并根据你的持仓筛选今天的相关新闻
              </div>
              <button
                className="fb-btn fb-btn-primary"
                disabled={generating}
                onClick={() => void generate()}
              >
                {generating
                  ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>生成中 <span className="fb-dots"><span /><span /><span /></span></span>
                  : '让 daimon 生成今日简报'}
              </button>
              {genError && <div style={{ fontSize: 12, color: 'var(--fb-up)', marginTop: 10 }}>{genError}</div>}
            </div>
          )}
          {loaded && briefing && news.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--fb-text-4)', padding: '6px 2px' }}>
              今天没有筛选出与持仓强相关的新闻。
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
