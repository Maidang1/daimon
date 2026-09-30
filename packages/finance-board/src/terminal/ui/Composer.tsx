/**
 * The prompt box: home, the chat page and the fund follow-up dock all use it.
 *
 * It used to live inside `chat/ChatPanel.tsx` and call `sessions.cancelActive()`
 * directly, so importing it for the sake of one textarea dragged the session
 * store, the events stream and `MessageList` into the home and fund module
 * graphs — and it was not actually reusable outside a session context. It now
 * takes an explicit `onStop`, so the stop action belongs to whoever owns the
 * running turn.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/ui/Composer
 */

import { useEffect, useRef, useState } from 'react'

export function Composer({ placeholder, disabled, onSend, onStop, autoFocus }: {
  placeholder: string
  disabled?: boolean
  onSend: (text: string) => void
  /** When provided, a stop button is rendered — the caller owns the turn. */
  onStop?: () => void
  autoFocus?: boolean
}): React.ReactElement {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="fb-composer">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={ev => setDraft(ev.target.value)}
          onKeyDown={ev => {
            if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
              ev.preventDefault()
              send()
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
        />
        <button
          className="fb-send"
          title="发送（Enter）"
          disabled={!draft.trim() || disabled}
          onClick={send}
        >
          ↑
        </button>
      </div>
      {onStop && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="fb-btn fb-btn-ghost" onClick={onStop}>
            ■ 停止生成
          </button>
        </div>
      )}
    </div>
  )
}
