#!/usr/bin/env python3
"""Start GameMind: the existing TypeScript agent and its Control Center, with checks, a browser and a clean shutdown.

    python3 main.py            persistent session, Control Center opened in your browser
    python3 main.py --help     every option

No AI runs in Python. This file only starts ``src/cli.ts`` and looks after the process.
"""

import sys

from launcher.cli import main

if __name__ == "__main__":
    sys.exit(main())
