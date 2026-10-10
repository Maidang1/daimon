/**
 * dsh-learning-hub — host half.
 *
 * Serves the learning/ content directory (chapters, quizzes, diagrams,
 * progress) to the browser half over a small JSON HTTP API, and owns all
 * writes (progress toggles, quiz submissions + log). Paths are confined to
 * the configured root; bodies are capped. The webserver offers no server-level
 * authentication, so this plugin assumes a loopback deployment (dsh web's
 * default bind) — do not expose the listener on a network interface.
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer']

const require = createRequire(import.meta.url)
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const BODY_CAP = 64 * 1024
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_CAP) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/** Strip grading fields so answers never reach the browser. */
function sanitizeQuiz(q) {
  return { id: q.id, chapter: q.chapter, question: q.question, options: q.options }
}

export function apply(ctx, config) {
  const root = path.resolve(config?.root ?? path.join(process.cwd(), 'learning'))
  const quizLog = path.join(root, 'quiz-log.jsonl')

  const readJson = async (file, fallback) => {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
  }

  const routes = {
    'GET /api/progress': async (_req, res) => {
      sendJson(res, 200, await readJson(path.join(root, 'progress.json'), { chapters: [] }))
    },
    'POST /api/progress/toggle': async (req, res) => {
      const body = await readBody(req)
      const file = path.join(root, 'progress.json')
      const progress = await readJson(file, { version: 1, chapters: [] })
      const ch = progress.chapters.find((c) => c.id === body.chapterId)
      if (!ch) return sendJson(res, 404, { error: 'unknown chapter' })
      ch.completed = Boolean(body.completed)
      await writeFile(file, JSON.stringify(progress, null, 2) + '\n')
      sendJson(res, 200, progress)
    },
    'POST /api/progress/level': async (req, res) => {
      const body = await readBody(req)
      if (!['beginner', 'advanced'].includes(body.level)) return sendJson(res, 400, { error: 'bad level' })
      const file = path.join(root, 'progress.json')
      const progress = await readJson(file, { version: 1, chapters: [] })
      progress.learnerLevel = body.level
      await writeFile(file, JSON.stringify(progress, null, 2) + '\n')
      sendJson(res, 200, progress)
    },
    'GET /api/chapters': async (_req, res) => {
      let names = []
      try { names = await readdir(path.join(root, 'chapters')) } catch { /* empty */ }
      sendJson(res, 200, names.filter((n) => n.endsWith('.md')).sort())
    },
    'GET /api/quiz': async (_req, res, url) => {
      const chapter = url.searchParams.get('chapter') ?? ''
      if (!SAFE_NAME.test(chapter)) return sendJson(res, 400, { error: 'bad chapter' })
      const quiz = await readJson(path.join(root, 'quizzes', `${chapter}.json`), [])
      sendJson(res, 200, quiz.map(sanitizeQuiz))
    },
    'POST /api/quiz/submit': async (req, res) => {
      const body = await readBody(req)
      if (typeof body.quizId !== 'string' || !Number.isSafeInteger(body.choice)) {
        return sendJson(res, 400, { error: 'bad submission' })
      }
      let names = []
      try { names = await readdir(path.join(root, 'quizzes')) } catch { /* empty */ }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const quiz = await readJson(path.join(root, 'quizzes', name), [])
        const found = quiz.find((q) => q.id === body.quizId)
        if (!found) continue
        const correct = body.choice === found.answer
        await mkdir(root, { recursive: true })
        await appendFile(quizLog, JSON.stringify({
          ts: new Date().toISOString(), quizId: found.id, chapter: found.chapter,
          choice: body.choice, correct,
        }) + '\n')
        return sendJson(res, 200, { correct, explanation: found.explanation, answer: found.answer })
      }
      sendJson(res, 404, { error: 'unknown quizId' })
    },
    'GET /api/quiz/log': async (_req, res) => {
      let text = ''
      try { text = await readFile(quizLog, 'utf8') } catch { /* empty */ }
      const entries = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      sendJson(res, 200, entries)
    },
    'GET /api/diagrams': async (_req, res) => {
      let names = []
      try { names = await readdir(path.join(root, 'diagrams')) } catch { /* empty */ }
      sendJson(res, 200, names.filter((n) => n.endsWith('.mmd')).sort())
    },
    'GET /api/diagram': async (_req, res, url) => {
      const name = url.searchParams.get('name') ?? ''
      if (!SAFE_NAME.test(name) || !name.endsWith('.mmd')) return sendJson(res, 400, { error: 'bad name' })
      try {
        sendJson(res, 200, { name, source: await readFile(path.join(root, 'diagrams', name), 'utf8') })
      } catch { sendJson(res, 404, { error: 'not found' }) }
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/__learning-hub',
    async handler(req, res) {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice('/__learning-hub'.length) || '/'
        if (sub.startsWith('/vendor/')) {
          const name = path.basename(sub)
          if (!SAFE_NAME.test(name) || !name.endsWith('.js')) return sendJson(res, 400, { error: 'bad asset' })
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'immutable' })
          createReadStream(path.join(PLUGIN_DIR, 'vendor', name)).pipe(res)
          return
        }
        const route = routes[`${req.method} ${sub}`]
        if (!route) return sendJson(res, 404, { error: 'not found' })
        await route(req, res, url)
      } catch (error) {
        ctx.logger?.warn?.('learning-hub request failed', error)
        if (!res.headersSent) sendJson(res, 400, { error: String(error?.message ?? error) })
        else res.destroy()
      }
    },
  }), 'learning-hub: http routes')

  ctx.logger?.info?.('learning-hub serving %s at /__learning-hub', root)
}
