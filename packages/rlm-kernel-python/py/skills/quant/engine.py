"""Daily QDII fund-NAV backtester, native to daimon (not ported).

Discipline inherited from the Vibe-Trading runner: no same-day fills. Fund
subscription/redemption executes at the NEXT published NAV — a weights row
dated ``t`` takes effect at date ``t+1``'s NAV, so a signal can never earn the
return it was written after. Between publication dates a fund's NAV is
forward-filled: a QDII fund that skips a holiday earns the move from its last
published NAV to the next one, which is what holding it actually pays.

Cost model: ``subscribe_fee`` is charged on buy notional; the redemption fee
tier is chosen per LOT by calendar holding days (oldest lots redeem first) and
charged on sell notional. Rows of ``weights`` must sum to AT MOST 1 — the
remainder stays in cash and earns 0; a row summing above 1 would silently
lever the book, so it raises instead. Fees are paid out of cash, so a 100%
allocation dips cash slightly negative by the fee amount; equity is always
cash + holdings value.

All per-fund bookkeeping (lots, open round-trip ledger, TradeRecord emission)
lives in ``_Position``/``_Book``; ``backtest`` itself is only the per-date
target-vs-current comparison loop.

Data fetching is the caller's job; ``fetch_nav`` is a convenience wrapper over
``finance.rbsa.fund_nav`` (天天基金 pingzhongdata).

pandas/numpy are imported lazily inside functions.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .metrics import TradeRecord, calc_metrics, effective_bars_per_year
from .validation import run_validation

DEFAULT_REDEEM_FEE_SCHEDULE: Tuple[Tuple[int | None, float], ...] = (
    (7, 0.015),
    (30, 0.005),
    (None, 0.0),
)

# Share-count dust below this threshold is treated as flat (a lot fully
# redeemed, a position closed); trade-value deltas below it are not worth a
# round trip.
_SHARE_EPS = 1e-9
_DELTA_EPS = 1e-9


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

    if weights is None or weights.empty:
        raise ValueError("weights is empty")
    w = weights.copy().sort_index()
    if w.index.duplicated().any():
        dupes = w.index[w.index.duplicated()][:3]
        raise ValueError(f"weights has duplicate dates: {list(dupes)}")
    if w.columns.duplicated().any():
        dupes = list(w.columns[w.columns.duplicated()][:3])
        raise ValueError(f"weights has duplicate fund columns: {dupes}")
    values = w.to_numpy(dtype=float, copy=False)
    if not np.isfinite(values).all():
        raise ValueError("weights contains non-finite values")
    if (values < 0).any():
        raise ValueError("weights contains negative values")
    row_sums = values.sum(axis=1)
    if (row_sums > 1.0 + _DELTA_EPS).any():
        raise ValueError(
            f"weights row sums exceed 1 (max {float(row_sums.max()):.6f}); "
            "leverage is not supported — the unallocated remainder stays in cash"
        )
    missing = w.index.difference(nav_index)
    if len(missing) > 0:
        raise ValueError(f"weights dates missing from nav index: {list(missing[:3])}")
    return w.astype(float)


def _usable_nav(nav_d: Any, fund: str, d: Any) -> float:
    """One fund's tradable NAV on date ``d``; raise if it cannot be traded."""
    if not math.isfinite(nav_d) or nav_d <= 0:
        raise ValueError(f"fund {fund} has no usable NAV on {d}")
    return float(nav_d)


@dataclass
class _Position:
    """One fund's holdings and its open round-trip ledger.

    ``lots`` keeps per-lot ``[buy_date, shares]`` so the redemption fee tier is
    chosen by each lot's own calendar holding days. The remaining fields
    accumulate the current round trip; when the position flattens, ``sell``
    emits the completed ``TradeRecord`` and resets them.
    """

    code: str
    shares: float = 0.0
    lots: List[List[Any]] = field(default_factory=list)
    # Open round-trip context; entry_idx < 0 means flat / no open round trip.
    entry_time: Any = None
    entry_price: float = 0.0
    entry_idx: int = -1
    size: float = 0.0
    cost_in: float = 0.0
    entry_cost: float = 0.0
    fees: float = 0.0
    pnl: float = 0.0

    def value(self, nav_d: float) -> float:
        """Market value at NAV ``nav_d``.

        0 * NaN is NaN: funds not yet listed (leading NaN after ffill) must
        not poison the equity of an all-cash book.
        """
        return self.shares * nav_d if self.shares > 0 else 0.0

    def buy(self, d: Any, nav_d: float, notional: float, fee: float, i: int) -> None:
        """Buy ``notional`` yuan at NAV ``nav_d``, paying ``fee`` from cash."""
        shares_buy = notional / nav_d
        self.lots.append([d, shares_buy])
        if self.entry_idx < 0:
            self.entry_time, self.entry_price, self.entry_idx = d, nav_d, i
        self.size += shares_buy
        self.cost_in += notional + fee
        self.entry_cost += notional + fee
        self.fees += fee
        self.shares += shares_buy

    def sell(
        self, d: Any, nav_d: float, shares_sell: float, reason: str, i: int, fee_rate: Any
    ) -> Tuple[float, Optional[TradeRecord]]:
        """Sell ``shares_sell`` shares at NAV ``nav_d`` (oldest lots first).

        Returns ``(fee, trade)`` — the redemption fee, and the completed
        TradeRecord when the sale flattens the position (None while a
        position remains open).
        """
        remaining = shares_sell
        fee = 0.0
        # Oldest lots first; each lot pays the tier its own holding days select.
        while remaining > 1e-12 and self.lots:
            lot = self.lots[0]
            take = min(remaining, lot[1])
            holding_days = (d - lot[0]).days
            fee += take * nav_d * fee_rate(holding_days)
            lot[1] -= take
            remaining -= take
            if lot[1] <= 1e-12:
                self.lots.pop(0)

        shares_before = self.shares
        realized_cost = (
            self.cost_in * (shares_sell / shares_before) if shares_before > 0 else 0.0
        )
        self.pnl += shares_sell * nav_d - fee - realized_cost
        self.fees += fee
        self.cost_in -= realized_cost
        self.shares = shares_before - shares_sell

        if self.shares <= _SHARE_EPS:
            trade = TradeRecord(
                symbol=self.code,
                entry_price=self.entry_price,
                exit_price=nav_d,
                entry_time=self.entry_time,
                exit_time=d,
                size=self.size,
                pnl=self.pnl,
                pnl_pct=self.pnl / self.entry_cost if self.entry_cost > 0 else 0.0,
                exit_reason=reason,
                holding_bars=float(i - self.entry_idx),
                commission=self.fees,
            )
            self._reset()
            return fee, trade
        return fee, None

    def _reset(self) -> None:
        self.shares = 0.0
        self.lots = []
        self.entry_time = None
        self.entry_price = 0.0
        self.entry_idx = -1
        self.size = 0.0
        self.cost_in = 0.0
        self.entry_cost = 0.0
        self.fees = 0.0
        self.pnl = 0.0


class _Book:
    """Portfolio state: cash, fees, completed trades, per-fund positions.

    Owns every mutation of those, so ``backtest`` stays a per-date
    target-vs-current comparison instead of interleaved bookkeeping.
    """

    def __init__(
        self,
        initial_cash: float,
        subscribe_fee: float,
        redeem_fee_schedule: Sequence[Tuple[int | None, float]],
    ) -> None:
        self.cash = float(initial_cash)
        self.subscribe_fee = subscribe_fee
        self.redeem_fee_schedule = redeem_fee_schedule
        self.total_fees = 0.0
        self.trades: List[TradeRecord] = []
        self.positions: Dict[str, _Position] = {}

    def _fee_rate(self, holding_days: int) -> float:
        return _redeem_fee_rate(holding_days, self.redeem_fee_schedule)

    def _position(self, code: str) -> _Position:
        pos = self.positions.get(code)
        if pos is None:
            pos = self.positions[code] = _Position(code)
        return pos

    def equity(self, row_nav: Any) -> float:
        """Cash plus holdings value; unlisted funds contribute 0, not NaN."""
        return self.cash + sum(pos.value(row_nav[code]) for code, pos in self.positions.items())

    def apply(self, codes: List[str], target_row: Any, row_nav: Any, d: Any, i: int) -> None:
        """Move each fund toward its target weight at date ``d``'s NAV.

        Targets are fractions of the equity held BEFORE today's trades, so
        the buy/sell decisions within one date stay independent of each
        other's order.
        """
        equity = self.equity(row_nav)
        for f in codes:
            pos = self._position(f)
            nav_d = row_nav[f]
            delta = float(target_row[f]) * equity - pos.value(nav_d)
            if abs(delta) <= _DELTA_EPS:
                continue
            nav_d = _usable_nav(nav_d, f, d)
            if delta > 0:
                fee = delta * self.subscribe_fee
                self.cash -= delta + fee
                self.total_fees += fee
                pos.buy(d, nav_d, delta, fee, i)
            else:
                shares_sell = -delta / nav_d
                fee, trade = pos.sell(d, nav_d, shares_sell, "rebalance", i, self._fee_rate)
                self.cash += shares_sell * nav_d - fee
                self.total_fees += fee
                if trade is not None:
                    self.trades.append(trade)

    def liquidate_all(self, codes: List[str], row_nav: Any, d: Any, i: int) -> int:
        """Close every open position at the last NAV (reason ``"final"``).

        Returns the number of trades emitted; when nonzero the caller must
        refresh the final equity/position row, because cash moved after the
        last loop iteration recorded it.
        """
        emitted = 0
        for f in codes:
            pos = self.positions.get(f)
            if pos is None or pos.shares <= _SHARE_EPS:
                continue
            nav_d = _usable_nav(row_nav[f], f, d)
            shares_sell = pos.shares
            fee, trade = pos.sell(d, nav_d, shares_sell, "final", i, self._fee_rate)
            self.cash += shares_sell * nav_d - fee
            self.total_fees += fee
            if trade is not None:
                self.trades.append(trade)
                emitted += 1
        return emitted


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
            codes). Rows must sum to at most 1; the remainder stays in cash
            (0% return). A row dated ``t`` executes at date ``t+1``'s NAV; a
            row dated on or after the last NAV date never executes.
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
        ValueError: duplicate dates, duplicate fund columns, weights dates
            outside the NAV index, negative/non-finite weights, weights rows
            summing above 1, non-positive initial cash, or a trade targeting
            a fund with no published NAV.
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

    book = _Book(initial_cash, subscribe_fee, redeem_fee_schedule)
    equity_values: List[float] = []
    position_rows: List[List[float]] = []

    for i, d in enumerate(dates):
        row_nav = navf.iloc[i]

        # Effective target: last weights row strictly BEFORE d (next-NAV fill).
        pos = w.index.searchsorted(d, side="left") - 1
        if pos >= 0:
            book.apply(codes, w.iloc[pos], row_nav, d, i)

        equity = book.equity(row_nav)
        equity_values.append(equity)
        position_rows.append(
            [
                (book.positions[c].value(row_nav[c]) / equity)
                if equity > 0 and c in book.positions
                else 0.0
                for c in codes
            ]
        )

    # Final closure: liquidate any remaining holdings at the last NAV so every
    # round trip is a completed TradeRecord.
    last_i = len(dates) - 1
    if book.liquidate_all(codes, navf.iloc[last_i], dates[last_i], last_i):
        equity_values[-1] = book.cash
        position_rows[-1] = [0.0 for _ in codes]

    equity = pd.Series(equity_values, index=dates, name="equity")
    positions = pd.DataFrame(position_rows, index=dates, columns=codes)

    # One annualisation factor, measured from this curve's own calendar span,
    # shared by the metrics and the validation trio.
    bars_per_year = effective_bars_per_year(equity.index)
    results: Dict[str, Any] = {
        "equity": equity,
        "trades": book.trades,
        "positions": positions,
        "metrics": calc_metrics(
            equity, book.trades, initial_cash,
            bars_per_year=bars_per_year, positions=positions,
        ),
        "validation": None,
        "total_fees": book.total_fees,
    }
    if validation is not None:
        results["validation"] = run_validation(
            {"validation": validation}, equity, book.trades, initial_cash,
            bars_per_year=bars_per_year,
        )
    return results
