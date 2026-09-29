/**
 * Finance 终端 on the dsh web server.
 *
 * Read side: serves the regenerated 看板 HTML at `/finance` (kept as a
 * no-JS fallback / deep-link), the interactive panel's data at
 * `/finance/api/snapshot`, and a status endpoint the SPA polls.
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
 * @module @deepseek-ai/dsh-finance-board
 */

import { execFile, spawn } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'

export const name = 'finance-board'
// connection: the root-takeover handler delegates token exchange / 401s to
// ctx.connection.authorizeIndex, the same gate the official SPA uses.
export const inject = ['webServer', 'connection']

/** Default daimon-owned FINANCE_HOME. */
const DEFAULT_FINANCE_HOME = '/Users/bytedance/codes/open-source/daimon/dsh-home/finance'

/** Default interpreter: the miniconda Python the RLM kernel is configured with. */
const DEFAULT_PYTHON_BIN = '/Users/bytedance/miniconda/bin/python3'

/**
 * Default skills directory: `<repo>/packages/rlm-kernel-python/py/skills`,
 * resolved relative to this package's `lib/` output (one level below the
 * package root, which sits next to rlm-kernel-python in the monorepo).
 */
const DEFAULT_SKILLS_PATH = fileURLToPath(
  new URL('../../rlm-kernel-python/py/skills', import.meta.url),
)

/**
 * Default terminal bundle directory: `<pkg>/lib/terminal` (esbuild output of
 * src/terminal/, produced by scripts/build-terminal.mjs), resolved relative
 * to this module's `lib/` output.
 */
const DEFAULT_TERMINAL_DIST = fileURLToPath(new URL('./terminal', import.meta.url))

/** Long-running job actions and the runner snippet each of them executes. */
const JOB_ACTIONS: Record<string, string> = {
  /** Daily pipeline: fetch market data → RBSA predictions → lock → snapshot. */
  daily_job: 'result = asyncio.run(finance.run_daily_job())',
  /** Re-render the 看板 HTML plus the UI snapshot (cheap). First recomputes
   * intraday estimates from current live quotes (incl. US pre/post market),
   * so a manual refresh reflects then-current US prices when locked
   * predictions aren't available yet. */
  refresh_dashboard: 'asyncio.run(finance.live_estimate()); result = asyncio.run(finance.dashboard())',
  /** Rebuild the UI snapshot including sector look-through (slow on cold cache). */
  deep_snapshot: 'result = asyncio.run(finance.ui_snapshot(include_lookthrough=True))',
}

/**
 * One-shot runner executed by the configured Python: runs one job action and
 * reports progress to a status file the host serves back. Arguments:
 * `<action> <statusFile>`.
 */
const JOB_RUNNER = `
import asyncio, json, os, sys, traceback

action, status_path = sys.argv[1], sys.argv[2]

def write(status, **kw):
    try:
        with open(status_path + ".tmp", "w", encoding="utf-8") as fh:
            json.dump({"action": action, "status": status, **kw}, fh, ensure_ascii=False)
        os.replace(status_path + ".tmp", status_path)
    except OSError:
        pass

ACTIONS = ${JSON.stringify(JOB_ACTIONS)}
if action not in ACTIONS:
    print(f"unknown action: {action}", file=sys.stderr)
    sys.exit(2)

write("running")
try:
    import finance
    result = None
    exec(ACTIONS[action])
    write("success", result=result)
except Exception:
    write("error", error=traceback.format_exc()[-600:])
    sys.exit(1)
`

/** Configuration for the finance 终端 routes. */
export interface Config {
  /** Absolute path of the FINANCE_HOME state root (dashboard + state live under it). */
  financeHome?: string
  /** Absolute path of the self-contained dashboard HTML file to serve at /finance. */
  dashboardPath?: string
  /** Python interpreter used for job/ops runners (must carry the finance deps). */
  pythonBin?: string
  /** Directory containing the `finance` Python skill package. */
  skillsPath?: string
  /** Directory holding the built terminal SPA (index.html + app.js). */
  terminalDist?: string
}

/** Validated configuration for the finance 终端 routes. */
export const Config: z<Config> = z.object({
  financeHome: z.string().default(DEFAULT_FINANCE_HOME),
  dashboardPath: z.string().default(''),
  pythonBin: z.string().default(DEFAULT_PYTHON_BIN),
  skillsPath: z.string().default(DEFAULT_SKILLS_PATH),
  terminalDist: z.string().default(DEFAULT_TERMINAL_DIST),
})

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

interface JobRecord {
  id: string
  action: string
  status: 'running' | 'success' | 'error'
  error?: string
  result?: unknown
}

interface OpsRequest {
  code?: string
  side?: string
  shares?: number
  price?: number
  date?: string
  note?: string
}

function sendJson(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(body))
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Parse a JSON request body with a size cap; returns null on malformed input. */
async function readBody(req: import('node:http').IncomingMessage, cap = 16_384): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > cap) return null
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    return null
  }
}

/**
 * Mount the `/finance` board route and the 终端 API endpoints.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const financeHome = config.financeHome ?? DEFAULT_FINANCE_HOME
  const dashboardPath = config.dashboardPath || join(financeHome, 'dashboard.html')
  const snapshotPath = join(financeHome, 'state', 'ui_snapshot.json')
  const jobsDir = join(financeHome, 'state')
  const terminalDist = config.terminalDist ?? DEFAULT_TERMINAL_DIST

  // Terminal SPA assets, cached in memory after first read (rebuilds are
  // followed by a process restart in this setup, so staleness is bounded).
  const assetCache = new Map<string, Promise<Buffer>>()
  const readAsset = (file: string): Promise<Buffer> => {
    let cached = assetCache.get(file)
    if (!cached) {
      cached = readFile(join(terminalDist, file))
      assetCache.set(file, cached)
      // A missing file must not poison the cache forever.
      cached.catch(() => assetCache.delete(file))
    }
    return cached
  }

  const serveTerminalAsset = async (
    res: import('node:http').ServerResponse,
    file: string,
    contentType: string,
  ): Promise<void> => {
    try {
      const body = await readAsset(file)
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' })
      res.end(body)
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('terminal bundle missing — run `pnpm build` in packages/finance-board first\n')
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
      await serveTerminalAsset(res, 'index.html', 'text/html; charset=utf-8')
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/terminal/app.js',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      await serveTerminalAsset(res, 'app.js', 'text/javascript; charset=utf-8')
    },
  })

  const runnerEnv = {
    ...process.env,
    FINANCE_HOME: financeHome,
    PYTHONPATH: [config.skillsPath ?? DEFAULT_SKILLS_PATH, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(':'),
  }

  async function listJobs(): Promise<JobRecord[]> {
    let files: string[]
    try {
      files = await readdir(jobsDir)
    } catch {
      return []
    }
    const jobs: { rec: JobRecord; mtime: number }[] = []
    for (const file of files) {
      if (!file.startsWith('ui_job_') || !file.endsWith('.json')) continue
      const path = join(jobsDir, file)
      const rec = await readJsonFile<JobRecord>(path)
      if (!rec || typeof rec.action !== 'string') continue
      // The Python runner rewrites the status file without the id — recover
      // it from the filename so ordering and frontend dedup keep working.
      if (!rec.id) rec.id = file.slice('ui_job_'.length, -'.json'.length)
      let mtime = 0
      try {
        mtime = (await stat(path)).mtimeMs
      } catch {
        // Keep 0 — sinks to the end of the list.
      }
      jobs.push({ rec, mtime })
    }
    // Newest first. Sorting by mtime, not id: finished records carry no
    // reliable timestamp of their own, and the seeded id may be gone.
    return jobs.sort((a, b) => b.mtime - a.mtime).map(j => j.rec)
  }

  // Exact routes win over the `/finance` prefix below in the web server's
  // dispatch order, so the API paths are safe to register first.
  ctx.webServer.register({
    kind: 'exact',
    path: '/finance/api/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const mtimeOf = async (path: string): Promise<string | null> => {
        try {
          return (await stat(path)).mtime.toISOString()
        } catch {
          return null
        }
      }
      const [dashboardMtime, snapshotMtime, jobs] = await Promise.all([
        mtimeOf(dashboardPath),
        mtimeOf(snapshotPath),
        listJobs(),
      ])
      sendJson(res, 200, {
        dashboard: { exists: dashboardMtime !== null, mtime: dashboardMtime },
        snapshot: { exists: snapshotMtime !== null, mtime: snapshotMtime },
        jobs,
      })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/finance/api/snapshot',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      try {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(await readFile(snapshotPath, 'utf-8'))
      } catch {
        sendJson(res, 404, { exists: false })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/finance/api/jobs',
    handler: async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { jobs: await listJobs() })
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const body = (await readBody(req)) as { action?: string } | null
      const action = body?.action ?? ''
      if (!(action in JOB_ACTIONS)) {
        sendJson(res, 400, { error: `unknown action "${action}"`, actions: Object.keys(JOB_ACTIONS) })
        return
      }
      const jobs = await listJobs()
      if (jobs.some(j => j.action === action && j.status === 'running')) {
        sendJson(res, 409, { error: `action "${action}" is already running`, jobs })
        return
      }
      const id = randomUUID()
      const statusPath = join(jobsDir, `ui_job_${id}.json`)
      const record: JobRecord = { id, action, status: 'running' }
      // Best-effort pre-seed so a slow interpreter startup reads as running.
      await writeFile(statusPath, JSON.stringify(record)).catch(() => {})
      const child = spawn(config.pythonBin ?? DEFAULT_PYTHON_BIN, ['-c', JOB_RUNNER, action, statusPath], {
        env: runnerEnv,
        stdio: 'ignore',
      })
      child.on('error', (err) => {
        const failed: JobRecord = { id, action, status: 'error', error: String(err) }
        void writeFile(statusPath, JSON.stringify(failed)).catch(() => {})
      })
      sendJson(res, 202, { job: record })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/finance/api/ops',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      const body = (await readBody(req)) as OpsRequest | null
      const side = body?.side === 'sell' ? 'sell' : body?.side === 'buy' ? 'buy' : null
      const shares = Number(body?.shares)
      const price = Number(body?.price)
      if (!body?.code || !side || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
        sendJson(res, 400, { error: 'body must be {code, side: "buy"|"sell", shares>0, price>0, date?, note?}' })
        return
      }
      const snippet = [
        'import asyncio, json, finance',
        `print("%%RESULT%%" + json.dumps(asyncio.run(finance.add_op(${
          JSON.stringify(body.code)}, ${JSON.stringify(side)}, ${shares}, ${price
        }, date=${body.date ? JSON.stringify(body.date) : 'None'}, note=${JSON.stringify(body.note ?? '')})), ensure_ascii=False))`,
      ].join('\n')
      try {
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
          execFile(
            config.pythonBin ?? DEFAULT_PYTHON_BIN,
            ['-c', snippet],
            { env: runnerEnv, timeout: 60_000, maxBuffer: 1_048_576 },
            (err, stdout, stderr) => {
              if (err && !stdout.includes('%%RESULT%%')) {
                reject(new Error(stderr.slice(-500) || String(err)))
                return
              }
              resolvePromise({ code: err ? 1 : 0, stdout, stderr })
            },
          )
        })
        const marker = result.stdout.split('%%RESULT%%')[1]?.trim()
        if (!marker) {
          sendJson(res, 502, { error: `python runner gave no result: ${result.stderr.slice(-300)}` })
          return
        }
        sendJson(res, 200, JSON.parse(marker))
      } catch (err) {
        sendJson(res, 502, { error: String(err) })
      }
    },
  })

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
      try {
        const html = await readFile(dashboardPath)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      } catch {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(GUIDE_PAGE)
      }
    },
  })
}
