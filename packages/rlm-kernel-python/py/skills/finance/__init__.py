"""Fund Copilot finance skill: daimon-native personal fund-analysis package.

Everything is owned by daimon — the analysis engine (portfolio accounting,
RBSA style regression, NAV prediction, hotspot radar, holdings look-through,
LiCaiTong import) lives in this package and ALL state lives under FINANCE_HOME
(env override, default `<daimon>/dsh-home/finance`). There is no web service
and no dependency on the old touzi checkout.

The kernel interpreter must be the miniconda Python (`pythonBin` in the
rlm-kernel-python config), which carries pandas/numpy/scipy/requests/dotenv.
`import finance` itself stays dependency-free and works under any interpreter;
only the data functions pull in heavy modules (lazily, per call).

Quick start inside a kernel cell:

    import finance
    await finance.status()               # FINANCE_HOME/interpreter/credential self-check
    await finance.set_holding("008401", shares=1000, cost_amount=1234.5, name="xx基金")
    await finance.add_op("008401", "buy", 100, 1.2345)   # board op, auto-rebuilds 看板
    path = await finance.dashboard()     # render the self-contained 看板 HTML
    ctx = await finance.agent_context()  # full investment context (no LLM call)

Data semantics:
- Money amounts are floats in yuan. Dates are `YYYYMMDD` for ledger/LCT APIs
  and `YYYY-MM-DD` for board ops (matching the board's display format).
- `lct_*` functions query Tencent LiCaiTong (理财通) and need `LCT_COOKIE` in
  `$FINANCE_HOME/.env`; they raise FinanceAuthError when the cookie expired —
  tell the user to copy a fresh www.tencentwm.com cookie into that file.
- `hotspots()` / `sectors()` can take minutes on a cold cache (full
  market-data rebuild); they run in a worker thread, just await them.
- Prefer reasoning over `agent_context()` / `portfolio()` / `hotspots()` data
  yourself instead of calling `analyze()` (which spends the LLM quota
  configured via MOONSHOT_API_KEY/KIMI_API_KEY in `$FINANCE_HOME/.env`).
- `dashboard()` re-renders the board; the Finance 看板 sidebar panel
  auto-reloads within ~5s (mtime poll). Mutating calls (`add_op`,
  `delete_op`, `set_holding`, `remove_holding`) rebuild by default
  (`rebuild=True`) so the board always reflects the latest state.

Configuration via environment variables (rarely needed):
- `FINANCE_HOME` — state root, default `<daimon>/dsh-home/finance`
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import time
from typing import Any

from ._state import FinanceError
from . import _state

_HOTSPOT_CACHE_SECONDS = 600  # 10-minute hotspot TTL

_modules: dict[str, Any] = {}


class FinanceAuthError(FinanceError):
    """The LiCaiTong cookie (`LCT_COOKIE` in `$FINANCE_HOME/.env`) expired."""


def _mod(name: str) -> Any:
    """Import one package submodule lazily, with an instructive error."""
    module = _modules.get(name)
    if module is not None:
        return module
    try:
        module = importlib.import_module(f".{name}", __package__)
    except ImportError as exc:
        raise FinanceError(
            f"failed to import finance submodule {name!r}: {exc}. The kernel interpreter "
            f"({sys.executable}) must be the miniconda Python with pandas/numpy/scipy/"
            "requests installed — check pythonBin in the rlm-kernel-python config."
        ) from exc
    except Exception as exc:
        raise FinanceError(f"finance submodule {name!r} raised at import time: {exc}") from exc
    _modules[name] = module
    return module


async def status() -> dict[str, Any]:
    """Self-check: FINANCE_HOME layout, interpreter deps, credentials. Safe to
    call repeatedly."""
    home = _state.home()
    deps = {}
    for pkg in ("pandas", "numpy", "scipy", "requests"):
        try:
            importlib.import_module(pkg)
            deps[pkg] = True
        except ImportError:
            deps[pkg] = False
    return {
        "status": "ok",
        "python": sys.executable,
        "finance_home": home,
        "home_exists": os.path.isdir(home),
        "lct_cookie_configured": bool(_state.credential("LCT_COOKIE")),
        "llm_key_configured": bool(_state.credential("MOONSHOT_API_KEY") or _state.credential("KIMI_API_KEY")),
        "deps": deps,
    }


# ---------------- 理财通 (requires LCT_COOKIE) ----------------


def _lct_error(exc: Exception) -> FinanceError:
    licaitong = _mod("licaitong")
    if isinstance(exc, licaitong.LctAuthError):
        return FinanceAuthError(
            f"理财通登录态失效: {exc}. 请把浏览器里 www.tencentwm.com 的最新 Cookie "
            f"写入 {_state.home()}/.env 的 LCT_COOKIE 后重试。"
        )
    return FinanceError(f"理财通接口调用失败: {exc}")


async def lct_positions(date: str | None = None) -> dict[str, Any]:
    """Tencent LiCaiTong real holdings plus per-fund daily P&L for `date`
    (YYYYMMDD, default yesterday). Returns `{"date", "holdings": {...},
    "items": [...]}`. Raises FinanceAuthError when the cookie expired."""

    def call() -> dict[str, Any]:
        licaitong = _mod("licaitong")
        data = licaitong.get_daily_position_changes(date)
        data.get("holdings", {}).pop("raw", None)
        return data

    try:
        return await asyncio.to_thread(call)
    except Exception as exc:
        raise _lct_error(exc) from exc


async def lct_transactions(start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """Tencent LiCaiTong transaction ledger, YYYYMMDD range, default last 90 days."""

    def call() -> dict[str, Any]:
        import datetime

        licaitong = _mod("licaitong")
        today = datetime.date.today()
        end_date = end or today.strftime("%Y%m%d")
        start_date = start or (today - datetime.timedelta(days=90)).strftime("%Y%m%d")
        client = licaitong.LicaitongClient()
        return {
            "start": start_date,
            "end": end_date,
            "transactions": client.get_transactions(start_date, end_date),
        }

    try:
        return await asyncio.to_thread(call)
    except Exception as exc:
        raise _lct_error(exc) from exc


# ---------------- 组合记账 ----------------


async def portfolio() -> dict[str, Any]:
    """Manual-ledger portfolio overview: `{"portfolio": {cost/P&L/estimates},
    "timeline": DCA timeline, "funds_catalog": {code: name}, "user_funds": [codes]}`.
    Note: a derived `state/portfolio.json` is persisted on every call."""

    def call() -> dict[str, Any]:
        pm = _mod("portfolio")
        return {
            "portfolio": pm.calculate_portfolio(),
            "timeline": pm.get_dca_timeline(),
            "funds_catalog": pm.get_all_funds(),
            "user_funds": sorted(pm.load_user_funds().keys()),
        }

    return await asyncio.to_thread(call)


async def transactions(fund: str | None = None) -> list[dict[str, Any]]:
    """Manual transaction records, newest first; `fund` filters by fund code."""

    def call() -> list[dict[str, Any]]:
        pm = _mod("portfolio")
        txs = pm.load_transactions()
        if fund:
            txs = [t for t in txs if t.get("fund_code") == fund]
        return sorted(txs, key=lambda x: (x.get("date", ""), x.get("created_at", "")), reverse=True)

    return await asyncio.to_thread(call)


async def add_transaction(
    fund_code: str,
    amount: float,
    type: str = "buy",
    date: str | None = None,
    nav: float | None = None,
    shares: float | None = None,
    fee: float = 0.0,
    note: str = "",
    fund_name: str | None = None,
) -> dict[str, Any]:
    """Record one ledger transaction. `type` is "buy" | "sell" | "dividend";
    `amount` in yuan; `date` YYYYMMDD (default today). Returns the stored record
    plus the recomputed portfolio. This is the accounting ledger — it does NOT
    appear on the board (use `add_op` for that)."""
    if type not in ("buy", "sell", "dividend"):
        raise ValueError(f"type must be buy/sell/dividend, got {type!r}")

    def call() -> dict[str, Any]:
        pm = _mod("portfolio")
        rec = pm.add_transaction(
            fund_code=fund_code,
            amount=amount,
            tx_type=type,
            tx_date=date,
            nav=nav,
            shares=shares,
            fee=fee,
            note=note,
            fund_name=fund_name,
        )
        return {"status": "success", "transaction": rec, "portfolio": pm.calculate_portfolio()}

    return await asyncio.to_thread(call)


async def delete_transaction(tx_id: str) -> dict[str, Any]:
    """Delete one ledger transaction by id. Returns the recomputed portfolio.
    Raises FinanceError when the id does not exist."""

    def call() -> dict[str, Any]:
        pm = _mod("portfolio")
        if not pm.delete_transaction(tx_id):
            raise FinanceError(f"未找到交易记录 {tx_id}")
        return {"status": "success", "deleted_id": tx_id, "portfolio": pm.calculate_portfolio()}

    return await asyncio.to_thread(call)


# ---------------- 看板状态（ops / 持仓基线） ----------------


async def ops() -> dict[str, Any]:
    """Board operation records (newest last, storage order), each tagged with
    its `index` for `delete_op`."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        items = [dict(o, index=i) for i, o in enumerate(board.load_ops())]
        return {"ops": items}

    return await asyncio.to_thread(call)


async def add_op(
    code: str,
    type: str,
    shares: float,
    price: float,
    date: str | None = None,
    note: str = "",
    rebuild: bool = True,
) -> dict[str, Any]:
    """Record one board operation (buy/sell with shares @ price). `date` is
    YYYY-MM-DD (default today). Selling more than the computed position returns
    a `warning` without writing — confirm with the user, then retry.
    `rebuild` (default True) re-renders the board so the sidebar panel picks it
    up within seconds. Requires a holdings baseline (`set_holding` first for
    new funds)."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        result = board.add_op(code, type, shares, price, date=date, note=note)
        if rebuild and "warning" not in result:
            try:
                result["dashboard"] = board.render()["path"]
            except FinanceError as exc:
                result["dashboard_error"] = str(exc)
        return result

    return await asyncio.to_thread(call)


async def delete_op(index: int, rebuild: bool = True) -> dict[str, Any]:
    """Delete one board operation by its `ops()` index. Raises FinanceError
    when out of range."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        result = board.delete_op(index)
        if rebuild:
            try:
                result["dashboard"] = board.render()["path"]
            except FinanceError as exc:
                result["dashboard_error"] = str(exc)
        return result

    return await asyncio.to_thread(call)


async def holdings() -> dict[str, Any]:
    """Merged baseline positions plus computed live position per fund
    (shares/cost/avg/nav/value/pnl), mirroring the board's math."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        return {
            "baseline": board.merged_holdings(),
            "positions": board.compute_positions(),
        }

    return await asyncio.to_thread(call)


async def set_holding(
    code: str,
    shares: float,
    cost_amount: float,
    name: str | None = None,
    rebuild: bool = True,
) -> dict[str, Any]:
    """Create or update one fund's baseline position (agent-managed, stored in
    `state/holdings.json`)."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        result = board.set_holding(code, shares, cost_amount, name)
        if rebuild:
            try:
                result["dashboard"] = board.render()["path"]
            except FinanceError as exc:
                result["dashboard_error"] = str(exc)
        return result

    return await asyncio.to_thread(call)


async def remove_holding(code: str, rebuild: bool = True) -> dict[str, Any]:
    """Drop one fund's baseline position override."""

    def call() -> dict[str, Any]:
        board = _mod("dashboard")
        result = board.remove_holding(code)
        if rebuild:
            try:
                result["dashboard"] = board.render()["path"]
            except FinanceError as exc:
                result["dashboard_error"] = str(exc)
        return result

    return await asyncio.to_thread(call)


# ---------------- 分析与雷达 ----------------


async def sectors(refresh: bool = False) -> dict[str, Any]:
    """Holdings look-through: `{"lookthrough": portfolio-level sector exposure,
    overlap and concentration risk, "all_fund_sectors": per-fund breakdown}`.
    Slow on a cold cache (fetches top-10 holdings per fund). `refresh` forces
    re-fetching the holdings cache."""

    def call() -> dict[str, Any]:
        ie = _mod("industry")
        pm = _mod("portfolio")
        all_fund_sectors: dict[str, Any] = {}
        for code in pm.get_all_funds():
            try:
                all_fund_sectors[code] = ie.analyze_fund_sectors(code, force_refresh=refresh)
            except TypeError:
                all_fund_sectors[code] = ie.analyze_fund_sectors(code)
            except Exception:
                all_fund_sectors[code] = {"error": "行业数据暂未提取"}
        return {
            "lookthrough": ie.analyze_portfolio_lookthrough(),
            "all_fund_sectors": all_fund_sectors,
            "stock_database_count": len(ie.STOCK_DATABASE),
        }

    return await asyncio.to_thread(call)


async def hotspots() -> dict[str, Any]:
    """Market hotspot radar: theme momentum/heat scores, candle signals, leaders
    and laggards, per-fund hotspot-chasing profiles, and top-pick stocks. Cached
    10 minutes (file mtime); a cold rebuild pulls full market data and can take
    minutes — it runs in a worker thread, just await it."""

    def call() -> dict[str, Any]:
        path = _state.state_path("hotspot.json")
        stale = (
            not os.path.exists(path)
            or (time.time() - os.path.getmtime(path)) > _HOTSPOT_CACHE_SECONDS
        )
        if stale:
            _mod("hotspot").build(verbose=False)
        return _state.read_json(path, {})

    return await asyncio.to_thread(call)


async def funds() -> dict[str, Any]:
    """Per-fund quotes, predicted NAV (band, R², MAE, factor weights, signals)
    and RBSA style results: `{"artifact": latest prediction artifact,
    "results": {code: result.json}}`. Pure state-file reads; freshness depends
    on when `run_daily_job()` last ran."""

    def call() -> dict[str, Any]:
        import glob

        pm = _mod("portfolio")
        artifact = _state.read_json(_state.state_path("artifact_latest.json"), {})
        results: dict[str, Any] = {}
        for code in pm.get_all_funds():
            res = _state.read_json(os.path.join(_state.fund_dir(code), "result.json"), None)
            if res is not None:
                results[code] = res
        # also pick up results for funds not in the registry (e.g. defaults)
        for path in glob.glob(os.path.join(_state.home(), "*/result.json")):
            res = _state.read_json(path, None)
            if isinstance(res, dict) and res.get("fund", {}).get("code"):
                results.setdefault(res["fund"]["code"], res)
        return {"artifact": artifact, "results": results}

    return await asyncio.to_thread(call)


async def fund_search(q: str) -> dict[str, Any]:
    """Search funds by code or name keyword (天天基金). Returns `{"results": [...]}`."""

    def call() -> dict[str, Any]:
        return {"results": _mod("portfolio").search_funds(q)}

    return await asyncio.to_thread(call)


async def add_fund(code: str, name: str | None = None) -> dict[str, Any]:
    """Add a fund to the user registry (name and latest NAV resolved automatically)."""

    def call() -> dict[str, Any]:
        return {"status": "success", "fund": _mod("portfolio").add_fund(code, name)}

    return await asyncio.to_thread(call)


async def register_fund(code: str, baskets: dict[str, Any], name: str | None = None) -> dict[str, Any]:
    """Register a fund for the prediction pipeline: writes `<code>/config.json`
    with RBSA factor baskets `{篮子名: {"market": "US"/"ASIA", "tickers":
    ["YF:QQQ", "IFIND:300476.SZ", ...]}}`. Infer baskets from the index the
    fund tracks. Raises when the config already exists (edit the file directly
    to change baskets)."""

    def call() -> dict[str, Any]:
        return _mod("portfolio").register_fund(code, baskets, name)

    return await asyncio.to_thread(call)


async def remove_fund(code: str) -> dict[str, Any]:
    """Remove a fund from the user registry (built-in funds and funds with
    transactions cannot be removed). Raises FinanceError when absent."""

    def call() -> dict[str, Any]:
        pm = _mod("portfolio")
        if not pm.remove_fund(code):
            raise FinanceError(f"基金 {code} 不在用户基金库中")
        return {"status": "success"}

    return await asyncio.to_thread(call)


async def accuracy() -> dict[str, Any]:
    """NAV-prediction track record: per-fund predicted vs official returns,
    including still-pending predictions (`status: "pending"`)."""

    def call() -> dict[str, Any]:
        import json

        pm = _mod("portfolio")
        artifact = _state.read_json(_state.state_path("artifact_latest.json"), {})
        track = _state.read_json(_state.state_path("track.json"), [])

        names = {f["code"]: f["name"] for f in artifact.get("funds", []) if f.get("name")}
        for code, name in pm.get_all_funds().items():
            names.setdefault(code, name)

        accuracy: list[dict[str, Any]] = []
        tracked = set()
        for t in track:
            rec = dict(t)
            rec["name"] = names.get(t["code"], t["code"])
            if rec.get("actualNav") is None and rec.get("predNav") and rec.get("predRet") not in (None, -100):
                try:
                    rec["actualNav"] = round(
                        t["predNav"] * (1 + t["actualRet"] / 100) / (1 + t["predRet"] / 100), 4
                    )
                    rec["actualNavApprox"] = True
                except Exception:
                    pass
            tracked.add((t["code"], t["navDate"]))
            accuracy.append(rec)

        # Predictions made but not yet officially published → pending review.
        pred_log = _state.state_path("pred_log.jsonl")
        latest_official = {f["code"]: f.get("officialDate", "") for f in artifact.get("funds", [])}
        if os.path.exists(pred_log):
            seen: dict[tuple[str, str], Any] = {}
            with open(pred_log, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    e = json.loads(line)
                    if e.get("mode") != "locked":
                        continue
                    seen[(e["code"], e["navDate"])] = e
            for (code, nav_date), e in sorted(seen.items(), key=lambda x: x[0][1], reverse=True):
                if (code, nav_date) in tracked:
                    continue
                if nav_date <= latest_official.get(code, ""):
                    continue
                accuracy.append(
                    {
                        "code": code,
                        "name": names.get(code, code),
                        "navDate": nav_date,
                        "predRet": e["predRet"],
                        "predNav": e["predNav"],
                        "madeAt": e["madeAt"],
                        "status": "pending",
                    }
                )
        return {"accuracy": accuracy}

    return await asyncio.to_thread(call)


async def agent_context() -> dict[str, Any]:
    """Assemble the full investment context WITHOUT calling any LLM:
    `{"portfolio", "recent_transactions", "lookthrough", "artifact", "hotspot"}`.
    Fetch it and do the investment reasoning yourself. Reads hotspot/artifact
    state as-is (never triggers a rebuild); call `hotspots()` first when
    freshness matters."""

    def call() -> dict[str, Any]:
        return _mod("agent").assemble_context()

    return await asyncio.to_thread(call)


async def analyze(mode: str = "dca", query: str = "") -> dict[str, Any]:
    """Run the packaged LLM investment reports. `mode` is one of "audit"
    (portfolio diagnosis), "brief" (daily review), "dca" (DCA advice), "ask"
    (free-form, pass `query`). Needs MOONSHOT_API_KEY/KIMI_API_KEY in
    `$FINANCE_HOME/.env` — prefer reasoning over `agent_context()` yourself."""
    if mode not in ("audit", "brief", "dca", "ask"):
        raise ValueError(f"mode must be audit/brief/dca/ask, got {mode!r}")

    def call() -> dict[str, Any]:
        import datetime

        fa = _mod("agent")
        if mode == "audit":
            report, title = fa.analyze_portfolio_audit(), "投资组合体检与穿透集中度诊断"
        elif mode == "brief":
            report, title = fa.analyze_daily_brief(), "每日复盘与市场归因报告"
        elif mode == "dca":
            report, title = fa.analyze_dca_advice(), "今日定投决策建议与加仓指引"
        else:
            q = query or "请对我的持仓组合给出一句综合点评"
            report, title = fa.ask_copilot(q), f"智能问答: {q[:24]}"
        return {
            "status": "success",
            "mode": mode,
            "title": title,
            "report": report,
            "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    return await asyncio.to_thread(call)


# ---------------- 每日流水线与看板 ----------------


async def run_daily_job(mode: str = "afternoon") -> dict[str, Any]:
    """Run the daily prediction pipeline: fetch market data → RBSA NAV
    predictions → lock predictions into pred_log → refresh artifact/track.
    `mode` is "morning" (pre-open estimate) or "afternoon" (post-close locked
    predictions, the usual one). Long-running (network + regression per fund);
    runs in a worker thread, just await it."""
    if mode not in ("morning", "afternoon"):
        raise ValueError(f"mode must be morning/afternoon, got {mode!r}")

    def call() -> dict[str, Any]:
        jobs = _mod("jobs")
        if mode == "morning":
            jobs.morning()
        else:
            jobs.afternoon()
        artifact = _state.read_json(_state.state_path("artifact_latest.json"), {})
        return {
            "status": "success",
            "mode": mode,
            "funds": len(artifact.get("funds", [])),
            "updated_at": artifact.get("updatedAt"),
        }

    return await asyncio.to_thread(call)


async def dashboard() -> dict[str, Any]:
    """Render the self-contained 看板 HTML (`$FINANCE_HOME/dashboard.html`, all
    data baked in, no service needed). The Finance 看板 sidebar panel and
    `http://127.0.0.1:3180/finance` serve this file and auto-reload on change.
    Without a prediction artifact (before the first `run_daily_job()`) the
    board still renders — holdings/ops visible, fund grid empty with a hint
    (`pending_artifact: True` in the result)."""

    def call() -> dict[str, Any]:
        return _mod("dashboard").render()

    return await asyncio.to_thread(call)


__all__ = [
    "FinanceAuthError",
    "FinanceError",
    "accuracy",
    "add_fund",
    "add_op",
    "add_transaction",
    "agent_context",
    "analyze",
    "dashboard",
    "delete_op",
    "delete_transaction",
    "fund_search",
    "funds",
    "holdings",
    "hotspots",
    "lct_positions",
    "lct_transactions",
    "ops",
    "portfolio",
    "remove_fund",
    "remove_holding",
    "register_fund",
    "run_daily_job",
    "sectors",
    "set_holding",
    "status",
    "transactions",
]
