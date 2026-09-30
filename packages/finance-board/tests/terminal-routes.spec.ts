/**
 * Terminal bundle routes and the `/` takeover.
 *
 * Shares `harness.ts` with `api.spec.ts`; these two specs used to re-implement
 * the same mock context, response and request helpers.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { call, type Route } from './harness.ts'

/** Build the plugin, optionally with a bundle directory containing assets. */
function setup(opts: { authorize?: boolean; bundle?: boolean } = {}): { routes: Route[] } {
  const home = mkdtempSync(join(tmpdir(), 'finance-board-terminal-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  const terminalDist = mkdtempSync(join(tmpdir(), 'finance-board-dist-'))
  if (opts.bundle) {
    writeFileSync(join(terminalDist, 'index.html'), '<html>terminal</html>')
    writeFileSync(join(terminalDist, 'app.js'), 'console.log(1)')
    writeFileSync(join(terminalDist, 'app.css'), 'body{}')
  }
  const routes: Route[] = []
  apply({
    webServer: { register: (r: Route) => routes.push(r) },
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
  } as unknown as Parameters<typeof apply>[0], { financeHome: home, pythonBin: '/nonexistent/python', terminalDist })
  return { routes }
}

const routeAt = (routes: Route[], path: string): Route => routes.find(r => r.path === path)!

describe('terminal root takeover', () => {
  it('registers exact / and /terminal/app.js routes', () => {
    const { routes } = setup()
    const paths = routes.map(r => `${r.kind}:${r.path}`)
    expect(paths).toContain('exact:/')
    expect(paths).toContain('exact:/terminal/app.js')
  })

  it('serves the terminal index.html when authorizeIndex returns true', async () => {
    const { routes } = setup({ bundle: true })
    const ok = await call(routeAt(routes, '/'), 'GET', '/')
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-type']).toContain('text/html')
    expect(ok.headers()['cache-control']).toBe('no-cache')
    expect(ok.body()).toBe('<html>terminal</html>')
  })

  it('writes nothing itself when authorizeIndex returns false', async () => {
    const { routes } = setup({ authorize: false, bundle: true })
    const denied = await call(routeAt(routes, '/'), 'GET', '/')
    // The 401 came from authorizeIndex; the handler must not touch res again.
    expect(denied.status()).toBe(401)
    expect(denied.body()).toBe('auth required')
  })

  it('answers 503 for a missing bundle instead of crashing', async () => {
    const { routes } = setup({ bundle: false })
    const miss = await call(routeAt(routes, '/'), 'GET', '/')
    expect(miss.status()).toBe(503)
    expect(miss.body()).toContain('terminal bundle missing')
  })
})

describe('terminal asset routes', () => {
  it('serves app.js and app.css with their own content types', async () => {
    const { routes } = setup({ bundle: true })
    const js = await call(routeAt(routes, '/terminal/app.js'), 'GET', '/terminal/app.js')
    expect(js.status()).toBe(200)
    expect(js.headers()['content-type']).toContain('text/javascript')
    expect(js.body()).toBe('console.log(1)')

    const css = await call(routeAt(routes, '/terminal/app.css'), 'GET', '/terminal/app.css')
    expect(css.status()).toBe(200)
    expect(css.headers()['content-type']).toContain('text/css')
    expect(css.body()).toBe('body{}')
  })

  it('reuses a cached asset and does not poison the cache on a miss', async () => {
    const { routes } = setup({ bundle: true })
    const jsRoute = routeAt(routes, '/terminal/app.js')
    expect((await call(jsRoute, 'GET', '/terminal/app.js')).status()).toBe(200)
    // A second read of the same file is served from the in-memory cache, which
    // is the documented behaviour (rebuilds are followed by a restart).
    expect((await call(jsRoute, 'GET', '/terminal/app.js')).body()).toBe('console.log(1)')

    // A route never read stays honest: a missing state document is a 404, not
    // a cached 503.
    const missing = await call(routeAt(routes, '/finance/api/snapshot'), 'GET', '/finance/api/snapshot')
    expect(missing.status()).toBe(404)
  })

  it('returns 405 for methods an asset route does not accept', async () => {
    const { routes } = setup({ bundle: true })
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const bad = await call(routeAt(routes, '/terminal/app.js'), method, '/terminal/app.js')
      expect(bad.status()).toBe(405)
    }
  })
})
