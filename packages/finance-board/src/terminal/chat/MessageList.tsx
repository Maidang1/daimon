/**
 * Chat message list: renders the session store's *normalised* message model
 * (dsh session events are mapped to this shape upstream, so this component
 * knows nothing about the wire protocol).
 *
 * v1 rendering is intentionally light: newlines preserved, fenced code gets a
 * panel background — no syntax highlighting, no markdown parser.
 *
 * Visuals: assistant messages get a gradient avatar and open typography
 * (ChatGPT-style), user messages a right-aligned brand-dim bubble; streaming
 * shows a blinking cursor, empty streaming bubbles the thinking dots; tool
 * calls render as status-bar cards with a CSS spinner while running.
 */

import { useEffect, useRef, useState } from 'react'
import { C } from '../../client/format.js'

/** Normalised chat message, produced by dsh/sessions.ts from session events. */
export type ChatMessage =
  | { kind: 'user'; id: string; text: string; time?: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; time?: string }
  | {
      kind: 'tool'
      id: string
      name: string
      argsSummary: string
      output?: string
      status: 'running' | 'done' | 'error'
      time?: string
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error'; time?: string }

/** Assistant/user text: preserve newlines, tint fenced code blocks. */
function Text({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(```[\s\S]*?```)/g)
  return (
    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {parts.map((part, i) =>
        part.startsWith('```') ? (
          <pre key={i} style={{
            background: 'var(--fb-bg-0)', borderRadius: 'var(--fb-r-sm)', padding: '8px 10px',
            fontSize: 12, overflowX: 'auto', margin: '6px 0', border: '1px solid var(--fb-line-1)',
          }}>
            {part.replace(/^```\w*\n?/, '').replace(/```$/, '')}
          </pre>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  )
}

/** Long tool output is truncated to the first N lines; expand on demand. */
const TOOL_OUTPUT_HEAD_LINES = 12

function ToolCard({ msg }: { msg: Extract<ChatMessage, { kind: 'tool' }> }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const lines = (msg.output ?? '').split('\n')
  const truncated = lines.length > TOOL_OUTPUT_HEAD_LINES
  const shown = open || !truncated ? lines : lines.slice(0, TOOL_OUTPUT_HEAD_LINES)
  return (
    <div className={`fb-tool-card ${msg.status}`} style={{ margin: '4px 0' }}>
      <span className="bar" />
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'transparent', border: 'none', color: 'var(--fb-text-1)', cursor: 'pointer',
          padding: '8px 12px 8px 15px', fontSize: 12, fontFamily: 'var(--fb-font-ui)',
        }}
      >
        {msg.status === 'running'
          ? <span className="fb-spinner" />
          : (
            <span style={{ color: msg.status === 'error' ? 'var(--fb-up)' : 'var(--fb-down)' }}>
              {msg.status === 'error' ? '✗' : '✓'}
            </span>
          )}
        <strong className="fb-mono" style={{ fontSize: 12 }}>{msg.name}</strong>
        {msg.argsSummary && (
          <span style={{ color: 'var(--fb-text-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {msg.argsSummary}
          </span>
        )}
        <span style={{ color: 'var(--fb-text-4)', marginLeft: 'auto' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && msg.output !== undefined && (
        <pre className="fb-scroll" style={{
          margin: 0, padding: '8px 12px 8px 15px', borderTop: '1px solid var(--fb-line-1)',
          background: 'var(--fb-bg-0)', fontSize: 11, overflowX: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 320, overflowY: 'auto',
        }}>
          {shown.join('\n')}
          {truncated && `\n…（共 ${lines.length} 行）`}
        </pre>
      )}
    </div>
  )
}

function Bubble({ msg }: { msg: ChatMessage }): React.ReactElement {
  if (msg.kind === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '10px 0' }}>
        <div className="fb-user-bubble">
          <Text text={msg.text} />
        </div>
      </div>
    )
  }
  if (msg.kind === 'assistant') {
    return (
      <div style={{ display: 'flex', gap: 10, margin: '10px 0' }}>
        <span className="fb-avatar">✦</span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.8, paddingTop: 2 }}>
          {msg.text
            ? <Text text={msg.text} />
            : msg.streaming && (
              <span className="fb-dots" style={{ color: 'var(--fb-text-3)', padding: '4px 0' }}>
                <span /><span /><span />
              </span>
            )}
          {msg.streaming && msg.text && <span className="fb-cursor">▍</span>}
        </div>
      </div>
    )
  }
  if (msg.kind === 'tool') {
    return (
      <div style={{ display: 'flex', gap: 10, margin: '4px 0' }}>
        <span style={{ width: 26, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}><ToolCard msg={msg} /></div>
      </div>
    )
  }
  // `notice` is the fallback render, so it is stated rather than implied: the
  // reachability assertion below fails to compile when a new kind is added and
  // no branch handles it, instead of silently rendering it as a notice.
  if (msg.kind === 'notice') {
    return (
      <div style={{
        margin: '8px 0', fontSize: 12, textAlign: 'center',
        color: msg.tone === 'error' ? C.up : 'var(--fb-text-4)',
      }}>
        {msg.text}
      </div>
    )
  }
  const never: never = msg
  throw new Error(`unrendered chat message kind: ${JSON.stringify(never)}`)
}

export function MessageList({ messages }: { messages: ChatMessage[] }): React.ReactElement {
  const endRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll only while the user is pinned to the bottom.
  useEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <div
      ref={scrollRef}
      className="fb-scroll"
      onScroll={() => {
        const el = scrollRef.current
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      style={{ flex: 1, overflowY: 'auto', padding: '6px 0', minHeight: 0 }}
    >
      {messages.length === 0 && (
        <div style={{ textAlign: 'center', marginTop: 64 }}>
          <div className="fb-empty-logo" style={{ margin: '0 auto 16px' }} />
          <div style={{ color: 'var(--fb-text-3)', fontSize: 13 }}>向 daimon 提问，开始分析你的持仓</div>
        </div>
      )}
      {messages.map(msg => <Bubble key={msg.id} msg={msg} />)}
      <div ref={endRef} />
    </div>
  )
}
