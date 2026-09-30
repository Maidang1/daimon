/** 交易流水 tab: board ops newest-first, each deletable via the session. */

import type { Snapshot } from '../api.js'
import { C, fmtMoney } from '../format.js'
import { tableStyle, thStyle, tdStyle } from '../table.js'

export function OpsTab({ snapshot }: { snapshot: Snapshot }): React.ReactElement {
  const ops = [...snapshot.ops].reverse()
  if (ops.length === 0) {
    return (
      <div style={{ padding: '48px 20px', textAlign: 'center', color: C.dim, fontSize: 13 }}>
        还没有看板操作记录。点右上角「记一笔」或在会话里让 agent 执行 <code>finance.add_op(...)</code>。
      </div>
    )
  }
  return (
    <div style={{ padding: '16px 20px', overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>日期</th>
            <th style={{ ...thStyle, textAlign: 'left' }}>基金</th>
            <th style={thStyle}>方向</th>
            <th style={thStyle}>份额</th>
            <th style={thStyle}>净值</th>
            <th style={thStyle}>金额</th>
            <th style={{ ...thStyle, textAlign: 'left' }}>备注</th>
          </tr>
        </thead>
        <tbody>
          {ops.map(op => {
            const fund = snapshot.funds.find(f => f.code === op.code)
            return (
              <tr key={op.index}>
                <td style={{ ...tdStyle, textAlign: 'left', color: C.dim }}>{op.date}</td>
                <td style={{ ...tdStyle, textAlign: 'left' }}>
                  {fund?.name ?? op.code}
                  <span style={{ fontSize: 10, color: C.dim, marginLeft: 6 }}>{op.code}</span>
                </td>
                <td style={{ ...tdStyle, color: op.type === 'buy' ? C.up : C.down, fontWeight: 600 }}>
                  {op.type === 'buy' ? '买入' : '卖出'}
                </td>
                <td style={tdStyle}>{fmtMoney(op.shares)}</td>
                <td style={tdStyle}>{fmtMoney(op.price, 4)}</td>
                <td style={tdStyle}>{fmtMoney(op.amount)}</td>
                <td style={{ ...tdStyle, textAlign: 'left', color: C.dim, fontSize: 11, whiteSpace: 'normal' }}>
                  {op.note || ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 11, color: C.dim }}>
        共 {ops.length} 条 · 删除记录请在会话里让 agent 执行 <code>finance.delete_op(index)</code>
      </div>
    </div>
  )
}
