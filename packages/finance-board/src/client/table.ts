/**
 * Table cell styles for the 看板 tabs.
 *
 * Both table tabs declared the same `th`/`td` objects and the same
 * `<table className="fb-table" style={{borderCollapse, width}}>` wrapper
 * inline, differing only in a `whiteSpace` here and a `fontWeight` there. The
 * `fb-table` rules in `terminal.css` were dead: this bundle never loads that
 * stylesheet. One definition now.
 *
 * @module @deepseek-ai/dsh-finance-board/client/table
 */

import type { CSSProperties } from 'react'
import { C } from './format.js'

/** `<table>` chrome: collapsed borders, full width, no cell spacing. */
export const tableStyle: CSSProperties = { borderCollapse: 'collapse', width: '100%' }

/** Header cell: right-aligned by default; pass `textAlign: 'left'` to override. */
export const thStyle: CSSProperties = {
  textAlign: 'right', padding: '8px 10px', fontSize: 11, color: C.faint,
  fontWeight: 500, borderBottom: `1px solid ${C.line2}`, whiteSpace: 'nowrap',
}

/** Body cell: right-aligned by default; pass `textAlign: 'left'` to override. */
export const tdStyle: CSSProperties = {
  textAlign: 'right', padding: '8px 10px', fontSize: 12, color: C.text,
  borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap',
}
