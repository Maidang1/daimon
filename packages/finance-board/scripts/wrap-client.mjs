/**
 * Wrap the CJS client bundle into the dsh client module loader envelope
 * (`window.__ModuleLoader__.load({ id, factory })`), the shape every shipped
 * dsh-client-ui-* bundle takes. Runs after tsdown.client.config.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../lib/client.js', import.meta.url)
const body = readFileSync(file, 'utf8')

if (body.includes('__ModuleLoader__')) {
  console.log('lib/client.js already wrapped, skipping')
  process.exit(0)
}

const wrapped = `window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-finance-board",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`
writeFileSync(file, wrapped)
console.log(`wrapped lib/client.js (${wrapped.length} bytes)`)
