"""Agent-published analysis views and alerts — the chat→panel channel.

The chat-side agent analyzes with `finance`/`quant` and calls `publish_view()`
to land a view document under ``state/views/<id>.json``; the Finance 终端
panel (``/finance/api/views`` + ``/finance/api/view/<id>``) renders it as a
dynamic tab within one poll (~5s). State file is the protocol — same pattern
as ``ui_snapshot.json``, no message channel of our own.

View documents are immutable-ish: ``publish_view`` with the same ``view_id``
overwrites in place (atomic write), so a re-run refreshes the tab a user
already has open. ``discard_view`` archives instead of deleting — the archive
is the audit trail of what the agent showed.

Block types (the panel renders exactly these four):

- ``{"type": "text", "text": str}``                       — 分析结论文字
- ``{"type": "chart", "title": str, "series": [...]}``    — 时序对比图
- ``{"type": "table", "title": str, "columns": [...], "rows": [...]}``
- ``{"type": "kpis", "items": [{label, value, sub?, tone?}]}``

Chart series accept points as a list of ``{"date", "value"}``, a
``{date: value}`` mapping, or a pandas Series / single-column DataFrame
(date index) — whatever the analysis just produced.

Alerts (``state/alerts.json``) are the proactive channel: the trading-day
heartbeat and in-chat analysis both append; the panel renders the newest as a
banner and the agent reports the important ones in conversation. Dismissal is
a panel-side POST that removes the entry — acknowledged, not just hidden.
"""

from __future__ import annotations

import datetime
import os
import re
import secrets
from typing import Any

from . import _state

#: Alerts file keeps only the newest this many entries.
MAX_ALERTS = 50

#: View ids are generated as 12-hex; user-supplied ids must survive a URL path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_BLOCK_TYPES = ("text", "chart", "table", "kpis")
_TONES = ("up", "down", "warn", "plain")
_LEVELS = ("info", "warn", "action")


def views_dir() -> str:
    """``state/views/`` — one JSON document per published view."""
    return _state.ensure_dir(os.path.join(_state.state_dir(), "views"))


def archive_dir() -> str:
    return _state.ensure_dir(os.path.join(views_dir(), ".archive"))


def _new_id() -> str:
    return secrets.token_hex(6)


def _now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _check_id(view_id: str) -> str:
    if not isinstance(view_id, str) or not _ID_RE.match(view_id):
        raise _state.FinanceError(
            f"view id 必须是 1-64 位字母/数字/_/-， got {view_id!r}"
        )
    return view_id


def _coerce_points(obj: Any) -> list[dict[str, Any]]:
    """Turn the caller's series data into ``[{"date", "value"}]``.

    Accepts a list of dicts, a ``{date: value}`` mapping, or a pandas
    Series / single-column DataFrame with a date-like index.
    """
    if hasattr(obj, "index") and hasattr(obj, "values") and not isinstance(obj, dict):
        try:
            obj = [
                {"date": str(idx), "value": float(val)}
                for idx, val in zip(list(obj.index), list(obj.values))
            ]
        except Exception as exc:
            raise _state.FinanceError(f"chart 序列无法从 DataFrame/Series 转换: {exc}")
    if isinstance(obj, dict):
        obj = [{"date": str(k), "value": v} for k, v in obj.items()]
    if not isinstance(obj, list) or not obj:
        raise _state.FinanceError("chart 序列 points 必须是非空列表 / 映射 / Series")
    points: list[dict[str, Any]] = []
    for item in obj:
        if isinstance(item, dict):
            date, value = item.get("date"), item.get("value")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            date, value = item[0], item[1]
        else:
            raise _state.FinanceError(f"chart 点必须是 {{date, value}}， got {item!r}")
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise _state.FinanceError(f"chart 点的 value 必须是数字， got {value!r}")
        if not (value == value and abs(value) != float("inf")):  # NaN / inf
            continue
        points.append({"date": str(date), "value": value})
    if len(points) < 2:
        raise _state.FinanceError("chart 序列至少需要 2 个有效点")
    return points


def _normalize_block(block: Any) -> dict[str, Any]:
    """Validate one block and project it down to the keys the panel renders.

    The agent authors blocks as loose dicts mid-analysis; the panel must not
    receive whatever shape happened to fall out of the notebook. Raising here
    (before anything is written) beats a blank tab the user has to close.
    """
    if not isinstance(block, dict) or block.get("type") not in _BLOCK_TYPES:
        raise _state.FinanceError(
            f"block 必须是带 type 的字典，type ∈ {_BLOCK_TYPES}， got {block!r:.200}"
        )
    kind = block["type"]

    if kind == "text":
        text = block.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _state.FinanceError("text block 需要非空字符串 text")
        return {"type": "text", "text": text}

    out: dict[str, Any] = {"type": kind}
    title = block.get("title")
    if isinstance(title, str) and title:
        out["title"] = title

    if kind == "chart":
        series = block.get("series")
        if not isinstance(series, list) or not series:
            raise _state.FinanceError("chart block 需要非空 series 列表")
        normalized = []
        for s in series:
            if not isinstance(s, dict) or not isinstance(s.get("name"), str) or not s["name"]:
                raise _state.FinanceError(f"chart 序列需要 name， got {s!r:.160}")
            normalized.append({"name": s["name"], "points": _coerce_points(s.get("points"))})
        out["series"] = normalized
    elif kind == "table":
        columns = block.get("columns")
        rows = block.get("rows")
        if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
            raise _state.FinanceError("table block 需要字符串 columns 列表")
        if not isinstance(rows, list):
            raise _state.FinanceError("table block 需要 rows 列表")
        width = len(columns)
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) > width:
                raise _state.FinanceError(
                    f"table 行必须是长度 ≤ columns 的列表， got {row!r:.160}"
                )
        out["columns"] = columns
        out["rows"] = [list(r) for r in rows]
    else:  # kpis
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise _state.FinanceError("kpis block 需要非空 items 列表")
        normalized = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("label"), str) \
                    or not isinstance(item.get("value"), str):
                raise _state.FinanceError(f"kpi 需要字符串 label/value， got {item!r:.160}")
            tone = item.get("tone", "plain")
            if tone not in _TONES:
                raise _state.FinanceError(f"kpi tone 必须是 {_TONES}， got {tone!r}")
            entry: dict[str, Any] = {"label": item["label"], "value": item["value"], "tone": tone}
            if isinstance(item.get("sub"), str):
                entry["sub"] = item["sub"]
            normalized.append(entry)
        out["items"] = normalized
    return out


def publish_view(
    title: str,
    blocks: list[dict[str, Any]],
    view_id: str | None = None,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Publish (or overwrite) one analysis view → ``state/views/<id>.json``.

    ``title`` shows as the panel tab label; ``blocks`` render in order (text /
    chart / table / kpis — see module docstring); ``prompt`` is the prebuilt
    question the panel's 「问问 daimon」 button sends back to the conversation.
    Returns the stored document with its id.
    """
    if not isinstance(title, str) or not title.strip():
        raise _state.FinanceError("publish_view 需要非空 title")
    if not isinstance(blocks, list) or not blocks:
        raise _state.FinanceError("publish_view 需要非空 blocks 列表")
    vid = _check_id(view_id) if view_id else _new_id()
    normalized = [_normalize_block(b) for b in blocks]
    doc: dict[str, Any] = {
        "id": vid,
        "title": title.strip(),
        "created_at": _now(),
        "blocks": normalized,
    }
    if isinstance(prompt, str) and prompt.strip():
        doc["prompt"] = prompt.strip()
    _state.write_json(os.path.join(views_dir(), f"{vid}.json"), doc)
    return doc


def list_views() -> list[dict[str, Any]]:
    """Every live view's metadata (no blocks), newest first."""
    directory = views_dir()
    metas: list[dict[str, Any]] = []
    for name in os.listdir(directory):
        if not name.endswith(".json"):
            continue
        doc = _state.read_json(os.path.join(directory, name), None)
        if not isinstance(doc, dict) or not doc.get("id"):
            continue
        metas.append(
            {
                "id": doc["id"],
                "title": doc.get("title", doc["id"]),
                "created_at": doc.get("created_at", ""),
                "prompt": doc.get("prompt"),
                "mtime": datetime.datetime.fromtimestamp(
                    os.path.getmtime(os.path.join(directory, name))
                ).isoformat(),
            }
        )
    metas.sort(key=lambda m: m["mtime"], reverse=True)
    return metas


def get_view(view_id: str) -> dict[str, Any] | None:
    """One full view document (blocks included), or None when absent."""
    _check_id(view_id)
    return _state.read_json(os.path.join(views_dir(), f"{view_id}.json"), None)


def discard_view(view_id: str) -> dict[str, Any]:
    """Archive one view (move to ``views/.archive/``); raises when absent."""
    _check_id(view_id)
    src = os.path.join(views_dir(), f"{view_id}.json")
    if not os.path.exists(src):
        raise _state.FinanceError(f"视图 {view_id} 不存在")
    os.replace(src, os.path.join(archive_dir(), f"{view_id}.json"))
    return {"status": "success", "archived": view_id}


# ---------------- 主动提醒 ----------------


def _alerts_path() -> str:
    return _state.state_path("alerts.json")


def alert(
    title: str,
    level: str = "info",
    detail: str | None = None,
    prompt: str | None = None,
) -> dict[str, Any]:
    """Append one alert → ``state/alerts.json`` (keeps the newest 50).

    ``level``: "info" (面板青色) / "warn" (关注) / "action" (需要处理).
    ``prompt`` powers the panel banner's 「问问 daimon」 button. The trading-day
    heartbeat uses this for hypothesis due-dates, prediction anomalies and
    portfolio moves; important ones are ALSO reported in conversation — one
    event, two channels.
    """
    if not isinstance(title, str) or not title.strip():
        raise _state.FinanceError("alert 需要非空 title")
    if level not in _LEVELS:
        raise _state.FinanceError(f"level 必须是 {_LEVELS}， got {level!r}")
    entry: dict[str, Any] = {
        "id": _new_id(),
        "title": title.strip(),
        "level": level,
        "created_at": _now(),
    }
    if isinstance(detail, str) and detail.strip():
        entry["detail"] = detail.strip()
    if isinstance(prompt, str) and prompt.strip():
        entry["prompt"] = prompt.strip()
    alerts = _state.read_json(_alerts_path(), [])
    if not isinstance(alerts, list):
        alerts = []
    alerts.append(entry)
    _state.write_json(_alerts_path(), alerts[-MAX_ALERTS:])
    return entry


def list_alerts() -> list[dict[str, Any]]:
    alerts = _state.read_json(_alerts_path(), [])
    return alerts if isinstance(alerts, list) else []


def dismiss_alert(alert_id: str) -> dict[str, Any]:
    """Remove one alert by id (panel ✕); raises when absent."""
    if not isinstance(alert_id, str) or not alert_id:
        raise _state.FinanceError("dismiss_alert 需要 alert id")
    alerts = list_alerts()
    remaining = [a for a in alerts if a.get("id") != alert_id]
    if len(remaining) == len(alerts):
        raise _state.FinanceError(f"提醒 {alert_id} 不存在")
    _state.write_json(_alerts_path(), remaining)
    return {"status": "success", "dismissed": alert_id}
