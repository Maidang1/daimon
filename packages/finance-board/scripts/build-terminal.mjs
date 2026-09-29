/**
 * Bundle the self-hosted finance terminal SPA (src/terminal/) into
 * lib/terminal/ with esbuild. Unlike the legacy client bundle
 * (tsdown.client.config.ts + wrap-client.mjs, which targets the dsh client
 * module loader and externalizes react), this SPA is a plain static site:
 * react/react-dom are bundled in and there is no loader envelope. esbuild
 * resolves the `./xx.js` specifiers shared with src/client/ to their .ts/.tsx
 * sources, so the terminal components are reused verbatim.
 *
 * Runs after wrap-client.mjs in the package build chain; any failure stops
 * the build (non-zero exit), per the monorepo's fail-loud convention.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(pkgRoot, 'lib', 'terminal')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(pkgRoot, 'src', 'terminal', 'app.tsx')],
  outfile: join(outDir, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
})

copyFileSync(join(pkgRoot, 'src', 'terminal', 'index.html'), join(outDir, 'index.html'))

console.log('built lib/terminal/app.js + index.html')
