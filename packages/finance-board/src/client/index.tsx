/**
 * Finance board client half: registers the 看板 as a global main panel of the
 * dsh SPA and adds its entry to the sidebar panel list. Selecting the sidebar
 * row swaps the central column from the conversation to the embedded board.
 *
 * The panel iframes `/finance` (same origin, served by this package's host
 * half) — the self-contained dashboard file the agent renders with
 * `finance.dashboard()`. A 5s poll of `/finance/api/status` reloads the
 * iframe only when the file actually changed, so scroll state survives.
 *
 * The bundle is wrapped for the dsh client module loader by scripts/wrap-client.mjs;
 * runtime imports are limited to the loader's baseline table (react only).
 */

import { useEffect, useState } from 'react'

/** Identity shared by the sidebar panel entry and the main-slot occupant. */
const PANEL_ID = 'finance'

/** Client-side services this plugin requires (the slots registry only). */
export const inject = ['slots']

interface BoardStatus {
  exists: boolean
  mtime: string | null
}

/**
 * The finance dashboard as a central main panel: a slim toolbar over a
 * same-origin iframe of the regenerated dashboard file.
 */
function FinanceBoardPanel(): React.ReactElement {
  const [nonce, setNonce] = useState(0)
  const [missing, setMissing] = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/finance/api/status?_=${Date.now()}`)
        const body = (await res.json()) as BoardStatus
        if (stopped) return
        setMissing(!body.exists)
        setGeneratedAt(prev => {
          if (prev !== null && body.mtime !== null && body.mtime !== prev) {
            setNonce(n => n + 1)
          }
          return body.mtime ?? prev
        })
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
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--dsh-bg, #fff)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
        borderBottom: '1px solid rgba(0,0,0,0.08)', fontSize: 13, flexShrink: 0,
      }}>
        <strong>📈 Finance 看板</strong>
        {generatedAt !== null && (
          <span style={{ opacity: 0.55 }}>
            数据更新于 {new Date(generatedAt).toLocaleString('zh-CN', { hour12: false })}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setNonce(n => n + 1)}
          style={{
            border: '1px solid rgba(0,0,0,0.15)', borderRadius: 6, background: 'transparent',
            padding: '3px 10px', fontSize: 12, cursor: 'pointer',
          }}
        >
          刷新
        </button>
      </div>
      {missing ? (
        <div style={{ margin: '80px auto', maxWidth: 520, padding: '0 24px', lineHeight: 1.8 }}>
          <h2>看板尚未生成</h2>
          <p>在会话里让 agent 执行：</p>
          <pre style={{ background: 'rgba(0,0,0,0.05)', padding: 12, borderRadius: 8 }}>
            {'import finance\npath = await finance.dashboard()'}
          </pre>
          <p>生成后本页会自动加载（5 秒轮询）。</p>
        </div>
      ) : (
        <iframe
          key={nonce}
          src="/finance"
          title="Finance 看板"
          style={{ flex: 1, border: 'none', width: '100%' }}
        />
      )}
    </div>
  )
}

/** Bar-chart row icon for the sidebar panel list. */
function FinanceBoardIcon({ size, active }: { size: number; active: boolean }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="8" width="3" height="6" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
      <rect x="6.5" y="4" width="3" height="10" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
      <rect x="11" y="1.5" width="3" height="12.5" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
    </svg>
  )
}

/**
 * Register the finance board panel and its sidebar entry.
 *
 * @param ctx - the client root context (typed loosely; the slot registry's
 *   generic machinery belongs to the dsh client internals).
 */
export function apply(ctx: any): void {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, FinanceBoardPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => 'Finance 看板',
  }, FinanceBoardIcon))
}
