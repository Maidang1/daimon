// Minimal repro for the thermo-nuclear review. Imports the *built* lib (no source edits).
// Run: node .sessions-review-artifacts/repro.mjs
import {
  applyRefinement,
  emptyHarnessState,
  normalizeEntry,
} from '../packages/rlm-harness/lib/index.mjs'
import { parseHarnessState } from '../packages/rlm-harness-local/lib/index.mjs'

const NOW = '2026-09-29T00:00:00.000Z'
function line(k, v) { console.log(`  ${k}:`, JSON.stringify(v)) }

console.log('=== H1: applyRefinement composes repeated writes to the SAME id in one proposal? ===')
const before = emptyHarnessState()
const out = applyRefinement(before, {
  trigger: 't',
  evidence: '',
  outcome: '',
  entries: [
    { id: 'a', kind: 'memory', title: 'T1', content: 'C1', reference: { type: 'python', import: 'x' } },
    { id: 'a', kind: 'memory', title: 'T2', content: 'C2' }, // omits reference
  ],
}, NOW, 'ref-1')
const e = out.entries.memory['a']
line('title (expect T2)', e.title)
line('version (expect 2, got)', e.version)
line('reference (expect preserved {type:python,import:x}, got)', e.reference)
line('createdAt (expect stable)', e.createdAt)

console.log('')
console.log('=== H2: TS parseHarnessState vs Python-written snake_case file ===')
// Simulate what py/rlm/harness.py actually writes (dataclass asdict -> snake_case):
const pyFile = JSON.stringify({
  schema: 1,
  entries: {
    memory: {
      a: {
        id: 'a', kind: 'memory', title: 'T', content: 'C', path: 'general',
        scope: 'local', reference: {}, arguments: {}, metadata: {},
        source: 'agent',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-02-02T00:00:00.000Z',
        version: 7,
      },
    },
  },
  refinements: [
    { id: 'refine_0001', trigger: 't', changes: ['a'], evidence: '', outcome: '', created_at: '2020-01-01T00:00:00.000Z' },
  ],
})
const parsed = parseHarnessState(pyFile, 'local', NOW)
const pe = parsed.entries.memory['a']
line('entry.createdAt (want 2020-01-01, got)', pe.createdAt)
line('entry.updatedAt (want 2020-02-02, got)', pe.updatedAt)
line('entry.version (want 7, got)', pe.version)
line('event.createdAt (want 2020-01-01, got)', parsed.refinements[0].createdAt)
