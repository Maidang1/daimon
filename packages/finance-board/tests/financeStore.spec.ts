/**
 * The shared finance data layer.
 *
 * The store owns one poll for the whole app, so its contract is what every
 * view relies on: fetch the cheap status, reload a document only when its
 * mtime moved, never overlap two passes, and keep a good frame when a read
 * fails transiently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** One canned status document. */
function status(over: Partial<{
  dashboard: string | null
  snapshot: string | null
  briefing: string | null
  jobs: unknown[]
}> = {}): unknown {
  return {
    dashboard: { exists: over.dashboard != null, mtime: over.dashboard ?? null },
    snapshot: { exists: over.snapshot != null, mtime: over.snapshot ?? null },
    briefing: { exists: over.briefing != null, mtime: over.briefing ?? null },
    jobs: over.jobs ?? [],
  }
}

const SNAPSHOT = { version: 1, funds: [], holdings: [], ops: [] }
const BRIEFING = { date: '2026-09-30', indices: [], news: [] }

/** Route `/finance/api/*` to canned answers, counting calls per endpoint. */
function stubFetch(routes: Record<string, unknown | (() => never)>): Record<string, number> {
  const counts: Record<string, number> = {}
  vi.stubGlobal('fetch', (url: string) => {
    const path = String(url).split('?')[0]
    counts[path] = (counts[path] ?? 0) + 1
    const answer = routes[path]
    if (answer === undefined) return Promise.reject(new Error(`unstubbed ${path}`))
    if (typeof answer === 'function') return (answer as () => never)()
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(answer),
    })
  })
  return counts
}

/** A 404 response, the way the host answers for a document that does not exist. */
const notFound = (): unknown => ({ ok: false, status: 404, json: () => Promise.resolve({ exists: false }) })

/** A 500 response. */
const serverError = (): unknown => ({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })

/** Load the store fresh each time: it is a module singleton. */
async function freshStore(): Promise<typeof import('../src/client/financeStore.ts').finance> {
  vi.resetModules()
  return (await import('../src/client/financeStore.ts')).finance
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('finance store', () => {
  it('loads both documents on the first pass, even when they are absent', async () => {
    // This is the first-run case: a fresh install has neither document. They
    // must still be *read*, or the skeleton never resolves into an empty state.
    stubFetch({
      '/finance/api/status': status(),
      '/finance/api/snapshot': notFound,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    const seen: string[] = []
    finance.subscribe(() => seen.push(finance.getState().snapshot.resource.kind))
    await vi.advanceTimersByTimeAsync(0)

    expect(finance.getState().snapshot.resource).toEqual({ kind: 'missing' })
    expect(finance.getState().briefing.resource).toEqual({ kind: 'missing' })
  })

  it('reports a loaded snapshot and its updatedAt', async () => {
    stubFetch({
      '/finance/api/status': status({ snapshot: '2026-09-30T10:00:00Z' }),
      '/finance/api/snapshot': SNAPSHOT,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    const state = finance.getState()
    expect(state.snapshot.resource).toEqual({ kind: 'ready', value: SNAPSHOT })
    expect(state.snapshot.mtime).toBe('2026-09-30T10:00:00Z')
    expect(state.updatedAt).toBe('2026-09-30T10:00:00Z')
  })

  it('re-reads a document only when its mtime moves', async () => {
    const counts = stubFetch({
      '/finance/api/status': status({ snapshot: 'm1' }),
      '/finance/api/snapshot': SNAPSHOT,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(counts['/finance/api/snapshot']).toBe(1)

    // Same mtime: the heavy document is not fetched again.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(counts['/finance/api/snapshot']).toBe(1)
    expect(counts['/finance/api/status']).toBe(2)

    // A moved mtime: exactly one reload.
    vi.stubGlobal('fetch', (url: string) => {
      const path = String(url).split('?')[0]
      if (path === '/finance/api/status') {
        counts[path] = (counts[path] ?? 0) + 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status({ snapshot: 'm2' })) })
      }
      counts[path] = (counts[path] ?? 0) + 1
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SNAPSHOT) })
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(counts['/finance/api/snapshot']).toBe(2)
    expect(finance.getState().snapshot.mtime).toBe('m2')
  })

  it('keeps the previous frame when a read fails transiently, and retries', async () => {
    const counts = stubFetch({
      '/finance/api/status': status({ snapshot: 'm1' }),
      '/finance/api/snapshot': SNAPSHOT,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    // The document now fails while the status reports a newer mtime.
    vi.stubGlobal('fetch', (url: string) => {
      const path = String(url).split('?')[0]
      counts[path] = (counts[path] ?? 0) + 1
      if (path === '/finance/api/snapshot') return Promise.reject(new Error('network down'))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status({ snapshot: 'm2' })) })
    })
    await vi.advanceTimersByTimeAsync(5_000)

    const state = finance.getState()
    expect(state.snapshot.resource).toEqual({ kind: 'ready', value: SNAPSHOT })
    expect(state.error).toBe('network down')
    expect(counts['/finance/api/snapshot']).toBe(2)

    // The mtime did not advance past a successful read, so the next tick tries
    // again rather than giving up on a stale frame forever.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(counts['/finance/api/snapshot']).toBe(3)
  })

  it('does not let a slow pass overlap the next tick', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>(resolve => { release = resolve })
    let statusCalls = 0
    vi.stubGlobal('fetch', (url: string) => {
      const path = String(url).split('?')[0]
      if (path === '/finance/api/status') {
        statusCalls += 1
        if (statusCalls === 1) return gate.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(status()) }))
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status()) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SNAPSHOT) })
    })

    const finance = await freshStore()
    finance.subscribe(() => {})
    // Two ticks fire while the first pass is still gated.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBe(1)
    release!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statusCalls).toBeGreaterThan(1)
  })

  it('surfaces a status failure without discarding loaded frames', async () => {
    stubFetch({
      '/finance/api/status': status({ snapshot: 'm1' }),
      '/finance/api/snapshot': SNAPSHOT,
      '/finance/api/briefing': BRIEFING,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    vi.stubGlobal('fetch', () => Promise.reject(new Error('host down')))
    await vi.advanceTimersByTimeAsync(5_000)
    const state = finance.getState()
    expect(state.error).toBe('host down')
    expect(state.snapshot.resource).toEqual({ kind: 'ready', value: SNAPSHOT })
    expect(state.briefing.resource).toEqual({ kind: 'ready', value: BRIEFING })
  })

  it('records a failed resource when there is no frame to keep', async () => {
    stubFetch({
      '/finance/api/status': status(),
      '/finance/api/snapshot': serverError,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(finance.getState().snapshot.resource.kind).toBe('failed')
    expect(finance.getState().error).toContain('→ 500')
  })

  it('keeps a document failure visible even when the other document succeeds', async () => {
    // Two folds used to write the shared `error` field independently, so a
    // briefing that loaded after a snapshot failure erased the failure.
    stubFetch({
      '/finance/api/status': status({ snapshot: 'm1', briefing: 'b1' }),
      '/finance/api/snapshot': () => Promise.reject(new Error('snapshot down')),
      '/finance/api/briefing': BRIEFING,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)

    const state = finance.getState()
    expect(state.briefing.resource).toEqual({ kind: 'ready', value: BRIEFING })
    expect(state.snapshot.resource.kind).toBe('failed')
    expect(state.error).toBe('snapshot down')
  })

  it('refresh forces a pass immediately', async () => {
    const counts = stubFetch({
      '/finance/api/status': status(),
      '/finance/api/snapshot': notFound,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const before = counts['/finance/api/status']
    finance.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(counts['/finance/api/status']).toBeGreaterThan(before)
  })

  it('starts only once, no matter how many views subscribe', async () => {
    const counts = stubFetch({
      '/finance/api/status': status(),
      '/finance/api/snapshot': notFound,
      '/finance/api/briefing': notFound,
    })
    const finance = await freshStore()
    const stopA = finance.subscribe(() => {})
    const stopB = finance.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    stopA()
    stopB()
    const afterUnsubscribe = counts['/finance/api/status']
    // A page-level store outlives views: unmounting a view must not stop the
    // poll, or every view switch would restart it and race a fresh mount.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(counts['/finance/api/status']).toBeGreaterThan(afterUnsubscribe)
  })
})
