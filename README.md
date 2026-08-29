# ai-tools

Small, self-contained tools for working with AI coding agents (pi, Claude
Code, Codex). Each directory stands alone with its own README, installer and
tests; nothing here needs a build step.

| Tool | What it does |
|------|--------------|
| [human-md-guard](human-md-guard/) | Makes `*.human.md` files read-only to agents — readable, never edited — enforced through each tool's own hooks/permissions. |
| [pi-unblock](pi-unblock/) | pi extension: interrupts generation loops (exact repeats, near-duplicate thinking, repeated tool calls), refuses tool-call loops, and applies a default/maximum shell timeout. |
