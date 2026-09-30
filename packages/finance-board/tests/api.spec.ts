/**
 * Host route behaviour: the finance API surface.
 *
 * The scaffolding (mock context / request / response) lives in `harness.ts`
 * and is shared with `terminal-routes.spec.ts` — these two specs used to
 * re-implement it, with two different status conventions between them.
 */

import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JOB_ACTIONS as CLIENT_JOB_ACTIONS } from '../src/client/api.ts'
import { JOB_ACTION_NAMES } from '../src/python-actions.ts'
import { call, setup } from './harness.ts'

/** A status body, as the SPA consumes it. */
interface StatusBody {
  dashboard: { exists: boolean; mtime: string | null }
  snapshot: { exists: boolean; mtime: string | null }
  briefing: { exists: boolean; mtime: string | null }
  jobs: { id: string; action: string; status: string; error?: string; updatedAt: string }[]
  updatedAt: string | null
}

describe('finance-board host routes', () => {
  it('registers all exact API routes plus the /finance prefix', () => {
    const { routes } = setup()
    const paths = routes.map(r => `${r.kind}:${r.path}`)
    expect(paths).toContain('exact:/finance/api/status')
    expect(paths).toContain('exact:/finance/api/snapshot')
    expect(paths).toContain('exact:/finance/api/briefing')
    expect(paths).toContain('exact:/finance/api/jobs')
    expect(paths).toContain('exact:/finance/api/ops')
    expect(paths).toContain('exact:/terminal/app.js')
    expect(paths).toContain('exact:/terminal/app.css')
    expect(paths).toContain('prefix:/finance')
  })

  it('briefing returns 404 when absent and the file content when present', async () => {
    const { home, exact } = setup()
    const missing = await call(exact('/finance/api/briefing'), 'GET', '/finance/api/briefing')
    expect(missing.status()).toBe(404)
    expect(missing.json()).toEqual({ exists: false })

    const briefing = { date: '2026-09-30', indices: [], news: [], suggestions: [] }
    writeFileSync(join(home, 'state', 'briefing.json'), JSON.stringify(briefing))
    const hit = await call(exact('/finance/api/briefing'), 'GET', '/finance/api/briefing')
    expect(hit.status()).toBe(200)
    expect(hit.headers()['content-type']).toContain('application/json')
    expect(hit.json()).toEqual(briefing)
  })

  it('status reports missing documents and lists jobs newest-first', async () => {
    const { home, exact } = setup()
    const empty = await call(exact('/finance/api/status'), 'GET', '/finance/api/status')
    expect(empty.status()).toBe(200)
    let body = empty.json() as StatusBody
    expect(body.snapshot.exists).toBe(false)
    expect(body.dashboard.exists).toBe(false)
    expect(body.briefing.exists).toBe(false)
    expect(body.jobs).toEqual([])
    expect(body.updatedAt).toBeNull()

    writeFileSync(join(home, 'state', 'ui_snapshot.json'), '{}')
    writeFileSync(join(home, 'state', 'ui_job_old.json'), JSON.stringify({ id: 'old', action: 'daily_job', status: 'success' }))
    writeFileSync(join(home, 'state', 'ui_job_new.json'), JSON.stringify({ id: 'new', action: 'refresh_dashboard', status: 'error', error: 'boom' }))
    // Order comes from mtime, not the id, so the timestamps decide it.
    utimesSync(join(home, 'state', 'ui_job_old.json'), new Date(1000), new Date(1000))

    const full = await call(exact('/finance/api/status'), 'GET', '/finance/api/status')
    body = full.json() as StatusBody
    expect(body.snapshot.exists).toBe(true)
    expect(body.updatedAt).not.toBeNull()
    expect(body.jobs).toEqual([
      { id: 'new', action: 'refresh_dashboard', status: 'error', error: 'boom', updatedAt: expect.any(String) },
      { id: 'old', action: 'daily_job', status: 'success', updatedAt: expect.any(String) },
    ])
  })

  it('rejects a request method a route does not accept', async () => {
    const { exact } = setup()
    for (const path of ['/finance/api/status', '/finance/api/snapshot', '/finance/api/briefing', '/terminal/app.js']) {
      const bad = await call(exact(path), 'DELETE', path)
      expect(bad.status()).toBe(405)
      expect(bad.body()).toBe('method not allowed')
      expect(bad.headers()['content-type']).toContain('text/plain')
    }
  })

  it('HEAD suppresses the body but keeps the status', async () => {
    const { exact } = setup()
    const head = await call(exact('/finance/api/status'), 'HEAD', '/finance/api/status')
    expect(head.status()).toBe(200)
    expect(head.body()).toBe('')
  })

  it('snapshot returns 404 when absent and the file content when present', async () => {
    const { home, exact } = setup()
    const missing = await call(exact('/finance/api/snapshot'), 'GET', '/finance/api/snapshot')
    expect(missing.status()).toBe(404)

    writeFileSync(join(home, 'state', 'ui_snapshot.json'), JSON.stringify({ version: 1 }))
    const hit = await call(exact('/finance/api/snapshot'), 'GET', '/finance/api/snapshot')
    expect(hit.status()).toBe(200)
    expect(hit.json()).toEqual({ version: 1 })
  })

  it('rejects POST /jobs with an unknown action and lists the valid ones', async () => {
    const { exact } = setup()
    const bad = await call(exact('/finance/api/jobs'), 'POST', '/finance/api/jobs', { action: 'nope' })
    expect(bad.status()).toBe(400)
    expect(bad.json()).toEqual({ error: 'unknown action "nope"', actions: JOB_ACTION_NAMES })
  })

  it('lists jobs over GET /jobs', async () => {
    const { home, exact } = setup()
    writeFileSync(join(home, 'state', 'ui_job_a.json'), JSON.stringify({ id: 'a', action: 'daily_job', status: 'success' }))
    const { json } = await call(exact('/finance/api/jobs'), 'GET', '/finance/api/jobs')
    expect((json() as { jobs: unknown[] }).jobs).toHaveLength(1)
  })

  it('409 when the same action is already running, otherwise 202 + status file', async () => {
    const { home, exact } = setup()
    writeFileSync(join(home, 'state', 'ui_job_running.json'), JSON.stringify({ id: 'running', action: 'daily_job', status: 'running' }))
    const dup = await call(exact('/finance/api/jobs'), 'POST', '/finance/api/jobs', { action: 'daily_job' })
    expect(dup.status()).toBe(409)

    const ok = await call(exact('/finance/api/jobs'), 'POST', '/finance/api/jobs', { action: 'refresh_dashboard' })
    expect(ok.status()).toBe(202)
    const jobId = (ok.json() as { job: { id: string } }).job.id
    const jobFile = join(home, 'state', `ui_job_${jobId}.json`)
    const { existsSync, readFileSync } = await import('node:fs')
    expect(existsSync(jobFile)).toBe(true)
    // Spawn with a nonexistent interpreter flips the record to error asynchronously.
    await new Promise(r => setTimeout(r, 300))
    expect(JSON.parse(readFileSync(jobFile, 'utf-8')).status).toBe('error')
  })

  it('stops treating a stale running record as a conflict', async () => {
    const { home, exact } = setup()
    // A child that was killed (OOM, SIGKILL) never rewrites its record, so
    // without an age check this action would 409 forever.
    const path = join(home, 'state', 'ui_job_stranded.json')
    writeFileSync(path, JSON.stringify({ id: 'stranded', action: 'daily_job', status: 'running' }))
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(path, old, old)

    const restarted = await call(exact('/finance/api/jobs'), 'POST', '/finance/api/jobs', { action: 'daily_job' })
    expect(restarted.status()).toBe(202)
  })

  it('skips a corrupt or unknown-action job file instead of crashing the list', async () => {
    const { home, exact } = setup()
    writeFileSync(join(home, 'state', 'ui_job_broken.json'), '{not json')
    writeFileSync(join(home, 'state', 'ui_job_unknown.json'), JSON.stringify({ id: 'u', action: 'no_such_action', status: 'success' }))
    const { json } = await call(exact('/finance/api/status'), 'GET', '/finance/api/status')
    expect((json() as { jobs: unknown[] }).jobs).toEqual([])
  })

  it('validates the POST /jobs body', async () => {
    const { exact } = setup()
    for (const bad of [{}, { action: '' }, { action: 5 }, 'nope', null]) {
      const rejected = await call(exact('/finance/api/jobs'), 'POST', '/finance/api/jobs', bad)
      expect(rejected.status()).toBe(400)
    }
  })

  it('validates the POST /ops body: presence, types and domain', async () => {
    const { exact } = setup()
    for (const bad of [
      { code: '008401', side: 'hold', shares: 1, price: 1 },
      { code: '008401', side: 'buy', shares: -1, price: 1 },
      { code: '008401', side: 'buy', shares: 1, price: 0 },
      { side: 'buy', shares: 1, price: 1 },                        // missing code
      { code: '', side: 'buy', shares: 1, price: 1 },              // empty code
      { code: '008401', side: 'buy', shares: '5', price: 1 },      // string shares
      { code: '008401', side: 'buy', shares: true, price: 1 },     // boolean shares
      { code: 5, side: 'buy', shares: 1, price: 1 },               // numeric code
      { code: '008401', side: 'buy', shares: 1, price: 1, date: 3 }, // wrong optional type
    ]) {
      const rejected = await call(exact('/finance/api/ops'), 'POST', '/finance/api/ops', bad)
      expect(rejected.status()).toBe(400)
    }
  })

  it('accepts a valid ops body shape and reaches the runner', async () => {
    const { exact } = setup()
    // The interpreter does not exist here, so the runner cannot produce a
    // result file — which must read as a diagnosable 502, never a hang or a
    // silent success.
    const { status, json } = await call(exact('/finance/api/ops'), 'POST', '/finance/api/ops', {
      code: '008401', side: 'buy', shares: 100, price: 1.2345, date: '2026-09-30', note: '定投',
    })
    expect(status()).toBe(502)
    expect(String((json() as { error: string }).error)).toContain('python runner')
  })

  it('tells a malformed body apart from a schema failure', async () => {
    const { exact } = setup()
    // No body at all: an empty request is not valid JSON.
    const malformed = await call(exact('/finance/api/ops'), 'POST', '/finance/api/ops')
    expect(malformed.status()).toBe(400)
    expect(malformed.json()).toEqual({ error: 'request body is not valid JSON' })

    // A valid JSON document that is not an object is a schema failure.
    const notAnObject = await call(exact('/finance/api/ops'), 'POST', '/finance/api/ops', 'a string')
    expect(notAnObject.status()).toBe(400)
    expect(notAnObject.json()).toEqual({ error: expect.stringContaining('expected object') })
  })

  it('keeps the client action list in step with the host action registry', () => {
    // The two bundles cannot share code, so this is the only thing stopping
    // the four action names from drifting apart.
    expect([...CLIENT_JOB_ACTIONS]).toEqual([...JOB_ACTION_NAMES])
  })

  it('/finance prefix serves the dashboard HTML or the guide page', async () => {
    const { home, routes } = setup()
    const prefix = routes.find(r => r.kind === 'prefix')!

    const guide = await call(prefix, 'GET', '/finance')
    expect(guide.body()).toContain('尚未生成')

    writeFileSync(join(home, 'dashboard.html'), '<html>board</html>')
    const board = await call(prefix, 'GET', '/finance')
    expect(board.body()).toBe('<html>board</html>')

    const nested = await call(prefix, 'GET', '/finance/anything')
    expect(nested.status()).toBe(404)

    const wrongMethod = await call(prefix, 'POST', '/finance')
    expect(wrongMethod.status()).toBe(405)
  })
})
