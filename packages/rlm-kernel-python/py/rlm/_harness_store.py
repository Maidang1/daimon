"""Cross-process writer lock and atomic commit for the shared harness store.

The lock protocol mirrors `@deepseek-ai/dsh-atomic-write`'s `withFileLock`
exactly, so the TypeScript host refiner and this Python runtime exclude each
other on a store they both write:

- the lock is a `<state>.lock` sibling created with `O_EXCL`;
- the holder's PID is recorded inside the lock file;
- `EEXIST` contends with exponential backoff;
- a contender takes over the lock when the recorded PID no longer exists.

Writers stay mutually exclusive only because both sides follow this same
convention; a different lock file or `fcntl.flock()` would not exclude the
TS side. Reads stay lock-free because commits rename a same-directory temp
file over the target.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import stat
import time
from pathlib import Path
from uuid import uuid4

_LOCK_WAIT_SECONDS = 30.0
_LOCK_POLL_BASE_SECONDS = 0.05
_LOCK_POLL_CAP_SECONDS = 0.5

# Exactly "<pid>\n", as the TS dsh-atomic-write holder record is validated.
_PID_RE = re.compile(r"\d+\n")


def lock_path(state_path: str | Path) -> Path:
    # Resolve through symlinks first: two writers that reach the same file via
    # different alias paths must contend on the same lock sibling.
    resolved = Path(os.path.realpath(state_path))
    return resolved.with_name(resolved.name + ".lock")


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _dead_holder_pid(lock: Path) -> int | None:
    """Return the recorded holder PID only when it is proven gone.

    Mirrors the TS `holderExited` rule: a takeover is allowed exclusively for a
    record of exactly `<pid>\\n`. An empty lock (a contender created it a moment
    ago but has not written its PID yet), unreadable, or malformed content is
    treated as a live lock and never unlinked — removing it would break mutual
    exclusion exactly while the real holder is inside its critical section.
    """
    try:
        record = lock.read_text(encoding="utf-8")
    except OSError:
        return None
    if not _PID_RE.fullmatch(record):
        return None
    pid = int(record.strip())
    if pid == 0 or pid > 2147483647 or pid == os.getpid():
        return None
    if _pid_alive(pid):
        return None
    return pid


@contextlib.contextmanager
def writer_lock(state_path: str | Path):
    """Hold the `<state>.lock` sibling for the duration of one mutation.

    Raises ``TimeoutError`` when the lock cannot be acquired within
    ``_LOCK_WAIT_SECONDS``; raises ``OSError`` when the lock directory cannot
    be created. The lock is always released on context exit.
    """
    path = Path(state_path)
    lock = lock_path(path)
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS
    backoff = _LOCK_POLL_BASE_SECONDS
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            dead_pid = _dead_holder_pid(lock)
            if dead_pid is not None:
                # Proven-dead holder: remove it and retry the exclusive create.
                try:
                    lock.unlink()
                except FileNotFoundError:
                    pass
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"timed out waiting for harness store lock: {lock}")
            time.sleep(backoff)
            backoff = min(backoff * 2, _LOCK_POLL_CAP_SECONDS)
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(f"{os.getpid()}\n")
            try:
                yield
            finally:
                try:
                    lock.unlink()
                except FileNotFoundError:
                    pass
            return


def atomic_write(state_path: str | Path, data: dict) -> None:
    """Write ``data`` to ``state_path`` as one atomic rename.

    Readers always observe either the old or the new complete content; an
    existing file keeps its permission bits, a fresh one is created 0600.
    """
    target = Path(os.path.realpath(state_path))
    temp_path = target.with_name(f"{target.name}.{os.getpid()}.{uuid4().hex}.tmp")
    try:
        existing_mode = stat.S_IMODE(os.stat(target).st_mode)
    except FileNotFoundError:
        existing_mode = None
    mode = existing_mode if existing_mode is not None else 0o600
    try:
        descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        if existing_mode is not None:
            os.chmod(temp_path, existing_mode)
        os.replace(temp_path, target)
    finally:
        temp_path.unlink(missing_ok=True)


__all__ = ["atomic_write", "lock_path", "writer_lock"]
