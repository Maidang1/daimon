/**
 * Finance 终端 client half: registers the 终端 as a global main panel of the
 * dsh SPA, puts its entry at the top of the sidebar panel list, and makes it
 * the default landing view (`ctx.layout.selectPanel('finance')` swaps the
 * central column from the conversation to the terminal; selecting the
 * sidebar「会话」entry returns to the conversation as usual).
 *
 * Data comes from this package's host half (`/finance/api/snapshot`), rendered
 * natively in React — the old `/finance` iframe board is kept server-side as a
 * no-JS fallback and deep link, but this panel no longer embeds it.
 *
 * The bundle is wrapped for the dsh client module loader by scripts/wrap-client.mjs;
 * runtime imports are limited to the loader's baseline table (react only).
 *
 * @module @deepseek-ai/dsh-finance-board/client/index
 */

import { TerminalPanel } from './TerminalPanel.js'
import { sessions } from '../terminal/dsh/sessions.js'

/** Identity shared by the sidebar panel entry and the main-slot occupant. */
const PANEL_ID = 'finance'

/** How long to keep waiting for the deferred panel registration. */
const SELECT_RETRY_MS = 50
/** ~2s at `SELECT_RETRY_MS`: long enough for the host's deferred registration. */
const MAX_SELECT_ATTEMPTS = 40

/** The slice of the client root context this plugin actually uses. */
interface FinanceClientContext {
  slots: {
    inject(slot: string, fn: () => unknown): void
    register(descriptor: unknown, component: unknown): unknown
  }
  layout: { selectPanel(id: string): void }
}

/** Bar-chart row icon for the sidebar panel list. */
function FinanceBoardIcon({ size, active }: { size: number; active: boolean }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="8" width="3" height="6" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
      <rect x="6.5" y="4" width="3" height="10" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
      <rect x="11" y="1.5" width="3" height="12.5" rx="1" fill="currentColor" opacity={active ? 1 : 0.7} />
    </svg>
  )
}

/**
 * Register the finance terminal panel, its sidebar entry, and the default
 * landing selection.
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: FinanceClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, TerminalPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: () => 'Finance 终端',
  }, FinanceBoardIcon))

  // The session store's wiring is the page's, so it starts here once — the
  // terminal app does the same in its own entry, and each bundle mounts one
  // of them.
  sessions.start()

  let attempts = 0
  // Finance-first landing: swap the central column to the terminal on load.
  // Registration is deferred by the host, so the panel may not exist yet; wait
  // for it rather than retrying a throwaway call and hoping. `selectPanel`
  // throws only for an unknown id, so that is the one failure worth waiting
  // through — anything else is a real bug and is surfaced, not swallowed for
  // five seconds the way the previous bare `catch` did.
  const selectDefault = (): void => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch (err) {
      if (attempts >= MAX_SELECT_ATTEMPTS) {
        throw new Error(`finance panel '${PANEL_ID}' was never registered: ${String(err)}`)
      }
      attempts += 1
      setTimeout(selectDefault, SELECT_RETRY_MS)
    }
  }
  selectDefault()
}

