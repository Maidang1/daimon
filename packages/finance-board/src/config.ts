/**
 * Configuration for the finance 终端 routes.
 *
 * Every default is defined exactly once, in `DEFAULTS`. The schemastery
 * `Config` schema (what cordis parses from the profile) and `resolveConfig`
 * (what `apply` actually runs on) both read those constants, so there is no
 * second copy to drift. Defaults are machine-independent: paths are resolved
 * from this package's location in the monorepo, and the interpreter is
 * resolved through `$PATH` so a fresh clone works without edits.
 *
 * @module @deepseek-ai/dsh-finance-board/config
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** Monorepo root, resolved from this package's `lib/` output. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Machine-independent defaults. `financeHome` follows `DSH_HOME` when the
 * host sets it (the dsh CLI does), otherwise it falls back to the repo's own
 * `dsh-home/finance`. `pythonBin` is a `$PATH` name rather than an absolute
 * path: which interpreter carries pandas/numpy/scipy is a per-machine fact,
 * and a wrong absolute default fails far away from its cause.
 */
export const DEFAULTS = {
  /** Root of all finance state (`dashboard.html` + `state/` live under it). */
  financeHome: process.env.FINANCE_HOME ?? join(REPO_ROOT, 'dsh-home', 'finance'),
  /** Interpreter used for the job/ops runners; must carry the finance deps. */
  pythonBin: process.env.FINANCE_PYTHON_BIN ?? process.env.PYTHON_BIN ?? 'python3',
  /** `<repo>/packages/rlm-kernel-python/py/skills`, where the `finance` package lives. */
  skillsPath: fileURLToPath(new URL('../../rlm-kernel-python/py/skills', import.meta.url)),
  /** `<pkg>/lib/terminal`: the esbuild output of `src/terminal/`. */
  terminalDist: fileURLToPath(new URL('./terminal', import.meta.url)),
} as const

/** Configuration accepted by the plugin (all fields optional). */
export interface Config {
  /** Absolute path of the FINANCE_HOME state root. */
  financeHome?: string
  /** Absolute path of the dashboard HTML served at `/finance`. Defaults to `<financeHome>/dashboard.html`. */
  dashboardPath?: string
  /** Python interpreter used for the job/ops runners. */
  pythonBin?: string
  /** Directory containing the `finance` Python skill package. */
  skillsPath?: string
  /** Directory holding the built terminal SPA (index.html + app.js). */
  terminalDist?: string
}

/** Validated configuration, as cordis hands it to `apply`. */
export const Config: z<Config> = z.object({
  financeHome: z.string().default(DEFAULTS.financeHome),
  // Unset means "derive from financeHome" — deliberately not defaulted to '',
  // so an empty string is never a nullable mode. schemastery objects tolerate
  // an absent key, which is exactly "optional" here.
  dashboardPath: z.string(),
  pythonBin: z.string().default(DEFAULTS.pythonBin),
  skillsPath: z.string().default(DEFAULTS.skillsPath),
  terminalDist: z.string().default(DEFAULTS.terminalDist),
})

/** Configuration with every field resolved — the form `apply` runs on. */
export interface ResolvedConfig {
  financeHome: string
  dashboardPath: string
  pythonBin: string
  skillsPath: string
  terminalDist: string
}

/**
 * Resolve a (possibly partial) config into the fully-defaulted form.
 *
 * The single place defaults are applied. Production reaches here through the
 * schema above; tests and direct callers reach here with a partial object.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const financeHome = config.financeHome ?? DEFAULTS.financeHome
  return {
    financeHome,
    dashboardPath: config.dashboardPath || join(financeHome, 'dashboard.html'),
    pythonBin: config.pythonBin ?? DEFAULTS.pythonBin,
    skillsPath: config.skillsPath ?? DEFAULTS.skillsPath,
    terminalDist: config.terminalDist ?? DEFAULTS.terminalDist,
  }
}
