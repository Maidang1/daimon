"""Daily QDII fund-NAV backtester, native to daimon (not ported).

Discipline inherited from the Vibe-Trading runner: no same-day fills. Fund
subscription/redemption executes at the NEXT published NAV — a weights row
dated ``t`` takes effect at date ``t+1``'s NAV, so a signal can never earn the
return it was written after. Between publication dates a fund's NAV is
forward-filled: a QDII fund that skips a holiday earns the move from its last
published NAV to the next one, which is what holding it actually pays.

Cost model: ``subscribe_fee`` is charged on buy notional; the redemption fee
tier is chosen per LOT by calendar holding days (oldest lots redeem first) and
charged on sell notional. Rows of ``weights`` need not sum to 1 — the
remainder stays in cash and earns 0. Fees are paid out of cash, so a 100%
allocation dips cash slightly negative by the fee amount; equity is always
cash + holdings value.

Data fetching is the caller's job; ``fetch_nav`` is a convenience wrapper over
``finance.rbsa.fund_nav`` (天天基金 pingzhongdata).

pandas/numpy are imported lazily inside functions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from .metrics import TradeRecord, calc_metrics, effective_bars_per_year
from .validation import run_validation

DEFAULT_REDEEM_FEE_SCHEDULE: Tuple[Tuple[int | None, float], ...] = (
    (7, 0.015),
    (30, 0.005),
    (None, 0.0),
)


def fetch_nav(*codes: str) -> Any:
    """Fetch daily NAV series for ``codes`` from 天天基金 (eastmoney).

    Lazily imports ``finance.rbsa.fund_nav`` (network access to
    ``fund.eastmoney.com``). Returns a DataFrame of NAVs outer-joined on the
    union of publication dates, sorted ascending, one column per code. Rows
    are NOT forward-filled here — ``backtest`` forward-fills each fund across
    its own publication gaps.

    Raises ValueError when no codes are given; raises the finance package's
    fetch error when eastmoney is unreachable.
    """
    import pandas as pd

    if not codes:
        raise ValueError("fetch_nav needs at least one fund code")
    from finance.rbsa import fund_nav

    series = {}
    for code in codes:
        nav, _er = fund_nav(str(code))
        series[str(code)] = nav
    frame = pd.DataFrame(series).sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    return frame


def _redeem_fee_rate(holding_days: int, schedule: Sequence[Tuple[int | None, float]]) -> float:
    """Redemption fee for a lot held ``holding_days`` calendar days.

    The first tier whose day count reaches the holding period applies:
    ``(7, 0.015)`` charges 1.5% for holds of up to and including 7 calendar
    days; ``(None, 0.0)`` is the open-ended final tier.
    """
    for tier_days, rate in schedule:
        if tier_days is None or holding_days <= tier_days:
            return rate
    return 0.0


def _prepare_nav(nav: Any, min_nav_date: Any) -> Any:
    """Normalise the NAV input to a sorted, duplicate-free DataFrame."""
    import numpy as np
    import pandas as pd

    if isinstance(nav, dict):
        frame = pd.DataFrame({str(k): v for k, v in nav.items()})
    else:
        frame = nav.copy()
    frame = frame.sort_index()
    if frame.index.duplicated().any():
        dupes = frame.index[frame.index.duplicated()][:3]
        raise ValueError(f"nav has duplicate dates: {list(dupes)}")
    if frame.empty:
        raise ValueError("nav is empty")
    values = frame.to_numpy(dtype=float, copy=False)
    if not np.isfinite(values[~np.isnan(values)]).all():
        raise ValueError("nav contains non-finite values")
    if min_nav_date is not None:
        frame = frame.loc[frame.index >= pd.Timestamp(min_nav_date)]
        if frame.empty:
            raise ValueError("min_nav_date leaves no nav rows")
    # Forward-fill within each fund's own listing span: NAV is stepwise
    # constant between publication dates. Leading NaN (fund not yet listed) is
    # kept and rejected only if a trade actually targets that fund that early.
    return frame.ffill()


def _validate_weights(weights: Any, nav_index: Any) -> Any:
    """Validate the target-weight frame; raise ValueError on any contract break."""
    import numpy as np
    import pandas as pd

    if weights is None or weights.empty:
        raise ValueError("weights is empty")
    w = weights.copy().sort_index()
    if w.index.duplicated().any():
        dupes = w.index[w.index.duplicated()][:3]
        raise ValueError(f"weights has duplicate dates: {list(dupes)}")
    values = w.to_numpy(dtype=float, copy=False)
    if not np.isfinite(values).all():
        raise ValueError("weights contains non-finite values")
    if (values < 0).any():
        raise ValueError("weights contains negative values")
    missing = w.index.difference(nav_index)
    if len(missing) > 0:
        raise ValueError(f"weights dates missing from nav index: {list(missing[:3])}")
    return w.astype(float)


def backtest(
    weights: Any,
    nav: Any,
    *,
    initial_cash: float = 1_000_000.0,
    subscribe_fee: float = 0.0015,
    redeem_fee_schedule: Sequence[Tuple[int | None, float]] = DEFAULT_REDEEM_FEE_SCHEDULE,
    min_nav_date: Any = None,
    validation: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Run a daily fund-NAV backtest with next-NAV execution.

    Args:
        weights: Daily target-weight DataFrame (index=date, columns=fund
            codes). Rows need not sum to 1; the remainder stays in cash (0%
            return). A row dated ``t`` executes at date ``t+1``'s NAV; a row
            dated on or after the last NAV date never executes.
        nav: Fund code → daily NAV Series mapping, or a DataFrame of NAVs.
            Outer-joined, forward-filled across publication gaps; leading NaN
            before a fund's first NAV is a hard error if traded into.
        initial_cash: Starting capital. Must be positive and finite.
        subscribe_fee: Fraction charged on buy notional.
        redeem_fee_schedule: ``((max_holding_days, fee), ...)`` tiers chosen
            per lot by calendar holding days; ``None`` day count is the final
            open-ended tier.
        min_nav_date: Optional earliest NAV date to keep.
        validation: Optional dict selecting validation runs, e.g.
            ``{"monte_carlo": {}, "bootstrap": {}, "walk_forward": {}}``;
            per-key kwargs override the defaults. Runs with
            ``bars_per_year`` measured from the equity curve's calendar span.

    Returns:
        ``{"equity": Series, "trades": [TradeRecord], "positions": DataFrame,
        "metrics": dict, "validation": dict | None, "total_fees": float}``.

    Raises:
        ValueError: duplicate dates, weights dates outside the NAV index,
            negative or non-finite weights/NAV, non-positive initial cash, or
            a trade targeting a fund with no published NAV.
    """
    import numpy as np
    import pandas as pd

    if not np.isfinite(initial_cash) or initial_cash <= 0:
        raise ValueError(f"initial_cash must be positive and finite, got {initial_cash}")

    frame = _prepare_nav(nav, min_nav_date)
    w = _validate_weights(weights, frame.index)

    codes = list(dict.fromkeys(str(c) for c in w.columns))
    for c in codes:
        if c not in frame.columns:
            raise ValueError(f"weights references fund {c!r} missing from nav")

    dates = frame.index
    navf = frame[codes]

    cash = float(initial_cash)
    shares: Dict[str, float] = {c: 0.0 for c in codes}
    lots: Dict[str, List[List[Any]]] = {c: [] for c in codes}
    # Open round-trip context per fund for TradeRecord emission.
    ctx: Dict[str, Dict[str, Any]] = {}
    trades: List[TradeRecord] = []
    total_fees = 0.0

    equity_values: List[float] = []
    position_rows: List[List[float]] = []

    def _redeem(f: str, d: Any, nav_d: float, shares_sell: float, reason: str, i: int) -> None:
        nonlocal cash, total_fees
        # Oldest lots first; each lot pays the tier its own holding days select.
        remaining = shares_sell
        fee = 0.0
        fund_lots = lots[f]
        while remaining > 1e-12 and fund_lots:
            lot = fund_lots[0]
            take = min(remaining, lot[1])
            holding_days = (d - lot[0]).days
            fee += take * nav_d * _redeem_fee_rate(holding_days, redeem_fee_schedule)
            lot[1] -= take
            remaining -= take
            if lot[1] <= 1e-12:
                fund_lots.pop(0)
        notional = shares_sell * nav_d
        proceeds = notional - fee
        cash += proceeds
        total_fees += fee

        c = ctx[f]
        shares_before = shares[f]
        realized_cost = c["cost_in"] * (shares_sell / shares_before)
        c["pnl"] += proceeds - realized_cost
        c["fees"] += fee
        c["cost_in"] -= realized_cost
        shares[f] = shares_before - shares_sell
        if shares[f] <= 1e-9:
            entry_cost = c["entry_cost"]
            trades.append(
                TradeRecord(
                    symbol=f,
                    direction=1,
                    entry_price=c["entry_price"],
                    exit_price=nav_d,
                    entry_time=c["entry_time"],
                    exit_time=d,
                    size=c["size"],
                    leverage=1.0,
                    pnl=c["pnl"],
                    pnl_pct=c["pnl"] / entry_cost if entry_cost > 0 else 0.0,
                    exit_reason=reason,
                    holding_bars=float(i - c["entry_idx"]),
                    commission=c["fees"],
                    entry_margin=entry_cost,
                    exit_margin=notional,
                )
            )
            shares[f] = 0.0
            ctx.pop(f, None)

    def _holdings_value(row_nav: Any) -> float:
        # 0 * NaN is NaN: funds not yet listed (leading NaN after ffill) must
        # not poison the equity of an all-cash book.
        return float(sum(shares[c] * row_nav[c] for c in codes if shares[c] > 0))

    for i, d in enumerate(dates):
        row_nav = navf.iloc[i]
        equity_before = cash + _holdings_value(row_nav)

        # Effective target: last weights row strictly BEFORE d (next-NAV fill).
        pos = w.index.searchsorted(d, side="left") - 1
        target = w.iloc[pos] if pos >= 0 else None

        if target is not None:
            for f in codes:
                nav_d = row_nav[f]
                w_f = float(target[f])
                cur_val = shares[f] * nav_d if shares[f] > 0 else 0.0
                tgt_val = w_f * equity_before
                delta = tgt_val - cur_val
                if abs(delta) <= 1e-9:
                    continue
                if not np.isfinite(nav_d) or nav_d <= 0:
                    raise ValueError(f"fund {f} has no usable NAV on {d}")
                if delta > 0:
                    notional = delta
                    fee = notional * subscribe_fee
                    shares_buy = notional / nav_d
                    cash -= notional + fee
                    total_fees += fee
                    lots[f].append([d, shares_buy])
                    c = ctx.get(f)
                    if c is None:
                        c = {
                            "entry_time": d,
                            "entry_price": nav_d,
                            "entry_idx": i,
                            "size": 0.0,
                            "cost_in": 0.0,
                            "entry_cost": 0.0,
                            "fees": 0.0,
                            "pnl": 0.0,
                        }
                        ctx[f] = c
                    c["size"] += shares_buy
                    c["cost_in"] += notional + fee
                    c["entry_cost"] += notional + fee
                    c["fees"] += fee
                    shares[f] += shares_buy
                else:
                    _redeem(f, d, nav_d, -delta / nav_d, "rebalance", i)

        equity = cash + _holdings_value(row_nav)
        equity_values.append(equity)
        position_rows.append(
            [shares[c] * row_nav[c] / equity if equity > 0 else 0.0 for c in codes]
        )

    # Final closure: liquidate any remaining holdings at the last NAV so every
    # round trip is a completed TradeRecord.
    last_i = len(dates) - 1
    last_d = dates[last_i]
    last_nav = navf.iloc[last_i]
    for f in codes:
        if shares[f] > 1e-9:
            nav_d = last_nav[f]
            if not np.isfinite(nav_d) or nav_d <= 0:
                raise ValueError(f"fund {f} has no usable NAV on {last_d}")
            _redeem(f, last_d, nav_d, shares[f], "final", last_i)
    if trades and trades[-1].exit_reason == "final":
        equity_values[-1] = cash
        position_rows[-1] = [0.0 for _ in codes]

    equity = pd.Series(equity_values, index=dates, name="equity")
    positions = pd.DataFrame(position_rows, index=dates, columns=codes)

    results: Dict[str, Any] = {
        "equity": equity,
        "trades": trades,
        "positions": positions,
        "metrics": calc_metrics(equity, trades, initial_cash, bars_per_year=None, positions=positions),
        "validation": None,
        "total_fees": total_fees,
    }
    if validation is not None:
        results["validation"] = run_validation(
            {"validation": validation}, equity, trades, initial_cash,
            bars_per_year=effective_bars_per_year(equity.index),
        )
    return results
