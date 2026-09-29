"""Native dashboard renderer and board-state store for the finance package.

Forked from touzi/build_dashboard.py, but fully daimon-owned: every input is
read from FINANCE_HOME (see `_state`) and the rendered self-contained HTML is
written to `$FINANCE_HOME/dashboard.html`, which the dsh-finance-board plugin
serves at `/finance`. The touzi checkout is never touched.

Board-facing mutable state (all under `$FINANCE_HOME/state/`):
- `ops.json`       — `{"ops": [...]}` operation records shown on the board
                     (date YYYY-MM-DD, code, type buy/sell, shares, price,
                     amount, note). Written by `add_op`/`delete_op`.
- `holdings.json`  — `{"holdings": {code: {name, shares, cost_amount}}}`
                     baseline positions managed by the agent via
                     `set_holding`/`remove_holding`. Merged OVER the per-fund
                     `<code>/config.json` holdings (override wins, may add
                     funds that have no config yet).
"""

from __future__ import annotations

import glob
import json
import os
import re
from typing import Any

from . import _state

_TEMPLATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard_template.html")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------- board state: ops ----------------


def load_ops() -> list[dict[str, Any]]:
    """All operation records in storage order."""
    data = _state.read_json(_state.state_path("ops.json"), {"ops": []})
    ops = data.get("ops", [])
    return ops if isinstance(ops, list) else []


def _save_ops(ops: list[dict[str, Any]]) -> None:
    _state.write_json(_state.state_path("ops.json"), {"ops": ops})


# ---------------- board state: holdings baseline ----------------


def load_holding_overrides() -> dict[str, dict[str, Any]]:
    data = _state.read_json(_state.state_path("holdings.json"), {"holdings": {}})
    holdings = data.get("holdings", {})
    return holdings if isinstance(holdings, dict) else {}


def _save_holding_overrides(holdings: dict[str, dict[str, Any]]) -> None:
    _state.write_json(_state.state_path("holdings.json"), {"holdings": holdings})


def merged_holdings() -> dict[str, dict[str, Any]]:
    """Baseline positions: per-fund `<code>/config.json` holdings merged with
    the agent-managed overrides in `state/holdings.json` (override wins and may
    introduce funds that have no config.json yet)."""
    merged: dict[str, dict[str, Any]] = {}
    for path in glob.glob(os.path.join(_state.home(), "*/config.json")):
        cfg = _state.read_json(path, {})
        holdings = cfg.get("holdings")
        if isinstance(holdings, dict) and cfg.get("code"):
            merged[cfg["code"]] = {"name": cfg.get("name", ""), **holdings}
    for code, override in load_holding_overrides().items():
        base = merged.get(code, {})
        merged[code] = {**base, **override}
    return merged


def set_holding(code: str, shares: float, cost_amount: float, name: str | None = None) -> dict[str, Any]:
    """Create or update the baseline position of one fund."""
    if not code or not code.isdigit():
        raise _state.FinanceError(f"基金代码应为数字字符串，got {code!r}")
    if shares < 0 or cost_amount < 0:
        raise _state.FinanceError("shares 与 cost_amount 不能为负")
    holdings = load_holding_overrides()
    entry: dict[str, Any] = {"shares": round(float(shares), 2), "cost_amount": round(float(cost_amount), 2)}
    if name:
        entry["name"] = name
    elif code in holdings and holdings[code].get("name"):
        entry["name"] = holdings[code]["name"]
    holdings[code] = entry
    _save_holding_overrides(holdings)
    return {"status": "success", "code": code, "holding": merged_holdings()[code]}


def remove_holding(code: str) -> dict[str, Any]:
    """Drop one fund's baseline position override. Funds that only exist in a
    `<code>/config.json` cannot be removed here (edit the config instead)."""
    holdings = load_holding_overrides()
    if code not in holdings:
        raise _state.FinanceError(f"基金 {code} 不在持仓基线覆盖表（state/holdings.json）中")
    del holdings[code]
    _save_holding_overrides(holdings)
    return {"status": "success", "removed": code}


# ---------------- position math (mirror of the board's computePos) ----------------


def _fund_navs(artifact: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["code"]: {"nav": f.get("officialNav"), "date": f.get("officialDate", "")}
            for f in artifact.get("funds", []) if f.get("code")}


def compute_positions(
    ops: list[dict[str, Any]] | None = None,
    artifact: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Python replica of the board's computePos, per fund with a baseline."""
    if ops is None:
        ops = load_ops()
    if artifact is None:
        artifact = _state.read_json(_state.state_path("artifact_latest.json"), {})
    navs = _fund_navs(artifact)
    positions: dict[str, dict[str, Any]] = {}
    for code, init in merged_holdings().items():
        shares = float(init.get("shares", 0))
        cost = float(init.get("cost_amount", 0))
        mine = sorted((o for o in ops if o.get("code") == code), key=lambda o: o.get("date", ""))
        for o in mine:
            if o.get("type") == "buy":
                shares += o["shares"]
                cost += o["amount"]
            else:
                avg = cost / shares if shares > 0 else 0
                shares -= o["shares"]
                cost -= o["shares"] * avg
        nav = navs.get(code, {}).get("nav")
        value = shares * nav if nav is not None else None
        positions[code] = {
            "code": code,
            "name": init.get("name") or code,
            "shares": shares,
            "cost": cost,
            "avg": cost / shares if shares > 0 else None,
            "nav": nav,
            "navDate": navs.get(code, {}).get("date", ""),
            "value": value,
            "pnl": (value - cost) if value is not None else None,
        }
    return positions


# ---------------- ops write API ----------------


def add_op(
    code: str,
    type: str,
    shares: float,
    price: float,
    date: str | None = None,
    note: str = "",
) -> dict[str, Any]:
    """Record one buy/sell operation onto the board. Returns the stored op
    (plus a `warning` when selling more than the computed position)."""
    if type not in ("buy", "sell"):
        raise _state.FinanceError(f"type 必须是 buy/sell，got {type!r}")
    if shares <= 0:
        raise _state.FinanceError("shares 必须大于 0")
    if price <= 0:
        raise _state.FinanceError("price 必须大于 0")
    holdings = merged_holdings()
    if code not in holdings:
        raise _state.FinanceError(
            f"基金 {code} 没有持仓基线，看板无法展示它的操作。"
            "请先 finance.set_holding 建立基线（或让该基金生成 config.json）。"
        )
    import datetime

    op_date = date or datetime.date.today().isoformat()
    if not _DATE_RE.match(op_date):
        raise _state.FinanceError(f"date 应为 YYYY-MM-DD，got {op_date!r}")
    op = {
        "date": op_date,
        "code": code,
        "type": type,
        "shares": round(float(shares), 2),
        "price": round(float(price), 4),
        "amount": round(float(shares) * float(price), 2),
        "note": note,
    }
    result: dict[str, Any] = {"status": "success", "op": op}
    if type == "sell":
        pos = compute_positions().get(code)
        if pos is not None and op["shares"] > pos["shares"] + 1e-9:
            result["warning"] = (
                f"卖出份额 {op['shares']} 超过当前持有 {round(pos['shares'], 2)} 份，"
                "请与用户确认后再继续（确认后可重放本调用）。"
            )
            return result
    ops = load_ops()
    ops.append(op)
    _save_ops(ops)
    result["ops_count"] = len(ops)
    return result


def delete_op(index: int) -> dict[str, Any]:
    """Delete one operation by its index in `load_ops()` order."""
    ops = load_ops()
    if not 0 <= index < len(ops):
        raise _state.FinanceError(f"操作记录下标越界: {index}（共 {len(ops)} 条）")
    removed = ops.pop(index)
    _save_ops(ops)
    return {"status": "success", "removed": removed, "ops_count": len(ops)}


# ---------------- renderer ----------------


def _load_template() -> str:
    with open(_TEMPLATE_PATH, encoding="utf-8") as fh:
        return fh.read()


def render() -> dict[str, Any]:
    """Render the self-contained board HTML to `$FINANCE_HOME/dashboard.html`.

    Data baked in: prediction artifact, per-fund result.json, merged holdings
    baseline and ops — all read from FINANCE_HOME. When no prediction artifact
    exists yet (fresh FINANCE_HOME before the first `run_daily_job()`), the
    board renders with an empty fund grid plus a hint, so holdings/ops are
    visible from day one."""
    artifact_path = _state.state_path("artifact_latest.json")
    artifact = _state.read_json(artifact_path, None)
    pending_artifact = artifact is None
    if pending_artifact:
        artifact = {
            "jobKind": "未生成",
            "jobLabel": "",
            "updatedAt": "—",
            "summary": "预测数据尚未生成——在会话里让 agent 先 register_fund 再 run_daily_job()。",
            "notes": "",
            "funds": [],
            "track": [],
            "corrections": [],
        }

    results: dict[str, Any] = {}
    for path in glob.glob(os.path.join(_state.home(), "*/result.json")):
        res = _state.read_json(path, None)
        if isinstance(res, dict) and res.get("fund", {}).get("code"):
            results[res["fund"]["code"]] = res

    data = {
        "artifact": artifact,
        "results": results,
        "holdingsInit": merged_holdings(),
        "opsBaseline": load_ops(),
    }
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = _load_template().replace("__DATA__", blob)

    out = os.path.join(_state.home(), "dashboard.html")
    _state.ensure_dir(os.path.dirname(out))
    tmp = f"{out}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html)
    os.replace(tmp, out)
    return {"status": "success", "path": out, "funds": len(artifact.get("funds", [])), "ops": len(data["opsBaseline"]), "pending_artifact": pending_artifact}
