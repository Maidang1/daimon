/**
 * Chat message list: renders the session store's *normalised* message model
 * (dsh session events are mapped to this shape upstream, so this component
 * knows nothing about the wire protocol).
 *
 * v1 rendering is intentionally light: newlines preserved, fenced code gets a
 * panel background — no syntax highlighting, no markdown parser.
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
            background: 'rgba(0,0,0,0.35)', borderRadius: 6, padding: '8px 10px',
            fontSize: 12, overflowX: 'auto', margin: '6px 0',
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
  const statusIcon = msg.status === 'running' ? '⏳' : msg.status === 'error' ? '✗' : '✓'
  const statusColor = msg.status === 'error' ? C.up : msg.status === 'running' ? C.warn : C.dim
  return (
    <div style={{
      margin: '4px 0', border: `1px solid ${C.line}`, borderRadius: 8,
      background: C.panel, fontSize: 12, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'transparent', border: 'none', color: C.text, cursor: 'pointer',
          padding: '7px 10px', fontSize: 12,
        }}
      >
        <span style={{ color: statusColor }}>{statusIcon}</span>
        <strong>{msg.name}</strong>
        {msg.argsSummary && (
          <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {msg.argsSummary}
          </span>
        )}
        <span style={{ color: C.dim, marginLeft: 'auto' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && msg.output !== undefined && (
        <pre style={{
          margin: 0, padding: '8px 10px', borderTop: `1px solid ${C.line}`,
          background: 'rgba(0,0,0,0.3)', fontSize: 11, overflowX: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 320, overflowY: 'auto',
        }}>
          {shown.join('\n')}
          {truncated && !open && ''}
          {truncated && `\n…（共 ${lines.length} 行）`}
        </pre>
      )}
    </div>
  )
}

function Bubble({ msg }: { msg: ChatMessage }): React.ReactElement {
  if (msg.kind === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
        <div style={{
          maxWidth: '88%', background: 'rgba(77, 159, 255, 0.16)', border: `1px solid rgba(77,159,255,0.35)`,
          borderRadius: 10, padding: '7px 11px', fontSize: 13,
        }}>
          <Text text={msg.text} />
        </div>
      </div>
    )
  }
  if (msg.kind === 'assistant') {
    return (
      <div style={{ margin: '6px 0', fontSize: 13, lineHeight: 1.7 }}>
        <Text text={msg.text} />
        {msg.streaming && <span style={{ color: C.accent }}>▍</span>}
      </div>
    )
  }
  if (msg.kind === 'tool') return <ToolCard msg={msg} />
  return (
    <div style={{
      margin: '6px 0', fontSize: 12, textAlign: 'center',
      color: msg.tone === 'error' ? C.up : C.dim,
    }}>
      {msg.text}
    </div>
  )
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
      onScroll={() => {
        const el = scrollRef.current
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', minHeight: 0 }}
    >
      {messages.length === 0 && (
        <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', marginTop: 48 }}>
          没有消息。在下面输入，或从终端面板发起快捷操作。
        </div>
      )}
      {messages.map(msg => <Bubble key={msg.id} msg={msg} />)}
      <div ref={endRef} />
    </div>
  )
}
