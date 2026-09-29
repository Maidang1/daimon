"""UI snapshot builder: aggregates finance state into `state/ui_snapshot.json`.

The dsh-finance-board host half serves this file at `/finance/api/snapshot`,
and the React 终端 panel renders it natively. The snapshot is written
atomically by the same call sites that re-render the 看板, so the UI always
shows board-consistent numbers. Everything here is plain state-file reads plus
the board's own math (compute_positions) — no network, no LLM, no hotspot
rebuild — so it stays cheap enough to run on every `add_op`/`set_holding`.

`lookthrough` (行业穿透) is opt-in (`include_lookthrough=True`): on a cold
industry cache it fetches top-10 holdings per fund and can take minutes, so
only the daily pipeline passes that flag.
"""

from __future__ import annotations

import datetime
import glob
import os
from typing import Any

from . import _state


def _mod(name: str) -> Any:
    """Import a sibling submodule by its real module path.

    `from . import dashboard` cannot be used here: `__init__.py` defines
    public functions named `dashboard`/`jobs`/`hotspots` that shadow the
    submodules as package attributes, so attribute-style imports would bind
    the functions instead of the modules.
    """
    import importlib

    return importlib.import_module(f".{name}", __package__)

SNAPSHOT_VERSION = 1


def _load_artifact() -> tuple[dict[str, Any] | None, bool]:
    artifact = _state.read_json(_state.state_path("artifact_latest.json"), None)
    if artifact is None:
        return None, True
    return artifact, False


def _load_results() -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for path in glob.glob(os.path.join(_state.home(), "*/result.json")):
        res = _state.read_json(path, None)
        if isinstance(res, dict) and res.get("fund", {}).get("code"):
            results[res["fund"]["code"]] = res
    return results


def _positions_block() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    dashboard = _mod("dashboard")

    positions = dashboard.compute_positions()
    rows: list[dict[str, Any]] = []
    total_cost = 0.0
    total_value = 0.0
    valued = 0
    nav_asof = ""
    for code in sorted(positions):
        p = positions[code]
        cost = float(p.get("cost") or 0)
        value = p.get("value")
        pnl = p.get("pnl")
        total_cost += cost
        if value is not None:
            total_value += float(value)
            valued += 1
        if p.get("navDate", "") > nav_asof:
            nav_asof = p["navDate"]
        rows.append(
            {
                "code": code,
                "name": p.get("name") or code,
                "shares": p.get("shares"),
                "cost": round(cost, 2),
                "avg": p.get("avg"),
                "nav": p.get("nav"),
                "navDate": p.get("navDate", ""),
                "value": round(value, 2) if value is not None else None,
                "pnl": round(pnl, 2) if pnl is not None else None,
                "pnl_pct": round(pnl / cost * 100, 2) if pnl is not None and cost > 0 else None,
            }
        )
    pnl = total_value - total_cost
    summary = {
        "total_cost": round(total_cost, 2),
        "total_value": round(total_value, 2) if valued else None,
        "total_pnl": round(pnl, 2) if valued else None,
        "total_pnl_pct": round(pnl / total_cost * 100, 2) if valued and total_cost > 0 else None,
        "nav_asof": nav_asof,
        "positions_count": len(rows),
        "valued_count": valued,
    }
    return rows, summary


def _funds_block(artifact: dict[str, Any] | None, results: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    jobs = _mod("jobs")

    names: dict[str, str] = {}
    for f in (artifact or {}).get("funds", []):
        if f.get("code") and f.get("name"):
            names[f["code"]] = f["name"]
    for code, res in results.items():
        names.setdefault(code, res.get("fund", {}).get("name", code))

    try:
        track = jobs.load_track()
    except Exception:
        track = []

    funds: list[dict[str, Any]] = []
    for code in sorted(set(names) | set(results)):
        res = results.get(code, {})
        art_fund = next((f for f in (artifact or {}).get("funds", []) if f.get("code") == code), {})
        bt = res.get("backtest", {}) if isinstance(res, dict) else {}
        weights = res.get("weights", {}) if isinstance(res, dict) else {}
        top_weights = sorted(
            ({"name": k, "pct": v} for k, v in weights.items() if v >= 1),
            key=lambda x: -x["pct"],
        )[:5]
        recs = [t for t in track if t.get("code") == code and t.get("dev") is not None]
        accuracy: dict[str, Any] = {"n": len(recs)}
        if recs:
            avg_dev = sum(abs(t["dev"]) for t in recs) / len(recs)
            thr = max(0.5, 1.5 * (bt.get("mae60") or 1.0))
            accuracy["avg_dev"] = round(avg_dev, 2)
            accuracy["hit_rate"] = round(
                sum(1 for t in recs if abs(t["dev"]) <= thr) / len(recs) * 100, 1
            )
        pred = res.get("pred") if isinstance(res, dict) else None
        signals = res.get("signals") if isinstance(res, dict) else None
        nav_tail = res.get("nav_tail") if isinstance(res, dict) else None
        funds.append(
            {
                "code": code,
                "name": names.get(code, code),
                "official_nav": art_fund.get("officialNav") or res.get("official", {}).get("nav"),
                "official_date": art_fund.get("officialDate") or res.get("official", {}).get("date"),
                "pred_nav": art_fund.get("predNav") or (pred or {}).get("nav"),
                "pred_ret": art_fund.get("predRet") if art_fund.get("predRet") is not None else (pred or {}).get("ret"),
                "pred_date": (pred or {}).get("date"),
                "pred_label": res.get("status", {}).get("label"),
                "pred_note": res.get("status", {}).get("note"),
                "intraday": art_fund.get("intraday"),
                "r2": res.get("r2"),
                "mae": bt.get("mae"),
                "mae60": bt.get("mae60"),
                "p10": bt.get("p10"),
                "p90": bt.get("p90"),
                "weights": top_weights,
                "signals": signals,
                "nav_tail": nav_tail,
                "result_updated_at": res.get("updated_at"),
                "accuracy": accuracy,
            }
        )
    return funds


def _accuracy_block() -> dict[str, Any]:
    jobs = _mod("jobs")

    try:
        track = jobs.load_track()
    except Exception:
        track = []
    recs = [t for t in track if t.get("dev") is not None]
    block: dict[str, Any] = {"n": len(recs)}
    if recs:
        block["avg_dev"] = round(sum(abs(t["dev"]) for t in recs) / len(recs), 2)
        block["hit_rate"] = round(
            sum(1 for t in recs if abs(t["dev"]) <= max(0.5, 1.5)) / len(recs) * 100, 1
        )
    recent = sorted(track, key=lambda t: (t.get("navDate", ""), t.get("code", "")), reverse=True)[:10]
    block["recent"] = [
        {
            "code": t.get("code"),
            "navDate": t.get("navDate"),
            "predRet": t.get("predRet"),
            "actualRet": t.get("actualRet"),
            "dev": t.get("dev"),
        }
        for t in recent
    ]
    return block


def _hotspot_block() -> dict[str, Any]:
    path = _state.state_path("hotspot.json")
    data = _state.read_json(path, None)
    if not isinstance(data, dict) or not data:
        return {"data": None, "age_seconds": None}
    age = round(time_age(path), 1)
    return {"data": data, "age_seconds": age}


def time_age(path: str) -> float:
    """Seconds since `path` was last modified (0.0 when missing)."""
    try:
        import time

        return time.time() - os.path.getmtime(path)
    except OSError:
        return 0.0


def build(include_lookthrough: bool = False) -> dict[str, Any]:
    """Assemble the UI snapshot and write it to `state/ui_snapshot.json`.
    Returns the snapshot dict. Never raises on partial state: individual
    blocks degrade to empty values so the UI can render what exists."""
    dashboard = _mod("dashboard")

    artifact, pending_artifact = _load_artifact()
    results = _load_results()
    holdings, summary = _positions_block()
    ops = [dict(o, index=i) for i, o in enumerate(dashboard.load_ops())]
    summary["ops_count"] = len(ops)
    summary["funds_count"] = len(artifact.get("funds", [])) if artifact else 0

    lookthrough = None
    if include_lookthrough and holdings:
        try:
            industry = _mod("industry")

            lookthrough = industry.analyze_portfolio_lookthrough()
        except Exception as exc:  # cold cache / network failure → UI shows hint
            lookthrough = {"error": str(exc)[:200]}

    snapshot = {
        "version": SNAPSHOT_VERSION,
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "meta": {
            "finance_home": _state.home(),
            "pending_artifact": pending_artifact,
            "artifact_updated_at": (artifact or {}).get("updatedAt"),
            "artifact_job_kind": (artifact or {}).get("jobKind"),
            "artifact_summary": (artifact or {}).get("summary"),
        },
        "summary": summary,
        "holdings": holdings,
        "ops": ops,
        "funds": _funds_block(artifact, results),
        "accuracy": _accuracy_block(),
        "hotspot": _hotspot_block(),
        "lookthrough": lookthrough,
    }
    _state.write_json(_state.state_path("ui_snapshot.json"), snapshot)
    return snapshot
