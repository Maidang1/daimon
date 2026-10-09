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
atomic and reads tolerate one torn write: each write goes to its OWN
`tempfile.mkstemp` file (never a shared fixed `<path>.tmp`, which two OS
processes — the RLM kernel heartbeat and the TS-spawned job runner — would
interleave and publish half-written bytes through the first `os.replace`),
then fsync + `os.replace`.

This module also owns the small pure file-I/O state accessors
(`load_pred_log` / `save_pred_log` / `load_track` / `save_track`) so that
lightweight readers (e.g. `snapshot.py`) do not have to import the
pandas/urllib-heavy `jobs` module just to read one JSON file.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from collections.abc import Iterable
from typing import Any

def _default_home() -> str:
    """``$DSH_HOME/finance`` when the host set DSH_HOME, else the repo's own
    ``dsh-home/finance``. A hardcoded absolute path here silently breaks on
    any other machine or DSH_HOME layout, the same way the TS-side default
    did before it learned to follow DSH_HOME."""
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        return os.path.join(dsh_home, "finance")
    return "/Users/bytedance/codes/open-source/daimon/dsh-home/finance"

_env_loaded = False


class FinanceError(RuntimeError):
    """A finance-package operation failed (bad input, missing state, or an
    upstream fetch/compute error). The message is written for the agent to
    relay to the user, so it stays specific and actionable."""


def home() -> str:
    """Root of all finance-owned state."""
    return os.environ.get("FINANCE_HOME") or _default_home()


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


def _tmp_path(path: str) -> str:
    """给 `path` 分配一个本次写独有的临时文件（mkstemp 保证不重名）。"""
    parent = os.path.dirname(path) or "."
    ensure_dir(parent)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=os.path.basename(path) + ".", suffix=".tmp")
    os.close(fd)
    return tmp


def _discard(tmp: str) -> None:
    """写失败时清掉临时文件，不在状态目录里留垃圾。"""
    try:
        os.unlink(tmp)
    except OSError:
        pass


def write_json(path: str, data: Any) -> None:
    """Atomically write JSON (own mkstemp tmp file + fsync + os.replace),
    creating parents."""
    tmp = _tmp_path(path)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        _discard(tmp)
        raise
    os.replace(tmp, path)


def write_jsonl_atomic(path: str, records: Iterable[dict[str, Any]]) -> None:
    """Atomically write a whole JSONL file (one JSON object per line):
    own mkstemp tmp file + fsync + os.replace, creating parents.

    比「先清空再逐行 append」安全：后者写到一半崩溃会把不可重建的账本
    （pred_log.jsonl）留成空文件或残缺文件；这里旧的完整文件在任何一步失败前都还在。
    """
    tmp = _tmp_path(path)
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            for record in records:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        _discard(tmp)
        raise
    os.replace(tmp, path)


def append_jsonl(path: str, record: dict[str, Any]) -> None:
    """Append one record to a JSONL file (creating parents).

    断行自愈：文件若不以换行结尾（上次写崩了），先补一个换行再追加，
    免得新记录和损坏字节粘成一行、下次整行读不动。
    """
    ensure_dir(os.path.dirname(path))
    sep = ""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            if fh.read(1) != b"\n":
                sep = "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(sep + json.dumps(record, ensure_ascii=False) + "\n")


# ---------------- 状态访问器（纯文件 I/O，勿在此堆业务逻辑） ----------------
# jobs.py 保留同名薄封装 re-export；其它模块请直接用这里的函数，
# 免得为了读一个 JSON 把 pandas/urllib 整套 jobs 模块拖进来。


def load_pred_log() -> dict[tuple[str, str, str], dict[str, Any]]:
    """pred_log.jsonl → {(code, navDate, mode): 预测记录}，同 key 保留最后一条。"""
    entries: dict[tuple[str, str, str], dict[str, Any]] = {}
    pred_log = state_path("pred_log.jsonl")
    if os.path.exists(pred_log):
        with open(pred_log, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                e = json.loads(line)
                entries[(e["code"], e["navDate"], e["mode"])] = e
    return entries


def save_pred_log(entries: dict[tuple[str, str, str], dict[str, Any]]) -> None:
    """按 (navDate, code) 排序后整份原子重写 pred_log.jsonl。"""
    pred_log = state_path("pred_log.jsonl")
    write_jsonl_atomic(pred_log, sorted(entries.values(), key=lambda x: (x["navDate"], x["code"])))


def load_track() -> list[dict[str, Any]]:
    """读取 track.json（早间核对的战绩记录），缺失或读坏时返回 []。"""
    return read_json(state_path("track.json"), [])


def save_track(track: list[dict[str, Any]]) -> None:
    """写 track.json，只保留最近 300 条。"""
    write_json(state_path("track.json"), track[-300:])
