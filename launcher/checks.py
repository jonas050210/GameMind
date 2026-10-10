"""Environment checks. Each returns data (never prints), so the caller decides how to present problems."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence

MIN_NODE = (22, 0, 0)


@dataclass(frozen=True)
class Problem:
    code: str
    message: str
    fix: str

    def render(self) -> str:
        return f"{self.message}\n    Fix: {self.fix}"


def parse_node_version(text: str) -> Optional[tuple[int, int, int]]:
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", text)
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def node_candidates(env: Mapping[str, str], system: str) -> list[str]:
    """Executables to try, in order: an explicit $NODE, then the platform's name for node."""
    explicit = env.get("NODE") or env.get("GAMEMIND_NODE")
    names = ["node.exe", "node"] if system == "windows" else ["node"]
    return ([explicit] if explicit else []) + names


def find_executable(names: Sequence[str], which: Callable[[str], Optional[str]] = shutil.which) -> Optional[str]:
    for name in names:
        if os.path.isabs(name) and os.path.isfile(name):
            return name
        found = which(name)
        if found:
            return found
    return None


def node_version(executable: str, run: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run) -> Optional[tuple[int, int, int]]:
    try:
        result = run([executable, "--version"], capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_node_version(result.stdout or result.stderr or "")


def check_node(executable: Optional[str], version: Optional[tuple[int, int, int]]) -> list[Problem]:
    if executable is None:
        return [
            Problem(
                "NODE_MISSING",
                "Node.js was not found on PATH.",
                "Install Node.js 22 or newer from https://nodejs.org (or with nvm), then open a new terminal. "
                "Set NODE=/full/path/to/node if it is installed somewhere unusual.",
            )
        ]
    if version is None:
        return [Problem("NODE_VERSION_UNKNOWN", f"Could not read the version of {executable}.", "Run it with --version yourself to see why it fails.")]
    if version < MIN_NODE:
        found = ".".join(str(part) for part in version)
        return [Problem("NODE_TOO_OLD", f"Node.js {found} is too old; GameMind needs 22 or newer.", "Install Node.js 22+ (for example 'nvm install 22').")]
    return []


def esbuild_platform_dirs(node_modules: Path) -> list[str]:
    directory = node_modules / "@esbuild"
    try:
        return sorted(entry.name for entry in directory.iterdir() if entry.is_dir())
    except OSError:
        return []


def expected_esbuild_package(system: str, machine: str) -> Optional[str]:
    arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine.lower())
    platform = {"linux": "linux", "darwin": "darwin", "windows": "win32"}.get(system.lower())
    return f"{platform}-{arch}" if platform and arch else None


def check_dependencies(root: Path, system: str, machine: str) -> list[Problem]:
    """node_modules must exist and must have been installed for *this* operating system (the classic WSL trap)."""
    tsx = root / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx.is_file():
        return [Problem("DEPENDENCIES_MISSING", "The project dependencies are not installed (node_modules/tsx is missing).", "Run 'npm ci' in the project folder, or run this launcher with --install.")]
    expected = expected_esbuild_package(system, machine)
    present = esbuild_platform_dirs(root / "node_modules")
    if expected and present and expected not in present:
        return [
            Problem(
                "DEPENDENCIES_WRONG_PLATFORM",
                f"node_modules was installed for another operating system (found esbuild for {', '.join(present)}, need {expected}).",
                "Delete node_modules and run 'npm ci' from the same terminal you launch GameMind from (a Windows install does not work inside WSL, and vice versa).",
            )
        ]
    return []


def check_project(root: Path) -> list[Problem]:
    problems: list[Problem] = []
    for relative in ("package.json", "src/cli.ts"):
        if not (root / relative).is_file():
            problems.append(Problem("PROJECT_FILE_MISSING", f"{relative} was not found in {root}.", "Run main.py from the root of the GameMind checkout."))
    return problems


def check_windows_mount(root: Path, wsl: bool) -> Optional[str]:
    """A warning (not an error) for a project on the Windows drive seen from WSL: it works, but slowly and with watchers off."""
    text = str(root)
    if wsl and re.match(r"^/mnt/[a-z]/", text):
        return "The project is on the Windows drive (/mnt/<drive>). It works, but file access from WSL is much slower there; cloning into the Linux home folder is faster."
    return None


def read_json_file(path: Path) -> Optional[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def pid_alive(pid: int, kill: Callable[[int, int], None] = os.kill) -> bool:
    try:
        kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def existing_instance(data_dir: Path, alive: Optional[Callable[[int], bool]] = None) -> Optional[dict]:
    """The lock a running GameMind left (``data/run/gamemind.lock.json``), if its process still exists."""
    alive = alive or pid_alive
    lock = read_json_file(data_dir / "run" / "gamemind.lock.json")
    if not lock:
        return None
    pid = lock.get("pid")
    if isinstance(pid, int) and pid != os.getpid() and alive(pid):
        return lock
    return None


def is_port_free(host: str, port: int) -> bool:
    import socket

    family = socket.AF_INET6 if ":" in host and not host.startswith("[") else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0 if os.name == "nt" else 1)
        try:
            sock.bind((host.strip("[]"), port))
        except OSError:
            return False
    return True


def choose_control_port(
    preferred: int,
    explicit: bool,
    host: str,
    is_free: Optional[Callable[[str, int], bool]] = None,
    span: int = 20,
) -> tuple[Optional[int], Optional[Problem]]:
    """Returns the port to use. An explicitly requested port is never silently replaced."""
    is_free = is_free or is_port_free
    if preferred == 0:
        return 0, None
    if is_free(host, preferred):
        return preferred, None
    if explicit:
        return None, Problem("PORT_IN_USE", f"Control Center port {preferred} is already in use on {host}.", f"Stop whatever uses it, or choose another with --control-port (0 picks a free one).")
    for candidate in range(preferred + 1, preferred + 1 + span):
        if is_free(host, candidate):
            return candidate, None
    return None, Problem("NO_FREE_PORT", f"No free port between {preferred} and {preferred + span} on {host}.", "Pass --control-port 0 to let the system pick one.")
