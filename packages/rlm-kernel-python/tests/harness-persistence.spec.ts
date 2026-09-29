/**
 * Persistence contract between the Python runtime and the TypeScript host:
 *
 * - the runtime writes camelCase timestamps so the host's parser keeps the real
 *   history instead of stamping the load clock;
 * - a legacy snake_case file written by an older runtime is still read by the
 *   host and by a fresh runtime reload;
 * - two processes mutating the same store concurrently through the runtime's
 *   public upsert cannot lose each other's entry: the per-file writer lock
 *   serializes each load/apply/commit transaction.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseHarnessState } from '@deepseek-ai/dsh-rlm-harness-local/src/store.ts'

const PYTHON = process.env.RLM_TEST_PYTHON ?? 'python3'
const RLM_PY = resolve(__dirname, '../py/rlm')
// dsh-atomic-write is a transitive dep of harness-local, not of this package;
// resolve it from there so the node holder script runs the real withFileLock.
const requireFromHarnessLocal = createRequire(resolve(__dirname, '../node_modules/@deepseek-ai/dsh-rlm-harness-local/package.json'))
const ATOMIC_WRITE_URL = requireFromHarnessLocal.resolve('@deepseek-ai/dsh-atomic-write')

const DRIVER = `
import sys, types, importlib.util
pkg = types.ModuleType('rlm'); pkg.__path__ = [sys.argv[3]]; sys.modules['rlm'] = pkg
def fresh(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m
fresh('rlm._harness_store', sys.argv[3] + '/_harness_store.py')
H = fresh('rlm.harness', sys.argv[3] + '/harness.py')
state = H.HarnessState(file_path=sys.argv[1], scope='local')
for title in sys.argv[2].split(','):
    state.upsert('memory', title, 'content-' + title)
`

function home(): string {
  return mkdtempSync(join(tmpdir(), 'rlm-harness-persistence-'))
}

function runPython(args: string[]): void {
  execFileSync(PYTHON, ['-c', DRIVER, ...args], { stdio: 'pipe' })
}

describe('Python runtime <-> TS host persistence contract', () => {
  it('writes camelCase timestamps the TS host parser preserves', () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    runPython([file, 'alpha', RLM_PY])
    const state = parseHarnessState(readFileSync(file, 'utf8'), 'local', '2026-09-29T00:00:00.000Z')
    const entry = state.entries.memory['alpha']
    expect(entry?.title).toBe('alpha')
    expect(typeof entry?.createdAt).toBe('string')
    expect(entry?.createdAt?.length).toBeGreaterThan(0)
    // Timestamps were not reset to the host's load clock.
    expect(entry?.createdAt).not.toBe('2026-09-29T00:00:00.000Z')
  })

  it('round-trips a state written in camelCase back through the runtime reload', () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    runPython([file, 'alpha', RLM_PY])
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written.entries.memory.alpha.createdAt).toBeDefined()
    expect(written.entries.memory.alpha.created_at).toBeUndefined()
    // A second runtime process adds another entry: it must reload the first
    // writer's entry rather than overwrite it.
    runPython([file, 'beta', RLM_PY])
    const state = parseHarnessState(readFileSync(file, 'utf8'), 'local', 'now')
    expect(Object.keys(state.entries.memory).sort()).toEqual(['alpha', 'beta'])
  })

  it('reads a legacy snake_case file the host parser preserves', () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    const legacy = {
      schema: 1,
      entries: {
        memory: {
          legacy: {
            id: 'legacy', kind: 'memory', title: 'legacy', content: 'old',
            created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-02-02T00:00:00.000Z',
            version: 7, reference: { type: 'python' },
          },
        },
      },
      refinements: [],
    }
    writeFileSync(file, JSON.stringify(legacy))
    const state = parseHarnessState(readFileSync(file, 'utf8'), 'local', 'now')
    const entry = state.entries.memory['legacy']
    expect(entry?.createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect(entry?.updatedAt).toBe('2020-02-02T00:00:00.000Z')
    expect(entry?.version).toBe(7)
  })

  it('two concurrent runtime writers do not lose each other\'s upsert', async () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    runPython([file, 'base', RLM_PY])
    const run = (title: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(PYTHON, ['-c', DRIVER, file, title, RLM_PY])
        child.on('error', reject)
        child.on('close', (code) => resolve(code))
      })
    const [a, b] = await Promise.all([run('alpha'), run('beta')])
    expect(a).toBe(0)
    expect(b).toBe(0)
    const state = parseHarnessState(readFileSync(file, 'utf8'), 'local', 'now')
    expect(Object.keys(state.entries.memory).sort()).toEqual(['alpha', 'base', 'beta'])
  }, 30000)

  it('waits while a TypeScript writer holds the shared .lock sibling', async () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    runPython([file, 'base', RLM_PY])
    // Node holds the same <file>.lock sibling dsh-atomic-write's withFileLock
    // creates; the Python runtime must contend on it instead of racing through.
    const holder = new Promise<number | null>((resolve, reject) => {
      const child = spawn('node', [
        '--input-type=module',
        '-e',
        `import { withFileLock } from ${JSON.stringify(ATOMIC_WRITE_URL)}
         await withFileLock(${JSON.stringify(file)}, async () => {
           await new Promise((r) => setTimeout(r, 1500))
         })`,
      ])
      child.on('error', reject)
      child.on('close', (code) => resolve(code))
    })
    const started = Date.now()
    // Give the holder a moment to grab the lock first.
    await new Promise((r) => setTimeout(r, 200))
    runPython([file, 'alpha', RLM_PY])
    const waited = Date.now() - started
    expect(await holder).toBe(0)
    // Python blocked for the duration the TS writer held the lock.
    expect(waited).toBeGreaterThanOrEqual(1200)
    const state = parseHarnessState(readFileSync(file, 'utf8'), 'local', 'now')
    expect(Object.keys(state.entries.memory).sort()).toEqual(['alpha', 'base'])
  }, 30000)

  it('refuses a stale explicit save() once another writer committed', () => {
    const dir = home()
    const file = join(dir, 'harness_state.json')
    runPython([file, 'base', RLM_PY])
    const barrier = join(dir, 'barrier')
    const driver = `
import sys, types, importlib.util, json, os
pkg = types.ModuleType("rlm"); pkg.__path__ = [sys.argv[3]]; sys.modules["rlm"] = pkg
def fresh(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); sys.modules[name] = m
    spec.loader.exec_module(m); return m
fresh("rlm._harness_store", sys.argv[3] + "/_harness_store.py")
fresh("rlm._harness_wire", sys.argv[3] + "/_harness_wire.py")
H = fresh("rlm.harness", sys.argv[3] + "/harness.py")
stale = H.HarnessState(file_path=sys.argv[1], scope="local")
stale.entries["memory"]["would_lost"] = H.HarnessEntry(
    id="would_lost", kind="memory", title="would_lost", content="x")
os.makedirs(sys.argv[2], exist_ok=True)
open(sys.argv[2] + "/ready", "w").close()
while not os.path.exists(sys.argv[2] + "/go"):
    pass
try:
    stale.save()
    print("NO_CONFLICT")
except H.HarnessStateConflictError:
    print("CONFLICT")
print("disk:", sorted(json.load(open(sys.argv[1]))["entries"]["memory"]))
`
    const out = new Promise<string>((resolve, reject) => {
      const child = spawn(PYTHON, ['-c', driver, file, barrier, RLM_PY])
      let buf = ''
      child.stdout.on('data', (d) => { buf += d })
      child.on('error', reject)
      child.on('close', () => resolve(buf))
    })
    // Wait until the driver has snapshotted the store, then commit 'beta' out
    // from under it, then release the driver to attempt its stale save().
    while (!existsSync(join(barrier, 'ready'))) { /* spin */ }
    runPython([file, 'beta', RLM_PY])
    mkdirSync(join(barrier, 'go'))
    return out.then((text) => {
      expect(text).toContain('CONFLICT')
      expect(text).toContain('beta')
      expect(text).not.toContain('would_lost')
    })
  }, 30000)
})
