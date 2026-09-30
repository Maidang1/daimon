/**
 * 记一笔 modal: records one buy/sell op through `/finance/api/ops` (which is
 * `finance.add_op` server-side, so UI-recorded ops are identical to
 * in-conversation ones). On a sell-over-position warning the modal flips into
 * a confirm step instead of silently succeeding.
 */

import { useState } from 'react'
import { recordOp, type Holding } from './api.js'
import { C } from './format.js'

export function QuickOpModal({ holdings, initialCode, onClose, onDone }: {
  holdings: Holding[]
  initialCode?: string
  onClose: () => void
  onDone: (message: string) => void
}): React.ReactElement {
  const [code, setCode] = useState(initialCode ?? (holdings[0]?.code ?? ''))
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [warning, setWarning] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (confirmed: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await recordOp({
        code, side,
        shares: Number(shares),
        price: Number(price),
        note: note || undefined,
      })
      if (res.warning && !confirmed) {
        setWarning(res.warning)
        return
      }
      onDone(`已记录 ${code} ${side === 'buy' ? '买入' : '卖出'} ${shares} 份 @ ${price}`)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    background: C.panelHi, border: `1px solid ${C.line2}`, borderRadius: 8,
    color: C.text, padding: '7px 10px', fontSize: 13, width: '100%', boxSizing: 'border-box',
    fontFamily: 'inherit', outline: 'none',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
    }} onClick={onClose}>
      <div style={{
        background: C.bg, border: `1px solid ${C.line2}`, borderRadius: 16,
        padding: 22, width: 380, maxWidth: '90vw',
        boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>记一笔</div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ fontSize: 12, color: C.dim }}>
            基金
            <select value={code} onChange={e => setCode(e.currentTarget.value)} style={{ ...inputStyle, marginTop: 4 }}>
              {holdings.map(h => (
                <option key={h.code} value={h.code}>{h.code} {h.name}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['buy', 'sell'] as const).map(s => (
              <button key={s} onClick={() => setSide(s)} style={{
                flex: 1, padding: '7px 0', borderRadius: 999, cursor: 'pointer', fontSize: 13,
                fontFamily: 'inherit', fontWeight: side === s ? 600 : 400,
                border: `1px solid ${side === s ? (s === 'buy' ? C.up : C.down) : C.line2}`,
                background: side === s ? (s === 'buy' ? '#f25a5a1f' : '#22c55e1f') : 'transparent',
                color: side === s ? (s === 'buy' ? C.up : C.down) : C.dim,
              }}>
                {s === 'buy' ? '买入' : '卖出'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ fontSize: 12, color: C.dim, flex: 1 }}>
              份额
              <input value={shares} onChange={e => setShares(e.currentTarget.value)} type="number" min="0" step="any"
                style={{ ...inputStyle, marginTop: 4 }} placeholder="100" />
            </label>
            <label style={{ fontSize: 12, color: C.dim, flex: 1 }}>
              净值
              <input value={price} onChange={e => setPrice(e.currentTarget.value)} type="number" min="0" step="any"
                style={{ ...inputStyle, marginTop: 4 }} placeholder="1.2345" />
            </label>
          </div>
          <label style={{ fontSize: 12, color: C.dim }}>
            备注（可选）
            <input value={note} onChange={e => setNote(e.currentTarget.value)} style={{ ...inputStyle, marginTop: 4 }}
              placeholder="定投 / 手动…" />
          </label>
          {warning && (
            <div style={{
              position: 'relative', overflow: 'hidden',
              background: C.warnDim, border: `1px solid ${C.line2}`,
              borderRadius: 8, padding: '10px 12px 10px 15px', fontSize: 12, color: C.warn, lineHeight: 1.6,
            }}>
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: C.warn }} />
              {warning}
            </div>
          )}
          {error && (
            <div style={{ color: C.up, fontSize: 12 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button onClick={onClose} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              border: `1px solid ${C.line2}`, background: 'transparent', color: C.dim,
              fontFamily: 'inherit',
            }}>
              取消
            </button>
            <button
              disabled={busy || !code || !shares || !price}
              onClick={() => void submit(warning !== null)}
              style={{
                flex: 2, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                border: 'none', fontWeight: 600, fontFamily: 'inherit',
                background: side === 'buy' ? C.up : C.down,
                color: '#fff', opacity: busy ? 0.6 : 1,
              }}
            >
              {warning ? '确认仍要记录' : busy ? '提交中…' : '确认记录'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
