import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthExpiredError, RpcFailure, call, onAuthExpired } from '../src/terminal/dsh/rpc.ts'

/** Stub fetch responses; each entry is consumed by one call. */
let responses: { status: number; body: unknown }[] = []
let requests: { url: string; init: RequestInit }[] = []

vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  requests.push({ url, init })
  const next = responses.shift()
  if (!next) throw new Error('no stubbed response')
  return new Response(JSON.stringify(next.body), { status: next.status })
})

vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:3180' })

describe('dsh unary rpc', () => {
  beforeEach(() => {
    responses = []
    requests = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wraps args into the client-request envelope and unwraps ok results', async () => {
    responses.push({ status: 200, body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { sessions: [] } } } })
    const value = await call<{ sessions: unknown[] }>('session/list', { limit: 10 })
    expect(value).toEqual({ sessions: [] })
    const req = requests[0]
    expect(req.url).toBe('/api/session/list')
    const body = JSON.parse(String(req.init.body))
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session/list')
    expect(body.payload).toEqual({ args: { limit: 10 } })
    expect(typeof body.rpcId).toBe('string')
  })

  it('maps {ok:false,error} to an RpcFailure carrying the remote error', async () => {
    responses.push({ status: 200, body: { type: 'server-response', result: { ok: false, error: { code: 'not-found', message: 'no such session' } } } })
    const err = await call('session/follow', { sessionId: 'nope' }).catch(e => e) as RpcFailure
    expect(err).toBeInstanceOf(RpcFailure)
    expect(err.message).toBe('no such session')
    expect(err.remote).toEqual({ code: 'not-found', message: 'no such session' })
  })

  it('notifies auth-expired listeners and throws AuthExpiredError on 401', async () => {
    const seen: number[] = []
    const off = onAuthExpired(() => seen.push(1))
    responses.push({ status: 401, body: {} })
    const err = await call('session/list').catch(e => e)
    expect(err).toBeInstanceOf(AuthExpiredError)
    expect(seen).toEqual([1])
    off()
    responses.push({ status: 401, body: {} })
    await call('session/list').catch(() => {})
    expect(seen).toEqual([1])
  })

  it('treats malformed envelopes and non-200 statuses as failures', async () => {
    responses.push({ status: 200, body: { type: 'server-response' } })
    await expect(call('session/list')).rejects.toThrow('malformed envelope')
    responses.push({ status: 500, body: {} })
    await expect(call('session/list')).rejects.toThrow('responded 500')
  })
})
