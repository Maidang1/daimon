/**
 * Self-hosted finance terminal: root layout and entry point.
 *
 * Served by the finance-board host half at `/` (the official dsh SPA stays
 * reachable at `/index.html`). AI-first layout: a 250px sidebar (brand,
 * new-chat, recent sessions, bottom nav) plus a main area switching between
 * four views — `home` (AI 对话首页，默认落地), `chat` (会话消息流), `board`
 * (金融看板，原 TerminalPanel) and `fund` (基金下钻，携带 fundCode）。
 *
 * The view model and its persistence live in `view.ts`; this file is layout
 * plus wiring. ⌘/Ctrl+B toggles home ↔ chat.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/app
 */

import './terminal.css'

import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPanel } from '../client/TerminalPanel.js'
import { mux, type ConnectionState } from './dsh/mux.js'
import { onAuthExpired } from './dsh/rpc.js'
import { sessions } from './dsh/sessions.js'
import { Sidebar } from './sidebar.js'
import { ChatPanel } from './chat/ChatPanel.js'
import { HomeView } from './home/HomeView.js'
import { FundView } from './fund/FundView.js'
import { loadView, saveView, type View } from './view.js'

const STATE_LABEL: Record<ConnectionState, string> = {
  open: '已连接',
  connecting: '连接中',
  closed: '已断开',
}

function App(): React.ReactElement {
  const [connState, setConnState] = useState(mux.state)
  const [authExpired, setAuthExpired] = useState(false)
  const [view, setViewState] = useState<View>(loadView)

  /**
   * The one writer of view state. Accepts an updater so the ⌘/Ctrl+B handler
   * toggles from current state instead of re-implementing the persistence.
   */
  const setView = useCallback((next: View | ((cur: View) => View)): void => {
    setViewState(cur => {
      const value = typeof next === 'function' ? next(cur) : next
      saveView(value)
      return value
    })
  }, [])

  useEffect(() => mux.onStateChange(setConnState), [])
  useEffect(() => onAuthExpired(() => setAuthExpired(true)), [])

  /**
   * 发送一条 prompt：保证有活动会话后发出，随后切到对话页。
   *
   * The session-creation-then-prompt policy lives in the store, so home
   * suggestions, fund follow-ups and the chat composer share one path instead
   * of three that drifted. Navigation is immediate — the RPCs are not awaited
   * on the render path.
   */
  const sendPrompt = useCallback((text: string): void => {
    void sessions.ask(text)
    setView({ kind: 'chat' })
  }, [setView])

  const newChat = useCallback((): void => {
    void sessions.newSession()
    setView({ kind: 'chat' })
  }, [setView])

  // 快捷键：Cmd/Ctrl + B 在首页 ↔ 对话页之间切换。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'b') {
        ev.preventDefault()
        setView(cur => (cur.kind === 'chat' ? { kind: 'home' } : { kind: 'chat' }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView])

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--fb-bg-0)', color: 'var(--fb-text-1)' }}>
      <Sidebar
        active={view.kind}
        onNavigate={setView}
        onNewChat={newChat}
        onSelectChat={id => {
          sessions.selectSession(id)
          setView({ kind: 'chat' })
        }}
      />

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* 顶行：连接状态 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: '8px 18px 0', flexShrink: 0,
        }}>
          <span className="fb-pill">
            <span className={`fb-conn-dot ${connState}`} />
            {STATE_LABEL[connState]}
          </span>
        </div>

        {authExpired && (
          <div className="fb-banner warn" style={{ margin: '8px 18px 0', flexShrink: 0 }}>
            登录凭证已失效——请重新打开带 <code>?token=</code> 的链接登录（见 dsh-home 运行手册）。
          </div>
        )}

        {view.kind === 'home' && <HomeView onSend={sendPrompt} />}

        {view.kind === 'chat' && (
          <div style={{ flex: 1, minHeight: 0, maxWidth: 820, width: '100%', margin: '0 auto', padding: '0 24px' }}>
            <ChatPanel />
          </div>
        )}

        {view.kind === 'board' && (
          <div style={{ flex: 1, minHeight: 0 }}>
            <TerminalPanel
              tab={view.tab}
              onTabChange={tab => setView({ kind: 'board', tab })}
              onFundClick={code => setView({ kind: 'fund', code, from: view.tab })}
            />
          </div>
        )}

        {view.kind === 'fund' && (
          <FundView
            code={view.code}
            onBack={() => setView({ kind: 'board', tab: view.from })}
            onSend={sendPrompt}
          />
        )}
      </main>
    </div>
  )
}

// The session store's lifetime is the page's, so its entry point is wired here
// once rather than from whichever component happens to mount first. It runs
// after the first render: the chat needs it, but the shell must not wait on a
// socket that may not connect.
const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')
createRoot(container).render(<App />)
sessions.start()
