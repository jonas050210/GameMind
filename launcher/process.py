"""Starting the TypeScript agent as a child process, relaying its output, and stopping it without leaving anything behind."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

READY_MARKER = "GAMEMIND_READY"


def parse_ready_line(line: str) -> Optional[dict]:
    """The machine-readable line the agent prints once its Control Center is listening."""
    if not line.startswith(READY_MARKER + " "):
        return None
    try:
        value = json.loads(line[len(READY_MARKER) + 1 :])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def build_command(node: str, root: Path, passthrough: Sequence[str]) -> list[str]:
    """``node node_modules/tsx/dist/cli.mjs src/cli.ts ...``: no shell, no npm.cmd shim, no PATH lookup of tsx."""
    return [node, str(root / "node_modules" / "tsx" / "dist" / "cli.mjs"), str(root / "src" / "cli.ts"), *passthrough]


def spawn(command: Sequence[str], cwd: Path, env: Optional[dict] = None) -> subprocess.Popen:
    kwargs: dict = {
        "cwd": str(cwd),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
        "env": {**os.environ, **(env or {})},
    }
    if os.name == "nt":
        # A separate process group lets Ctrl+Break reach the child alone, so it can shut down gracefully.
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(list(command), **kwargs)


def request_graceful_stop(process: subprocess.Popen) -> None:
    """Asks the agent to shut down the way Ctrl-C does: it closes the session and the Control Center in order."""
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            os.killpg(process.pid, signal.SIGINT)
    except (OSError, ValueError):
        process.terminate()


def force_stop(process: subprocess.Popen, sig: int) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/pid", str(process.pid), "/T", "/F"], capture_output=True, check=False)
        else:
            os.killpg(process.pid, sig)
    except (OSError, ValueError):
        try:
            process.kill()
        except OSError:
            pass


def stop_process(
    process: subprocess.Popen,
    grace: float = 25.0,
    term_grace: float = 5.0,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> int:
    """Graceful stop, then SIGTERM, then SIGKILL, each after its grace period. Returns the exit code."""
    request_graceful_stop(process)
    deadline = now() + grace
    while process.poll() is None and now() < deadline:
        sleep(0.1)
    if process.poll() is None:
        force_stop(process, signal.SIGTERM if os.name != "nt" else 0)
        deadline = now() + term_grace
        while process.poll() is None and now() < deadline:
            sleep(0.1)
    if process.poll() is None:
        force_stop(process, signal.SIGKILL if os.name != "nt" else 0)
        deadline = now() + 3.0
        while process.poll() is None and now() < deadline:
            sleep(0.1)
    code = process.poll()
    return code if code is not None else -1


def relay_output(
    process: subprocess.Popen,
    on_line: Callable[[str], None],
) -> threading.Thread:
    """Reads the child's output on a thread so the main thread stays free to react to signals."""

    def pump() -> None:
        stream = process.stdout
        if stream is None:
            return
        for raw in iter(stream.readline, ""):
            on_line(raw.rstrip("\r\n"))

    thread = threading.Thread(target=pump, name="gamemind-output", daemon=True)
    thread.start()
    return thread


def install_signal_handlers(on_stop: Callable[[str], None]) -> Callable[[], None]:
    """First signal asks for a graceful stop; a second one forces it. Returns a function that restores the handlers."""
    names = ["SIGINT", "SIGTERM"] + (["SIGBREAK"] if os.name == "nt" else ["SIGHUP"])
    previous: dict = {}
    count = {"value": 0}

    def handler(signum: int, _frame: object) -> None:
        count["value"] += 1
        on_stop(signal.Signals(signum).name if count["value"] == 1 else "SECOND_SIGNAL")

    for name in names:
        number = getattr(signal, name, None)
        if number is None:
            continue
        try:
            previous[number] = signal.signal(number, handler)
        except (ValueError, OSError):
            continue

    def restore() -> None:
        for number, old in previous.items():
            try:
                signal.signal(number, old)
            except (ValueError, OSError):
                pass

    return restore
