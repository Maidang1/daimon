/** Shared dark-terminal style tokens and number formatters. */

/**
 * 色板桥接：新终端 UI（src/terminal/）加载 terminal.css 定义 --fb-*，
 * 旧 client bundle（注入官方 SPA 侧栏，无 terminal.css）走 fallback，
 * 两条链渲染出同一套 dsw 暗色值。up/down/warn 保留 hex——SVG attribute
 * 不支持 var()，且 pnlColor 需要稳定字符串。涨跌为 CN 语义：红涨绿跌。
 */
export const C = {
  bg: 'var(--fb-bg-0, #151517)',
  panel: 'var(--fb-bg-2, #2c2c2e)',
  panelHi: 'var(--fb-bg-3, #353638)',
  line: 'var(--fb-line-1, #ffffff0f)',
  line2: 'var(--fb-line-2, #ffffff1f)',
  text: 'var(--fb-text-1, #f9fafb)',
  dim: 'var(--fb-text-3, #adb2b8)',
  faint: 'var(--fb-text-4, #81858c)',
  up: '#f25a5a', // 涨/盈利 — CN convention
  down: '#22c55e', // 跌/亏损
  upDim: 'var(--fb-up-dim, #f25a5a1f)',
  downDim: 'var(--fb-down-dim, #22c55e1f)',
  accent: 'var(--fb-brand, #5686fe)',
  accentHi: 'var(--fb-brand-hi, #7aaaff)',
  accentDim: 'var(--fb-brand-dim, #5686fe24)',
  warn: '#f59e0b',
  warnDim: 'var(--fb-warn-dim, #f59e0b1f)',
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
