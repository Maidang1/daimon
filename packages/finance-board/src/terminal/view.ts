/**
 * The terminal's view model.
 *
 * A discriminated union, so "which screen am I on" is one value with one
 * shape per case instead of a `view` string plus a `boardTab` beside it. The
 * tab lives inside the `board` variant, so what gets persisted describes the
 * state it claims to persist; `fund.from` is the return address for ←.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/view
 */

import type { BoardTab } from '../client/TerminalPanel.js'

export type View =
  | { kind: 'home' }
  | { kind: 'chat' }
  | { kind: 'board'; tab: BoardTab }
  | { kind: 'fund'; code: string; /** The board tab ← returns to. */ from: BoardTab }

/** The view kinds, for the sidebar's active-item contract. */
export type ViewKind = View['kind']

const BOARD_TABS: readonly BoardTab[] = ['overview', 'holdings', 'hotspots', 'ops']

/**
 * Type guard for persisted view state.
 *
 * `JSON.parse(raw) as View` asserted a shape nothing checked; a corrupt or
 * stale entry then either crashed the app or silently rendered nothing.
 */
export function parseView(raw: unknown): View | null {
  if (typeof raw !== 'object' || raw === null) return null
  const parsed = raw as { kind?: unknown; code?: unknown; tab?: unknown; from?: unknown }
  const tab = BOARD_TABS.includes(parsed.tab as BoardTab) ? parsed.tab as BoardTab : 'overview'
  const from = BOARD_TABS.includes(parsed.from as BoardTab) ? parsed.from as BoardTab : 'overview'
  switch (parsed.kind) {
    case 'home':
    case 'chat':
      return { kind: parsed.kind }
    case 'fund':
      return typeof parsed.code === 'string' && parsed.code ? { kind: 'fund', code: parsed.code, from } : null
    case 'board':
      return { kind: 'board', tab }
    default:
      return null
  }
}

/** Read the persisted view, falling back to the AI home page. */
export function loadView(): View {
  try {
    const raw = localStorage.getItem('fb.view')
    return (raw ? parseView(JSON.parse(raw)) : null) ?? { kind: 'home' }
  } catch {
    return { kind: 'home' }
  }
}

/** Persist a view; private-mode failures are not worth surfacing. */
export function saveView(view: View): void {
  try {
    localStorage.setItem('fb.view', JSON.stringify(view))
  } catch {
    // 隐私模式下持久化失败不影响使用
  }
}
