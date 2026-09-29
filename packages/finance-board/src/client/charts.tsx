/**
 * Hand-rolled SVG charts (line / bars / sparkline). The dsh client bundle
 * may only import `react` at runtime, so no chart library — these cover the
 * 终端's needs with zero dependencies.
 */

import { C } from './format.js'

function pointsOf(values: number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  return values
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1)}`)
    .join(' ')
}

/** Simple time-series line with axis-free minimal chrome. */
export function LineChart({ values, width = '100%', height = 140 }: {
  values: number[]
  width?: number | string
  height?: number
}): React.ReactElement {
  const w = 600
  const h = height as number
  if (values.length < 2) {
    return <div style={{ height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>
      数据不足
    </div>
  }
  const pts = pointsOf(values, w, h, 6)
  const last = values[values.length - 1]
  const rising = values.length > 1 && last >= values[0]
  const lineColor = rising ? C.up : C.down
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width, height: h, display: 'block' }}
      role="img" aria-label="趋势图">
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Horizontal bar row: label on the left, signed bar centered on zero. */
export function BarRow({ label, value, maxAbs, width = 200 }: {
  label: string
  value: number
  maxAbs: number
  width?: number
}): React.ReactElement {
  const half = width / 2
  const len = maxAbs > 0 ? Math.min(Math.abs(value) / maxAbs, 1) * (half - 4) : 0
  const color = value >= 0 ? C.up : C.down
  return (
    <svg width={width} height={12} style={{ display: 'block' }} aria-hidden>
      <line x1={half} y1={0} x2={half} y2={12} stroke={C.line} strokeWidth={1} />
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
        stroke={rising ? C.up : C.down} strokeWidth={1.2} />
    </svg>
  )
}

/** Mini vertical bars (e.g. per-theme heat). */
export function HeatBar({ pct, width = 64, height = 8 }: {
  pct: number
  width?: number
  height?: number
}): React.ReactElement {
  const color = pct >= 70 ? C.up : pct >= 40 ? C.warn : C.down
  return (
    <svg width={width} height={height} style={{ display: 'inline-block' }} aria-hidden>
      <rect x={0} y={0} width={width} height={height} rx={4} fill={C.panel} />
      <rect x={0} y={0} width={(Math.min(pct, 100) / 100) * width} height={height} rx={4} fill={color} />
    </svg>
  )
}
