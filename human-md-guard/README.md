# human-md-guard

Stop AI coding agents from writing files you've reserved for yourself.

Name a file `something.human.md` and **pi**, **Claude Code** and **Codex** will
all be able to read it but not edit, create, move or delete it — enforced by
each tool's own permission/hook machinery, not by asking the model nicely.

Useful for: design notes you want to stay in your own words, a running log of
decisions, review comments, anything where "the agent tidied it up" would be a
loss.

## Install

Requires `python3` for the installer and `node` ≥ 22.18 for the hook (it runs
the TypeScript rules directly; no `npm install`, no build step).

```bash
git clone https://github.com/krzentner/ai-tools ~/ai-tools   # or wherever
~/ai-tools/human-md-guard/install.py
```

That does three things, each skippable with `--no-pi` / `--no-claude` / `--no-codex`:

| Tool | Mechanism | Where |
|------|-----------|-------|
| pi | extension blocking the `tool_call` event | symlink at `~/.pi/agent/extensions/human-md-guard` |
| Claude Code | `permissions.deny` rule `Edit(//**/*.human.md)` + a `PreToolUse` hook on `Bash` | merged into `~/.claude/settings.json` |
| Codex | the same `PreToolUse` hook on `apply_patch` and `Bash` | merged into `~/.codex/hooks.json` |

The installer *merges*: whatever is already in those files stays (other hooks,
your model choice, existing deny rules). Re-running is a no-op. `--dry-run`
shows what would change; `--uninstall` removes exactly what was added.

Keep the clone where it is — the settings point at the hook script by absolute
path. If you move it, re-run `install.py` and it fixes the paths.

Then tell the agents about the rule so they don't waste turns bumping into it.
A line like this in `CLAUDE.md` / `AGENTS.md` / pi's `AGENTS.md` works:

> Files named `*.human.md` are written by the user only. Read them whenever
> useful, but never edit, create, move or delete one; if a change is needed,
> describe it and let the user make it.

## How it works

One rule module, `guard.ts`, is shared by everything:

- **File tools** (Edit, Write, NotebookEdit, pi's `edit`/`write`, MCP
  filesystem servers): blocked if any path-like argument (`path`, `file_path`,
  `notebook_path`, `destination`, …) ends in `.human.md`. Codex's
  `apply_patch` carries a patch body instead of a path, so its
  `*** Update File:` / `*** Move to:` headers are parsed. Only path fields
  count — writing a README that *mentions* `notes.human.md` is fine.
- **Read-only tools** (`read`, `grep`, `find`, `ls`, MCP `read_file` and
  friends) always pass. Reading is the point.
- **Shell commands** can't be resolved to a file list, so the rule is a
  conservative heuristic. A command that mentions `.human.md` is allowed only
  if *every* simple command in it is on a read-only list (`cat`, `grep`,
  `head`, `git diff`, `git commit`, …, with `sed -i` / `find -delete` /
  `git checkout` excluded) **and** nothing is redirected to a file. Quoted
  strings and heredoc bodies are treated as data, so a commit message may
  mention the files.

Claude Code and Codex talk to the hook with the same protocol (the pending
call as JSON on stdin; exit 2 + stderr to deny), so `agent-guard-human-md`
serves both. It runs `hook.ts` under node, and if node is missing it falls
back to a plain `grep` that denies any call mentioning `.human.md` at all —
coarser, but it fails closed.

On Claude Code the deny rule does most of the work: Claude consults `Edit`
rules for Write, NotebookEdit and shell redirections too. The hook is there
for the shell commands a path rule can't see (`sed -i`, `mv`, `tee`, a Python
one-liner).

## What it can't do

The guard sees the tool calls the harness routes through it. It cannot see a
write made by a program the agent starts — a script it wrote and then ran with
a path built at runtime, a subagent with its own tool set. Treat it as a
backstop for the instruction above, not a substitute for it. If you need a
hard guarantee, make the file immutable at the filesystem level
(`chattr +i` on Linux).

The shell heuristic will occasionally block a legitimate read-only command it
doesn't recognise. The agent can always use its Read tool instead.

## Test

```bash
node index.test.ts
```

Covers the path rules, the shell heuristic, the hook end-to-end through the
wrapper, the no-node fallback, the pi handler wiring, and the installer
against a throwaway `$HOME`.

## Files

- `guard.ts` — the rules (no dependencies)
- `index.ts` — pi extension entry point
- `hook.ts` — stdin/exit-code hook for Claude Code and Codex
- `agent-guard-human-md` — shell wrapper the settings point at
- `install.py` — installer / uninstaller
- `index.test.ts` — tests
