# pi-unblock

A [pi](https://pi.dev) extension that keeps a session moving when the model
stops making progress:

1. **Generation loops are interrupted.** While the assistant streams, its text,
   thinking *and tool calls* are watched for repetition. On detection the run
   is aborted immediately (no more tokens, and none of the message's pending
   tool calls execute) and a follow-up message tells the model what it was
   doing and to take a different step.
2. **Tool-call loops are refused.** Before a tool runs, the call is checked
   against recent calls: identical repeats and calls whose result has not
   changed are refused (the batch ends and the model gets a fresh turn); short
   cycles and near-repeats get a hint injected into the current turn.
3. **Shell commands get a timeout.** `bash`/`powershell` calls without a
   `timeout` get 60 seconds; the model may ask for more, up to 600. The system
   prompt says so (pi's own tool description says "no default timeout"), and a
   timed-out result explains how to get more time or background the job.

It is a superset of [loop-guard](https://github.com/isr4el-silv4/loop-guard)
(execution-side: repeats, cycles, stagnation, escalation) and
[pi-no-spin](https://www.npmjs.com/package/pi-no-spin) (generation-side
periodicity check), with two additions that motivated it: tool calls are part
of the watched stream, so a model that emits the same tool call thousands of
times in one message is cut off at the seventh, and near-duplicate detection
catches the thinking loops of local models (Gemma, Qwen, DeepSeek) that never
repeat byte-for-byte.

## Detection

**Generation (streaming)** - run every 40 new characters and on every
completed tool call, over `text + thinking + "[call name args]"`:

| detector | fires when | default |
|---|---|---|
| periodic | the tail is one segment (4-400 chars) repeated N times exactly | N = 6 |
| similar-lines | N consecutive lines are each >= 80% word-similar (Jaccard) to a line within the previous 6 | N = 8, lines >= 24 chars |
| low-diversity | fewer than 20% of the 12-character n-grams in the last 3000 characters are distinct | |

Whitespace-only and separator-only repeats (rules, dot leaders, table borders)
never count. The two fuzzy detectors are for prose and thinking; `textFuzzy:
false` keeps only the exact check.

**Tool calls (before execution)** - `edit` and `write` are ignored (small
successive edits are normal):

| detector | action | default |
|---|---|---|
| exact: same tool, identical (canonicalized) arguments, N in a row | refuse | N = 3 (2 allowed) |
| stagnant: the same call returned the identical result N times | refuse | N = 3 |
| cycle: a sequence of 2-4 calls repeated N times | hint, then refuse | hint x3, refuse x6 |
| fuzzy: same tool, >= 85% similar arguments, N in a row | hint | N = 5 |

A refusal returns an error result to the model and sets pi's `terminate`
flag, so the current tool batch ends and the model answers with the refusal
in view. A hint is a steer message delivered inside the current turn, once
per kind per turn.

**Escalation.** Every interruption (abort or refusal) is a strike; a turn
without any detection clears them. After `maxStrikes` (3) without a clean
turn, pi-unblock stops re-prompting and aborts, so a headless run ends
instead of looping at a higher level. `/unblock reset` clears the state.

Every interruption is recorded in the session as a `pi-unblock/event` entry
(kind, detail, strike count), so a session file shows what happened.

## Install

```bash
./install.py            # symlinks this directory into ~/.pi/agent/extensions/
./install.py --uninstall
```

or, without installing, `pi -e /path/to/pi-unblock/index.ts`.

## Configure

`/unblock` in a session:

```
/unblock                         status
/unblock on|off                  loop detection (the timeout policy stays on)
/unblock timeout 60 600          default and maximum shell timeout, seconds (0 = no policy)
/unblock set tools.exactBlockAfter 3
/unblock set text.periodic.threshold 8
/unblock set textFuzzy off
/unblock reset                   clear trackers and strikes
```

Changes persist in the session file. Defaults for every session come from
`~/.pi/agent/unblock.json` (or `$PI_UNBLOCK_CONFIG`), merged over the
built-in defaults - the full key set is `DEFAULTS` in `config.ts`, e.g.

```json
{ "timeout": { "defaultSeconds": 120, "maxSeconds": 1800 }, "tools": { "exactBlockAfter": 3 } }
```

## Headless runs

Everything works in `pi --print` mode too: refusals and hints are ordinary
tool results and steer messages, and pi delivers the queued follow-up after
the aborted run (verified below). For batch jobs a low `maxStrikes` keeps a
model that will not stop from getting many second chances.

## Verified against pi

`node --test` covers the detectors, tracker, timeout policy, config and the
hook wiring with a fake `ExtensionAPI`. Two real runs (`pi --print --mode json
-ne -e index.ts`, glm-5.3-flash via OpenRouter):

- asked to print one sentence 40 times: aborted after the 6th repeat
  (`stopReason: aborted`, 0 output tokens billed), follow-up delivered, the
  next turn answered normally;
- asked to run `bash true` ten times as ten calls: the model emitted all ten
  in one message; the stream detector fired at the sixth, the abort cancelled
  the batch after one execution, the follow-up turn ran `true` again and the
  third identical call was refused. The follow-up turn does run in `--print`
  mode.

## Test

```bash
node --test index.test.ts     # Node >= 22.18
```

## Files

- `index.ts` - the extension: hooks, escalation, `/unblock`
- `detect.ts` - text detectors (periodic, similar-lines, low-diversity)
- `tools.ts` - tool-call tracker (exact, stagnant, cycle, fuzzy)
- `timeout.ts` - shell timeout policy and prompt text
- `config.ts` - defaults, config file, command grammar
- `index.test.ts` - tests, including a replay of the failure that motivated this (14,308 `bash true` calls in one message)
- `install.py` - symlink installer
