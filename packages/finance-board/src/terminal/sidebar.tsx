/** 侧边栏：品牌区、新对话按钮、最近会话列表、底部导航（看板/热点/官方界面）。 */

import { useEffect, useSyncExternalStore } from 'react'
import { sessions } from './dsh/sessions.js'

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function sessionLabel(id: string, cwd?: string): string {
  if (!cwd) return shortId(id)
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? cwd
  return `${base} · ${shortId(id)}`
}

export function Sidebar({ active, onNewChat, onSelectChat, onOpenBoard, onOpenHotspots, onOpenHome }: {
  /** 当前主区视图，用于导航高亮。 */
  active: 'home' | 'chat' | 'board' | 'fund'
  onNewChat: () => void
  onSelectChat: (sessionId: string) => void
  onOpenBoard: () => void
  onOpenHotspots: () => void
  onOpenHome: () => void
}): React.ReactElement {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getState)
  useEffect(() => sessions.start(), [])

  const navItem = (label: string, isActive: boolean, onClick: () => void, external = false): React.ReactElement => (
    <button
      key={label}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        background: isActive ? 'var(--fb-bg-3)' : 'transparent', border: 'none',
        color: isActive ? 'var(--fb-text-1)' : 'var(--fb-text-3)',
        padding: '7px 10px', fontSize: 13, borderRadius: 'var(--fb-r-sm)', cursor: 'pointer',
        fontFamily: 'var(--fb-font-ui)',
      }}
      onMouseEnter={ev => { if (!isActive) ev.currentTarget.style.background = 'var(--fb-hover)' }}
      onMouseLeave={ev => { if (!isActive) ev.currentTarget.style.background = 'transparent' }}
    >
      {label}
      {external && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fb-text-4)' }}>↗</span>}
    </button>
  )

  return (
    <aside style={{
      width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--fb-bg-1)', borderRight: '1px solid var(--fb-line-1)', minHeight: 0,
    }}>
      {/* 品牌区：点击回首页 */}
      <button
        onClick={onOpenHome}
        title="回到首页"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--fb-font-ui)',
        }}
      >
        <span className="fb-logo" />
        <div>
          <div className="fb-wordmark">daimon</div>
          <div style={{ fontSize: 11, color: 'var(--fb-text-4)', marginTop: 1 }}>AI 投资助手</div>
        </div>
      </button>

      {/* 新对话 */}
      <div style={{ padding: '0 12px 12px' }}>
        <button className="fb-btn fb-btn-primary" style={{ width: '100%' }} onClick={onNewChat}>
          ＋ 新对话
        </button>
      </div>

      {/* 最近会话 */}
      <div style={{
        padding: '0 12px 6px', fontSize: 11, color: 'var(--fb-text-4)',
        letterSpacing: '0.04em',
      }}>
        最近对话
      </div>
      <div className="fb-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 8px', minHeight: 0 }}>
        {state.sessions.length === 0 && (
          <div style={{ padding: '10px 10px', fontSize: 12, color: 'var(--fb-text-4)' }}>暂无会话</div>
        )}
        {state.sessions.map(s => {
          const isActive = s.sessionId === state.activeSessionId && (active === 'chat' || active === 'home')
          return (
            <button
              key={s.sessionId}
              onClick={() => onSelectChat(s.sessionId)}
              title={sessionLabel(s.sessionId, s.cwd)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                background: isActive ? 'var(--fb-bg-3)' : 'transparent', border: 'none',
                color: isActive ? 'var(--fb-text-1)' : 'var(--fb-text-3)',
                padding: '7px 10px', fontSize: 12, borderRadius: 'var(--fb-r-sm)', cursor: 'pointer',
                fontFamily: 'var(--fb-font-ui)',
              }}
              onMouseEnter={ev => { if (!isActive) ev.currentTarget.style.background = 'var(--fb-hover)' }}
              onMouseLeave={ev => { if (!isActive) ev.currentTarget.style.background = 'transparent' }}
            >
              {s.running
                ? <span style={{ color: 'var(--fb-brand)', fontSize: 9 }}>●</span>
                : <span style={{ width: 9 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sessionLabel(s.sessionId, s.cwd)}
              </span>
            </button>
          )
        })}
      </div>

      {/* 底部导航 */}
      <div style={{
        borderTop: '1px solid var(--fb-line-1)', padding: '8px 8px 12px',
        display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0,
      }}>
        {navItem('金融看板', active === 'board' || active === 'fund', onOpenBoard)}
        {navItem('热点资讯', false, onOpenHotspots)}
        {navItem('官方界面', false, () => window.open('/index.html', '_blank'), true)}
      </div>
    </aside>
  )
}
