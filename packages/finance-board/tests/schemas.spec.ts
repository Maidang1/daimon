/**
 * Request-body schemas.
 *
 * These guard the boundary the handlers used to cross with a blind cast. The
 * interesting cases are the ones a `z.object` schema alone does *not* catch:
 * schemastery validates the keys that are present and passes unknown keys
 * through, but never asserts presence.
 */

import type z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { JobsBody, OpsBody } from '../src/schemas.ts'
const attempt = (schema: z<unknown, unknown>, value: unknown): string | null => {
  try {
    schema(value)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

describe('JobsBody', () => {
  it('accepts a known action name and rejects anything else', () => {
    expect(attempt(JobsBody, { action: 'daily_job' })).toBeNull()
    expect(attempt(JobsBody, { action: '' })).toContain('length >= 1')
    expect(attempt(JobsBody, { action: 5 })).toContain('expected string')
    expect(attempt(JobsBody, {})).toContain('missing required field action')
    expect(attempt(JobsBody, 'nope')).toContain('expected object')
  })
})

describe('OpsBody', () => {
  const good = { code: '008401', side: 'buy', shares: 100, price: 1.2345 }

  it('accepts a complete record, with the optional fields left off', () => {
    expect(OpsBody(good)).toEqual(good)
  })

  it('keeps optional fields when they are supplied and well-typed', () => {
    expect(OpsBody({ ...good, date: '2026-09-30', note: '定投' })).toEqual({ ...good, date: '2026-09-30', note: '定投' })
  })

  it('projects undeclared keys away, so nothing extra reaches the runner', () => {
    // `z.object` passes unknown keys through; the wrapper narrows the value to
    // the declared contract.
    expect(OpsBody({ ...good, junk: 'x', status: 'hacked' })).toEqual(good)
  })

  it('requires the four fields the runner cannot work without', () => {
    // Missing keys used to sail through: schemastery objects never assert
    // presence, so this surfaced much later as a Python TypeError.
    for (const key of ['code', 'side', 'shares', 'price'] as const) {
      const partial: Record<string, unknown> = { ...good }
      delete partial[key]
      expect(attempt(OpsBody, partial)).toContain(`missing required field ${key}`)
    }
  })

  it('rejects wrong types and non-positive amounts', () => {
    expect(attempt(OpsBody, { ...good, code: 5 })).toContain('expected string')
    expect(attempt(OpsBody, { ...good, code: '' })).toContain('length >= 1')
    expect(attempt(OpsBody, { ...good, side: 'hold' })).toContain('expected "buy" | "sell"')
    // Coercion used to happen downstream (`Number(body.shaares)`), so "5" and
    // true both looked like valid input until something silently cast them.
    expect(attempt(OpsBody, { ...good, shares: '5' })).toContain('expected number')
    expect(attempt(OpsBody, { ...good, shares: true })).toContain('expected number')
    expect(attempt(OpsBody, { ...good, shares: 0 })).toContain('must be > 0')
    expect(attempt(OpsBody, { ...good, shares: -1 })).toContain('must be > 0')
    expect(attempt(OpsBody, { ...good, price: 0 })).toContain('must be > 0')
    // Fractional shares and sub-unit NAVs are legitimate and must survive.
    expect(attempt(OpsBody, { ...good, shares: 0.5, price: 0.0001 })).toBeNull()
  })

  it('validates an optional field that is present, and tolerates its absence', () => {
    expect(attempt(OpsBody, { ...good, date: 3 })).toContain('expected string')
    expect(attempt(OpsBody, { ...good, note: 7 })).toContain('expected string')
  })

  it('rejects a non-object body', () => {
    // `undefined` reaches the transform, which is where the guard lives; the
    // route's own null check happens before the schema.
    for (const bad of ['x', 42, [], [good]]) {
      expect(attempt(OpsBody, bad)).toBeTruthy()
    }
  })
})
