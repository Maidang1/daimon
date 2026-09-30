/**
 * The fund page's derivation: snapshot + briefing in, everything the page
 * renders out.
 *
 * The page used to own its fetching, its polling, its filtering and a fuzzy
 * fund↔news matcher. Only the derivation is left here, so it is testable
 * without rendering the page and without a browser.
 *
 * @module @deepseek-ai/dsh-finance-board/terminal/fund/useFundDetail
 */

import { useMemo } from 'react'
import { navSeriesOf } from '../../client/format.js'
import { useFinance } from '../../client/financeStore.js'
import type { BriefingNews, FundInfo, Holding, Resource, Snapshot } from '../../client/api.js'

export interface FundDetail {
  /** The board snapshot document, so the page can tell "not generated" from "not loaded". */
  snapshot: Resource<Snapshot>
  fund?: FundInfo
  holding?: Holding
  /** Display name: the fund's, else the holding's, else the code. */
  name: string
  navSeries: number[]
  /** Briefing news that names this fund. */
  relatedNews: BriefingNews[]
}

/** Match a briefing news item to a fund by the names the briefing carries. */
function relatesTo(news: BriefingNews, name: string, code: string): boolean {
  // `funds` holds fund *names* by contract, so an exact name match is the
  // rule. The old `name.includes(f) || f.includes(name)` both-ways fuzzy match
  // could attach a news item to any fund whose name shared a substring.
  return (news.funds ?? []).some(f => f === name || f === code)
}

export function useFundDetail(code: string): FundDetail {
  const { snapshot, briefing } = useFinance()
  return useMemo(() => {
    const snap = snapshot.resource.kind === 'ready' ? snapshot.resource.value : null
    const doc = briefing.resource.kind === 'ready' ? briefing.resource.value : null
    const fund = snap?.funds.find(f => f.code === code)
    const holding = snap?.holdings.find(h => h.code === code)
    const name = fund?.name ?? holding?.name ?? code
    return {
      // The page wants the document's state, not the store's mtime bookkeeping.
      snapshot: snapshot.resource,
      fund,
      holding,
      name,
      navSeries: navSeriesOf(fund),
      relatedNews: (doc?.news ?? []).filter(n => relatesTo(n, name, code)),
    }
  }, [snapshot, briefing, code])
}
