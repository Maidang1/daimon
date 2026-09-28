import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/**
 * Shared build for all vendored packages under `packages/*`, invoked per
 * package as `tsdown -c ../../tsdown.config.ts`. `-c` makes tsdown take the
 * config file's directory as root, so entry/outDir are pinned to the
 * process cwd (the package directory) explicitly.
 *
 * Single stage from `src`: tsdown emits both the runtime and the type
 * declarations. Everything `@deepseek-ai/*` stays unbundled — these are
 * libraries, not apps, so runtime deps belong to each package's declared
 * `dependencies`. Inlining them would also duplicate branded types
 * (`SessionId` & friends use a `unique symbol` per module instance), which
 * breaks nominal type identity across packages.
 */
export default defineConfig({
  entry: [join(process.cwd(), 'src/index.ts')],
  outDir: join(process.cwd(), 'lib'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
