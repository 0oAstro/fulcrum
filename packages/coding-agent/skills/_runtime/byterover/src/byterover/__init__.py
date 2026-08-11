"""Python facade for an enabled ByteRover V4 Agent Skill.

The official ByteRover runtime is distributed as deterministic Node scripts.
Fulcrum sets ``BYTEROVER_SKILL_DIR`` when it loads that skill; this module calls
those scripts with argv-based subprocesses from the current project directory.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TypeAlias, cast

_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
_MAX_ERROR_DETAIL_BYTES = 8 * 1024
JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


class ByteRoverError(RuntimeError):
    """Raised when the ByteRover skill runtime cannot complete a request."""


def skill_dir() -> Path:
    """Return the enabled ByteRover skill directory supplied by Fulcrum."""
    configured = os.environ.get("BYTEROVER_SKILL_DIR", "").strip()
    if not configured:
        raise ByteRoverError(
            "ByteRover is not enabled. Install and enable the official "
            "campfirein/skills package, then reload Fulcrum."
        )
    root = Path(configured).expanduser().resolve()
    if not (root / "SKILL.md").is_file():
        raise ByteRoverError(f"ByteRover SKILL.md not found in {root}")
    return root


def _require_text(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be str, got {type(value).__name__}")
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{name} must not be empty")
    return normalized


def _require_cli_value(value: object, name: str) -> str:
    normalized = _require_text(value, name)
    if normalized.startswith("--"):
        raise ValueError(f"{name} must not start with '--'")
    return normalized


def _kill_if_running(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _script_path(name: str) -> Path:
    scripts = (skill_dir() / "scripts").resolve()
    script = (scripts / name).resolve()
    if script.parent != scripts or not script.is_file():
        raise ByteRoverError(f"ByteRover runtime script not found: {name}")
    return script


def _decode_json(stdout: bytes, script: str) -> JsonObject:
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise ByteRoverError(f"ByteRover {script} returned no output")
    candidates = [text]
    last_line = text.rsplit("\n", 1)[-1].strip()
    if last_line != text:
        candidates.append(last_line)
    result: object = None
    error: json.JSONDecodeError | None = None
    parsed = False
    for candidate in candidates:
        try:
            result = json.loads(candidate)
            parsed = True
            break
        except json.JSONDecodeError as candidate_error:
            error = candidate_error
    if not parsed:
        assert error is not None
        raise ByteRoverError(f"ByteRover {script} returned invalid JSON: {error}") from error
    if not isinstance(result, dict):
        raise ByteRoverError(
            f"ByteRover {script} returned {type(result).__name__}, expected object"
        )
    if not all(isinstance(key, str) for key in result):
        raise ByteRoverError(f"ByteRover {script} returned an object with non-string keys")
    return cast(JsonObject, result)


async def _read_limited(
    stream: asyncio.StreamReader,
    process: asyncio.subprocess.Process,
    script: str,
    stream_name: str,
) -> bytes:
    chunks: list[bytes] = []
    size = 0
    exceeded = False
    while chunk := await stream.read(64 * 1024):
        remaining = _MAX_OUTPUT_BYTES - size
        if remaining > 0:
            chunks.append(chunk[:remaining])
        size += len(chunk)
        if size > _MAX_OUTPUT_BYTES and not exceeded:
            exceeded = True
            _kill_if_running(process)
    if exceeded:
        raise ByteRoverError(
            f"ByteRover {script} {stream_name} exceeded {_MAX_OUTPUT_BYTES} bytes"
        )
    return b"".join(chunks)


def _assert_offline_daemon_isolated(data_dir: Path) -> None:
    pid_path = data_dir / "projects" / ".daemon" / "daemon.pid"
    try:
        marker = json.loads(pid_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    except (OSError, json.JSONDecodeError) as error:
        raise ByteRoverError(f"Cannot verify ByteRover offline daemon state: {error}") from error
    pid = marker.get("pid") if isinstance(marker, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ByteRoverError("Cannot verify ByteRover offline daemon PID")
    process_root = Path("/proc") / str(pid)
    if not process_root.exists():
        return
    try:
        daemon_namespace = (process_root / "ns" / "net").readlink()
        host_namespace = Path("/proc/self/ns/net").readlink()
        network_lines = (process_root / "net" / "dev").read_text(encoding="utf-8").splitlines()[2:]
    except OSError as error:
        raise ByteRoverError(f"Cannot verify ByteRover offline daemon network isolation: {error}") from error
    interfaces = {line.split(":", 1)[0].strip() for line in network_lines if ":" in line}
    if daemon_namespace == host_namespace or any(interface != "lo" for interface in interfaces):
        raise ByteRoverError(
            "ByteRover offline mode refused an existing daemon with network access; "
            "stop that daemon and retry"
        )


def _command(node: str, script_path: Path, args: Sequence[str]) -> tuple[list[str], Path]:
    cwd = Path.cwd().resolve()
    command = [node, str(script_path), *args]
    if os.environ.get("FULCRUM_BYTEROVER_OFFLINE") != "1":
        return command, cwd
    if not sys.platform.startswith("linux"):
        raise ByteRoverError("Offline ByteRover V4 currently requires Linux bubblewrap")
    bubblewrap = shutil.which("bwrap")
    if not bubblewrap:
        raise ByteRoverError("Offline ByteRover V4 requires bubblewrap (bwrap)")
    configured_data_dir = os.environ.get("BRV_DATA_DIR", "").strip()
    if not configured_data_dir:
        raise ByteRoverError("Offline ByteRover V4 requires an explicit BRV_DATA_DIR")
    data_dir = Path(configured_data_dir).expanduser().resolve()
    if not data_dir.is_dir():
        raise ByteRoverError(f"ByteRover V4 data directory not found: {data_dir}")
    _assert_offline_daemon_isolated(data_dir)
    return (
        [
            bubblewrap,
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--bind",
            str(data_dir),
            str(data_dir),
            "--bind",
            str(cwd),
            str(cwd),
            "--chdir",
            str(cwd),
            *command,
        ],
        cwd,
    )


async def _run(script: str, *args: str, timeout_s: float = 60) -> JsonObject:
    if not isinstance(timeout_s, (int, float)) or isinstance(timeout_s, bool):
        raise TypeError(f"timeout_s must be a number, got {type(timeout_s).__name__}")
    if timeout_s <= 0:
        raise ValueError("timeout_s must be greater than zero")
    node = shutil.which("node")
    if not node:
        raise ByteRoverError("Node.js is required to use ByteRover V4")
    script_path = _script_path(script)
    command, cwd = _command(node, script_path, args)
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    if process.stdout is None or process.stderr is None:
        _kill_if_running(process)
        await process.wait()
        raise ByteRoverError(f"ByteRover {script} did not open output pipes")
    stdout_task = asyncio.create_task(_read_limited(process.stdout, process, script, "stdout"))
    stderr_task = asyncio.create_task(_read_limited(process.stderr, process, script, "stderr"))
    execution = asyncio.gather(stdout_task, stderr_task, process.wait())
    try:
        stdout, stderr, _ = await asyncio.wait_for(asyncio.shield(execution), timeout=timeout_s)
    except TimeoutError as error:
        _kill_if_running(process)
        await asyncio.gather(execution, return_exceptions=True)
        raise ByteRoverError(f"ByteRover {script} timed out after {timeout_s} seconds") from error
    except asyncio.CancelledError:
        _kill_if_running(process)
        await asyncio.gather(execution, return_exceptions=True)
        raise
    except BaseException:
        _kill_if_running(process)
        await asyncio.gather(execution, return_exceptions=True)
        raise
    if process.returncode != 0:
        error_output = stderr or stdout
        detail = error_output[:_MAX_ERROR_DETAIL_BYTES].decode("utf-8", errors="replace").strip()
        if len(error_output) > _MAX_ERROR_DETAIL_BYTES:
            detail += "…"
        raise ByteRoverError(
            f"ByteRover {script} exited with code {process.returncode}"
            + (f": {detail}" if detail else "")
        )
    if stderr:
        warning = stderr[:_MAX_ERROR_DETAIL_BYTES].decode("utf-8", errors="replace").strip()
        if len(stderr) > _MAX_ERROR_DETAIL_BYTES:
            warning += "…"
        if warning:
            print(f"ByteRover {script}: {warning}", file=sys.stderr)
    return _decode_json(stdout, script)


async def query(question: str, *, limit: int = 5, timeout_s: float = 30) -> JsonObject:
    """Retrieve ranked project memory for ``question``."""
    question = _require_cli_value(question, "question")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    if limit < 1:
        raise ValueError("limit must be greater than zero")
    return await _run("query.mjs", question, "--limit", str(limit), timeout_s=timeout_s)


async def read(topic_path: str, *, raw: bool = False, timeout_s: float = 30) -> JsonObject:
    """Read a complete topic by its tree-relative path."""
    topic_path = _require_cli_value(topic_path, "topic_path")
    if not isinstance(raw, bool):
        raise TypeError(f"raw must be bool, got {type(raw).__name__}")
    args = ["read", topic_path]
    if raw:
        args.append("--raw")
    return await _run("brv.mjs", *args, timeout_s=timeout_s)


async def record(
    topic_path: str,
    *,
    title: str | None = None,
    summary: str | None = None,
    keywords: str | Sequence[str] | None = None,
    body: str | None = None,
    html: str | None = None,
    overwrite: bool = False,
    timeout_s: float = 60,
) -> JsonObject:
    """Record one topic; simple form requires title/body, while summary/keywords are optional."""
    topic_path = _require_cli_value(topic_path, "topic_path")
    if not isinstance(overwrite, bool):
        raise TypeError(f"overwrite must be bool, got {type(overwrite).__name__}")
    if html is not None:
        if any(value is not None for value in (title, summary, keywords, body)):
            raise ValueError("html cannot be combined with title, summary, keywords, or body")
        args = [topic_path, "--html", _require_cli_value(html, "html")]
        if overwrite:
            args.append("--overwrite")
        return await _run("record.mjs", *args, timeout_s=timeout_s)

    title = _require_cli_value(title, "title")
    body = _require_cli_value(body, "body")
    args = [topic_path, "--title", title]
    if summary is not None:
        args.extend(["--summary", _require_cli_value(summary, "summary")])
    if isinstance(keywords, str):
        args.extend(["--keywords", _require_cli_value(keywords, "keywords")])
    elif isinstance(keywords, Sequence):
        keyword_text = ",".join(_require_text(value, "keyword") for value in keywords)
        if not keyword_text:
            raise ValueError("keywords must not be empty")
        args.extend(["--keywords", _require_cli_value(keyword_text, "keywords")])
    elif keywords is not None:
        raise TypeError("keywords must be str or a sequence of str")
    args.extend(["--body", body])
    if overwrite:
        args.append("--overwrite")
    return await _run("record.mjs", *args, timeout_s=timeout_s)


async def current_space(*, timeout_s: float = 30) -> JsonObject:
    """Return the ByteRover space resolved for the current project."""
    return await _run("space.mjs", "current", timeout_s=timeout_s)


async def list_spaces(*, timeout_s: float = 30) -> JsonObject:
    """List available ByteRover spaces."""
    return await _run("space.mjs", "list", timeout_s=timeout_s)


async def bind_space(name: str, *, timeout_s: float = 30) -> JsonObject:
    """Bind the current project to a named ByteRover space."""
    return await _run("space.mjs", "bind", _require_cli_value(name, "name"), timeout_s=timeout_s)


async def sync_status(*, timeout_s: float = 30) -> JsonObject:
    """Return ByteRover background synchronization status."""
    return await _run("sync.mjs", "status", timeout_s=timeout_s)


__all__ = [
    "ByteRoverError",
    "bind_space",
    "current_space",
    "list_spaces",
    "query",
    "read",
    "record",
    "skill_dir",
    "sync_status",
]
