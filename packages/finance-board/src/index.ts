/**
 * Finance dashboard on the dsh web server: serves the self-contained 看板
 * HTML at `/finance` plus a small `/finance/api/status` JSON endpoint the SPA
 * panel polls for regeneration. The browser half (`./client`) embeds the
 * board as a sidebar-registered main panel of the SPA.
 *
 * No separate service is involved — the dashboard file is rendered by the
 * agent (`finance.dashboard()` in the RLM kernel, daimon-native renderer in
 * the finance skill) with all data baked in, and this plugin only reads the
 * file off disk per request, so a regeneration is visible on the next load.
 * The route is unauthenticated like the rest of the web server; the loopback
 * bind is the protection, and the dashboard contains personal portfolio data,
 * so never rebind the server to a non-loopback host.
 *
 * @module @deepseek-ai/dsh-finance-board
 */

import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

export const name = 'finance-board'
export const inject = ['webServer']

/** Default location of the agent-regenerated dashboard (daimon-owned FINANCE_HOME). */
const DEFAULT_DASHBOARD_PATH = '/Users/bytedance/codes/open-source/daimon/dsh-home/finance/dashboard.html'

/** Configuration for the finance dashboard route. */
export interface Config {
  /** Absolute path of the self-contained dashboard HTML file to serve. */
  dashboardPath?: string
}

/** Validated configuration for the finance dashboard route. */
export const Config: z<Config> = z.object({
  dashboardPath: z.string().default(DEFAULT_DASHBOARD_PATH),
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

/**
 * Mount the `/finance` board route and its regeneration-status endpoint.
 *
 * @param ctx - the Cordis context this plugin registers into.
 * @param config - validated configuration with the dashboard file path.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const dashboardPath = config.dashboardPath ?? DEFAULT_DASHBOARD_PATH

  // Exact routes win over the `/finance` prefix below in the web server's
  // dispatch order, so the API path is safe to register first.
  ctx.webServer.register({
    kind: 'exact',
    path: '/finance/api/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      let mtime: string | null = null
      try {
        mtime = (await stat(dashboardPath)).mtime.toISOString()
      } catch {
        // Missing dashboard file reads as exists:false below.
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(JSON.stringify({ exists: mtime !== null, mtime }))
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
