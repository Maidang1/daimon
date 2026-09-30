# dsh RLM kernel skills

Six Python skill packages for the CPython RLM kernel, ported from the
prime-agent bundled skills, plus the `finance` skill. Each host-bridge package
is a thin typed wrapper over the generic host bridge (`rlm.host_request`); all
state and effects live in the TypeScript host, answered by
`@deepseek-ai/dsh-rlm-bindings`:

| Import name | Wires | dsh host handlers |
|---|---|---|
| `goal` | `goal.get` / `goal.create` / `goal.complete` | `rlm-bindings/src/goal.ts` |
| `compact` | `compact.status` / `compact.run` | `rlm-bindings/src/compact.ts` |
| `refine` | `refine.status` / `refine.run` | `rlm-bindings/src/refine.ts` |
| `rlm_heartbeat` | `rlm_heartbeat.list` / `.create` / `.update` / `.delete` | `rlm-bindings/src/heartbeat.ts` |
| `agent_message` | `agent_message.send` | `rlm-bindings/src/message.ts` |
| `agent_observe` | `agent_observe.list` / `.get` / `.recent` | `rlm-bindings/src/observe.ts` |

`finance` is the exception: it is a daimon-native fund-analysis package
(forked from the touzi backend, now fully self-contained) — portfolio ledger,
fund quotes (天天基金 public APIs), LiCaiTong import, RBSA style regression,
NAV prediction pipeline, sector look-through, hotspot radar, and the board
renderer. ALL state lives under FINANCE_HOME (env override, default
`<repo>/dsh-home/finance/`); nothing touches the old touzi checkout. It needs
the kernel interpreter to be the miniconda Python (carrying
pandas/numpy/scipy/requests/dotenv), configured via `pythonBin` in the
profile patch; `import finance` itself stays dependency-free under any
interpreter. It also renders the self-contained dashboard HTML
(`finance.dashboard()` → `$FINANCE_HOME/dashboard.html`), which the
`finance-board` package serves at `/finance` on the dsh web server. See its
module docstring for the API map and the `LCT_COOKIE` caveat.

The host-bridge modules only import `host_request` and `emit` from the `rlm`
runtime that `py/rlm/` ships, so they have no third-party dependencies and work
in any interpreter that meets the kernel minimum (CPython 3.10+). `finance`'s
public API is async and stdlib-only at import time; the heavyweight
dependencies (pandas/scipy) load lazily inside the submodules that need them.

`quant` is the second daimon-native package: quantitative validation for the
QDII mutual-fund universe. Its `metrics`/`validation` modules are ported from
HKUDS/Vibe-Trading (MIT) — annualisation, full metric calculation, Monte
Carlo permutation test, bootstrap Sharpe CI, walk-forward analysis — and its
`engine` module is a native daily fund-NAV backtester (weights execute at the
next published NAV, per-lot redemption fees by calendar holding days, cash
remainder earns 0). Fund data comes from the `finance` package's 天天基金 NAV
fetch (`quant.fetch_nav` wraps `finance.rbsa.fund_nav`). `quant.ledger` is an
append-only hypothesis ledger at `$FINANCE_HOME/quant_hypotheses.jsonl` with
conservative auto-resolution (only explicit `nav_above`/`nav_below` checks
against a known NAV), and `quant.evidence` is an advisory provenance
self-check for write-ups. The public API is sync and stdlib-only at import
time; see the package docstring for the API map.

## Use inside a dsh kernel (no install)

This directory ships inside the npm package (`py/**/*.py`). Add it to the
child interpreter's module search path, either through the provider config:

```yaml
# cordis.yml
plugins:
  rlm-kernel-python:
    pythonPath:
      - /absolute/path/to/packages/rlm/rlm-kernel-python/py/skills
```

or per `acquire`:

```ts
await ctx.rlmKernel.acquire(agent, { pythonPath: [skillsDir] })
```

Then every cell can `import goal` (and the other skills, e.g. `import finance`) directly.

## Install into a host Python (pip)

From a repository checkout, one command installs all import packages:

```sh
python3 -m pip install packages/rlm/rlm-kernel-python/py/skills
```

Use this when the kernel runs with a host interpreter whose environment
should resolve the skills without a `pythonPath` entry, or when embedding the
skills in another Python application that provides a compatible `rlm` module.

## CLI entry points

Unlike the prime-agent packaging, this distribution registers no console
scripts: the kernel imports the modules directly, and `rlm.skill.cli` needs
`tyro`, which the kernel does not require. Run the documented async functions
from a cell instead.
