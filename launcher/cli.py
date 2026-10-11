"""Command line of ``python3 main.py``."""

from __future__ import annotations

import argparse
import os
import platform as platform_module
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable, Mapping, Optional, Sequence

from . import checks, process, wsl

DEFAULT_CONTROL_PORT = 8787

EPILOG = """\
Examples:
  python3 main.py                               persistent session on the Minecraft server (MINECRAFT_HOST or 127.0.0.1:25565)
  python3 main.py --host 192.168.1.20 --port 25565
  python3 main.py --task gather-logs            run a task first, then stay connected
  python3 main.py --simulated                   offline simulator instead of a real server (labelled simulated everywhere)
  python3 main.py --check                       only check the environment
Anything after -- is passed to the TypeScript CLI unchanged (try: python3 main.py -- --help).
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description="Start GameMind (the TypeScript agent) and its Control Center, open your browser, and stop everything cleanly on Ctrl-C.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    live = parser.add_argument_group("Minecraft connection")
    live.add_argument("--host", help="Minecraft server host (default: $MINECRAFT_HOST, else 127.0.0.1; under WSL2 the Windows host is used when it is the only one that answers)")
    live.add_argument("--port", type=int, help="Minecraft server port (default: $MINECRAFT_PORT or 25565)")
    live.add_argument("--username", help="bot name")
    live.add_argument("--version", help="Minecraft version (default 1.20.4)")
    live.add_argument("--auth", choices=["offline", "microsoft"], help="authentication mode (default offline)")
    live.add_argument("--simulated", nargs="?", const="explore-remote-log", metavar="SCENARIO", help="use the offline simulator (default scenario explore-remote-log) instead of a real server")
    live.add_argument("--no-connect", action="store_true", help="start only the Control Center and connect from the page")
    task = parser.add_argument_group("Task")
    task.add_argument("--task", choices=["gather-logs", "mine-stone", "craft-wooden-pickaxe", "secure-food", "build-shelter"], help="run this task first")
    task.add_argument("--resource", help="task target (for example oak_log)")
    task.add_argument("--count", type=int, help="task amount")
    task.add_argument("--one-shot", action="store_true", help="end the session when the task finishes (default: stay connected until you stop it)")
    task.add_argument("--no-autonomy", action="store_true", help="the agent acts only on tasks you start")
    ui = parser.add_argument_group("Control Center")
    ui.add_argument("--control-port", type=int, help=f"Control Center port (default {DEFAULT_CONTROL_PORT}, or the next free one; 0 lets the system pick)")
    ui.add_argument("--control-host", default="127.0.0.1", help="interface to bind (default 127.0.0.1, this machine only)")
    ui.add_argument("--no-browser", action="store_true", help="do not open the browser")
    env = parser.add_argument_group("Environment")
    env.add_argument("--check", action="store_true", help="check Node, dependencies, ports and WSL, then exit")
    env.add_argument("--install", action="store_true", help="run 'npm ci' automatically when dependencies are missing (this is the default)")
    env.add_argument("--no-install", action="store_true", help="do not install missing dependencies; report them and stop")
    env.add_argument("--yes", "-y", action="store_true", help="answer yes to prompts")
    env.add_argument("--verbose", "-v", action="store_true", help="print the exact command that is started")
    env.add_argument("passthrough", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    return parser


def agent_arguments(args: argparse.Namespace, control_port: int, host: Optional[str]) -> list[str]:
    """The argument list for ``src/cli.ts``. Pure, so it can be tested without starting anything."""
    out: list[str] = []
    if args.simulated is not None:
        out += ["--sim", args.simulated]
    else:
        if host:
            out += ["--host", host]
        if args.port is not None:
            out += ["--port", str(args.port)]
        if args.username:
            out += ["--username", args.username]
        if args.version:
            out += ["--version", args.version]
        if args.auth:
            out += ["--auth", args.auth]
    if args.task:
        out += ["--task", args.task]
    if args.resource:
        out += ["--resource", args.resource]
    if args.count is not None:
        out += ["--count", str(args.count)]
    if args.one_shot:
        out += ["--one-shot", "--control-center"]
    else:
        out += ["--persistent", "--control-center"]
    if args.no_autonomy:
        out.append("--no-autonomy")
    if args.no_connect:
        out.append("--no-connect")
    out += ["--control-port", str(control_port), "--control-host", args.control_host]
    if not args.no_browser:
        out.append("--open-browser")
    passthrough = [item for item in args.passthrough if item != "--"] if args.passthrough else []
    return out + passthrough


def read_proc_version() -> Optional[str]:
    try:
        return Path("/proc/version").read_text(encoding="utf-8")
    except OSError:
        return None


def discover_windows_host(platform: wsl.Platform) -> list[str]:
    if not platform.wsl:
        return []
    route: Optional[str] = None
    try:
        route = subprocess.run(["ip", "route", "show", "default"], capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        route = None
    try:
        resolv = Path("/etc/resolv.conf").read_text(encoding="utf-8")
    except OSError:
        resolv = None
    return wsl.windows_host_candidates(route, resolv)


def ask(question: str, assume_yes: bool, interactive: bool) -> bool:
    if assume_yes:
        return True
    if not interactive:
        return False
    try:
        return input(f"{question} [y/N] ").strip().lower() in {"y", "yes"}
    except EOFError:
        return False


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
    out: Callable[[str], None] = print,
    spawn_fn: Callable[..., "subprocess.Popen"] = process.spawn,
) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    root = (root or Path(__file__).resolve().parent.parent).resolve()
    environment = dict(os.environ if env is None else env)
    # Plain `python3 main.py` opens the Control Center and waits: the operator connects from the page, with host and port
    # typed there. Any explicit connection request (a host, a port, the simulator, a task) still connects at once.
    explicit_connection = bool(
        args.host or args.port is not None or args.simulated is not None or args.task
        or environment.get("MINECRAFT_HOST") or environment.get("MINECRAFT_PORT")
    )
    if not explicit_connection:
        args.no_connect = True
    system = platform_module.system()
    plat = wsl.detect_platform(system, environment, read_proc_version())
    interactive = sys.stdin.isatty() and sys.stdout.isatty()

    problems = checks.check_project(root)
    node = checks.find_executable(checks.node_candidates(environment, system.lower()))
    version = checks.node_version(node) if node else None
    problems += checks.check_node(node, version)
    dependency_problems = checks.check_dependencies(root, system, platform_module.machine()) if not problems else []

    if dependency_problems and dependency_problems[0].code == "DEPENDENCIES_MISSING" and node:
        npm = checks.find_executable(["npm.cmd", "npm"] if system.lower() == "windows" else ["npm"])
        if npm and ask("Dependencies are missing. Run 'npm ci' now?", not args.no_install, interactive):
            out(f"Running: {npm} ci (this can take a minute)")
            code = subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=str(root), check=False).returncode
            dependency_problems = checks.check_dependencies(root, system, platform_module.machine()) if code == 0 else dependency_problems
            if code != 0:
                out(f"'npm ci' failed with exit code {code}.")
    problems += dependency_problems

    mount_warning = checks.check_windows_mount(root, plat.wsl)
    optional_tools = checks.check_optional_tools(system)
    data_dir = root / "data"
    running = checks.existing_instance(data_dir)

    explicit_port = args.control_port is not None
    control_port, port_problem = (None, None)
    if not running:
        control_port, port_problem = checks.choose_control_port(args.control_port if explicit_port else DEFAULT_CONTROL_PORT, explicit_port, args.control_host)
        if port_problem:
            problems.append(port_problem)

    if args.check:
        out(f"Project:      {root}")
        out(f"Platform:     {system}{' (WSL' + str(plat.wsl_version or '') + (', ' + plat.distro if plat.distro else '') + ')' if plat.wsl else ''}")
        out(f"Node:         {node or 'not found'} {'.'.join(map(str, version)) if version else ''}")
        out(f"Control port: {control_port if control_port is not None else 'unavailable'}")
        if running:
            out(f"Running:      GameMind is already running (process {running.get('pid')}) at {running.get('url') or 'an unknown address'}")
        if mount_warning:
            out(f"Warning:      {mount_warning}")
        for tool in optional_tools:
            out(f"Optional:     {tool.render()}")
        for problem in problems:
            out(f"Problem:      {problem.render()}")
        out("Environment OK." if not problems else f"{len(problems)} problem(s) found.")
        return 0 if not problems else 1

    if running and not problems:
        url = running.get("url")
        out(f"GameMind is already running (process {running.get('pid')}){' at ' + url if url else ''}. Not starting a second copy.")
        if url and not args.no_browser:
            out("Open that address in your browser. (Starting only one copy keeps one bot connected.)")
        return 0
    if problems:
        out("GameMind cannot start yet:")
        for problem in problems:
            out(f"  - {problem.render()}")
        return 2
    assert node is not None and control_port is not None

    host: Optional[str] = args.host
    # Host detection also runs without a connection: the Control Center pre-fills its host field from it under WSL.
    if args.simulated is None:
        port = args.port or int(environment.get("MINECRAFT_PORT", "25565") or "25565")
        decision = wsl.choose_host(args.host, environment.get("MINECRAFT_HOST"), port, plat, discover_windows_host(plat), wsl.probe_tcp)
        host = decision.host if (decision.changed or args.host) else None
        for note in decision.notes:
            out(f"Note: {note}")
        if not decision.changed and not args.host and not environment.get("MINECRAFT_HOST"):
            status = wsl.probe_tcp(decision.host, port)
            if status != "open":
                out(f"Note: nothing answers at {decision.host}:{port} right now ({status}). GameMind will still start and explain the failure; start Minecraft (or open the world to LAN) and connect from the page.")
    if mount_warning:
        out(f"Note: {mount_warning}")
    for tool in optional_tools:
        if not tool.found:
            out(f"Note: {tool.render()}")

    command = process.build_command(node, root, agent_arguments(args, control_port, host))
    if args.verbose:
        out("Starting: " + " ".join(command))
    child = spawn_fn(command, root)
    state = {"stopping": False, "ready": None}

    def on_line(line: str) -> None:
        ready = process.parse_ready_line(line)
        if ready is not None:
            state["ready"] = ready
            browser = ready.get("browser") or {}
            out(f"GameMind is running. Control Center: {ready.get('url')}")
            if browser.get("requested") and not browser.get("opened"):
                out(f"Your browser could not be opened automatically ({browser.get('reason') or 'no reason given'}). Open {ready.get('url')} yourself.")
            elif browser.get("opened"):
                out(f"Opened in your default browser ({browser.get('method')}).")
            out("Press Ctrl-C to stop GameMind (the bot disconnects cleanly).")
            return
        out(line)

    def request_stop(reason: str) -> None:
        if state["stopping"]:
            threading.Thread(target=process.force_stop, args=(child, 15), daemon=True).start()
            return
        state["stopping"] = True
        out(f"Stopping GameMind ({reason})...")
        threading.Thread(target=lambda: process.stop_process(child), daemon=True).start()

    restore = process.install_signal_handlers(request_stop)
    reader = process.relay_output(child, on_line)
    try:
        code = child.wait()
        reader.join(timeout=3)
    except KeyboardInterrupt:
        request_stop("KeyboardInterrupt")
        code = child.wait()
    finally:
        restore()
        if child.poll() is None:
            process.stop_process(child, grace=5, term_grace=3)
    return code if code is not None else 1
