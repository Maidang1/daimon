/**
 * Self-hosted finance terminal: root layout and entry point.
 *
 * Served by the finance-board host half at `/` (the official dsh SPA stays
 * reachable at `/index.html`). Layout: a top bar (title, connection
 * indicator, chat toggle), the finance terminal panel filling the main area
 * (same components as the legacy dsh client panel, finance API same-origin),
 * and the chat drawer docked right.
 */

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPanel } from '../client/TerminalPanel.js'
import { C } from '../client/format.js'
import { mux } from './dsh/mux.js'
import { onAuthExpired } from './dsh/rpc.js'
import { ChatDrawer } from './chat/ChatDrawer.js'

const STATE_DOT: Record<string, string> = {
  open: '#2fbf71',
  connecting: '#e2a336',
  closed: '#ff5c6c',
}

const STATE_LABEL: Record<string, string> = {
  open: '已连接',
  connecting: '连接中',
  closed: '已断开',
}

function App(): React.ReactElement {
  const [connState, setConnState] = useState(mux.state)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [authExpired, setAuthExpired] = useState(false)

  useEffect(() => mux.onStateChange(setConnState), [])
  useEffect(() => onAuthExpired(() => setAuthExpired(true)), [])

  // 快捷键：Cmd/Ctrl + B 切换聊天抽屉。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'b') {
        ev.preventDefault()
        setDrawerOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 42,
        borderBottom: `1px solid ${C.line}`, flexShrink: 0, fontSize: 13,
      }}>
        <strong style={{ fontSize: 14 }}>daimon · 金融终端</strong>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.dim }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: STATE_DOT[connState],
            display: 'inline-block',
          }} />
          {STATE_LABEL[connState]}
        </span>
        <button
          onClick={() => setDrawerOpen(open => !open)}
          style={{
            border: `1px solid ${C.line}`, borderRadius: 6, background: drawerOpen ? C.panel : 'transparent',
            color: C.text, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
          }}
          title="切换会话抽屉（⌘/Ctrl+B）"
        >
          会话
        </button>
      </header>

      {authExpired && (
        <div style={{
          padding: '8px 16px', fontSize: 12, flexShrink: 0,
          background: 'rgba(226, 163, 54, 0.12)', color: C.warn,
          borderBottom: `1px solid ${C.line}`,
        }}>
          登录凭证已失效——请重新打开带 <code>?token=</code> 的链接登录（见 dsh-home 运行手册）。
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, minWidth: 0 }}>
          <TerminalPanel />
        </main>
        {drawerOpen && <ChatDrawer onClose={() => setDrawerOpen(false)} />}
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')
createRoot(container).render(<App />)
