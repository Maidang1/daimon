/**
 * The finance job store: one JSON record per spawned action under
 * `<financeHome>/state/`, plus the two child-process entry points.
 *
 * The record format is a *file protocol* shared by both paths — the child
 * writes `{action, status, ...}` and the host reads it back. That is the only
 * result channel in this package (see `python-actions.ts`).
 *
 * @module @deepseek-ai/dsh-finance-board/jobs
 */

import { spawn } from 'node:child_process'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ResolvedConfig } from './config.js'
import { JOB_RUNNER, OPS_RUNNER, type JobAction } from './python-actions.js'
import { isJobAction, type OpsRequest } from './schemas.js'

/** Fields of a job result the UI is allowed to read. */
export interface JobResult {
  /** Number of funds the pipeline fitted. */
  funds?: number
  /** One-line summary the job wrote for the artifact header. */
  summary?: string
}

/** One job record, as the host reports it. */
export interface JobRecord {
  id: string
  action: JobAction
  status: 'running' | 'success' | 'error'
  /** When this record last changed (ISO) — the client announces completions on it. */
  updatedAt: string
  error?: string
  result?: JobResult
}

/**
 * How long a `running` record still blocks its action.
 *
 * A record reaches a terminal state only if its child runs to completion, so
 * a SIGKILL/OOM/timeout would otherwise leave that action blocked by a 409
 * *forever*. The process has no exit timeout, so wall-clock age is the only
 * signal available; older-than-this records are still listed (the operator
 * sees the truth) but no longer lock the action.
 */
const STALE_RUN_MS = 30 * 60_000

/** Record prefix; `ui_job_<id>.json`. */
const JOB_PREFIX = 'ui_job_'

/** Atomically write JSON: a uniquely-named temp file, then rename.
 *
 * A fixed `<path>.tmp` name would let two concurrent writers interleave on
 * the same temp file (the RLM kernel and this plugin are separate OS
 * processes sharing one state dir), so the temp name carries the writer's id.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value))
    await rename(tmp, path)
  } catch (err) {
    try {
      await rm(tmp, { force: true })
    } catch {
      // best effort
    }
    throw err
  }
}

/** Read one record file and recover the id the runner does not persist. */
async function readRawRecord(path: string, file: string): Promise<Omit<JobRecord, 'updatedAt'> | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    // Vanished between readdir and read — nothing to report.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[finance-board] skipping corrupt job file ${file}`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    console.warn(`[finance-board] skipping non-object job file ${file}`)
    return null
  }
  const rec = parsed as Record<string, unknown>
  if (!isJobAction(rec.action) || typeof rec.status !== 'string') {
    console.warn(`[finance-board] skipping job file ${file} with unknown action/status`)
    return null
  }
  // The Python runner rewrites the status file without the id — recover it
  // from the filename so ordering and frontend dedup keep working.
  return {
    id: typeof rec.id === 'string' && rec.id ? rec.id : file.slice(JOB_PREFIX.length, -'.json'.length),
    action: rec.action,
    status: rec.status as JobRecord['status'],
    error: typeof rec.error === 'string' ? rec.error : undefined,
    result: rec.result as JobResult | undefined,
  }
}

/**
 * Every job record, newest first.
 *
 * The files are independent, so they are read concurrently — the previous
 * serial `for await` put a sequential read + stat on every `/status` poll.
 * Ordering is by mtime rather than id: finished records carry no reliable
 * timestamp of their own, and the seeded id may be gone.
 */
export async function listJobs(jobsDir: string): Promise<JobRecord[]> {
  let files: string[]
  try {
    files = await readdir(jobsDir)
  } catch {
    return []
  }
  const entries = await Promise.all(
    files
      .filter(file => file.startsWith(JOB_PREFIX) && file.endsWith('.json'))
      .map(async file => {
        const path = join(jobsDir, file)
        const [rec, mtime] = await Promise.all([readRawRecord(path, file), stat(path).then(s => s.mtimeMs, () => 0)])
        // A vanished file is not a job; a phantom would sort to 1970.
        return rec && mtime > 0 ? { rec, mtime } : null
      }),
  )
  return entries
    .filter((entry): entry is { rec: Omit<JobRecord, 'updatedAt'>; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ rec, mtime }) => ({ ...rec, updatedAt: new Date(mtime).toISOString() }))
}

/** The running record blocking `action`, if any (see `STALE_RUN_MS`). */
export function activeRun(jobs: JobRecord[], action: JobAction): JobRecord | undefined {
  const now = Date.now()
  const running = jobs.filter(job => job.action === action && job.status === 'running')
  const live = running.find(job => now - Date.parse(job.updatedAt) < STALE_RUN_MS)
  for (const job of running) {
    if (job !== live) console.warn(`[finance-board] ignoring stale running record ${job.id} for ${action}`)
  }
  return live
}

/** Environment the runners need: where finance state lives and where `finance` is importable. */
export function runnerEnv(config: ResolvedConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FINANCE_HOME: config.financeHome,
    PYTHONPATH: [config.skillsPath, process.env.PYTHONPATH].filter(Boolean).join(':'),
  }
}

/**
 * Spawn the one-shot runner for `action` and return its record.
 *
 * The record is pre-seeded so a slow interpreter startup still reads as
 * running; the child rewrites it as it progresses.
 */
export async function spawnJob(config: ResolvedConfig, jobsDir: string, action: JobAction): Promise<JobRecord> {
  const id = randomUUID()
  const statusPath = join(jobsDir, `${JOB_PREFIX}${id}.json`)
  const job: JobRecord = { id, action, status: 'running', updatedAt: new Date().toISOString() }
  await writeJsonAtomic(statusPath, job).catch(() => {})
  const child = spawn(config.pythonBin, ['-c', JOB_RUNNER, action, statusPath], {
    env: runnerEnv(config),
    stdio: 'ignore',
  })
  child.on('error', err => {
    const failed: JobRecord = { ...job, status: 'error', error: String(err) }
    void writeJsonAtomic(statusPath, failed).catch(() => {})
  })
  return job
}

/** What `POST /finance/api/ops` answers. */
export type OpsOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number; error: string }

/**
 * Record one buy/sell synchronously through the finance skill.
 *
 * The request goes over stdin as JSON and the result comes back through the
 * shared file protocol; the temp result file is removed either way.
 */
export async function runOps(config: ResolvedConfig, jobsDir: string, req: OpsRequest): Promise<OpsOutcome> {
  const resultPath = join(jobsDir, `ui_ops_${randomUUID()}.json`)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(config.pythonBin, ['-c', OPS_RUNNER, resultPath], {
      env: runnerEnv(config),
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch (err) {
    return { ok: false, code: 502, error: String(err) }
  }

  const stderr = new Promise<string>(resolve => {
    const chunks: Buffer[] = []
    child.stderr?.on('data', chunk => chunks.push(chunk as Buffer))
    child.on('error', err => resolve(String(err)))
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
  child.stdin?.end(JSON.stringify(req))
  const diagnostics = await stderr

  const payload = await readFile(resultPath, 'utf-8')
    .then(text => JSON.parse(text) as unknown)
    .catch(() => null)
  await rm(resultPath, { force: true })

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, code: 502, error: `python runner gave no result: ${diagnostics.slice(-300)}` }
  }
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') {
    return { ok: false, code: 502, error: record.error }
  }
  return { ok: true, body: record }
}
