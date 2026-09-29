/**
 * Chat drawer docked to the right of the finance terminal: session picker,
 * message list, approval/question banners, and the composer.
 *
 * State comes from dsh/sessions.ts (wire protocol) and dsh/events.ts
 * (waterfall banners); this component owns only local UI state.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { C } from '../../client/format.js'
import { onEvent, answerApproval, answerQuestions, type ApprovalRequest, type UserQuestionsRequest } from '../dsh/events.js'
import { sessions } from '../dsh/sessions.js'
import { MessageList } from './MessageList.js'

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function sessionLabel(id: string, cwd?: string): string {
  if (!cwd) return shortId(id)
  const base = cwd.replace(/\/+$/, '').split('/').pop() ?? cwd
  return `${base} · ${shortId(id)}`
}

/* ---------- banners ---------- */

function ApprovalBanner({ req, onDone }: { req: ApprovalRequest; onDone: () => void }): React.ReactElement {
  return (
    <div style={{
      margin: '8px 12px', padding: '10px 12px', borderRadius: 8, fontSize: 12,
      background: 'rgba(226, 163, 54, 0.10)', border: `1px solid ${C.warn}`,
    }}>
      <div style={{ marginBottom: 6 }}>
        <strong>审批请求</strong>：工具 <code>{req.toolName}</code>
      </div>
      {(req.displayReason ?? req.reason) && (
        <div style={{ color: C.dim, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{req.displayReason ?? req.reason}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={bannerBtn(C.accent)} onClick={() => { answerApproval(req.eventId, 'allowed-once'); onDone() }}>
          同意
        </button>
        <button style={bannerBtn(C.up)} onClick={() => { answerApproval(req.eventId, 'rejected'); onDone() }}>
          拒绝
        </button>
      </div>
    </div>
  )
}

function QuestionsBanner({ req, onDone }: { req: UserQuestionsRequest; onDone: () => void }): React.ReactElement {
  // 每题一个自由文本回答；有选项时选项作为快捷按钮填入。
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const submit = (): void => {
    answerQuestions(req.eventId, req.questions.map(q => ({
      id: q.id,
      selected: selected[q.id] ?? [],
      custom: texts[q.id]?.trim() || undefined,
    })))
    onDone()
  }
  const toggle = (qid: string, label: string, multi?: boolean): void => {
    setSelected(prev => {
      const cur = prev[qid] ?? []
      const next = cur.includes(label)
        ? cur.filter(l => l !== label)
        : multi ? [...cur, label] : [label]
      return { ...prev, [qid]: next }
    })
  }
  return (
    <div style={{
      margin: '8px 12px', padding: '10px 12px', borderRadius: 8, fontSize: 12,
      background: 'rgba(77, 159, 255, 0.08)', border: `1px solid ${C.accent}`,
    }}>
      {req.questions.map(q => (
        <div key={q.id} style={{ marginBottom: 10 }}>
          {q.header && <div style={{ color: C.dim, fontSize: 11, marginBottom: 2 }}>{q.header}</div>}
          <div style={{ marginBottom: 4 }}>{q.question}</div>
          {q.detail && <div style={{ color: C.dim, marginBottom: 6, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>{q.detail}</div>}
          {q.options && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {q.options.map(opt => {
                const active = (selected[q.id] ?? []).includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    title={opt.description}
                    onClick={() => toggle(q.id, opt.label, q.multiSelect)}
                    style={{
                      ...bannerBtn(active ? C.accent : C.line),
                      background: active ? 'rgba(77,159,255,0.18)' : 'transparent',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )}
          <input
            value={texts[q.id] ?? ''}
            onChange={ev => setTexts(prev => ({ ...prev, [q.id]: ev.target.value }))}
            placeholder="其他回答（可选）"
            style={{
              width: '100%', boxSizing: 'border-box', background: 'rgba(0,0,0,0.25)', color: C.text,
              border: `1px solid ${C.line}`, borderRadius: 6, padding: '5px 8px', fontSize: 12,
            }}
          />
        </div>
      ))}
      <button style={bannerBtn(C.accent)} onClick={submit}>提交回答</button>
    </div>
  )
}

const bannerBtn = (color: string): React.CSSProperties => ({
  border: `1px solid ${color}`, borderRadius: 6, background: 'transparent',
  color: C.text, padding: '4px 14px', fontSize: 12, cursor: 'pointer',
})

/* ---------- the drawer ---------- */

export function ChatDrawer({ onClose }: { onClose: () => void }): React.ReactElement {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getState)
  const [draft, setDraft] = useState('')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [questions, setQuestions] = useState<UserQuestionsRequest | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => sessions.start(), [])

  useEffect(() => onEvent({
    onApproval: req => setApproval(req),
    onQuestions: req => setQuestions(req),
    onWithdrawn: eventId => {
      setApproval(cur => (cur?.eventId === eventId ? null : cur))
      setQuestions(cur => (cur?.eventId === eventId ? null : cur))
    },
  }), [])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void sessions.sendPrompt(text)
  }

  return (
    <aside style={{
      width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderLeft: `1px solid ${C.line}`, background: C.bg, minHeight: 0,
    }}>
      {/* header: session picker + new session + close */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: `1px solid ${C.line}`, flexShrink: 0, fontSize: 13,
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <button
            onClick={() => setPickerOpen(o => !o)}
            style={{
              width: '100%', textAlign: 'left', background: 'transparent', color: C.text,
              border: `1px solid ${C.line}`, borderRadius: 6, padding: '5px 10px',
              fontSize: 12, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {state.activeSessionId
              ? sessionLabel(state.activeSessionId, state.sessions.find(s => s.sessionId === state.activeSessionId)?.cwd)
              : '选择会话'}
            <span style={{ float: 'right', color: C.dim }}>▾</span>
          </button>
          {pickerOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
              background: '#161b22', border: `1px solid ${C.line}`, borderRadius: 8,
              maxHeight: 300, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}>
              {state.sessions.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 12, color: C.dim }}>暂无会话</div>
              )}
              {state.sessions.map(s => (
                <button
                  key={s.sessionId}
                  onClick={() => { setPickerOpen(false); sessions.selectSession(s.sessionId) }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                    border: 'none', color: C.text, padding: '8px 12px', fontSize: 12, cursor: 'pointer',
                    borderBottom: `1px solid ${C.line}`,
                  }}
                >
                  {s.running && <span style={{ color: C.accent }}>● </span>}
                  {sessionLabel(s.sessionId, s.cwd)}
                </button>
              ))}
            </div>
          )}
        </div>
        <button style={bannerBtn(C.line)} title="新建会话" onClick={() => void sessions.createSession()}>＋</button>
        <button style={bannerBtn(C.line)} title="关闭抽屉（⌘/Ctrl+B）" onClick={onClose}>✕</button>
      </div>

      {state.error && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: C.up, borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          {state.error}
        </div>
      )}

      {approval && <ApprovalBanner req={approval} onDone={() => setApproval(null)} />}
      {questions && <QuestionsBanner req={questions} onDone={() => setQuestions(null)} />}

      {state.loading
        ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>载入会话…</div>
        : <MessageList messages={state.messages} />}

      {/* composer */}
      <div style={{ borderTop: `1px solid ${C.line}`, padding: '10px 12px', flexShrink: 0 }}>
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
          placeholder={state.activeSessionId ? '发消息…（Enter 发送，Shift+Enter 换行）' : '先选择或新建一个会话'}
          disabled={!state.activeSessionId}
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'none', background: 'rgba(0,0,0,0.25)',
            color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px',
            fontSize: 13, fontFamily: 'inherit', lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          {state.running && (
            <button style={bannerBtn(C.up)} onClick={() => void sessions.cancelActive()}>■ 停止</button>
          )}
          <button
            style={{ ...bannerBtn(C.accent), opacity: draft.trim() && state.activeSessionId ? 1 : 0.4 }}
            disabled={!draft.trim() || !state.activeSessionId}
            onClick={send}
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  )
}
