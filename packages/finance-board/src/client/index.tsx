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
 */

import { TerminalPanel } from './TerminalPanel.js'

/** Identity shared by the sidebar panel entry and the main-slot occupant. */
const PANEL_ID = 'finance'

/** Client-side services this plugin requires. */
export const inject = ['slots', 'layout']

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
 * @param ctx - the client root context (typed loosely; the slot registry's
 *   generic machinery belongs to the dsh client internals).
 */
export function apply(ctx: any): void {
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
  // Finance-first landing: swap the central column to the terminal on load.
  // selectPanel throws while the panel id is not registered yet (slot
  // registration is deferred by the host), so retry briefly instead of
  // assuming ordering. Once registered the panel stays registered, so a
  // single success is enough for the app's lifetime.
  let attempts = 0
  const selectDefault = (): void => {
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch {
      attempts += 1
      if (attempts < 25) setTimeout(selectDefault, 200)
    }
  }
  selectDefault()
}
