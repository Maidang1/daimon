"""Prime Agent compact skill: context compaction control from the kernel.

Compaction runs host-side (the same implementation as /compact); these
functions are thin typed wrappers over the generic host bridge
(`rlm.host_request`). They only work inside the Prime Agent Python kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def status() -> dict[str, Any]:
    """Read current context usage.

    Returns a dict with `tokens`, `context_window`, `percent` (None right
    after a compaction until the next model response), and `scheduled`
    (whether a requested compaction is already pending for this turn).
    """
    return await host_request("compact.status")


async def run(instructions: str | None = None) -> dict[str, Any]:
    """Schedule context compaction.

    Compaction never runs mid-cell: it runs when the current turn ends and
    the harness resumes you automatically afterwards. Returns
    `{"scheduled": True}`, or `{"scheduled": False, "reason": ...}` when
    there is nothing to compact.

    The compaction engine takes no custom summary focus, so `instructions`
    is only accepted as `None` (the default) or an empty string. Passing a
    non-empty focus raises `ValueError` instead of being silently ignored.
    """
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError(f"instructions must be str or None, got {type(instructions).__name__}")
    if instructions is not None and instructions.strip():
        raise ValueError(
            "compact.run takes no custom instructions: the compaction engine "
            "has no summary-focus seam",
        )
    return await host_request("compact.run")
