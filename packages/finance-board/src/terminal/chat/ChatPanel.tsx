/**
 * Chat panel (main-area view): message list, approval/question banners, and
 * the composer — the ChatDrawer refactored out of its 420px drawer into the
 * primary chat surface. Session list/creation lives in the sidebar; this
 * panel only renders the active session.
 *
 * State comes from dsh/sessions.ts (wire protocol) and dsh/events.ts
 * (waterfall banners); this component owns only local UI state.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/chat/ChatPanel
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  onEvent,
  answerApproval,
  answerQuestions,
  type ApprovalRequest,
  type UserQuestionsRequest,
} from '../dsh/events.js'
import { C } from '../../client/format.js'
import { useFinance } from '../../client/financeStore.js'
import { Composer } from '../ui/Composer.js'
import { sessions } from '../dsh/sessions.js'
import { MessageList } from './MessageList.js'

/** One outstanding request the agent is blocked on. */
type PendingRequest =
  | { kind: 'approval'; req: ApprovalRequest }
  | { kind: 'questions'; req: UserQuestionsRequest }

/* ---------- banners ---------- */

function ApprovalBanner({ req, onDone }: { req: ApprovalRequest; onDone: () => void }): React.ReactElement {
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    // Only dismiss once the Host accepted the answer: an unanswered waterfall
    // parks the agent, so closing on a *failed* answer is the worst outcome.
    void answerApproval(req.eventId, outcome).then(onDone, err => {
      console.warn('[chat] approval answer failed', err)
    })
  }
  return (
    <div className="fb-approval" style={{ margin: '8px 0' }}>
      <div style={{ marginBottom: 6 }}>
        <strong>审批请求</strong>：工具 <code>{req.toolName}</code>
      </div>
      {(req.displayReason ?? req.reason) && (
        <div style={{ color: 'var(--fb-text-3)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{req.displayReason ?? req.reason}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="fb-btn fb-btn-primary" onClick={() => answer('allowed-once')}>
          同意
        </button>
        <button className="fb-btn fb-btn-danger" onClick={() => answer('rejected')}>
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
    void answerQuestions(req.eventId, req.questions.map(q => ({
      id: q.id,
      selected: selected[q.id] ?? [],
      custom: texts[q.id]?.trim() || undefined,
    }))).then(onDone, err => console.warn('[chat] questions answer failed', err))
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
    <div className="fb-approval" style={{ margin: '8px 0' }}>
      {req.questions.map(q => (
        <div key={q.id} style={{ marginBottom: 10 }}>
          {q.header && <div style={{ color: 'var(--fb-text-4)', fontSize: 11, marginBottom: 2 }}>{q.header}</div>}
          <div style={{ marginBottom: 4 }}>{q.question}</div>
          {q.detail && (
            <div style={{ color: 'var(--fb-text-3)', marginBottom: 6, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>
              {q.detail}
            </div>
          )}
          {q.options && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
              {q.options.map(opt => {
                const active = (selected[q.id] ?? []).includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    title={opt.description}
                    onClick={() => toggle(q.id, opt.label, q.multiSelect)}
                    className={active ? 'fb-chip fb-chip-brand' : 'fb-chip fb-chip-plain'}
                    style={{ cursor: 'pointer', border: 'none', fontFamily: 'var(--fb-font-ui)', padding: '5px 12px' }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          )}
          <input
            className="fb-input"
            value={texts[q.id] ?? ''}
            onChange={ev => setTexts(prev => ({ ...prev, [q.id]: ev.target.value }))}
            placeholder="其他回答（可选）"
          />
        </div>
      ))}
      <button className="fb-btn fb-btn-primary" onClick={submit}>提交回答</button>
    </div>
  )
}

/* ---------- the panel ---------- */

export function ChatPanel(): React.ReactElement {
  const state = useSyncExternalStore(sessions.subscribe, sessions.getState)
  // A *stack*, not two slots: parallel tool calls can raise several approvals
  // at once, and overwriting the first slot parked that agent turn forever.
  const [pending, setPending] = useState<PendingRequest[]>([])
  // The data layer starts on first subscribe; no view has to remember to.
  useFinance()

  useEffect(() => onEvent({
    onApproval: req => setPending(cur => [...cur, { kind: 'approval', req }]),
    onQuestions: req => setPending(cur => [...cur, { kind: 'questions', req }]),
    onWithdrawn: eventId => setPending(cur => cur.filter(p => p.req.eventId !== eventId)),
  }), [])

  const dismiss = useCallback((eventId: string): void => {
    setPending(cur => cur.filter(p => p.req.eventId !== eventId))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* header：当前会话 + 官方轨迹深链 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 8px',
        flexShrink: 0, fontSize: 12, color: 'var(--fb-text-4)',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {state.activeSessionId ? `会话 ${state.activeSessionId.slice(0, 8)}` : '未选择会话'}
          {state.running && <span style={{ color: 'var(--fb-brand)', marginLeft: 8 }}>● 生成中</span>}
        </span>
        <span style={{ flex: 1 }} />
        <a className="fb-link" href="/index.html" target="_blank" rel="noreferrer"
          title="在官方界面查看完整轨迹" style={{ fontSize: 12 }}>
          ⇱ 官方轨迹
        </a>
      </div>

      {state.error && (
        <div className="fb-banner error" style={{ marginBottom: 8, flexShrink: 0 }}>{state.error}</div>
      )}

      {pending.map(item => item.kind === 'approval'
        ? <ApprovalBanner key={item.req.eventId} req={item.req} onDone={() => dismiss(item.req.eventId)} />
        : <QuestionsBanner key={item.req.eventId} req={item.req} onDone={() => dismiss(item.req.eventId)} />)}

      {state.loading
        ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>
            载入会话…
          </div>
        )
        : <MessageList messages={state.messages} />}

      <div style={{ padding: '10px 0 14px', flexShrink: 0 }}>
        <Composer
          placeholder={state.activeSessionId ? '向 daimon 提问…（Enter 发送，Shift+Enter 换行）' : '先在左侧选择或新建一个会话'}
          disabled={!state.activeSessionId}
          onSend={text => void sessions.ask(text)}
          onStop={state.running ? () => void sessions.cancelActive() : undefined}
        />
      </div>
    </div>
  )
}
