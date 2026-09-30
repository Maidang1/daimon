/**
 * Self-hosted finance terminal: root layout and entry point.
 *
 * Served by the finance-board host half at `/` (the official dsh SPA stays
 * reachable at `/index.html`). AI-first layout: a 250px sidebar (brand,
 * new-chat, recent sessions, bottom nav) plus a main area switching between
 * four views — `home` (AI 对话首页，默认落地), `chat` (会话消息流), `board`
 * (金融看板，原 TerminalPanel) and `fund` (基金下钻，携带 fundCode)。
 *
 * View state is plain useState persisted to localStorage('fb.view') — no
 * router, keeping the bundle zero-dependency. ⌘/Ctrl+B toggles home ↔ chat.
 */

import './terminal.css'

import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPanel, type BoardTab } from '../client/TerminalPanel.js'
import { mux } from './dsh/mux.js'
import { onAuthExpired } from './dsh/rpc.js'
import { sessions } from './dsh/sessions.js'
import { Sidebar } from './sidebar.js'
import { ChatPanel } from './chat/ChatPanel.js'
import { HomeView } from './home/HomeView.js'
import { FundView } from './fund/FundView.js'

type View =
  | { kind: 'home' }
  | { kind: 'chat' }
  | { kind: 'board' }
  | { kind: 'fund'; code: string }

const VIEW_STORAGE_KEY = 'fb.view'

function loadView(): View {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    if (!raw) return { kind: 'home' }
    const parsed = JSON.parse(raw) as View
    if (parsed.kind === 'home' || parsed.kind === 'chat' || parsed.kind === 'board') return parsed
    if (parsed.kind === 'fund' && typeof parsed.code === 'string' && parsed.code) return parsed
  } catch {
    // fall through
  }
  return { kind: 'home' }
}

const STATE_LABEL: Record<string, string> = {
  open: '已连接',
  connecting: '连接中',
  closed: '已断开',
}

function App(): React.ReactElement {
  const [connState, setConnState] = useState(mux.state)
  const [authExpired, setAuthExpired] = useState(false)
  const [view, setViewState] = useState<View>(loadView)
  const [boardTab, setBoardTab] = useState<BoardTab>('overview')

  const setView = useCallback((v: View): void => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(v))
    } catch {
      // 隐私模式下持久化失败不影响使用
    }
  }, [])

  useEffect(() => mux.onStateChange(setConnState), [])
  useEffect(() => onAuthExpired(() => setAuthExpired(true)), [])
  useEffect(() => sessions.start(), [])

  /** 发送一条 prompt：无活动会话时先建会话，随后切到对话页。 */
  const sendPrompt = useCallback((text: string): void => {
    void (async () => {
      if (!sessions.getState().activeSessionId) await sessions.createSession()
      await sessions.sendPrompt(text)
      setView({ kind: 'chat' })
    })()
  }, [setView])

  const newChat = useCallback((): void => {
    void sessions.createSession().then(() => setView({ kind: 'chat' }))
  }, [setView])

  const openBoard = useCallback((tab?: BoardTab): void => {
    if (tab) setBoardTab(tab)
    setView({ kind: 'board' })
  }, [setView])

  // 快捷键：Cmd/Ctrl + B 在首页 ↔ 对话页之间切换。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'b') {
        ev.preventDefault()
        setViewState(cur => {
          const next: View = cur.kind === 'chat' ? { kind: 'home' } : { kind: 'chat' }
          try {
            localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(next))
          } catch {
            // ignore
          }
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--fb-bg-0)', color: 'var(--fb-text-1)' }}>
      <Sidebar
        active={view.kind}
        onNewChat={newChat}
        onSelectChat={id => { sessions.selectSession(id); setView({ kind: 'chat' }) }}
        onOpenBoard={() => openBoard()}
        onOpenHotspots={() => openBoard('hotspots')}
        onOpenHome={() => setView({ kind: 'home' })}
      />

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* 顶行：连接状态 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: '8px 18px 0', flexShrink: 0,
        }}>
          <span className="fb-pill">
            <span className={`fb-conn-dot ${connState}`} />
            {STATE_LABEL[connState] ?? connState}
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
              tab={boardTab}
              onTabChange={setBoardTab}
              onFundClick={code => setView({ kind: 'fund', code })}
            />
          </div>
        )}

        {view.kind === 'fund' && (
          <FundView
            code={view.code}
            onBack={() => setView({ kind: 'board' })}
            onSend={sendPrompt}
          />
        )}
      </main>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')
createRoot(container).render(<App />)
