"""quant skill: quantitative validation for daimon's QDII fund universe.

Backtest and stress-test daily target-weight strategies on mutual-fund NAV
series, and keep an honest record of what was claimed and what came true.
Metrics/validation are ported from HKUDS/Vibe-Trading (MIT); the fund
backtester, hypothesis ledger, and evidence helper are daimon-native. Data
comes from the ``finance`` package's 天天基金 NAV fetch — this package never
fetches at import time and pandas/numpy load lazily per call.

Quick start inside a kernel cell (all sync, no await needed):

    import quant
    nav = quant.fetch_nav("008401", "018036")        # DataFrame of daily NAVs
    w = nav.assign(**{c: 1.0 / len(nav.columns) for c in nav.columns})[
        ["008401", "018036"]]                        # example: equal weight
    # or build any date-indexed target-weight DataFrame yourself
    result = quant.backtest(w, nav, validation={"monte_carlo": {},
                        "bootstrap": {}, "walk_forward": {}})
    result["metrics"]                                # sharpe / max_dd / win_rate / ...
    result["validation"]                             # MC p-values, Sharpe CI, walk-forward

API map:
- ``quant.backtest(weights, nav, *, initial_cash=1e6, subscribe_fee=0.0015,
  redeem_fee_schedule=((7, 0.015), (30, 0.005), (None, 0.0)),
  validation=None) -> dict`` — daily fund backtester (engine.py). Weights row
  at date t executes at date t+1's NAV (no same-day fills); rows need not sum
  to 1, the remainder stays in cash. Redemption fees are per-lot by calendar
  holding days, charged on sell notional. Returns {"equity", "trades",
  "positions", "metrics", "validation", "total_fees"}. Raises ValueError on
  duplicate dates, weights outside the NAV calendar, negative/non-finite
  values.
- ``quant.fetch_nav(*codes) -> DataFrame`` — daily NAV from 天天基金 via
  ``finance.rbsa.fund_nav`` (network; lazy import).
- ``quant.validate(equity, trades, initial_cash, *, monte_carlo=None,
  bootstrap=None, walk_forward=None) -> dict`` — run the validation trio on an
  equity curve + completed trades (validation.py).
- ``quant.metrics`` — annualisation, returns, win-rate, turnover, and
  ``calc_metrics`` (ported from Vibe-Trading, MIT).
- ``quant.validation`` — ``monte_carlo_test`` / ``bootstrap_sharpe_ci`` /
  ``walk_forward_analysis`` / ``run_validation`` / ``to_jsonable`` (ported,
  same math and default seeds).
- ``quant.ledger`` — hypothesis ledger (ledger.py): add/resolve/open/due/get/
  accuracy/review on an append-only JSONL at
  ``$FINANCE_HOME/quant_hypotheses.jsonl``. review() auto-resolves ONLY
  entries with an explicit ``check={"type": "nav_above"|"nav_below",
  "level": float}`` and a resolvable NAV — it never guesses.
- ``quant.evidence.new_run()`` — advisory provenance self-check: record
  fingerprints of produced data, then check that the values you cite in a
  write-up actually appear in what you recorded. Not an enforcement gate.

The hypothesis ledger resolves FINANCE_HOME exactly like ``finance._state``
(env override, default ``<daimon>/dsh-home/finance``). ``quant`` may import
``finance`` lazily; ``finance`` never imports ``quant``.
"""

from __future__ import annotations

import importlib
from typing import Any

_SUBMODULES = ("metrics", "validation", "engine", "ledger", "evidence")

_MODULE_EXPORTS = {
    "engine": ("backtest", "fetch_nav"),
    "ledger": ("add", "resolve", "open", "due", "get", "accuracy", "review"),
    "evidence": ("new_run", "RunEvidence"),
    "metrics": ("TradeRecord", "calc_metrics", "calc_bars_per_year",
                "effective_bars_per_year", "bar_returns", "buy_and_hold_return",
                "win_rate_and_stats", "by_symbol_stats", "by_exit_reason_stats",
                "calc_turnover_series"),
    "validation": ("monte_carlo_test", "bootstrap_sharpe_ci",
                   "walk_forward_analysis", "run_validation", "to_jsonable"),
}

_NAME_TO_MODULE = {name: mod for mod, names in _MODULE_EXPORTS.items() for name in names}


def validate(equity: Any, trades: Any, initial_capital: float, *,
             monte_carlo: dict | None = None,
             bootstrap: dict | None = None,
             walk_forward: dict | None = None) -> dict:
    """Run the validation trio on an equity curve and completed trades.

    Each selector is an optional kwargs dict (e.g. ``monte_carlo=
    {"n_simulations": 500}``); pass the key to enable with defaults. The
    annualisation factor is measured from the equity curve's own calendar
    span, so every sub-report agrees.
    """
    validation: dict = {}
    if monte_carlo is not None:
        validation["monte_carlo"] = monte_carlo
    if bootstrap is not None:
        validation["bootstrap"] = bootstrap
    if walk_forward is not None:
        validation["walk_forward"] = walk_forward
    if not validation:
        raise ValueError("pass at least one of monte_carlo=/bootstrap=/walk_forward=")
    from .validation import run_validation

    return run_validation({"validation": validation}, equity, trades, initial_capital,
                          bars_per_year=None)


def __getattr__(name: str) -> Any:
    """Lazy re-exports: ``import quant`` never pulls in pandas/numpy."""
    if name in _SUBMODULES:
        module = importlib.import_module(f".{name}", __package__)
        globals()[name] = module
        return module
    module_name = _NAME_TO_MODULE.get(name)
    if module_name is not None:
        value = getattr(importlib.import_module(f".{module_name}", __package__), name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "backtest", "fetch_nav", "validate",
    "metrics", "validation", "engine", "ledger", "evidence",
    "add", "resolve", "open", "due", "get", "accuracy", "review",
    "new_run", "RunEvidence",
    "TradeRecord", "calc_metrics", "calc_bars_per_year",
    "effective_bars_per_year", "bar_returns", "buy_and_hold_return",
    "win_rate_and_stats", "by_symbol_stats", "by_exit_reason_stats",
    "calc_turnover_series",
    "monte_carlo_test", "bootstrap_sharpe_ci", "walk_forward_analysis",
    "run_validation", "to_jsonable",
]
