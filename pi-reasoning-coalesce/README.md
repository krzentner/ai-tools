# pi-reasoning-coalesce

A [pi](https://pi.dev) extension that merges OpenRouter's per-token
`reasoning_details` before pi replays them, so reasoning models stop thinking
one word per line.

## The problem

OpenRouter streams reasoning as `reasoning_details`, one `reasoning.text`
entry per token. pi stores that array in the thinking block's
`thinkingSignature` and sends it back verbatim on every later request of the
session, as OpenRouter's docs ask. Some upstreams reassemble hundreds of
one-token entries with separators, and from roughly the third tool call the
model sees its earlier reasoning as one word per line and imitates it:

```
The
 code
base
 is
 ~
11
.5
K
 lines
```

Half or more of the billed reasoning tokens become newlines, the traces are
unreadable, and the effect escalates over a session (2.4 newlines per word
was observed late in a long review). Reproduced with `z-ai/glm-5.3-flash`
across the Z.AI, Wafer and Modal upstreams in a plain multi-step tool loop;
the same loop without replay, or with the reasoning replayed as one entry
per block, is clean at every step.

## What it does

In pi's `context` hook — per request, never touching the session file — every
assistant thinking block whose signature is a reasoning-details array gets
its consecutive plain `reasoning.text` entries merged into one. Entries with
a cryptographic `signature`, and `reasoning.encrypted` / `reasoning.summary`
entries, are left untouched and in place, so providers that verify them still
receive the original sequence. Blocks whose signature is not such an array
(llama.cpp's `reasoning_content`, Anthropic signatures, …) are ignored.

`/reasoning-coalesce` shows how many requests were rewritten this session.

## Install

```
./install.py            # symlink into ~/.pi/agent/extensions
./install.py --uninstall
```

## Tests

```
npm test
```
