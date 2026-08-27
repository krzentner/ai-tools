#!/usr/bin/env python3
"""Install (or remove) the *.human.md write guard for pi, Claude Code and Codex.

What it does, per tool - each step is skipped with --no-<tool>:

  pi          symlinks this directory to ~/.pi/agent/extensions/human-md-guard,
              where pi discovers extensions. pi loads it on next start.
  claude      merges into ~/.claude/settings.json:
                - permissions.deny += "Edit(//**/*.human.md)"
                - hooks.PreToolUse += a hook running ./agent-guard-human-md
              Claude Code reloads the file live; no restart needed.
  codex       merges into ~/.codex/hooks.json:
                - hooks.PreToolUse += the same hook, matched on apply_patch/Bash
              Codex then needs the hook trusted once in an interactive session
              ("Hooks need review" at startup, or /hooks); it silently skips
              untrusted hooks.

Merging, not overwriting: anything already in those files is preserved (only
re-indented). Re-running is a no-op once the entries are present, and an entry
pointing at an older location of this directory is replaced. --uninstall
removes exactly what this script adds and nothing else.

Requires python3 (stdlib only). The hook itself needs node >= 22.18 to make
fine-grained decisions; without node it falls back to blocking any tool call
that mentions .human.md at all.

Usage:
    ./install.py                 # all three tools
    ./install.py --no-codex      # skip one
    ./install.py --uninstall
    ./install.py --dry-run       # print what would change
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK_CMD = str(HERE / "agent-guard-human-md")
HOOK_BASENAME = "agent-guard-human-md"
EXTENSION_NAME = "human-md-guard"

CLAUDE_DENY_RULE = "Edit(//**/*.human.md)"
# Claude Code matches `matcher` as a regex over the tool name. Edit/Write/
# NotebookEdit are already covered by the deny rule (Claude consults Edit
# rules for all of them); the hook is what covers Bash. Listing the file tools
# too costs nothing and guards the day the deny rule is edited away.
CLAUDE_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit"
# Codex names file edits apply_patch (Edit/Write are aliases) and shell Bash.
CODEX_MATCHER = "^(apply_patch|Edit|Write|Bash)$"


def log(msg: str) -> None:
    print(msg)


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    raw = path.read_text()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: top level is not a JSON object; refusing to touch it")
    return data


def save_json(path: Path, data: dict, dry_run: bool) -> None:
    if dry_run:
        log(f"  would write {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")
    log(f"  wrote {path}")


def is_our_hook(entry: object) -> bool:
    """True for a PreToolUse entry that runs this guard (at any path)."""
    if not isinstance(entry, dict):
        return False
    for hook in entry.get("hooks", []):
        command = hook.get("command", "") if isinstance(hook, dict) else ""
        if command == HOOK_CMD or command.endswith("/" + HOOK_BASENAME):
            return True
    return False


def merge_hook(settings: dict, matcher: str) -> bool:
    """Ensure exactly one up-to-date entry for our hook. Returns True if changed."""
    pre = settings.setdefault("hooks", {}).setdefault("PreToolUse", [])
    wanted = {"matcher": matcher, "hooks": [{"type": "command", "command": HOOK_CMD}]}
    ours = [e for e in pre if is_our_hook(e)]
    if ours == [wanted]:
        return False
    pre[:] = [e for e in pre if not is_our_hook(e)] + [wanted]
    return True


def remove_hook(settings: dict) -> bool:
    hooks = settings.get("hooks", {})
    pre = hooks.get("PreToolUse", [])
    kept = [e for e in pre if not is_our_hook(e)]
    if len(kept) == len(pre):
        return False
    pre[:] = kept
    return True


def install_claude(home: Path, dry_run: bool) -> None:
    path = home / ".claude" / "settings.json"
    log(f"claude: {path}")
    settings = load_json(path)
    changed = False

    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    if CLAUDE_DENY_RULE not in deny:
        deny.append(CLAUDE_DENY_RULE)
        changed = True

    changed |= merge_hook(settings, CLAUDE_MATCHER)
    if not changed:
        log("  already installed")
        return
    save_json(path, settings, dry_run)


def uninstall_claude(home: Path, dry_run: bool) -> None:
    path = home / ".claude" / "settings.json"
    log(f"claude: {path}")
    if not path.exists():
        log("  not present")
        return
    settings = load_json(path)
    changed = False

    permissions = settings.get("permissions", {})
    deny = permissions.get("deny", [])
    if CLAUDE_DENY_RULE in deny:
        deny.remove(CLAUDE_DENY_RULE)
        changed = True
    # Drop the containers we created if they are now empty.
    if not deny and "deny" in permissions:
        del permissions["deny"]
    if not permissions and "permissions" in settings:
        del settings["permissions"]

    changed |= remove_hook(settings)
    if not changed:
        log("  nothing to remove")
        return
    save_json(path, settings, dry_run)


def install_codex(home: Path, dry_run: bool) -> None:
    path = home / ".codex" / "hooks.json"
    log(f"codex: {path}")
    settings = load_json(path)
    if not merge_hook(settings, CODEX_MATCHER):
        log("  already installed")
        return
    save_json(path, settings, dry_run)


def uninstall_codex(home: Path, dry_run: bool) -> None:
    path = home / ".codex" / "hooks.json"
    log(f"codex: {path}")
    if not path.exists():
        log("  not present")
        return
    settings = load_json(path)
    if not remove_hook(settings):
        log("  nothing to remove")
        return
    save_json(path, settings, dry_run)


def install_pi(home: Path, dry_run: bool) -> None:
    link = home / ".pi" / "agent" / "extensions" / EXTENSION_NAME
    log(f"pi: {link}")
    if link.is_symlink() and link.resolve() == HERE:
        log("  already installed")
        return
    if link.exists() or link.is_symlink():
        raise SystemExit(f"  {link} exists and is not a link to this directory; move it aside first")
    if dry_run:
        log(f"  would symlink -> {HERE}")
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(HERE)
    log(f"  symlinked -> {HERE}")


def uninstall_pi(home: Path, dry_run: bool) -> None:
    link = home / ".pi" / "agent" / "extensions" / EXTENSION_NAME
    log(f"pi: {link}")
    if not link.is_symlink():
        log("  not present")
        return
    if link.resolve() != HERE:
        log(f"  {link} points elsewhere ({os.readlink(link)}); leaving it alone")
        return
    if dry_run:
        log("  would remove symlink")
        return
    link.unlink()
    log("  removed symlink")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--uninstall", action="store_true", help="remove what this script installed")
    parser.add_argument("--dry-run", action="store_true", help="print what would change, change nothing")
    for tool in ("pi", "claude", "codex"):
        parser.add_argument(f"--no-{tool}", dest=f"skip_{tool}", action="store_true", help=f"skip {tool}")
    args = parser.parse_args(argv)

    if not (HERE / "agent-guard-human-md").exists():
        raise SystemExit(f"agent-guard-human-md not found next to {__file__}; run from a full checkout")

    home = Path(os.environ.get("HOME") or Path.home())
    steps = {
        "pi": (install_pi, uninstall_pi),
        "claude": (install_claude, uninstall_claude),
        "codex": (install_codex, uninstall_codex),
    }
    for tool, (install, uninstall) in steps.items():
        if getattr(args, f"skip_{tool}"):
            log(f"{tool}: skipped")
            continue
        (uninstall if args.uninstall else install)(home, args.dry_run)

    if not args.uninstall and not args.dry_run:
        log("\nDone. Claude Code picks the change up live; restart pi sessions.")
        if not args.skip_codex:
            log(
                "\nCodex: hooks only run once you have trusted them. Start `codex` once,\n"
                "and when it says \"Hooks need review\" choose \"Trust all and continue\"\n"
                "(or use /hooks). Until then Codex silently skips this hook."
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
