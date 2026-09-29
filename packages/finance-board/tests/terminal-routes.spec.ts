import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface Route {
  kind: string
  path: string
  handler: (req: any, res: any) => Promise<void>
}

/** Build the plugin with a mocked webServer + connection and a fake bundle. */
function setup(opts: { authorize?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'finance-board-root-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  const terminalDist = mkdtempSync(join(tmpdir(), 'finance-board-dist-'))
  writeFileSync(join(terminalDist, 'index.html'), '<html>terminal</html>')
  writeFileSync(join(terminalDist, 'app.js'), 'console.log(1)')
  const routes: Route[] = []
  const authorizeCalls: number[] = []
  const fakeCtx = {
    webServer: {
      register(route: Route) {
        routes.push(route)
      },
    },
    connection: {
      authorizeIndex(_req: any, res: any) {
        authorizeCalls.push(1)
        if (opts.authorize !== false) return true
        // false means the response is already complete (303/401 written).
        res.writeHead(401)
        res.end('auth required')
        return false
      },
    },
  }
  apply(fakeCtx as any, { financeHome: home, pythonBin: '/nonexistent/python', terminalDist })
  const exact = (path: string): Route => {
    const route = routes.find(r => r.kind === 'exact' && r.path === path)
    if (!route) throw new Error(`route not registered: ${path}`)
    return route
  }
  return { exact, routes, authorizeCalls }
}

function mockRes(): { res: any; status: () => number; body: () => string; headers: () => Record<string, string> } {
  let status = 0
  let data = ''
  let headers: Record<string, string> = {}
  return {
    res: {
      writeHead(code: number, h?: Record<string, string>) {
        status = code
        headers = h ?? {}
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) data += chunk.toString()
      },
    },
    status: () => status,
    body: () => data,
    headers: () => headers,
  }
}

const mockReq = (method: string, url: string): any => ({ method, url, headers: {} })

describe('terminal root takeover', () => {
  it('registers exact / and /terminal/app.js routes', () => {
    const { routes } = setup()
    const paths = routes.map(r => `${r.kind}:${r.path}`)
    expect(paths).toContain('exact:/')
    expect(paths).toContain('exact:/terminal/app.js')
  })

  it('serves the terminal index.html when authorizeIndex returns true', async () => {
    const { exact, authorizeCalls } = setup({ authorize: true })
    const { res, status, body, headers } = mockRes()
    await exact('/').handler(mockReq('GET', '/'), res)
    expect(authorizeCalls).toHaveLength(1)
    expect(status()).toBe(200)
    expect(headers()['content-type']).toContain('text/html')
    expect(headers()['cache-control']).toBe('no-cache')
    expect(body()).toBe('<html>terminal</html>')
  })

  it('writes nothing itself when authorizeIndex returns false', async () => {
    const { exact } = setup({ authorize: false })
    const { res, status, body } = mockRes()
    await exact('/').handler(mockReq('GET', '/'), res)
    // The 401 came from authorizeIndex; the handler must not touch res again.
    expect(status()).toBe(401)
    expect(body()).toBe('auth required')
  })

  it('serves /terminal/app.js as JavaScript and rejects POST', async () => {
    const { exact } = setup()
    const ok = mockRes()
    await exact('/terminal/app.js').handler(mockReq('GET', '/terminal/app.js'), ok.res)
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-type']).toContain('text/javascript')
    expect(ok.body()).toBe('console.log(1)')
    const bad = mockRes()
    await exact('/terminal/app.js').handler(mockReq('POST', '/terminal/app.js'), bad.res)
    expect(bad.status()).toBe(405)
  })

  it('responds 503 when the bundle is missing instead of crashing', async () => {
    const { exact } = setup()
    const { res, status, body } = mockRes()
    await exact('/terminal/app.js').handler(mockReq('GET', '/terminal/app.js'), res)
    expect(status()).toBe(200) // cached from the previous request in this setup
    // Fresh setup without bundle files:
    const home = mkdtempSync(join(tmpdir(), 'finance-board-root-'))
    const terminalDist = mkdtempSync(join(tmpdir(), 'finance-board-dist-empty-'))
    const routes: Route[] = []
    apply({
      webServer: { register: (r: Route) => routes.push(r) },
      connection: { authorizeIndex: () => true },
    } as any, { financeHome: home, pythonBin: '/nonexistent/python', terminalDist })
    const route = routes.find(r => r.kind === 'exact' && r.path === '/')!
    const miss = mockRes()
    await route.handler(mockReq('GET', '/'), miss.res)
    expect(miss.status()).toBe(503)
    expect(miss.body()).toContain('terminal bundle missing')
  })
})
