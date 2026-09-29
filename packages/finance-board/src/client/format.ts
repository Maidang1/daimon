/** Shared dark-terminal style tokens and number formatters. */

export const C = {
  bg: 'var(--dsh-bg, #0d1117)',
  panel: 'rgba(127, 127, 127, 0.08)',
  line: 'rgba(127, 127, 127, 0.18)',
  text: 'var(--dsh-fg, #e6edf3)',
  dim: 'rgba(127, 140, 152, 0.9)',
  up: '#ff5c6c', // 涨/盈利 — CN convention
  down: '#2fbf71', // 跌/亏损
  accent: '#4d9fff',
  warn: '#e2a336',
}

export function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtPct(v: number | null | undefined, signed = true): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${signed && v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`
}

export function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0) return C.dim
  return v > 0 ? C.up : C.down
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

export function fmtAge(seconds: number | null): string {
  if (seconds === null) return ''
  if (seconds < 90) return `${Math.round(seconds)} 秒前`
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`
  return `${(seconds / 3600).toFixed(1)} 小时前`
}
