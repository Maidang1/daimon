"""On-disk wire shape for the harness store, shared by readers and writers.

The TS host refiner writes camelCase timestamps; legacy Python stores wrote
snake_case. Reads accept either spelling so a round trip through the host
preserves the real history, and writes emit camelCase to match the host.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any

# On-disk timestamp keys: camelCase written by the TS host, snake_case by
# legacy Python stores.
TIMESTAMP_ALIASES: dict[str, str] = {
    "created_at": "createdAt",
    "updated_at": "updatedAt",
}


def entry_to_wire(entry: Any) -> dict[str, Any]:
    data = asdict(entry)
    for python_key, wire_key in TIMESTAMP_ALIASES.items():
        data[wire_key] = data.pop(python_key)
    return data


def event_to_wire(event: Any) -> dict[str, Any]:
    data = asdict(event)
    data["createdAt"] = data.pop("created_at")
    return data


def wire_canonical(
    entries: dict[str, dict[str, Any]],
    refinements: list[Any],
) -> str:
    data = {
        "schema": 1,
        "entries": {
            kind: {entry_id: entry_to_wire(entry) for entry_id, entry in records.items()}
            for kind, records in entries.items()
        },
        "refinements": [event_to_wire(event) for event in refinements],
    }
    return json.dumps(data, sort_keys=True, ensure_ascii=False)


def normalize_state_data(
    data: dict,
    *,
    scope: str,
    kinds: tuple[str, ...],
    entry_fields: set[str],
    refinement_fields: set[str],
    entry_cls: type,
    refinement_cls: type,
) -> tuple[dict[str, dict[str, Any]], list[Any]]:
    """Field-by-field normalize a parsed state document into dataclass records.

    Both the runtime loader and the save() conflict check run the same
    normalization, so their canonical comparison is consistent across foreign
    (camelCase) and hand-edited files.
    """
    built_entries: dict[str, dict[str, Any]] = {kind: {} for kind in kinds}
    raw_entries = data.get("entries", {})
    if isinstance(raw_entries, dict):
        for kind in kinds:
            raw_kind_entries = raw_entries.get(kind, {})
            if not isinstance(raw_kind_entries, dict):
                continue
            for entry_id, raw_entry in raw_kind_entries.items():
                if not isinstance(raw_entry, dict):
                    continue
                entry_data = {key: value for key, value in raw_entry.items() if key in entry_fields}
                entry_data["id"] = str(entry_id)
                entry_data["kind"] = kind
                for python_key, wire_key in TIMESTAMP_ALIASES.items():
                    if entry_data.get(python_key) is None and isinstance(raw_entry.get(wire_key), str):
                        entry_data[python_key] = raw_entry[wire_key]
                if not isinstance(entry_data.get("title"), str) or not isinstance(entry_data.get("content"), str):
                    continue
                if not isinstance(entry_data.get("path"), str):
                    entry_data["path"] = "general"
                if entry_data.get("scope") not in ("local", "global"):
                    entry_data["scope"] = scope
                if not isinstance(entry_data.get("source"), str):
                    entry_data["source"] = "agent"
                version = entry_data.get("version", 1)
                if isinstance(version, str):
                    try:
                        version = int(version)
                    except ValueError:
                        version = 1
                if not isinstance(version, int) or isinstance(version, bool):
                    version = 1
                entry_data["version"] = version
                if not isinstance(entry_data.get("reference"), dict):
                    entry_data["reference"] = {}
                if not isinstance(entry_data.get("arguments"), dict):
                    entry_data["arguments"] = {}
                if not isinstance(entry_data.get("metadata"), dict):
                    entry_data["metadata"] = {}
                built_entries[kind][str(entry_id)] = entry_cls(**entry_data)

    built_refinements: list[Any] = []
    raw_refinements = data.get("refinements", [])
    if isinstance(raw_refinements, list):
        for raw_event in raw_refinements:
            if not isinstance(raw_event, dict):
                continue
            event_data = {key: value for key, value in raw_event.items() if key in refinement_fields}
            if event_data.get("created_at") is None and isinstance(raw_event.get("createdAt"), str):
                event_data["created_at"] = raw_event["createdAt"]
            if not isinstance(event_data.get("id"), str) or not isinstance(event_data.get("trigger"), str):
                continue
            changes = event_data.get("changes")
            if isinstance(changes, str):
                event_data["changes"] = [changes]
            elif isinstance(changes, list):
                event_data["changes"] = [str(change) for change in changes]
            else:
                continue
            built_refinements.append(refinement_cls(**event_data))
    return built_entries, built_refinements
