/**
 * Unary RPC client for the dsh web transport (protocol pinned to dsh
 * 0.1.7-rc.2 — bumping dsh requires re-verifying this module).
 *
 * Shape: `POST /api/<ns>/<m>` with body
 * `{type:"client-request", rpcId, method, payload:{args}}`; the response is
 * `{type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error}}`.
 * Same-origin cookies carry the session, so no auth header is involved; a 401
 * means the token cookie expired and the user must reopen the `?token=` link.
 */

/** Error object carried by a `{ok:false}` server response. */
export interface RpcRemoteError {
  code?: string
  message?: string
  [key: string]: unknown
}

/** Failure of one unary call: transport-level or server-reported. */
export class RpcFailure extends Error {
  constructor(
    message: string,
    /** Server-reported error object, when the failure came from `{ok:false}`. */
    readonly remote: RpcRemoteError | null = null,
    /** HTTP status when the failure was transport-level (0 = network error). */
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'RpcFailure'
  }
}

/** Raised specifically on HTTP 401 — the token cookie no longer validates. */
export class AuthExpiredError extends RpcFailure {
  constructor() {
    super('凭证已失效，请重新打开带 token 的链接', null, 401)
    this.name = 'AuthExpiredError'
  }
}

type AuthExpiredListener = () => void
const authExpiredListeners = new Set<AuthExpiredListener>()

/** Subscribe to 401s observed by any unary call; returns an unsubscribe fn. */
export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener)
  return () => authExpiredListeners.delete(listener)
}

interface ServerResponse<T> {
  type?: string
  rpcId?: string
  result?: { ok: true; value: T } | { ok: false; error: RpcRemoteError }
}

/**
 * Invoke one unary endpoint such as `session/list`.
 *
 * @param endpoint - `<ns>/<m>` path under `/api/`.
 * @param args - endpoint arguments, wrapped into `payload.args`.
 */
export async function call<T = unknown>(endpoint: string, args: Record<string, unknown> = {}): Promise<T> {
  const rpcId = crypto.randomUUID()
  let res: Response
  try {
    res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // method echoes the full endpoint ("session/list"), not the last segment.
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    })
  } catch (err) {
    throw new RpcFailure(`network error calling ${endpoint}: ${String(err)}`, null, 0)
  }
  if (res.status === 401) {
    for (const listener of authExpiredListeners) listener()
    throw new AuthExpiredError()
  }
  if (!res.ok) {
    throw new RpcFailure(`${endpoint} responded ${res.status}`, null, res.status)
  }
  let body: ServerResponse<T>
  try {
    body = (await res.json()) as ServerResponse<T>
  } catch {
    throw new RpcFailure(`${endpoint} returned a non-JSON response`, null, res.status)
  }
  const result = body.result
  if (!result) throw new RpcFailure(`${endpoint} returned a malformed envelope`, null, res.status)
  if (!result.ok) {
    throw new RpcFailure(result.error?.message ?? `${endpoint} failed`, result.error ?? null)
  }
  return result.value
}
