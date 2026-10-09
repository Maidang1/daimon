"""Hypothesis / forecast ledger for quant work.

Append-only JSONL at ``$FINANCE_HOME/quant_hypotheses.jsonl``. FINANCE_HOME
and the atomic writers come from ``finance._state`` — the canonical owner of
both: ``quant`` and ``finance`` are sibling packages in the same skills tree,
so whenever this module is importable ``finance`` is too, and a missing
finance package fails loudly at call time (repo convention) instead of
silently writing to a mirrored default. Every entry is a falsifiable
statement with a required invalidation condition and a horizon date;
``review`` auto-resolves only entries whose check is explicitly
machine-checkable (``nav_above`` / ``nav_below`` against a known NAV).
Everything else stays ``open`` for the agent to judge — the ledger never
guesses. Corrupt files read as empty (with a warning); whole-file rewrites
are ``finance._state``'s atomic write (own mkstemp tmp + fsync + rename) and
appends go through its torn-line-repairing ``append_jsonl``.

Stdlib-only at import time; synchronous.
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import os
import uuid
from builtins import open as _builtin_open
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

_OUTCOMES = ("won", "lost", "void")
_CHECK_TYPES = ("nav_above", "nav_below")
# Sort-stable stand-in for an open entry with no horizon: it never reads "due".
_OPEN_HORIZON = "9999-12-31"


def _finance_state() -> Any:
    """``finance._state`` — the canonical owner of FINANCE_HOME and of the
    atomic JSONL writers. Imported per call (lazy); a missing finance package
    raises here, by design."""
    from finance import _state as state

    return state


def _ledger_path() -> str:
    return os.path.join(_finance_state().home(), "quant_hypotheses.jsonl")


def _load() -> List[Dict[str, Any]]:
    """Read all entries, skipping unparseable lines with a warning.

    A torn or partially corrupt file keeps every intact line; a wholly corrupt
    file reads as empty.
    """
    path = _ledger_path()
    if not os.path.exists(path):
        return []
    try:
        # _builtin_open, not the module-level ``open()`` public API below —
        # this module's own ``open`` shadows the builtin.
        with _builtin_open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError as exc:
        _log.warning("quant ledger %s unreadable (%s); reading as empty", path, exc)
        return []
    entries: List[Dict[str, Any]] = []
    dropped = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            dropped += 1
    if dropped:
        _log.warning("quant ledger %s: dropped %d unparseable line(s)", path, dropped)
    return entries


def add(
    statement: str,
    instrument: str,
    invalidation: str,
    horizon_date: str,
    source_run: Optional[str] = None,
    check: Optional[Dict[str, Any]] = None,
) -> str:
    """Record one falsifiable hypothesis.

    Args:
        statement: The claim, written so a third party could judge it.
        instrument: Fund code or other identifier the claim is about.
        invalidation: What observation would disprove it (required, non-empty).
        horizon_date: YYYY-MM-DD; after this date the entry shows up in due().
        source_run: Optional provenance tag (e.g. an evidence-run id).
        check: Optional machine-checkable predicate
            ``{"type": "nav_above" | "nav_below", "level": float}``; only
            entries with a check can be auto-resolved by review().

    Returns:
        The new entry's short id (hid).

    Raises:
        ValueError: empty statement/instrument/invalidation, bad horizon_date,
            or a malformed check.
    """
    if not statement or not str(statement).strip():
        raise ValueError("statement must be non-empty")
    if not instrument or not str(instrument).strip():
        raise ValueError("instrument must be non-empty")
    if not invalidation or not str(invalidation).strip():
        raise ValueError("invalidation must be non-empty — a hypothesis without a disproof condition is not falsifiable")
    try:
        datetime.date.fromisoformat(str(horizon_date))
    except ValueError:
        raise ValueError(f"horizon_date must be YYYY-MM-DD, got {horizon_date!r}") from None
    if check is not None:
        if not isinstance(check, dict) or check.get("type") not in _CHECK_TYPES:
            raise ValueError(f"check must be {{'type': {list(_CHECK_TYPES)}, 'level': float}}")
        try:
            level = float(check["level"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("check requires a numeric 'level'") from None
        if level != level or level in (float("inf"), float("-inf")):
            raise ValueError("check level must be finite")
        check = {"type": check["type"], "level": level}

    hid = uuid.uuid4().hex[:12]
    entry = {
        "id": hid,
        "created_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "statement": str(statement),
        "instrument": str(instrument),
        "invalidation": str(invalidation),
        "horizon_date": str(horizon_date),
        "status": "open",
        "resolved_at": None,
        "evidence": None,
        "source_run": source_run,
        "check": check,
    }
    _finance_state().append_jsonl(_ledger_path(), entry)
    return hid


def get(hid: str) -> Optional[Dict[str, Any]]:
    """Return one entry by id, or None when absent."""
    for entry in _load():
        if entry.get("id") == hid:
            return entry
    return None


def resolve(hid: str, outcome: str, evidence: Optional[Any] = None) -> Dict[str, Any]:
    """Close one entry with a judged outcome.

    Args:
        hid: Entry id from add().
        outcome: "won" | "lost" | "void".
        evidence: Optional free-form payload recorded with the resolution
            (fingerprint, NAV snapshot, reasoning trace reference, ...).

    Returns:
        The updated entry.

    Raises:
        ValueError: unknown hid, bad outcome, or the entry is already resolved.
    """
    if outcome not in _OUTCOMES:
        raise ValueError(f"outcome must be one of {_OUTCOMES}, got {outcome!r}")
    entries = _load()
    for entry in entries:
        if entry.get("id") == hid:
            if entry.get("status") != "open":
                raise ValueError(f"entry {hid} is already resolved ({entry.get('status')})")
            entry["status"] = outcome
            entry["resolved_at"] = datetime.datetime.now().isoformat(timespec="seconds")
            entry["evidence"] = evidence
            _finance_state().write_jsonl_atomic(_ledger_path(), entries)
            return entry
    raise ValueError(f"no hypothesis with id {hid!r}")


def open() -> List[Dict[str, Any]]:
    """All entries still awaiting resolution."""
    return [e for e in _load() if e.get("status") == "open"]


def due(today: Optional[str] = None) -> List[Dict[str, Any]]:
    """Open entries whose horizon_date has arrived (inclusive).

    Args:
        today: YYYY-MM-DD; defaults to the local calendar date.
    """
    today_s = today or datetime.date.today().isoformat()
    return [
        e for e in _load()
        if e.get("status") == "open" and e.get("horizon_date", _OPEN_HORIZON) <= today_s
    ]


def accuracy() -> Dict[str, Any]:
    """Resolution tallies: won/lost/void counts and the hit rate.

    hit_rate is won / (won + lost), or None when no entry was decided either
    way (void entries do not count as decisions).
    """
    counts = {"won": 0, "lost": 0, "void": 0}
    for entry in _load():
        status = entry.get("status")
        if status in counts:
            counts[status] += 1
    decided = counts["won"] + counts["lost"]
    return {
        **counts,
        "hit_rate": counts["won"] / decided if decided > 0 else None,
    }


def _latest_nav(code: str) -> Optional[float]:
    """Latest known official NAV for a fund code (lazy finance import).

    Indirection kept so tests can monkeypatch this getter without importing
    the finance package.
    """
    try:
        from finance.portfolio import get_latest_nav_for_fund

        return get_latest_nav_for_fund(code)
    except Exception:
        return None


def _check_won(check: Dict[str, Any], nav: float) -> Optional[bool]:
    """Did a machine-checkable predicate win at NAV ``nav``?

    Returns None when the stored check is malformed — a missing, non-numeric,
    or non-finite ``level``, which ``add`` rejects but a hand-edited ledger
    line can still carry. review() leaves such entries open instead of
    crashing on them.
    """
    try:
        level = float(check["level"])
    except (KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(level) or not math.isfinite(nav):
        return None
    return nav >= level if check["type"] == "nav_above" else nav <= level


def review(today: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """Auto-resolve due entries whose check is machine-checkable today.

    An entry resolves only when ALL of the following hold: it is due, it
    carries a ``check`` of type ``nav_above`` / ``nav_below``, its instrument
    resolves to a known latest NAV, that NAV is on the winning side of
    ``level`` (nav_above wins when latest NAV >= level, nav_below when
    <= level), and the check itself is well-formed. Everything else due
    stays due and is returned under ``unresolved`` for the agent to judge.
    Never guesses.

    Args:
        today: YYYY-MM-DD override for due(); defaults to the local date.

    Returns:
        ``{"resolved": [entry...], "unresolved": [entry...]}``.
    """
    entries = _load()
    resolved: List[Dict[str, Any]] = []
    unresolved: List[Dict[str, Any]] = []
    changed = False
    today_s = today or datetime.date.today().isoformat()

    for entry in entries:
        if entry.get("status") != "open" or entry.get("horizon_date", _OPEN_HORIZON) > today_s:
            continue
        check = entry.get("check")
        nav = None
        if isinstance(check, dict) and check.get("type") in _CHECK_TYPES:
            nav = _latest_nav(str(entry.get("instrument", "")))
        if nav is None:
            unresolved.append(entry)
            continue
        won = _check_won(check, float(nav))
        if won is None:
            # Malformed check: never guess, never crash — leave it open.
            unresolved.append(entry)
            continue
        nav = float(nav)
        entry["status"] = "won" if won else "lost"
        entry["resolved_at"] = datetime.datetime.now().isoformat(timespec="seconds")
        entry["evidence"] = {
            "check": check,
            "latest_nav": nav,
            "auto": True,
        }
        resolved.append(entry)
        changed = True

    if changed:
        _finance_state().write_jsonl_atomic(_ledger_path(), entries)
    return {"resolved": resolved, "unresolved": unresolved}
