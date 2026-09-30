/**
 * HTTP transport for the finance 终端 routes.
 *
 * Every route in this plugin used to hand-write the same three things: a
 * method guard, a `writeHead` with a content-type, and an error mapping.
 * Eight copies of the guard, two byte-identical JSON-file handlers and two
 * byte-identical asset handlers later, the framing lives here once and a
 * route only supplies what actually varies — its path, its methods, and a
 * `RouteResult`.
 *
 * @module @deepseek-ai/dsh-finance-board/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const JSON_CT = 'application/json; charset=utf-8'
export const HTML_CT = 'text/html; charset=utf-8'
export const TEXT_CT = 'text/plain; charset=utf-8'
export const JS_CT = 'text/javascript; charset=utf-8'
export const CSS_CT = 'text/css; charset=utf-8'

/** One route's answer, before framing. */
export interface RouteResult {
  code: number
  body: string | Buffer
  contentType: string
}

/** The result of a JSON route. */
export function jsonResult(code: number, body: unknown): RouteResult {
  return { code, body: JSON.stringify(body), contentType: JSON_CT }
}

/** The result of a plain-text route. */
export function textResult(code: number, body: string): RouteResult {
  return { code, body, contentType: TEXT_CT }
}

/** Write one response: the only place status, headers and body are set. */
export function respond(res: ServerResponse, req: IncomingMessage, result: RouteResult): void {
  res.writeHead(result.code, {
    'content-type': result.contentType,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : result.body)
}

/**
 * Register an exact route that answers with a `RouteResult`.
 *
 * The method guard, the 405 body and the response framing exist exactly once,
 * here. A handler that throws becomes a logged 500 rather than an unhandled
 * rejection inside the web server.
 */
export function registerRoute(
  ctx: Context,
  path: string,
  methods: readonly string[],
  handler: (req: IncomingMessage) => Promise<RouteResult>,
): void {
  ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!methods.includes(req.method ?? '')) {
        res.writeHead(405, { 'content-type': TEXT_CT })
        res.end('method not allowed')
        return
      }
      try {
        respond(res, req, await handler(req))
      } catch (err) {
        console.error(`[finance-board] ${path} failed:`, err)
        respond(res, req, jsonResult(500, { error: 'internal error' }))
      }
    },
  })
}

/**
 * Serve one JSON state file. A miss is a 404 `{exists: false}` the SPA
 * degrades on — the same answer for `ui_snapshot.json` and `briefing.json`,
 * because they are the same kind of thing.
 */
export async function serveJsonFile(path: string): Promise<RouteResult> {
  try {
    return { code: 200, body: await readFile(path, 'utf-8'), contentType: JSON_CT }
  } catch {
    return jsonResult(404, { exists: false })
  }
}

export interface AssetServer {
  /** One bundle asset, or a 503 explaining which build step was skipped. */
  serve(file: string, contentType: string): Promise<RouteResult>
}

/**
 * Terminal bundle assets, cached in memory after first read (rebuilds are
 * followed by a process restart in this setup, so staleness is bounded).
 */
export function createAssetServer(terminalDist: string): AssetServer {
  const cache = new Map<string, Promise<Buffer>>()
  const readAsset = (file: string): Promise<Buffer> => {
    let cached = cache.get(file)
    if (!cached) {
      cached = readFile(join(terminalDist, file))
      cache.set(file, cached)
      // A missing file must not poison the cache forever.
      cached.catch(() => cache.delete(file))
    }
    return cached
  }
  return {
    async serve(file, contentType) {
      try {
        return { code: 200, body: await readAsset(file), contentType }
      } catch {
        return textResult(503, 'terminal bundle missing — run `pnpm build` in packages/finance-board first\n')
      }
    },
  }
}
