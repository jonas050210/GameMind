"""Launcher for GameMind.

The launcher starts the existing TypeScript agent (``src/cli.ts``) and its Control Center. It contains no game
logic and no AI: everything that decides what the bot does lives in the TypeScript project. Its job is the part that
goes wrong before Node is even running: finding the right executables, checking the environment (including the
Windows/WSL split), picking a free port, passing the right arguments, relaying output, and stopping the child cleanly.

Only the Python standard library is used.
"""

__all__ = ["checks", "wsl", "process", "cli"]
