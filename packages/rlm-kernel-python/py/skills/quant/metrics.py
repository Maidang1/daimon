"""Backtest metrics, ported from HKUDS/Vibe-Trading (MIT).

Source: ``agent/backtest/metrics.py`` in the Vibe-Trading checkout. The
per-source market tables (``_TRADING_DAYS`` / ``_BARS_PER_DAY``) are dropped:
daimon's universe is daily NAV of QDII mutual funds, so daily bars annualise
at 252 and weekly/monthly bars keep their calendar-period counts.

Numeric edge-case guards from the original are preserved: ddof=1 small-sample
guards, wipeout annualisation, the high-water mark seeded at ``initial_cash``,
and non-finite return handling.

This module is also the canonical home of two shared statistics: every Sharpe
in the package (headline ``calc_metrics``, bootstrap CI, Monte Carlo path
metrics) is ``sharpe_ratio``, and every drawdown is ``max_drawdown``, so a
report can never show two different values for the same named number. That
deliberately deviates from the Vibe-Trading original, whose validation module
computed Sharpe with numpy's population std (ddof=0) against this module's
sample std (ddof=1).

pandas/numpy are imported lazily inside functions; this module is stdlib-only
at import time.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

# Weekly and monthly bars count calendar periods, whatever the market's
# trading days: every week and every month holds one bar.
_CALENDAR_BARS_PER_YEAR = {"1W": 52, "1M": 12}

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TradeRecord:
    """A completed round-trip trade.

    Args:
        symbol: Fund code / instrument identifier.
        entry_price: Entry execution price (NAV).
        exit_price: Exit execution price (NAV).
        entry_time: Entry timestamp.
        exit_time: Exit timestamp.
        size: Shares bought across the whole round trip.
        pnl: Realised profit/loss in cash terms, net of fees.
        pnl_pct: Realised P&L as a fraction of total entry cost.
        exit_reason: Why the position closed ("rebalance" / "final").
        holding_bars: Bar-index span held between entry and exit.
        commission: Total fees paid across the round trip.
    """

    symbol: str
    entry_price: float
    exit_price: float
    entry_time: "Any"  # pd.Timestamp
    exit_time: "Any"  # pd.Timestamp
    size: float
    pnl: float
    pnl_pct: float
    exit_reason: str
    holding_bars: float
    commission: float


def calc_bars_per_year(interval: str = "1D", source: Optional[str] = None) -> int:
    """Bars per year for annualisation.

    Args:
        interval: Bar size. ``1D`` → 252 trading days; ``1W``/``1M`` count
            calendar periods (52 / 12), case-insensitive. Anything else raises
            ValueError — there is no per-source table to fall back to.
        source: Accepted for signature compatibility; ignored.

    Returns:
        Bars per year.
    """
    token = str(interval or "1D").strip()
    if token in ("1M",):
        return _CALENDAR_BARS_PER_YEAR["1M"]
    folded = token.lower()
    if folded == "1w":
        return _CALENDAR_BARS_PER_YEAR["1W"]
    if folded in ("1d", "day", "daily"):
        return 252
    raise ValueError(f"unsupported interval for fund NAV backtests: {interval!r}")


def effective_bars_per_year(index: Any, default: int = 252) -> int:
    """Bars per elapsed calendar year observed on ``index``.

    The fund-NAV convention: bars observed divided by calendar years elapsed,
    so a curve spanning markets or holidays annualises from its own span
    instead of an assumed 252.

    Args:
        index: Datetime-like index of the series being annualised.
        default: Returned when the span cannot be measured (empty index, or an
            index whose difference carries no ``days``).

    Returns:
        Effective bars per year. A span shorter than one calendar day counts as
        one year, matching how a single-bar curve annualises to its own return.
    """
    n = len(index)
    if n == 0:
        return default
    try:
        diff = index[-1] - index[0]
    except (IndexError, TypeError):
        return default
    calendar_days = diff.days if hasattr(diff, "days") else 0
    years = calendar_days / 365.25 if calendar_days > 0 else 1.0
    return int(n / years) if years > 0 else default


def bar_returns(close: Any, *, label: str = "") -> Any:
    """Per-bar simple returns, defined only where the prior price is positive.

    ``close.pct_change()`` silently assumes ``price[t-1] > 0``. Near a zero
    prior price an ordinary absolute move reads as an enormous percentage move
    and the next bar can print ``inf``, which ``fillna`` does not neutralise
    and which collapses ``(1 + r).prod()`` to ``nan``. A return is therefore
    defined only when the previous price is finite and strictly positive;
    otherwise it is reported as ``0.0``. For an all-positive series this is
    identical to ``pct_change().fillna(0.0)``.

    The prior price is carried forward across gaps, matching what a position
    held through a publication gap (e.g. a QDII fund skipping a holiday)
    actually earned; the whole across-gap move is attributed to the resumed
    bar.

    Args:
        close: Raw price ``Series`` or per-symbol ``DataFrame``.
        label: Optional name used when warning about undefined bars.

    Returns:
        Returns aligned to ``close``, with the first bar ``0.0``.
    """
    import numpy as np

    # ffill *then* shift: the divisor is the last known price, not NaN.
    prev = close.ffill().shift(1)
    # ``inf > 0`` is True, so finiteness has to be asserted, not assumed.
    usable_prev = np.isfinite(prev) & (prev > 0)
    positive_prev = prev.where(usable_prev)

    undefined = int((prev.notna() & ~usable_prev).to_numpy().sum())
    if undefined:
        # Silence is the hazard: a wrong return is a wrong reported number,
        # not a crash, so say it defaulted.
        _log.warning(
            "%s: %d bar(s) follow a non-positive or non-finite prior price; "
            "their return is undefined and reported as 0.0",
            label or "returns",
            undefined,
        )

    ret = close / positive_prev - 1
    return ret.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def buy_and_hold_return(close: Any) -> Optional[float]:
    """Total buy-and-hold return as a price relative, not a compounded product.

    ``(1 + pct_change()).prod() - 1`` telescopes to ``P_end / P_start - 1``
    only while every price is positive; near-zero prices make the product
    diverge from what a held position actually earned. This computes the price
    relative directly.

    Args:
        close: Raw price series, already ``dropna()``-ed.

    Returns:
        Total return, or ``None`` when no honest percentage exists (entry
        price not strictly positive and finite, or final price non-finite).
    """
    import numpy as np

    if len(close) < 2:
        return None
    first = float(close.iloc[0])
    last = float(close.iloc[-1])
    # ``inf > 0`` is True, so an infinite entry price would otherwise yield a
    # clean-looking -100% instead of "no honest percentage exists".
    if not (np.isfinite(first) and first > 0) or not np.isfinite(last):
        return None
    return last / first - 1.0


def win_rate_and_stats(trades: List[TradeRecord]) -> Dict[str, float]:
    """Win rate and P&L statistics from completed trades.

    Args:
        trades: Completed round-trip trades.

    Returns:
        Dict with win_rate, profit_loss_ratio, max_consecutive_loss,
        avg_holding_bars, profit_factor.
    """
    import numpy as np

    if not trades:
        return {
            "win_rate": 0.0,
            "profit_loss_ratio": 0.0,
            "max_consecutive_loss": 0,
            "avg_holding_bars": 0.0,
            "profit_factor": 0.0,
        }

    wins = [t.pnl for t in trades if t.pnl > 0]
    losses = [t.pnl for t in trades if t.pnl < 0]

    win_rate = len(wins) / len(trades)

    avg_win = float(np.mean(wins)) if wins else 0.0
    avg_loss = abs(float(np.mean(losses))) if losses else 1e-10
    profit_loss_ratio = avg_win / avg_loss if avg_loss > 1e-10 else 0.0

    gross_profit = sum(wins) if wins else 0.0
    gross_loss = abs(sum(losses)) if losses else 1e-10
    profit_factor = gross_profit / gross_loss if gross_loss > 1e-10 else 0.0

    max_consec = 0
    cur_consec = 0
    for t in trades:
        if t.pnl < 0:
            cur_consec += 1
            max_consec = max(max_consec, cur_consec)
        else:
            cur_consec = 0

    hold_bars = [t.holding_bars for t in trades if t.holding_bars > 0]
    avg_holding = float(np.mean(hold_bars)) if hold_bars else 0.0

    return {
        "win_rate": win_rate,
        "profit_loss_ratio": round(profit_loss_ratio, 4),
        "max_consecutive_loss": max_consec,
        "avg_holding_bars": round(avg_holding, 1),
        "profit_factor": round(profit_factor, 4),
    }


def by_symbol_stats(trades: List[TradeRecord]) -> Dict[str, Dict[str, Any]]:
    """Per-symbol trade statistics.

    Args:
        trades: Completed round-trip trades.

    Returns:
        {symbol: {count, win_rate, total_pnl, avg_pnl}}.
    """
    import numpy as np

    groups: Dict[str, list] = {}
    for t in trades:
        groups.setdefault(t.symbol, []).append(t)

    result = {}
    for sym, sym_trades in groups.items():
        pnls = [t.pnl for t in sym_trades]
        wins = [p for p in pnls if p > 0]
        result[sym] = {
            "count": len(sym_trades),
            "win_rate": round(len(wins) / len(sym_trades), 4) if sym_trades else 0.0,
            "total_pnl": round(sum(pnls), 2),
            "avg_pnl": round(float(np.mean(pnls)), 2) if pnls else 0.0,
        }
    return result


def by_exit_reason_stats(trades: List[TradeRecord]) -> Dict[str, Dict[str, Any]]:
    """Per-exit-reason trade statistics.

    Args:
        trades: Completed round-trip trades.

    Returns:
        {reason: {count, total_pnl}}.
    """
    groups: Dict[str, list] = {}
    for t in trades:
        groups.setdefault(t.exit_reason, []).append(t)

    result = {}
    for reason, reason_trades in groups.items():
        pnls = [t.pnl for t in reason_trades]
        result[reason] = {
            "count": len(reason_trades),
            "total_pnl": round(sum(pnls), 2),
        }
    return result


def calc_turnover_series(positions: Any) -> Any:
    """Per-bar weight-implied portfolio turnover from a position frame.

    Turnover for a bar is ``0.5 * sum_i |w_{t,i} - w_{t-1,i}|``, so a full
    rotation from one fund to another counts as 1.0. The first bar's turnover
    is ``0.5 * sum_i |w_{0,i}|``, treating the initial allocation as entry from
    cash. Turnover is measured on the weight frame the caller supplies; it does
    not know whether execution filled, rounded, or rejected those targets.

    Args:
        positions: Position-weight matrix (index=date, columns=fund codes).

    Returns:
        Per-bar turnover series indexed like ``positions``; empty when the
        input is empty.
    """
    import pandas as pd

    if positions is None or positions.empty:
        return pd.Series(dtype=float)
    filled = positions.fillna(0.0)
    prev = filled.shift(1).fillna(0.0)
    return 0.5 * (filled - prev).abs().sum(axis=1)


def sharpe_ratio(returns: Any, bars_per_year: int = 252) -> float:
    """Annualised Sharpe ratio from per-bar returns (sample std, ddof=1).

    THE canonical Sharpe for the whole package: ``calc_metrics``, the
    bootstrap CI, the walk-forward windows, and the Monte Carlo path metrics
    all report this one number, so a report never shows two different
    "Sharpes" for the same series. Build the returns with ``bar_returns`` for
    the same convention at every call site.

    Args:
        returns: Per-bar simple returns (Series or array-like).
        bars_per_year: Annualisation factor.

    Returns:
        The annualised Sharpe, or 0.0 when the sample is too small
        (``len < 2``), the standard deviation is non-finite, or the result
        overflows — a Sharpe that cannot be computed honestly reads as 0.
    """
    import numpy as np

    values = np.asarray(returns, dtype=float).ravel()
    if values.size < 2:
        return 0.0
    std = float(np.std(values, ddof=1))
    if not math.isfinite(std):
        return 0.0
    sharpe = float(values.mean() / (std + 1e-10) * math.sqrt(bars_per_year))
    return sharpe if math.isfinite(sharpe) else 0.0


def max_drawdown(equity: Any, *, initial: Optional[float] = None) -> float:
    """Largest peak-to-trough decline of an equity curve.

    THE canonical drawdown for the whole package (headline metrics, Monte
    Carlo path metrics, and walk-forward windows all call this).

    Args:
        equity: Equity Series.
        initial: Optional high-water mark floor. ``calc_metrics`` passes
            ``initial_cash`` — the book starts there before the first
            recorded bar, so a first-bar loss is a real drawdown; path and
            window callers leave it unset so the running peak starts at the
            first value.

    Returns:
        The most negative drawdown (0.0 when there is none), with a zero peak
        guarded to 1 so a wiped-out book cannot divide by zero.
    """
    peak = equity.cummax()
    if initial is not None:
        peak = peak.clip(lower=float(initial))
    dd = (equity - peak) / peak.replace(0, 1)
    value = float(dd.min()) if len(dd) else 0.0
    return value if math.isfinite(value) else 0.0


def calc_metrics(
    equity_curve: Any,
    trades: List[TradeRecord],
    initial_cash: float,
    bars_per_year: Optional[int] = 252,
    bench_ret: Any = None,
    positions: Any = None,
    turnover_series: Any = None,
) -> Dict[str, Any]:
    """Full set of performance metrics.

    Args:
        equity_curve: Equity time series (index=date, values=equity).
        trades: Completed round-trip trades.
        initial_cash: Starting capital.
        bars_per_year: Bars per year for annualisation. None = measure from
            the equity curve's own calendar span.
        bench_ret: Benchmark per-bar return series (optional).
        positions: Position-weight frame used as a turnover fallback when
            ``turnover_series`` is not supplied.
        turnover_series: Actual per-bar turnover (optional); takes precedence
            over position-implied turnover.

    Returns:
        Metrics dictionary.
    """
    import numpy as np
    import pandas as pd

    if len(equity_curve) == 0:
        return _empty_metrics(initial_cash)

    n = len(equity_curve)

    if bars_per_year is None:
        bpy = effective_bars_per_year(equity_curve.index)
    else:
        bpy = bars_per_year

    # One return series for the whole package: ``bar_returns`` defines every
    # bar's return (undefined bars after a non-positive prior price report
    # 0.0 with a warning), so the Sharpe below is the same number the
    # bootstrap CI reports for this curve.
    port_ret = bar_returns(equity_curve, label="equity")

    total_ret = float(equity_curve.iloc[-1] / initial_cash - 1)
    # A book that ends at or below zero equity (``total_ret <= -1``) would
    # raise a negative base to a fractional power, which Python evaluates to a
    # ``complex`` and crashes the subsequent ``float(...)``. A total wipeout
    # annualises to -100%.
    growth = 1 + total_ret
    if growth <= 0:
        ann_ret = -1.0
    else:
        # Explosive equity paths overflow ``float(growth ** …)``; treat as
        # non-finite annualisation.
        try:
            ann_ret = float(growth ** (bpy / max(n, 1)) - 1)
        except OverflowError:
            ann_ret = float("inf")
        if not np.isfinite(ann_ret):
            ann_ret = float("inf")
    # ``Series.std()`` uses ddof=1, so a single-observation return series
    # yields NaN; guard the small sample the same way ``downside_std`` is
    # guarded below.
    vol = float(port_ret.std()) if len(port_ret) > 1 else 0.0
    sharpe = sharpe_ratio(port_ret, bpy)

    # The account starts at ``initial_cash`` before the first recorded bar, so
    # that value is the initial high-water mark. Using only observed equity
    # understates a first-bar loss and makes drawdown nonsensical after equity
    # crosses zero.
    max_dd = max_drawdown(equity_curve, initial=initial_cash)

    calmar = ann_ret / abs(max_dd) if abs(max_dd) > 1e-10 else 0.0

    downside = port_ret[port_ret < 0]
    downside_std = float(downside.std()) if len(downside) > 1 else 1e-10
    sortino = float(port_ret.mean() / (downside_std + 1e-10) * np.sqrt(bpy))
    if not math.isfinite(sortino):
        sortino = 0.0

    trade_stats = win_rate_and_stats(trades)

    if turnover_series is not None:
        turnover_values = turnover_series.reindex(equity_curve.index).fillna(0.0).clip(lower=0.0)
    elif positions is not None:
        turnover_values = calc_turnover_series(positions)
    else:
        turnover_values = pd.Series(dtype=float)
    avg_turnover = float(turnover_values.mean()) if len(turnover_values) > 0 else 0.0
    total_turnover = float(turnover_values.sum()) if len(turnover_values) > 0 else 0.0

    bench_return = 0.0
    excess = 0.0
    ir = 0.0
    tracking_error = 0.0
    bench_beta = 0.0
    if bench_ret is not None and len(bench_ret) > 0:
        bench_return = float((1 + bench_ret).prod() - 1)
        excess = total_ret - bench_return
        aligned_bench = bench_ret.reindex(port_ret.index).fillna(0.0)
        active_ret = port_ret - aligned_bench
        # The information ratio is the Sharpe of active returns — same
        # canonical estimator, so it stays comparable with the headline Sharpe.
        # Non-finite active returns (an inf in a caller-supplied benchmark)
        # report 0, matching the old explicit guard.
        ir = sharpe_ratio(active_ret, bpy)
        active_std = float(active_ret.std()) if len(active_ret) > 1 else 0.0
        tracking_error = active_std * np.sqrt(bpy)
        if not math.isfinite(tracking_error):
            tracking_error = 0.0
        bench_var = float(aligned_bench.var()) if len(aligned_bench) > 1 else 0.0
        if math.isfinite(bench_var) and bench_var > 0:
            covariance = float(port_ret.cov(aligned_bench))
            bench_beta = covariance / bench_var
            if not np.isfinite(bench_beta):
                bench_beta = 0.0

    return {
        "final_value": float(equity_curve.iloc[-1]),
        "total_return": total_ret,
        "annual_return": ann_ret,
        "max_drawdown": max_dd,
        "sharpe": sharpe,
        "calmar": round(calmar, 4),
        "sortino": round(sortino, 4),
        "win_rate": trade_stats["win_rate"],
        "profit_loss_ratio": trade_stats["profit_loss_ratio"],
        "profit_factor": trade_stats["profit_factor"],
        "max_consecutive_loss": trade_stats["max_consecutive_loss"],
        "avg_holding_days": trade_stats["avg_holding_bars"],
        "trade_count": len(trades),
        "benchmark_return": round(bench_return, 6),
        "excess_return": round(excess, 6),
        "information_ratio": round(ir, 4),
        "tracking_error": round(float(tracking_error), 6),
        "benchmark_beta": round(float(bench_beta), 4),
        "avg_turnover": round(avg_turnover, 6),
        "total_turnover": round(total_turnover, 6),
    }


def _empty_metrics(initial_cash: float) -> Dict[str, Any]:
    """Return zero-valued metrics when no data is available."""
    return {
        "final_value": initial_cash,
        "total_return": 0, "annual_return": 0, "max_drawdown": 0,
        "sharpe": 0, "calmar": 0, "sortino": 0,
        "win_rate": 0, "profit_loss_ratio": 0, "profit_factor": 0,
        "max_consecutive_loss": 0, "avg_holding_days": 0, "trade_count": 0,
        "benchmark_return": 0, "excess_return": 0, "information_ratio": 0,
        "tracking_error": 0.0, "benchmark_beta": 0.0,
        "avg_turnover": 0.0, "total_turnover": 0.0,
    }
