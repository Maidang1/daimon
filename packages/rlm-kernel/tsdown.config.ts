import { defineConfig } from 'tsdown'

/**
 * Single ESM bundle emitted from the tsc output under `lib/types`.
 * `tsc` owns type declarations; this step only concatenates the runtime.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
