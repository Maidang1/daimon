/**
 * Finance 终端 on the dsh web server.
 *
 * Read side: serves the regenerated 看板 HTML at `/finance` (kept as a
 * no-JS fallback / deep-link), the interactive terminal's data at
 * `/finance/api/snapshot` and `/finance/api/briefing`, and a status endpoint
 * the SPA polls.
 *
 * Action side: `POST /finance/api/jobs` spawns a one-shot Python runner
 * (same interpreter and skills the RLM kernel uses) for long tasks
 * (`daily_job` minutes, `deep_snapshot` with sector look-through), and
 * `POST /finance/api/ops` records one buy/sell synchronously — both paths
 * go through the finance skill itself, so UI actions and in-conversation
 * `finance.add_op` calls are semantically identical.
 *
 * No separate service is involved — every byte lives under FINANCE_HOME and
 * the plugin only reads/writes files there. The `/finance/*` routes are
 * unauthenticated like the static assets; the loopback bind is the
 * protection, and the data is personal portfolio data, so never rebind the
 * server to a non-loopback host. The `/` takeover, by contrast, goes through
 * the same authorizeIndex token/cookie gate as the official SPA.
 *
 * This module is the composition root only: routes live in `routes.ts`,
 * the job store in `jobs.ts`, the Python snippets in `python-actions.ts`,
 * and configuration in `config.ts`.
 *
 * @module @deepseek-ai/dsh-finance-board
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveConfig, type Config } from './config.js'
import { isJobAction } from './schemas.js'
import { bodyErrorMessage, JobsBody, OpsBody, readJsonBody } from './schemas.js'
import { JOB_ACTION_NAMES } from './python-actions.js'
import { activeRun, listJobs, runOps, spawnJob } from './jobs.js'
import { createAssetServer, HTML_CT, jsonResult, registerRoute, respond, serveJsonFile } from './routes.js'

export { Config } from './config.js'

export const name = 'finance-board'
// connection: the root-takeover handler delegates token exchange / 401s to
// ctx.connection.authorizeIndex, the same gate the official SPA uses.
export const inject = ['webServer', 'connection']

const GUIDE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Finance 看板</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 24px;color:#222}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>📈 Finance 看板尚未生成</h1>
<p>在 daimon 会话里让 agent 执行：</p>
<pre>import finance
path = await finance.dashboard()</pre>
<p>看板由 daimon 内置的 finance skill 原生渲染（数据全部烘焙进 HTML，无需服务），
状态存放在 <code>dsh-home/finance/</code>。生成后刷新本页即可。</p>
</body></html>
`

/** The static terminal bundle: `file → content-type`. Exact paths, so no traversal risk. */
const TERMINAL_ASSETS: readonly (readonly [string, string])[] = [
  ['app.js', 'text/javascript; charset=utf-8'],
  ['app.css', 'text/css; charset=utf-8'],
]

/**
 * Mount the `/finance` board route and the 终端 API endpoints.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - configuration; every field is optional and defaults to a
 *   machine-independent value (see `config.ts`).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const { financeHome, dashboardPath, terminalDist } = resolved
  const jobsDir = join(financeHome, 'state')
  const snapshotPath = join(jobsDir, 'ui_snapshot.json')
  const briefingPath = join(jobsDir, 'briefing.json')
  const assets = createAssetServer(terminalDist)

  const mtimeOf = async (path: string): Promise<string | null> => {
    try {
      return (await stat(path)).mtime.toISOString()
    } catch {
      return null
    }
  }

  // Root takeover: exact '/' beats the upstream SPA's fallback seat (the web
  // server checks exact routes first), while GET /index.html keeps falling
  // through to the official SPA as a backdoor. Token exchange, the
  // cookie-stripping 303, and 401s are all delegated to authorizeIndex — it
  // responds on our behalf exactly like it does for the official bundle.
  ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler: async (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return
      respond(res, req, await assets.serve('index.html', HTML_CT))
    },
  })

  for (const [file, contentType] of TERMINAL_ASSETS) {
    registerRoute(ctx, `/terminal/${file}`, ['GET', 'HEAD'], () => assets.serve(file, contentType))
  }

  // Exact routes win over the `/finance` prefix below in the web server's
  // dispatch order, so the API paths are safe to register first.
  registerRoute(ctx, '/finance/api/status', ['GET', 'HEAD'], async () => {
    const [dashboardMtime, snapshotMtime, briefingMtime, jobs] = await Promise.all([
      mtimeOf(dashboardPath),
      mtimeOf(snapshotPath),
      mtimeOf(briefingPath),
      listJobs(jobsDir),
    ])
    return jsonResult(200, {
      dashboard: { exists: dashboardMtime !== null, mtime: dashboardMtime },
      snapshot: { exists: snapshotMtime !== null, mtime: snapshotMtime },
      briefing: { exists: briefingMtime !== null, mtime: briefingMtime },
      jobs,
      updatedAt: snapshotMtime ?? dashboardMtime,
    })
  })

  registerRoute(ctx, '/finance/api/snapshot', ['GET', 'HEAD'], () => serveJsonFile(snapshotPath))
  registerRoute(ctx, '/finance/api/briefing', ['GET', 'HEAD'], () => serveJsonFile(briefingPath))

  registerRoute(ctx, '/finance/api/jobs', ['GET', 'HEAD', 'POST'], async req => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return jsonResult(200, { jobs: await listJobs(jobsDir) })
    }
    const body = await readJsonBody(req, JobsBody)
    if (!body.ok) return jsonResult(400, { error: bodyErrorMessage(body) })
    const action = body.value.action
    if (!isJobAction(action)) {
      return jsonResult(400, { error: `unknown action "${action}"`, actions: JOB_ACTION_NAMES })
    }
    const jobs = await listJobs(jobsDir)
    if (activeRun(jobs, action)) {
      return jsonResult(409, { error: `action "${action}" is already running`, jobs })
    }
    return jsonResult(202, { job: await spawnJob(resolved, jobsDir, action) })
  })

  registerRoute(ctx, '/finance/api/ops', ['POST'], async req => {
    const body = await readJsonBody(req, OpsBody)
    if (!body.ok) return jsonResult(400, { error: bodyErrorMessage(body) })
    const outcome = await runOps(resolved, jobsDir, body.value)
    return outcome.ok ? jsonResult(200, outcome.body) : jsonResult(outcome.code, { error: outcome.error })
  })

  // The static 看板, kept as a no-JS fallback and deep link.
  ctx.webServer.register({
    kind: 'prefix',
    path: '/finance',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
      if (pathname !== '/finance') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      let html: Buffer
      try {
        html = await readFile(dashboardPath)
        respond(res, req, { code: 200, body: html, contentType: HTML_CT })
      } catch {
        respond(res, req, { code: 200, body: GUIDE_PAGE, contentType: HTML_CT })
      }
    },
  })
}
