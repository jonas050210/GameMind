"""Windows / WSL awareness. Every function takes its inputs as arguments so it can be tested with any environment."""

from __future__ import annotations

import re
import socket
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence

LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}


@dataclass(frozen=True)
class Platform:
    system: str  # "linux", "windows", "darwin" (lower-case platform.system())
    wsl: bool
    wsl_version: Optional[int]
    distro: Optional[str]


def detect_platform(system: str, env: Mapping[str, str], proc_version: Optional[str]) -> Platform:
    """Detects WSL from the markers WSL itself sets (never from guessing)."""
    system = system.lower()
    if system != "linux":
        return Platform(system, False, None, None)
    version_text = proc_version or ""
    markers = bool(env.get("WSL_DISTRO_NAME") or env.get("WSL_INTEROP") or env.get("WSLENV")) or bool(
        re.search(r"microsoft|wsl", version_text, re.IGNORECASE)
    )
    if not markers:
        return Platform(system, False, None, None)
    if re.search(r"wsl2|microsoft-standard", version_text, re.IGNORECASE) or env.get("WSL_INTEROP"):
        version: Optional[int] = 2
    elif re.search(r"microsoft", version_text, re.IGNORECASE):
        version = 1
    else:
        version = None
    return Platform(system, True, version, env.get("WSL_DISTRO_NAME"))


def is_loopback(host: str) -> bool:
    host = host.strip().lower()
    return host in LOOPBACK_NAMES or re.fullmatch(r"127\.\d+\.\d+\.\d+", host) is not None


def parse_default_gateway(route_output: str) -> Optional[str]:
    match = re.search(r"^default\s+via\s+((?:\d{1,3}\.){3}\d{1,3})", route_output, re.MULTILINE)
    return match.group(1) if match else None


def parse_resolv_nameserver(resolv_conf: str) -> Optional[str]:
    for line in resolv_conf.splitlines():
        match = re.fullmatch(r"\s*nameserver\s+((?:\d{1,3}\.){3}\d{1,3})\s*", line)
        if match and not match.group(1).startswith("127."):
            return match.group(1)
    return None


def windows_host_candidates(route_output: Optional[str], resolv_conf: Optional[str]) -> list[str]:
    """Addresses that may reach the Windows host from a WSL2 (NAT) VM, most likely first, without duplicates."""
    found: list[str] = []
    for candidate in (
        parse_default_gateway(route_output) if route_output else None,
        parse_resolv_nameserver(resolv_conf) if resolv_conf else None,
    ):
        if candidate and candidate not in found:
            found.append(candidate)
    return found


Probe = Callable[[str, int], str]


def probe_tcp(host: str, port: int, timeout: float = 1.5) -> str:
    """Returns "open", "refused", "timeout" or "error:<detail>" for a TCP connect to host:port."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return "open"
    except ConnectionRefusedError:
        return "refused"
    except socket.timeout:
        return "timeout"
    except OSError as error:
        return f"error:{error.__class__.__name__}"


@dataclass(frozen=True)
class HostDecision:
    host: str
    changed: bool
    notes: tuple[str, ...]


def choose_host(
    requested: Optional[str],
    environment_host: Optional[str],
    port: int,
    platform: Platform,
    candidates: Sequence[str],
    probe: Probe,
) -> HostDecision:
    """Picks the Minecraft host without ever overriding something the operator chose.

    Only when no host was given (neither a flag nor MINECRAFT_HOST), the platform is WSL, loopback does not answer and
    exactly the Windows host does, the Windows host is used, and the decision is reported. In every other case the
    given (or default) host is kept and the notes explain what was found.
    """
    chosen = requested or environment_host
    if chosen:
        return HostDecision(chosen, False, ())
    default = "127.0.0.1"
    if not platform.wsl or platform.wsl_version == 1:
        return HostDecision(default, False, ())
    if probe(default, port) == "open":
        return HostDecision(default, False, ("Minecraft answers on 127.0.0.1 from this WSL session (mirrored networking or a server inside WSL).",))
    for candidate in candidates:
        if probe(candidate, port) == "open":
            return HostDecision(
                candidate,
                True,
                (f"Nothing answers on 127.0.0.1:{port} inside WSL, but the Windows host {candidate}:{port} does; using it. Pass --host to choose another.",),
            )
    note = (
        "You are running inside WSL2. If Minecraft runs on Windows, 127.0.0.1 here is the Linux VM, not Windows. "
        + (f"Windows host candidates: {', '.join(candidates)}. " if candidates else "")
        + "Open the world to LAN (or start the server) and pass --host <Windows address>, or enable mirrored networking."
    )
    return HostDecision(default, False, (note,))
