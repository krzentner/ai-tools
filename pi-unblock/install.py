#!/usr/bin/env python3
"""Install (or remove) pi-unblock for pi.

Symlinks this directory to ~/.pi/agent/extensions/pi-unblock, where pi
discovers extensions; pi loads it on next start (or `/reload`). Re-running is
a no-op once the link exists; a link pointing at an older location of this
directory is replaced. --uninstall removes exactly that link.

Usage:
    ./install.py
    ./install.py --uninstall
    ./install.py --dry-run
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = Path(os.environ.get("PI_AGENT_DIR", Path.home() / ".pi" / "agent")) / "extensions" / "pi-unblock"


def install(dry_run: bool) -> int:
    if TARGET.is_symlink() and TARGET.resolve() == HERE:
        print(f"already installed: {TARGET} -> {HERE}")
        return 0
    if TARGET.exists() or TARGET.is_symlink():
        if not TARGET.is_symlink():
            print(f"refusing to replace a real directory: {TARGET}", file=sys.stderr)
            return 1
        print(f"replacing stale link {TARGET} -> {os.readlink(TARGET)}")
        if not dry_run:
            TARGET.unlink()
    print(f"link {TARGET} -> {HERE}")
    if not dry_run:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.symlink_to(HERE)
    return 0


def uninstall(dry_run: bool) -> int:
    if not TARGET.is_symlink():
        print(f"not installed: {TARGET}")
        return 0
    print(f"remove {TARGET}")
    if not dry_run:
        TARGET.unlink()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    return uninstall(a.dry_run) if a.uninstall else install(a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
