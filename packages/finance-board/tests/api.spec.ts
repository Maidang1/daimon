import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'

interface Route {
  kind: string
  path: string
  handler: (req: any, res: any) => Promise<void>
}

function setup(config: Partial<Config> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'finance-board-test-'))
  mkdirSync(join(home, 'state'), { recursive: true })
  const routes: Route[] = []
  const fakeCtx = {
    webServer: {
      register(route: Route) {
        routes.push(route)
      },
    },
  }
  apply(fakeCtx as any, { financeHome: home, pythonBin: '/nonexistent/python', ...config })
  const exact = (path: string): Route => {
    const route = routes.find(r => r.kind === 'exact' && r.path === path)
    if (!route) throw new Error(`route not registered: ${path}`)
    return route
  }
  return { home, exact, routes }
}

function mockRes(): { res: any; body: () => string; json: () => any } {
  let status = 0
  let data = ''
  const res = {
    writeHead(code: number) {
      status = code
    },
    end(chunk?: string) {
      if (chunk !== undefined) data += chunk
    },
    _status: () => status,
  }
  return {
    res,
    body: () => data,
    json: () => JSON.parse(data),
  }
}

function mockReq(method: string, url: string, body?: unknown): any {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

describe('finance-board host routes', () => {
  it('registers all exact API routes plus the /finance prefix', () => {
    const { routes } = setup()
    const paths = routes.map(r => `${r.kind}:${r.path}`)
    expect(paths).toContain('exact:/finance/api/status')
    expect(paths).toContain('exact:/finance/api/snapshot')
    expect(paths).toContain('exact:/finance/api/jobs')
    expect(paths).toContain('exact:/finance/api/ops')
    expect(paths).toContain('prefix:/finance')
  })

  it('status reports missing snapshot/dashboard on an empty home', async () => {
    const { home, exact } = setup()
    const { res, json } = mockRes()
    await exact('/finance/api/status').handler(mockReq('GET', '/finance/api/status'), res)
    expect(res._status()).toBe(200)
    const body = json()
    expect(body.snapshot.exists).toBe(false)
    expect(body.dashboard.exists).toBe(false)
    expect(body.jobs).toEqual([])
    void home
  })

  it('snapshot returns 404 when absent and the file content when present', async () => {
    const { home, exact } = setup()
    const missing = mockRes()
    await exact('/finance/api/snapshot').handler(mockReq('GET', '/finance/api/snapshot'), missing.res)
    expect(missing.res._status()).toBe(404)

    writeFileSync(join(home, 'state', 'ui_snapshot.json'), JSON.stringify({ version: 1 }))
    const hit = mockRes()
    await exact('/finance/api/snapshot').handler(mockReq('GET', '/finance/api/snapshot'), hit.res)
    expect(hit.res._status()).toBe(200)
    expect(hit.json()).toEqual({ version: 1 })
  })

  it('rejects POST /jobs with an unknown action', async () => {
    const { exact } = setup()
    const { res, json } = mockRes()
    await exact('/finance/api/jobs').handler(mockReq('POST', '/finance/api/jobs', { action: 'nope' }), res)
    expect(res._status()).toBe(400)
    expect(json().actions).toEqual(['daily_job', 'refresh_dashboard', 'deep_snapshot'])
  })

  it('409 when the same action is already running, otherwise 202 + status file', async () => {
    const { home, exact } = setup()
    writeFileSync(
      join(home, 'state', 'ui_job_running.json'),
      JSON.stringify({ id: 'running', action: 'daily_job', status: 'running' }),
    )
    const dup = mockRes()
    await exact('/finance/api/jobs').handler(mockReq('POST', '/finance/api/jobs', { action: 'daily_job' }), dup.res)
    expect(dup.res._status()).toBe(409)

    const ok = mockRes()
    await exact('/finance/api/jobs').handler(mockReq('POST', '/finance/api/jobs', { action: 'refresh_dashboard' }), ok.res)
    expect(ok.res._status()).toBe(202)
    const jobFile = join(home, 'state', `ui_job_${ok.json().job.id}.json`)
    expect(existsSync(jobFile)).toBe(true)
    // Spawn with a nonexistent interpreter flips the record to error asynchronously.
    await new Promise(r => setTimeout(r, 300))
    expect(JSON.parse(readFileSync(jobFile, 'utf-8')).status).toBe('error')
  })

  it('validates POST /ops payload', async () => {
    const { exact } = setup()
    for (const bad of [
      { code: '008401', side: 'hold', shares: 1, price: 1 },
      { code: '008401', side: 'buy', shares: -1, price: 1 },
      { code: '008401', side: 'buy', shares: 1, price: 0 },
      { side: 'buy', shares: 1, price: 1 },
    ]) {
      const { res } = mockRes()
      await exact('/finance/api/ops').handler(mockReq('POST', '/finance/api/ops', bad), res)
      expect(res._status()).toBe(400)
    }
  })

  it('/finance prefix serves the dashboard HTML or the guide page', async () => {
    const { home, routes } = setup()
    const prefix = routes.find(r => r.kind === 'prefix')!

    const guide = mockRes()
    await prefix.handler(mockReq('GET', '/finance'), guide.res)
    expect(guide.body()).toContain('尚未生成')

    writeFileSync(join(home, 'dashboard.html'), '<html>board</html>')
    const board = mockRes()
    await prefix.handler(mockReq('GET', '/finance'), board.res)
    expect(board.body()).toBe('<html>board</html>')

    const nested = mockRes()
    await prefix.handler(mockReq('GET', '/finance/anything'), nested.res)
    expect(nested.res._status()).toBe(404)
  })
})
