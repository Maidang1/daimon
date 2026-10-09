"""Run-evidence provenance helper.

RunEvidence records what data a run produced (as fingerprints, not copies) and
later answers "does this claimed value appear in what I recorded?" via
``check``. This is an ADVISORY self-check for the agent: it catches stale or
hallucinated numbers when writing up a result. It is NOT an enforcement gate —
nothing in daimon consumes it to block or certify anything, and a claim that
checks "found" is only as honest as the recording was.

Fingerprints keep scalars verbatim and containers as ``{"len"|"shape",
"min", "max"}`` plus the value list for containers up to 1000 entries (Series
values, DataFrame flattened cells); larger containers fingerprint by extents
only. Everything is in-memory; ``save(path)`` writes strict JSON via
``validation.to_jsonable``, so non-finite recorded values (a NAV series with
a gap, an ``inf`` metric) serialise as ``None`` instead of crashing.

``check`` reports HOW a claim matched — ``"value"`` (equals a recorded
scalar), ``"member"`` (contained in recorded values), or ``"range"`` (inside
an extents-only fingerprint's min/max, a weaker guarantee) — because the
three strengths are not interchangeable evidence.

Stdlib-only at import time.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import tempfile
from typing import Any, Dict, List, Optional, Tuple

_VALUES_CAP = 1000

Fingerprint = Dict[str, Any]
Claim = Tuple[str, Any, Optional[str]]


def _fingerprint(data: Any) -> Fingerprint:
    """Fingerprint scalar/list/Series/DataFrame data without keeping a copy."""
    fp: Fingerprint = {"recorded_at": datetime.datetime.now().isoformat(timespec="seconds")}

    def _extents(values: List[float]) -> None:
        finite = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)
                  and math.isfinite(float(v))]
        if finite:
            fp["min"] = min(finite)
            fp["max"] = max(finite)
        if len(values) <= _VALUES_CAP:
            fp["values"] = values

    if hasattr(data, "to_numpy") and hasattr(data, "shape"):
        # pandas Series or DataFrame (duck-typed so pandas need not be imported).
        fp["kind"] = "dataframe" if getattr(data, "ndim", 2) == 2 else "series"
        fp["shape"] = list(data.shape)
        flat = data.to_numpy().ravel().tolist()
        fp["len"] = len(flat)
        _extents(flat)
    elif isinstance(data, (list, tuple)):
        fp["kind"] = "list"
        fp["len"] = len(data)
        _extents(list(data))
    elif isinstance(data, (int, float)) and not isinstance(data, bool):
        fp["kind"] = "scalar"
        fp["value"] = float(data)
    elif isinstance(data, (str, bool)):
        fp["kind"] = "scalar"
        fp["value"] = data
    else:
        fp["kind"] = "repr"
        fp["value"] = repr(data)
    return fp


def _match_kind(fp: Fingerprint, value: Any) -> Optional[str]:
    """How a claim matches a fingerprint, or None when it does not.

    ``"value"`` — equals a recorded scalar; ``"member"`` — contained in the
    recorded values of a container; ``"range"`` — merely inside an
    extents-only fingerprint's [min, max], which is a much weaker statement
    than the first two.
    """
    if fp.get("kind") == "scalar":
        return "value" if value == fp.get("value") else None
    if "values" in fp:
        return "member" if any(v == value for v in fp["values"]) else None
    # Extents-only fingerprint: numeric containment between min and max.
    if "min" in fp and isinstance(value, (int, float)) and not isinstance(value, bool):
        return "range" if float(fp["min"]) <= float(value) <= float(fp["max"]) else None
    return None


class RunEvidence:
    """Registry of data produced by one analysis/backtest run."""

    def __init__(self, run_id: Optional[str] = None) -> None:
        self.run_id = run_id or datetime.datetime.now().strftime("run-%Y%m%d-%H%M%S")
        self._registry: Dict[str, Dict[str, Fingerprint]] = {}

    def record(self, name: str, data: Any, source: str) -> Fingerprint:
        """Fingerprint ``data`` under ``name`` tagged with ``source``.

        Args:
            name: What the data is (e.g. "equity", "sharpe").
            data: Scalar, list, or pandas Series/DataFrame.
            source: Where it came from (e.g. "quant.engine.backtest",
                "finance.rbsa.fund_nav:008401").

        Returns:
            The stored fingerprint.
        """
        fp = _fingerprint(data)
        fp["source"] = source
        self._registry.setdefault(str(name), {})[str(source)] = fp
        return fp

    def check(self, claims: List[Claim]) -> List[Dict[str, Any]]:
        """Check claimed values against what this run recorded.

        Args:
            claims: List of ``(label, value, source_name=None)`` — a
                2-tuple ``(label, value)`` is accepted and matches any
                recorded source; a claim passes when ``value`` equals (or is
                contained in) recorded data for ``source_name``, or for any
                recorded source when ``source_name`` is None/absent.

        Returns:
            One result per claim: ``{"label", "value", "status":
            "found" | "not_found", "where", "match"}``; ``where`` names the
            source(s) the value was found under (None when not found), and
            ``match`` the strength — ``"value"`` / ``"member"`` / ``"range"``
            (None when not found).
        """
        results = []
        for claim in claims:
            label, value, *rest = claim
            source_name = rest[0] if rest else None
            found_in: List[str] = []
            match_kind: Optional[str] = None
            for name_sources in self._registry.values():
                for src, fp in name_sources.items():
                    if source_name is not None and src != source_name:
                        continue
                    match = _match_kind(fp, value)
                    if match is not None and src not in found_in:
                        found_in.append(src)
                        if match_kind is None or match != "range":
                            match_kind = match
            results.append(
                {
                    "label": label,
                    "value": value,
                    "status": "found" if found_in else "not_found",
                    "where": found_in or None,
                    "match": match_kind,
                }
            )
        return results

    def summary(self) -> Dict[str, Any]:
        """Overview of the run's registry: names, sources, kinds, extents."""
        names = {}
        for name, sources in self._registry.items():
            names[name] = {
                "sources": sorted(sources),
                "kinds": sorted({fp.get("kind", "?") for fp in sources.values()}),
            }
        return {"run_id": self.run_id, "recorded": names, "n_records": sum(len(s) for s in self._registry.values())}

    def save(self, path: str) -> str:
        """Write the registry as strict JSON; returns the path.

        Recorded values are sanitised through ``validation.to_jsonable``, so
        non-finite floats (a NAV series with a gap, an ``inf`` metric)
        serialise as ``None`` — strict JSON, no crash, no ``NaN`` token.
        """
        from .validation import to_jsonable

        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=parent, prefix=os.path.basename(path) + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(
                    to_jsonable({"run_id": self.run_id, "registry": self._registry}),
                    fh, ensure_ascii=False, indent=1, allow_nan=False,
                )
                fh.flush()
                os.fsync(fh.fileno())
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        os.replace(tmp, path)
        return path


def new_run(run_id: Optional[str] = None) -> RunEvidence:
    """Start a new evidence run. See the module docstring for the caveat:
    this is an advisory self-check, not an enforcement gate."""
    return RunEvidence(run_id=run_id)
