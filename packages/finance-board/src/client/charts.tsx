/**
 * Hand-rolled SVG charts (line / bars / sparkline). The dsh client bundle
 * may only import `react` at runtime, so no chart library — these cover the
 * 终端's needs with zero dependencies.
 *
 * Colors are hex constants on purpose: SVG presentation attributes do not
 * resolve var(), and this file is shared by the old client bundle which never
 * loads terminal.css. Single-point maintenance lives here, values mirror the
 * --fb-* tokens.
 *
 * @module @deepseek-ai/dsh-finance-board/client/charts
 */

import { useId } from 'react'
import { C } from './format.js'

/** Hex palette for SVG attributes (mirrors --fb-* tokens). */
const CH = {
  up: C.up,
  down: C.down,
  warn: C.warn,
  track: '#ffffff14',
  line: '#ffffff1f',
}

/** Padding inside a chart's viewBox, so strokes are not clipped. */
const PAD = 6

/**
 * Map values onto a polyline `points` string.
 *
 * Both `LineChart` and `Sparkline` need this. It used to be written twice,
 * with different padding constants, so the two charts' geometry had already
 * drifted apart.
 */
function pointsOf(values: number[], width: number, height: number, pad: number): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  return values
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1)}`)
    .join(' ')
}

/** Simple time-series line with gradient area fill and axis-free minimal chrome. */
export function LineChart({ values, width = '100%', height = 140, ma20 }: {
  values: number[]
  width?: number | string
  height?: number
  /** Optional horizontal reference line (dashed amber), in the same unit as values. */
  ma20?: number
}): React.ReactElement {
  // A stable per-instance id: a render-scoped counter produced ids that both
  // churned on every re-render and grew for the page's lifetime, so
  // `fill="url(#…)"` never resolved to a stable node.
  const gid = `fb-area-${useId()}`
  const w = 600
  const h = height
  if (values.length < 2) {
    return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>
      数据不足
    </div>
  }
  // Include the MA20 reference in the value domain so the guide line stays in frame.
  const domain = ma20 !== undefined ? [...values, ma20] : values
  const min = Math.min(...domain)
  const max = Math.max(...domain)
  const span = max - min || 1
  const yOf = (v: number): number => h - PAD - ((v - min) / span) * (h - PAD * 2)
  const linePts = pointsOf(values, w, h, PAD)
  const last = values[values.length - 1]
  const rising = last >= values[0]
  const lineColor = rising ? CH.up : CH.down
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width, height: h, display: 'block' }}
      role="img" aria-label="趋势图">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
          <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`${PAD},${h} ${linePts} ${w - PAD},${h}`} fill={`url(#${gid})`} stroke="none" />
      <polyline points={linePts} fill="none" stroke={lineColor} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      {ma20 !== undefined && (
        <line x1={PAD} y1={yOf(ma20)} x2={w - PAD} y2={yOf(ma20)} stroke={CH.warn}
          strokeWidth={1} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  )
}

/** Horizontal bar row: label on the left, signed bar centered on zero. */
export function BarRow({ value, maxAbs, width = 200 }: {
  value: number
  maxAbs: number
  width?: number
}): React.ReactElement {
  const half = width / 2
  const len = maxAbs > 0 ? Math.min(Math.abs(value) / maxAbs, 1) * (half - 4) : 0
  const color = value >= 0 ? CH.up : CH.down
  return (
    <svg width={width} height={12} style={{ display: 'block' }} aria-hidden>
      <line x1={half} y1={0} x2={half} y2={12} stroke={CH.line} strokeWidth={1} />
      <rect x={value >= 0 ? half : half - len} y={3.5} width={Math.max(len, value === 0 ? 0 : 1.5)} height={5}
        rx={2} fill={color} />
    </svg>
  )
}

/** Inline sparkline for table cells. */
export function Sparkline({ values, width = 72, height = 20 }: {
  values: number[]
  width?: number
  height?: number
}): React.ReactElement {
  if (values.length < 2) return <span style={{ color: C.dim, fontSize: 11 }}>—</span>
  const rising = values[values.length - 1] >= values[0]
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width, height, display: 'inline-block' }} aria-hidden>
      <polyline points={pointsOf(values, width, height, 2)} fill="none"
        stroke={rising ? CH.up : CH.down} strokeWidth={1.2} />
    </svg>
  )
}

/** The heat band a percentage falls in — one classifier, shared with the table. */
export function heatBand(pct: number): 'up' | 'warn' | 'down' {
  if (pct >= 70) return 'up'
  if (pct >= 40) return 'warn'
  return 'down'
}

/** Mini vertical bars (e.g. per-theme heat). */
export function HeatBar({ pct, width = 64, height = 8 }: {
  pct: number
  width?: number
  height?: number
}): React.ReactElement {
  return (
    <svg width={width} height={height} style={{ display: 'inline-block' }} aria-hidden>
      <rect x={0} y={0} width={width} height={height} rx={4} fill={CH.track} />
      <rect x={0} y={0} width={(Math.min(pct, 100) / 100) * width} height={height} rx={4} fill={CH[heatBand(pct)]} />
    </svg>
  )
}
