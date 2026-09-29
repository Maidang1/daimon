import { join } from 'node:path'
import { defineConfig } from 'tsdown'

/**
 * Browser half build: plain CJS wrapped afterwards by scripts/wrap-client.mjs
 * into the dsh client module loader envelope. Only `react` (and its JSX
 * runtime) stays external — those module ids resolve from the loader's
 * baseline table at runtime, so they must never be bundled.
 *
 * `clean: false` keeps the host half's `lib/index.mjs` from the same outDir.
 */
export default defineConfig({
  entry: { client: join(process.cwd(), 'src/client/index.tsx') },
  outDir: join(process.cwd(), 'lib'),
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
})
