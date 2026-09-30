/**
 * The view model and its persistence.
 *
 * `JSON.parse(raw) as View` used to assert a shape nothing checked: a corrupt
 * or stale entry either crashed the app or silently rendered nothing. The
 * board tab also used to live beside `view` rather than inside it, so a
 * persisted `board` view described a state it could not actually restore.
 */

import { describe, expect, it } from 'vitest'
import { loadView, parseView, saveView, type View } from '../src/terminal/view.ts'

/** A localStorage stand-in, since the module reads the global by name. */
function withStorage(seed: Record<string, string>, fn: () => void): void {
  const store = new Map(Object.entries(seed))
  const backing = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
  try {
    fn()
  } finally {
    ;(globalThis as { localStorage?: Storage }).localStorage = backing
  }
}

describe('parseView', () => {
  it('restores every view kind', () => {
    expect(parseView({ kind: 'home' })).toEqual({ kind: 'home' })
    expect(parseView({ kind: 'chat' })).toEqual({ kind: 'chat' })
    expect(parseView({ kind: 'board', tab: 'holdings' })).toEqual({ kind: 'board', tab: 'holdings' })
    expect(parseView({ kind: 'fund', code: '008401', from: 'ops' })).toEqual({ kind: 'fund', code: '008401', from: 'ops' })
  })

  it('defaults a board tab it does not recognise, rather than dropping the view', () => {
    expect(parseView({ kind: 'board', tab: 'nonsense' })).toEqual({ kind: 'board', tab: 'overview' })
    expect(parseView({ kind: 'board' })).toEqual({ kind: 'board', tab: 'overview' })
  })

  it('rejects anything it cannot represent', () => {
    for (const bad of [
      null, undefined, 'home', 42, [], {},
      { kind: 'nope' },
      { kind: 'fund' },                        // no code
      { kind: 'fund', code: '' },              // empty code
      { kind: 'fund', code: 5 },               // wrong type
    ]) {
      expect(parseView(bad)).toBeNull()
    }
  })
})

describe('loadView / saveView', () => {
  it('round-trips through storage', () => {
    const view: View = { kind: 'fund', code: '012752', from: 'holdings' }
    withStorage({}, () => {
      saveView(view)
      expect(loadView()).toEqual(view)
    })
  })

  it('falls back to the AI home page when nothing valid is stored', () => {
    const seeds: Record<string, string>[] = [
      {},
      { 'fb.view': 'not json' },
      { 'fb.view': '{"kind":"nope"}' },
      { 'fb.view': 'null' },
    ]
    for (const seed of seeds) {
      withStorage(seed, () => expect(loadView()).toEqual({ kind: 'home' }))
    }
  })
})
