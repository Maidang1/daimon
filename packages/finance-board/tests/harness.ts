/**
 * Shared test scaffolding for the finance-board specs.
 *
 * `api.spec.ts` and `terminal-routes.spec.ts` each used to re-implement the
 * same `setup` / `mockRes` / `mockReq` — and `mockRes` settled on two
 * different status conventions between them. One harness now, with the fake
 * context typed against the real `WebRoute` so a signature change in the host
 * is caught by `tsc` rather than only by a failing runtime assertion.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, type Config } from '../src/index.ts'

export type Route = WebRoute

/** A recorded HTTP response. */
export interface RecordedResponse {
  res: {
    writeHead(code: number, headers?: Record<string, string>): void
    end(chunk?: string | Buffer): void
  }
  status: () => number
  headers: () => Record<string, string>
  body: () => string
  json: () => unknown
}

export function mockRes(): RecordedResponse {
  let status = 0
  let data = ''
  let headers: Record<string, string> = {}
  return {
    res: {
      writeHead(code, h) {
        status = code
        headers = h ?? {}
      },
      end(chunk) {
        if (chunk !== undefined) data += chunk.toString()
      },
    },
    status: () => status,
    headers: () => headers,
    body: () => data,
    json: () => JSON.parse(data),
  }
}

/** A request whose body is an async iterable of one JSON chunk. */
export function mockReq(method: string, url: string, body?: unknown): Parameters<WebRoute['handler']>[0] {
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  } as unknown as Parameters<WebRoute['handler']>[0]
}

/**
 * Invoke one route and return the recorded response.
 *
 * The two casts (request in, response out) live here: a route handler is typed
 * against the real `IncomingMessage`/`ServerResponse`, but a test only needs to
 * drive `method`, `url` and the body iterable, and read back status, headers
 * and body.
 */
export async function call(route: Route, method: string, url: string, body?: unknown): Promise<RecordedResponse> {
  const recorded = mockRes()
  await route.handler(mockReq(method, url, body), recorded.res as unknown as ServerResponse)
  return recorded
}

export interface Harness {
  /** The finance home (with `state/` already created). */
  home: string
  /** Look up a registered exact route. */
  exact: (path: string) => Route
  /** Every registered route, in registration order. */
  routes: Route[]
}

/**
 * Build the plugin with a mocked webServer + connection and a fake bundle.
 *
 * `apply` is called with a partial config on purpose: it exercises the same
 * `resolveConfig` path a direct caller (or a test) takes.
 */
export function setup(config: Partial<Config> = {}, opts: { authorize?: boolean } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'finance-board-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  const terminalDist = mkdtempSync(join(tmpdir(), 'finance-board-dist-'))
  writeFileSync(join(terminalDist, 'index.html'), '<html>terminal</html>')
  writeFileSync(join(terminalDist, 'app.js'), 'console.log(1)')
  writeFileSync(join(terminalDist, 'app.css'), 'body{}')

  const routes: Route[] = []
  const fakeCtx = {
    webServer: { register: (route: Route) => routes.push(route) },
    connection: {
      authorizeIndex(_req: unknown, res: { writeHead: (code: number) => void; end: (chunk?: string) => void }) {
        if (opts.authorize === false) {
          res.writeHead(401)
          res.end('auth required')
          return false
        }
        return true
      },
    },
  }
  apply(fakeCtx as unknown as Parameters<typeof apply>[0], {
    financeHome: home,
    pythonBin: '/nonexistent/python',
    terminalDist,
    ...config,
  })
  return {
    home,
    routes,
    exact: (path: string) => {
      const route = routes.find(r => r.kind === 'exact' && r.path === path)
      if (!route) throw new Error(`route not registered: ${path}`)
      return route
    },
  }
}
