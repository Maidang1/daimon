"""Shared state foundation for the daimon-native finance package.

Every mutable byte this package owns lives under FINANCE_HOME (env override,
default ``<daimon>/dsh-home/finance``). The layout mirrors the original touzi
backend so ported modules keep their relative structure::

    $FINANCE_HOME/
      .env                      # LCT_COOKIE / KIMI_API_KEY (user-managed)
      state/                    # transactions.json ops.json holdings.json
                                # funds_registry.json hotspot.json track.json
                                # artifact_latest.json pred_log.jsonl ...
      <fund_code>/              # config.json / result.json per fund
      mkt_data/ industry_cache/ logs/
      dashboard.html            # rendered board, served by dsh-finance-board

Path resolution happens AT CALL TIME (never in module-level constants) so
tests can point FINANCE_HOME at a tmpdir after import. All JSON writes are
atomic (tmp file + os.replace) and reads tolerate one torn write.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

_DEFAULT_HOME = "/Users/bytedance/codes/open-source/daimon/dsh-home/finance"

_env_loaded = False


class FinanceError(RuntimeError):
    """A finance-package operation failed (bad input, missing state, or an
    upstream fetch/compute error). The message is written for the agent to
    relay to the user, so it stays specific and actionable."""


def home() -> str:
    """Root of all finance-owned state."""
    return os.environ.get("FINANCE_HOME", _DEFAULT_HOME)


def state_dir() -> str:
    return os.path.join(home(), "state")


def fund_dir(code: str) -> str:
    return os.path.join(home(), code)


def state_path(name: str) -> str:
    return os.path.join(state_dir(), name)


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def _load_env_fallback(path: str) -> None:
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


def load_env() -> None:
    """Load `$FINANCE_HOME/.env` exactly once (dotenv when available)."""
    global _env_loaded
    if _env_loaded:
        return
    env_path = os.path.join(home(), ".env")
    try:
        from dotenv import load_dotenv

        load_dotenv(env_path)
    except ImportError:
        _load_env_fallback(env_path)
    _env_loaded = True


def credential(name: str) -> str | None:
    """Read a credential from the environment, loading .env first."""
    load_env()
    return os.environ.get(name)


def read_json(path: str, default: Any) -> Any:
    """Read one JSON state file, tolerating a torn write with one retry."""
    if not os.path.exists(path):
        return default
    for attempt in range(2):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except json.JSONDecodeError:
            if attempt == 1:
                raise RuntimeError(
                    f"finance state file {path} is unreadable (concurrent writer?); try again"
                ) from None
            time.sleep(0.2)
    return default


def write_json(path: str, data: Any) -> None:
    """Atomically write JSON (tmp file + rename), creating parents."""
    ensure_dir(os.path.dirname(path))
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def append_jsonl(path: str, record: dict[str, Any]) -> None:
    ensure_dir(os.path.dirname(path))
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
