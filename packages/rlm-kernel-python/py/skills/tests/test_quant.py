"""Tests for the quant skill: engine, metrics, validation, ledger, evidence.

All data is synthetic — no network access anywhere.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import quant
from quant import engine, metrics, validation
from quant.metrics import TradeRecord

DATES5 = pd.date_range("2026-01-01", periods=5, freq="D")  # d0..d4


def _nav_frame() -> pd.DataFrame:
    # A d0 NAV 0.5 (below d1's 1.0) and B d0 NAV 5.0 prove nothing fills at
    # d0: a same-day fill would change every hand-computed number below.
    return pd.DataFrame(
        {
            "A": pd.Series([0.5, 1.0, 1.1, 1.1, 1.0], index=DATES5),
            "B": pd.Series([5.0, 2.0, 2.0, 2.2, 2.2], index=DATES5),
        }
    )


def _weights() -> pd.DataFrame:
    return pd.DataFrame(
        {"A": [1.0, 0.0, 0.0], "B": [0.0, 1.0, 0.0]},
        index=[DATES5[0], DATES5[2], DATES5[4]],
    )


# ─── engine: hand-computable primary scenario ───


def test_backtest_hand_computed_t_plus_1_and_fees():
    result = engine.backtest(_weights(), _nav_frame())
    eq = result["equity"]

    # d0: weights not yet effective (no same-day fill), all cash.
    assert eq.iloc[0] == pytest.approx(1_000_000.0)
    # d1: A bought at d1 NAV 1.0 (not d0's 0.5): shares 1e6, subscribe fee 1500.
    assert eq.iloc[1] == pytest.approx(998_500.0)
    # d2: A still 100%; a 1500 partial rebalance-sell with 1-day hold pays 1.5% (22.5).
    assert eq.iloc[2] == pytest.approx(1_098_477.5)
    # d3: A sold (2-day hold, 1.5% = 16477.5), B bought at 2.2.
    assert eq.iloc[3] == pytest.approx(1_080_352.28375)
    # d4: w(d4) never executes (needs a d5); final liquidation of B at 2.2.
    assert eq.iloc[4] == pytest.approx(1_063_875.1212515)

    assert result["total_fees"] == pytest.approx(36_124.8787485)

    trades = result["trades"]
    assert len(trades) == 2
    ta, tb = trades
    assert ta.symbol == "A"
    assert ta.exit_reason == "rebalance"
    assert ta.entry_time == DATES5[1] and ta.exit_time == DATES5[3]
    assert ta.entry_price == pytest.approx(1.0) and ta.exit_price == pytest.approx(1.1)
    assert ta.pnl == pytest.approx(82_000.0)  # +10% on 1e6 minus 18000 fees
    assert ta.holding_bars == pytest.approx(2)
    assert ta.commission == pytest.approx(18_000.0)
    assert tb.symbol == "B"
    assert tb.exit_reason == "final"
    assert tb.entry_time == DATES5[3] and tb.exit_time == DATES5[4]
    assert tb.pnl == pytest.approx(-18_124.8787485)  # B flat 2.2→2.2, all fees

    m = result["metrics"]
    for key in ("sharpe", "max_drawdown", "total_return", "win_rate",
                "trade_count", "annual_return", "avg_turnover"):
        assert key in m
    assert m["trade_count"] == 2
    assert m["win_rate"] == pytest.approx(0.5)
    assert m["total_return"] == pytest.approx(eq.iloc[-1] / 1_000_000.0 - 1)

    pos = result["positions"]
    assert pos.loc[DATES5[1], "A"] == pytest.approx(1e6 / 998_500.0)
    assert pos.loc[DATES5[2], "B"] == 0.0
    assert (pos.iloc[-1] == 0.0).all()  # liquidated at the end


def test_backtest_validation_block_runs():
    result = engine.backtest(
        _weights(), _nav_frame(),
        validation={"monte_carlo": {"n_simulations": 20},
                    "bootstrap": {"n_bootstrap": 20},
                    "walk_forward": {"n_windows": 2}},
    )
    v = result["validation"]
    assert v is not None and set(v) == {"monte_carlo", "bootstrap", "walk_forward"}
    # 2 trades / 4 returns are too small — error branches, still reported.
    assert "error" in v["monte_carlo"]
    assert "error" in v["bootstrap"]
    assert "error" not in v["walk_forward"]


def test_backtest_redeem_fee_within_7_days():
    dates = pd.date_range("2026-01-01", periods=3, freq="D")
    nav = pd.DataFrame({"A": pd.Series([1.0, 1.0, 1.0], index=dates)})
    weights = pd.DataFrame({"A": [0.5, 0.0]}, index=[dates[0], dates[1]])
    result = engine.backtest(weights, nav)
    # Buy at d1 (fee 750), sell at d2 with a 1-day hold → 1.5% of 500000 = 7500.
    assert result["total_fees"] == pytest.approx(8_250.0)
    assert result["equity"].iloc[-1] == pytest.approx(991_750.0)
    assert result["trades"][0].exit_reason == "rebalance"


def test_backtest_redeem_fee_exempt_after_30_days_and_cash_earns_zero():
    dates = pd.date_range("2026-01-01", periods=33, freq="D")
    nav = pd.DataFrame({"A": pd.Series([1.0] * 33, index=dates)})
    weights = pd.DataFrame({"A": [0.5, 0.0]}, index=[dates[0], dates[31]])
    # subscribe_fee=0 isolates the redemption tier: any positive fee would
    # feed back into daily rebalance drift on a flat NAV.
    result = engine.backtest(weights, nav, subscribe_fee=0.0)
    # Sold at d32 after a 31-calendar-day hold → open-ended 0% tier.
    assert result["total_fees"] == pytest.approx(0.0)
    assert result["equity"].iloc[-1] == pytest.approx(1_000_000.0)
    # Cash remainder (the other 50%) earns 0 while the fund is flat.
    assert result["equity"].iloc[15] == pytest.approx(1_000_000.0)


def test_backtest_rows_need_not_sum_to_one():
    dates = pd.date_range("2026-01-01", periods=3, freq="D")
    nav = pd.DataFrame({"A": pd.Series([1.0, 2.0, 2.0], index=dates)})
    weights = pd.DataFrame({"A": [0.5]}, index=[dates[0]])
    result = engine.backtest(weights, nav)
    # Bought at d1's NAV 2.0 (t+1 — no free double from d0's 1.0), liquidated
    # at d2 with a 1-day hold: equity = 1e6 − 750 subscribe − 7500 redeem, and
    # the un-invested half stayed in cash the whole time.
    assert result["equity"].iloc[-1] == pytest.approx(1_000_000.0 - 750.0 - 7_500.0)
    assert result["positions"].loc[dates[1], "A"] == pytest.approx(500_000.0 / 999_250.0)


# ─── engine guards ───


def test_backtest_rejects_duplicate_weight_dates():
    nav = _nav_frame()
    w = _weights()
    w.index = list(w.index)
    w.index = [DATES5[0], DATES5[2], DATES5[2]]  # duplicate
    with pytest.raises(ValueError, match="duplicate"):
        engine.backtest(w, nav)


def test_backtest_rejects_weight_date_outside_nav_calendar():
    nav = _nav_frame()
    w = _weights()
    w.index = [DATES5[0], DATES5[2], pd.Timestamp("2026-02-01")]  # not in nav
    with pytest.raises(ValueError, match="missing from nav index"):
        engine.backtest(w, nav)


def test_backtest_rejects_negative_and_non_finite_weights():
    nav = _nav_frame()
    w = _weights()
    w.iloc[0, 0] = -0.5
    with pytest.raises(ValueError, match="negative"):
        engine.backtest(w, nav)
    w.iloc[0, 0] = float("inf")
    with pytest.raises(ValueError, match="non-finite"):
        engine.backtest(w, nav)


def test_backtest_rejects_duplicate_nav_dates_and_bad_cash():
    nav = _nav_frame()
    bad = pd.concat([nav, nav.iloc[[1]]])
    with pytest.raises(ValueError, match="duplicate"):
        engine.backtest(_weights(), bad)
    with pytest.raises(ValueError, match="initial_cash"):
        engine.backtest(_weights(), nav, initial_cash=0.0)


# ─── metrics ───


def _equity4() -> pd.Series:
    return pd.Series([100.0, 110.0, 121.0, 108.9],
                     index=pd.date_range("2026-01-01", periods=4, freq="D"))


def _one_trade() -> TradeRecord:
    return TradeRecord(
        symbol="A", direction=1, entry_price=1.0, exit_price=1.1,
        entry_time=pd.Timestamp("2026-01-01"), exit_time=pd.Timestamp("2026-01-03"),
        size=1000.0, pnl=100.0, pnl_pct=0.1, exit_reason="rebalance",
        holding_bars=2, commission=1.5,
    )


def test_calc_metrics_hand_computed():
    # returns [0, .1, .1, -.1]: mean .025, ddof=1 std .0957425,
    # sharpe = .025/.0957425*sqrt(252) ≈ 4.1449; drawdown −10% off the 121 peak.
    m = metrics.calc_metrics(_equity4(), [_one_trade()], 100.0)
    assert m["sharpe"] == pytest.approx(4.1449, abs=1e-3)
    assert m["max_drawdown"] == pytest.approx(-0.1)
    assert m["total_return"] == pytest.approx(0.089)
    assert m["final_value"] == pytest.approx(108.9)
    assert m["win_rate"] == 1.0
    assert m["trade_count"] == 1
    assert m["avg_holding_days"] == 2.0


def test_calc_metrics_empty_equity():
    m = metrics.calc_metrics(pd.Series(dtype=float), [], 1000.0)
    assert m["final_value"] == 1000.0
    assert m["sharpe"] == 0
    assert m["trade_count"] == 0
    assert m["avg_turnover"] == 0.0


def test_bars_per_year_calendar():
    assert metrics.calc_bars_per_year("1D") == 252
    assert metrics.calc_bars_per_year("1w") == 52
    assert metrics.calc_bars_per_year("1M") == 12
    with pytest.raises(ValueError):
        metrics.calc_bars_per_year("5m")


def test_win_rate_and_stats_split():
    t = _one_trade()
    losing = TradeRecord(**{**t.__dict__, "pnl": -50.0, "exit_reason": "final"})
    stats = metrics.win_rate_and_stats([t, losing])
    assert stats["win_rate"] == pytest.approx(0.5)
    assert stats["profit_factor"] == pytest.approx(100.0 / 50.0)
    assert stats["max_consecutive_loss"] == 1


# ─── validation ───


def _five_trades():
    base = _one_trade()
    return [
        TradeRecord(**{**base.__dict__, "pnl": float(p), "exit_time": pd.Timestamp("2026-01-02") + pd.Timedelta(days=i)})
        for i, p in enumerate([100.0, -40.0, 80.0, 60.0, -20.0])
    ]


def test_monte_carlo_deterministic_fixed_seed():
    a = validation.monte_carlo_test(_five_trades(), 1000.0, n_simulations=50, seed=42)
    b = validation.monte_carlo_test(_five_trades(), 1000.0, n_simulations=50, seed=42)
    assert a == b
    assert a["n_trades"] == 5
    assert 0.0 <= a["p_value_sharpe"] <= 1.0


def test_monte_carlo_error_branches():
    r = validation.monte_carlo_test(_five_trades()[:2], 1000.0)
    assert "error" in r and r["p_value_sharpe"] == 1.0
    r = validation.monte_carlo_test(_five_trades(), 1000.0, n_simulations=0)
    assert "error" in r
    r = validation.monte_carlo_test(_five_trades(), 1000.0, seed=-1)
    assert "error" in r


def test_bootstrap_error_branches_and_determinism():
    short = pd.Series([100.0, 101.0, 102.0, 103.0],
                      index=pd.date_range("2026-01-01", periods=4, freq="D"))
    assert "error" in validation.bootstrap_sharpe_ci(short)
    assert "error" in validation.bootstrap_sharpe_ci(_equity4(), n_bootstrap=0)
    assert "error" in validation.bootstrap_sharpe_ci(_equity4(), confidence=1.5)
    equity = pd.Series(np.linspace(100, 130, 12),
                       index=pd.date_range("2026-01-01", periods=12, freq="D"))
    a = validation.bootstrap_sharpe_ci(equity, n_bootstrap=100, seed=42)
    b = validation.bootstrap_sharpe_ci(equity, n_bootstrap=100, seed=42)
    assert a == b
    assert a["ci_lower"] <= a["observed_sharpe"] <= a["ci_upper"]


def test_walk_forward_window_count_and_consistency():
    equity = pd.Series(
        [100, 101, 102, 103, 104, 105, 106, 107, 108, 107, 106, 105],
        index=pd.date_range("2026-01-01", periods=12, freq="D"),
    )
    r = validation.walk_forward_analysis(equity, [], n_windows=3)
    assert "error" not in r
    assert len(r["windows"]) == 3
    assert [w["window"] for w in r["windows"]] == [1, 2, 3]
    assert r["profitable_windows"] == 2
    assert r["consistency_rate"] == pytest.approx(round(2 / 3, 4))
    assert r["windows"][2]["return"] < 0
    assert "error" in validation.walk_forward_analysis(equity, [], n_windows=0)
    assert "error" in validation.walk_forward_analysis(equity.iloc[:4], [], n_windows=3)


def test_validate_wrapper_runs_trio():
    equity = pd.Series(np.linspace(100, 130, 12),
                       index=pd.date_range("2026-01-01", periods=12, freq="D"))
    trades = _five_trades()
    out = quant.validate(equity, trades, 100.0,
                         monte_carlo={"n_simulations": 20},
                         bootstrap={"n_bootstrap": 20},
                         walk_forward={"n_windows": 2})
    assert set(out) == {"monte_carlo", "bootstrap", "walk_forward"}
    with pytest.raises(ValueError):
        quant.validate(equity, trades, 100.0)


# ─── ledger ───


@pytest.fixture()
def ledger_home(tmp_path, monkeypatch):
    monkeypatch.setenv("FINANCE_HOME", str(tmp_path))
    return tmp_path


def test_ledger_add_resolve_accuracy(ledger_home):
    from quant import ledger

    h1 = ledger.add("A 净值一周内心上穿 1.10", "A", "7 个自然日后 NAV 仍低于 1.10", "2026-01-08")
    h2 = ledger.add("B 跑输基准", "B", "下期超额收益为正", "2026-01-05")
    assert h1 != h2
    e = ledger.get(h1)
    assert e["status"] == "open" and e["check"] is None
    assert len(ledger.open()) == 2

    ledger.resolve(h1, "won", evidence={"nav": 1.12})
    ledger.resolve(h2, "lost")
    assert len(ledger.open()) == 0
    acc = ledger.accuracy()
    assert acc == {"won": 1, "lost": 1, "void": 0, "hit_rate": pytest.approx(0.5)}

    with pytest.raises(ValueError, match="already resolved"):
        ledger.resolve(h1, "lost")
    with pytest.raises(ValueError):
        ledger.resolve("nope", "won")
    with pytest.raises(ValueError):
        ledger.resolve(h1, "maybe")


def test_ledger_add_validation(ledger_home):
    from quant import ledger

    with pytest.raises(ValueError, match="invalidation"):
        ledger.add("s", "A", "  ", "2026-01-08")
    with pytest.raises(ValueError, match="horizon_date"):
        ledger.add("s", "A", "inv", "01/08/2026")
    with pytest.raises(ValueError, match="check"):
        ledger.add("s", "A", "inv", "2026-01-08",
                   check={"type": "nav_above"})  # missing level
    with pytest.raises(ValueError, match="check"):
        ledger.add("s", "A", "inv", "2026-01-08",
                   check={"type": "nav_above", "level": float("nan")})
    hid = ledger.add("s", "A", "inv", "2026-01-08",
                     check={"type": "nav_below", "level": 1.0}, source_run="run-x")
    assert ledger.get(hid)["check"] == {"type": "nav_below", "level": 1.0}


def test_ledger_due_boundary_inclusive(ledger_home):
    from quant import ledger

    ledger.add("past", "A", "inv", "2026-01-07")
    ledger.add("today", "A", "inv", "2026-01-08")
    ledger.add("future", "A", "inv", "2026-01-09")
    due = ledger.due(today="2026-01-08")
    assert sorted(e["statement"] for e in due) == ["past", "today"]


def test_ledger_review_auto_resolves_only_checkable(ledger_home, monkeypatch):
    from quant import ledger

    monkeypatch.setattr(ledger, "_latest_nav", lambda code: 1.5 if code == "A" else None)
    ledger.add("above", "A", "inv", "2026-01-01",
               check={"type": "nav_above", "level": 1.0})
    ledger.add("below", "A", "inv", "2026-01-01",
               check={"type": "nav_below", "level": 1.0})
    ledger.add("no check", "A", "inv", "2026-01-01")
    ledger.add("unknown nav", "ZZZ", "inv", "2026-01-01",
               check={"type": "nav_above", "level": 1.0})
    ledger.add("not due yet", "A", "inv", "2027-01-01",
               check={"type": "nav_above", "level": 1.0})

    out = ledger.review(today="2026-01-08")
    resolved = {e["statement"]: e["status"] for e in out["resolved"]}
    assert resolved == {"above": "won", "below": "lost"}
    assert all(e["evidence"]["auto"] for e in out["resolved"])
    unresolved = {e["statement"] for e in out["unresolved"]}
    assert unresolved == {"no check", "unknown nav"}
    # The not-due entry is untouched and stays open.
    assert len(ledger.open()) == 1 + len(out["unresolved"])


def test_ledger_corrupt_file_reads_empty(ledger_home):
    from quant import ledger

    hid = ledger.add("kept", "A", "inv", "2026-01-08")
    path = ledger_home / "quant_hypotheses.jsonl"
    path.write_text("{not json\n\x00", encoding="utf-8")
    assert ledger.open() == []  # corrupt → empty, no crash
    assert ledger.get(hid) is None
    # And the ledger is usable again after corruption.
    hid2 = ledger.add("new", "A", "inv", "2026-01-08")
    assert [e["statement"] for e in ledger.open()] == ["new"]


# ─── evidence ───


def test_evidence_record_check_and_source_filter():
    from quant import evidence

    run = evidence.new_run(run_id="t1")
    run.record("sharpe", 1.23, "quant.engine.backtest")
    run.record("equity", pd.Series([100.0, 101.0, 103.0]), "quant.engine.backtest")
    run.record("nav", [1.0, 1.1, 1.2], "finance.rbsa.fund_nav:A")

    out = run.check([
        ("sharpe claim", 1.23),                          # scalar, any source
        ("nav member", 1.1, "finance.rbsa.fund_nav:A"),  # member of a list
        ("series member", 101.0, "quant.engine.backtest"),
        ("wrong value", 9.99),
        ("wrong source", 1.23, "finance.rbsa.fund_nav:A"),
    ])
    by_label = {r["label"]: r for r in out}
    assert by_label["sharpe claim"]["status"] == "found"
    assert by_label["sharpe claim"]["where"] == ["quant.engine.backtest"]
    assert by_label["nav member"]["status"] == "found"
    assert by_label["series member"]["status"] == "found"
    assert by_label["wrong value"]["status"] == "not_found"
    assert by_label["wrong value"]["where"] is None
    assert by_label["wrong source"]["status"] == "not_found"

    s = run.summary()
    assert s["run_id"] == "t1" and s["n_records"] == 3
    assert sorted(s["recorded"]) == ["equity", "nav", "sharpe"]


def test_evidence_save_roundtrip(tmp_path):
    from quant import evidence

    run = evidence.new_run(run_id="t2")
    run.record("x", 42.0, "test.source")
    path = run.save(str(tmp_path / "ev" / "run.json"))
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    assert data["run_id"] == "t2"
    assert data["registry"]["x"]["test.source"]["value"] == 42.0


# ─── import hygiene ───


def test_import_quant_does_not_import_pandas():
    skills_dir = Path(__file__).resolve().parent.parent
    code = "import quant, sys; assert 'pandas' not in sys.modules; assert 'numpy' not in sys.modules; print('ok')"
    env = {**os.environ, "PYTHONPATH": str(skills_dir)}
    proc = subprocess.run([sys.executable, "-c", code], env=env,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert "ok" in proc.stdout
