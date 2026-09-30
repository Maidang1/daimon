/**
 * Request-boundary schemas for the mutating routes.
 *
 * A request body arrives as `unknown` (parsed JSON). Before this module the
 * two POST handlers cast it blind — `as { action?: string }` — and then
 * re-validated by coercion (`Number(body?.shares)`, ternaries on `side`),
 * which let `shares: "5"` or `price: true` sail through until something
 * downstream silently coerced them. The invariant now lives in a schemastery
 * schema: the same tool the plugin already uses for `Config`, so "what the
 * body actually looks like" is stated once instead of reconstructed per field.
 *
 * @module @deepseek-ai/dsh-finance-board/schemas
 */

import type { IncomingMessage } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { JOB_ACTIONS, type JobAction } from './python-actions.js'

/** Hard cap on a JSON request body — these routes carry a handful of scalars. */
const BODY_CAP = 16_384

/**
 * A number that must be strictly positive. schemastery's `min()` is inclusive
 * and there is no `positive()`, and `min(1)` would wrongly reject legitimate
 * fractional shares (`0.5`) and low NAVs, so the domain rule is expressed as
 * a transform that rejects non-positive input.
 */
function positiveNumber(): z<number> {
  return z.transform(z.number(), value => {
    if (!(value > 0)) throw new z.ValidationError('must be > 0', {})
    return value
  })
}

/**
 * An optional-but-validated field. schemastery has no `.optional()`: a field
 * absent from the input is simply left absent, so unioning with `never()`
 * keeps the constraint active for callers that do supply the field.
 */
function optionalString(): z<string | undefined> {
  return z.union([z.string(), z.never()]) as unknown as z<string | undefined>
}

/**
 * Wrap a `z.object` schema so its declared keys are actually required.
 *
 * schemastery objects validate the keys that are *present* and pass unknown
 * keys straight through — they never assert presence, so a body missing
 * `code` would sail through here and surface much later as a Python
 * `TypeError`. This wrapper adds the missing half, and projects the value
 * down to the declared keys so nothing undeclared reaches the runner.
 */
function strictBody<T>(shape: Record<string, z<never, unknown>>, required: readonly string[]): z<unknown, T> {
  return z.transform(z.object(shape).required(), (value: unknown) => {
    if (typeof value !== 'object' || value === null) {
      throw new z.ValidationError('expected a JSON object', {})
    }
    for (const field of required) {
      if (!(field in value)) throw new z.ValidationError(`missing required field ${field}`, {})
    }
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) {
      if (key in source) out[key] = source[key]
    }
    return out as T
  }) as z<unknown, T>
}

/** `POST /finance/api/jobs` body. */
export const JobsBody: z<unknown, { action: string }> = strictBody({
  action: z.string().min(1),
}, ['action'])

/** `POST /finance/api/ops` body: one buy/sell record. */
export const OpsBody: z<unknown, OpsRequest> = strictBody<OpsRequest>({
  code: z.string().min(1),
  side: z.union(['buy', 'sell'] as const),
  shares: positiveNumber(),
  price: positiveNumber(),
  date: optionalString(),
  note: optionalString(),
}, ['code', 'side', 'shares', 'price'])

/** Validated `POST /finance/api/ops` body. */
export interface OpsRequest {
  code: string
  side: 'buy' | 'sell'
  shares: number
  price: number
  date?: string
  note?: string
}

/** Why a request body could not be turned into a usable value. */
export type BodyFailure = 'too-large' | 'malformed' | 'invalid'

export type BodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BodyFailure; detail?: string }

/**
 * Read a JSON request body and validate it against `schema`.
 *
 * "Body too large" and "malformed JSON" used to collapse into the same
 * `null`, so both surfaced as one indistinguishable 400; they are now
 * separate outcomes, as is a schema failure.
 */
export async function readJsonBody<T>(req: IncomingMessage, schema: z<unknown, T>): Promise<BodyResult<T>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > BODY_CAP) return { ok: false, reason: 'too-large' }
    chunks.push(buf)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // `JSON.parse('null')` is a valid parse but not a request object, and a
  // transform over the object schema short-circuits on null without running
  // its callback — so the check belongs here, before the schema.
  if (parsed === null) return { ok: false, reason: 'invalid', detail: 'expected a JSON object' }
  try {
    return { ok: true, value: schema(parsed) }
  } catch (err) {
    return { ok: false, reason: 'invalid', detail: err instanceof Error ? err.message : String(err) }
  }
}

/** The 400 body for a rejected request. */
export function bodyErrorMessage(failure: { ok: false; reason: BodyFailure; detail?: string }): string {
  switch (failure.reason) {
    case 'too-large':
      return 'request body too large'
    case 'malformed':
      return 'request body is not valid JSON'
    case 'invalid':
      return `request body failed validation: ${failure.detail ?? 'unknown'}`
  }
}

/** Type guard for a job action; unknown ids only come from stale or corrupt records. */
export function isJobAction(value: unknown): value is JobAction {
  return typeof value === 'string' && value in JOB_ACTIONS
}
