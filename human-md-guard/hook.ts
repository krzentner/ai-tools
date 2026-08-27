// PreToolUse hook for Claude Code and Codex: refuse tool calls that would
// write a `*.human.md` file.
//
// Both tools use the same hook protocol: the pending call arrives as JSON on
// stdin with `tool_name` and `tool_input`, and exit code 2 with the reason on
// stderr denies it (the reason is shown to the model). Exit 0 lets it proceed.
// Anything else is treated as a hook error and the call goes ahead, so this
// script never throws on malformed input - it just allows.
//
// Invoked via ./agent-guard-human-md, which is what the settings files point
// at; run directly only for testing:
//
//   echo '{"tool_name":"Write","tool_input":{"file_path":"a.human.md"}}' | node --no-warnings hook.ts
//
// The rules themselves are in guard.ts, shared with the pi extension.

import { judgeToolCall } from "./guard.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let payload: { tool_name?: unknown; tool_input?: unknown } = {};
try {
	payload = JSON.parse(raw);
} catch {
	process.exit(0);
}

const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
const verdict = judgeToolCall(toolName, payload.tool_input);
if (!verdict.block) process.exit(0);

process.stderr.write(`${verdict.reason}\n`);
process.exit(2);
