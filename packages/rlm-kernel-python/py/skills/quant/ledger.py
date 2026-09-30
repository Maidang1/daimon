"""Hypothesis / forecast ledger for quant work.

Append-only JSONL at ``$FINANCE_HOME/quant_hypotheses.jsonl`` (FINANCE_HOME
resolved the same way ``finance._state`` resolves it — imported lazily so this
module never hard-depends on the finance package being importable). Every
entry is a falsifiable statement with a required invalidation condition and a
horizon date; ``review`` auto-resolves only entries whose check is explicitly
machine-checkable (``nav_above`` / ``nav_below`` against a known NAV).
Everything else stays ``open`` for the agent to judge — the ledger never
guesses. Corrupt files read as empty (with a warning); whole-file rewrites are
atomic (own mkstemp tmp + fsync + rename, via ``finance._state`` when
available, mirrored locally otherwise).

Stdlib-only at import time; synchronous.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import uuid
from builtins import open as _builtin_open
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)

# Mirror of finance._state._DEFAULT_HOME, used only when the finance package
# cannot be imported. Keep in sync with that module.
_FALLBACK_FINANCE_HOME = "/Users/bytedance/codes/open-source/daimon/dsh-home/finance"

_OUTCOMES = ("won", "lost", "void")
_CHECK_TYPES = ("nav_above", "nav_below")


def _finance_state() -> Any:
    """Import finance._state lazily; None when finance is not importable."""
    try:
        from finance import _state as state

        return state
    except Exception:
        return None


def _finance_home() -> str:
    state = _finance_state()
    if state is not None:
        return state.home()
    return os.environ.get("FINANCE_HOME", _FALLBACK_FINANCE_HOME)


def _ledger_path() -> str:
    return os.path.join(_finance_home(), "quant_hypotheses.jsonl")


def _write_jsonl_atomic(path: str, records: List[Dict[str, Any]]) -> None:
    state = _finance_state()
    if state is not None:
        state.write_jsonl_atomic(path, records)
        return
    import tempfile

    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for record in records:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.replace(tmp, path)


def _append_jsonl(path: str, record: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sep = ""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with _builtin_open(path, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            if fh.read(1) != b"\n":
                # Torn last line (no trailing newline): start a fresh line so
                # the append does not fuse with corrupt bytes.
                sep = "\n"
    with _builtin_open(path, "a", encoding="utf-8") as fh:
        fh.write(sep + json.dumps(record, ensure_ascii=False) + "\n")


def _load() -> List[Dict[str, Any]]:
    """Read all entries, skipping unparseable lines with a warning.

    A torn or partially corrupt file keeps every intact line; a wholly corrupt
    file reads as empty.
    """
    path = _ledger_path()
    if not os.path.exists(path):
        return []
    try:
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


def _store_all(entries: List[Dict[str, Any]]) -> None:
    _write_jsonl_atomic(_ledger_path(), entries)


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
    _append_jsonl(_ledger_path(), entry)
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
            _store_all(entries)
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
    return [e for e in _load() if e.get("status") == "open" and e.get("horizon_date", "9999-12-31") <= today_s]


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


def review(today: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    """Auto-resolve due entries whose check is machine-checkable today.

    An entry resolves only when ALL of the following hold: it is due, it
    carries a ``check`` of type ``nav_above`` / ``nav_below``, its instrument
    resolves to a known latest NAV, and that NAV is on the winning side of
    ``level`` (nav_above wins when latest NAV >= level, nav_below when
    <= level). Everything else due stays due and is returned under
    ``unresolved`` for the agent to judge. Never guesses.

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
        if entry.get("status") != "open" or entry.get("horizon_date", "9999-12-31") > today_s:
            continue
        check = entry.get("check")
        nav = None
        if isinstance(check, dict) and check.get("type") in _CHECK_TYPES:
            nav = _latest_nav(str(entry.get("instrument", "")))
        if nav is None:
            unresolved.append(entry)
            continue
        nav = float(nav)
        level = float(check["level"])
        won = nav >= level if check["type"] == "nav_above" else nav <= level
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
        _store_all(entries)
    return {"resolved": resolved, "unresolved": unresolved}
