import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { judgeToolCall } from "./guard.ts";

// Refuse any tool call that would write a `*.human.md` file. The rules live in
// guard.ts, which the Claude Code / Codex hook shares - see that file.
//
// `tool_call` fires for every tool, including ones registered by packages, so
// path-named fields on custom and MCP tools are covered too. What it cannot
// see is a write made by a process the agent starts (a script it wrote, a
// subagent's own tools), so the bash rule is deliberately conservative.
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		const verdict = judgeToolCall(event.toolName, event.input);
		if (!verdict.block) return undefined;
		return { block: true, reason: verdict.reason };
	});
}
