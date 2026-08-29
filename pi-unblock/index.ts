/**
 * pi-unblock: keeps a pi session moving.
 *
 *   1. Generation loops. While the assistant streams, its text, thinking and
 *      tool calls are watched for repetition (exact periodic repeats, runs of
 *      near-duplicate lines, low n-gram diversity). On detection the run is
 *      aborted and a follow-up message tells the model what it was doing.
 *   2. Tool-call loops. Before each tool executes, identical repeats,
 *      stagnant results and short cycles are caught: repeats are refused
 *      (with `terminate` so the batch ends and the model gets a fresh turn),
 *      near-repeats and early cycles get a steer hint.
 *   3. Shell timeouts. `bash`/`powershell` calls without a timeout get the
 *      default (60 s); requests above the ceiling (600 s) are clamped. The
 *      system prompt says so, and a timed-out result says how to get more.
 *
 * After `maxStrikes` interruptions without a clean turn in between, the
 * extension stops re-prompting so a headless run ends instead of spinning at
 * a higher level.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCommand, CONFIG_ENTRY, describe, EVENT_ENTRY, loadConfig, type UnblockConfig } from "./config.ts";
import { detectTextLoop, type TextLoop } from "./detect.ts";
import { applyTimeout, TIMED_OUT_RE, TIMEOUT_TOOLS, timeoutGuidance, timeoutHint } from "./timeout.ts";
import { signature, type ToolLoop, ToolTracker } from "./tools.ts";

interface TextBlock {
	type?: string;
	text?: string;
}

const textOf = (content: unknown): string =>
	Array.isArray(content) ? (content as TextBlock[]).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("") : "";

/** What the model sees after an aborted generation. */
export function reminder(loop: TextLoop): string {
	return (
		`[pi-unblock] Your last response was interrupted because you were repeating yourself: ${loop.detail} ` +
		`(for example: "${loop.sample}"). Do not continue that output. Re-read the task, say in one sentence ` +
		"what you were trying to do, then take the next concrete, different step or give your final answer."
	);
}

/** The tool result a refused call gets. */
export function refusal(loop: ToolLoop): string {
	return (
		`[pi-unblock] Refused: ${loop.detail}. Running it again will not change anything. ` +
		"Take a different action, or explain what is blocking you."
	);
}

export default function (pi: ExtensionAPI): void {
	let cfg: UnblockConfig = loadConfig();
	let tracker = new ToolTracker(cfg.tools);

	// streaming state for the current assistant message
	let stream = "";
	let checkedAt = 0;
	let firedAt = 0;
	// escalation state
	let strikes = 0;
	let turnHadLoop = false;
	const hinted = new Set<string>();

	const notify = (ctx: ExtensionContext, msg: string, level: "warning" | "error" | "info" = "warning"): void => {
		try {
			ctx.ui.notify(msg, level);
		} catch {
			/* headless */
		}
	};

	const record = (kind: string, detail: string): void => {
		pi.appendEntry(EVENT_ENTRY, { kind, detail, strikes, ts: Date.now() });
	};

	const strike = (ctx: ExtensionContext, what: string): boolean => {
		strikes++;
		turnHadLoop = true;
		if (strikes <= cfg.maxStrikes) return true;
		notify(ctx, `pi-unblock: giving up after ${strikes} interruptions (${what}); run /unblock reset to continue`, "error");
		record("gave-up", what);
		return false;
	};

	/** Abort the stream and hand the model a corrective follow-up. */
	function interrupt(ctx: ExtensionContext, loop: TextLoop): void {
		firedAt = Date.now();
		const keepGoing = strike(ctx, loop.detail);
		record(loop.kind, loop.detail);
		notify(ctx, `pi-unblock: ${loop.detail} - generation interrupted`);
		try {
			ctx.abort();
		} catch {
			/* not streaming */
		}
		if (keepGoing) pi.sendUserMessage(reminder(loop), { deliverAs: "followUp" });
	}

	function checkStream(ctx: ExtensionContext, force: boolean): void {
		if (!cfg.enabled || Date.now() - firedAt < cfg.cooldownMs) return;
		if (!force && stream.length - checkedAt < cfg.checkEveryChars) return;
		checkedAt = stream.length;
		const loop = detectTextLoop(stream, cfg.text, cfg.textFuzzy);
		if (loop) interrupt(ctx, loop);
	}

	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CONFIG_ENTRY) cfg = entry.data as UnblockConfig;
		}
		tracker = new ToolTracker(cfg.tools);
		strikes = 0;
		stream = "";
	});

	pi.on("before_agent_start", async (event) => {
		if (cfg.timeout.defaultSeconds <= 0) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${timeoutGuidance(cfg.timeout)}` };
	});

	pi.on("message_start", async (event) => {
		if ((event.message as { role?: string }).role !== "assistant") return;
		stream = "";
		checkedAt = 0;
	});

	pi.on("message_update", async (event, ctx) => {
		const ev = event.assistantMessageEvent as { type: string; delta?: string; toolCall?: { name: string; arguments: unknown } };
		if (ev.type === "text_delta" || ev.type === "thinking_delta") {
			stream += ev.delta ?? "";
			checkStream(ctx, false);
		} else if (ev.type === "toolcall_end" && ev.toolCall) {
			const sig = signature(ev.toolCall.name, ev.toolCall.arguments);
			stream += `\n[call ${sig.name} ${sig.args}]\n`;
			checkStream(ctx, true);
		}
	});

	// Non-streaming providers, or a loop that completed between checks.
	pi.on("message_end", async (event, ctx) => {
		const m = event.message as { role?: string; stopReason?: string; content?: unknown };
		if (m.role !== "assistant" || m.stopReason === "aborted" || !cfg.enabled) return;
		if (Date.now() - firedAt < cfg.cooldownMs) return;
		const text = (Array.isArray(m.content) ? m.content : [])
			.map((c: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) =>
				c.type === "text" ? (c.text ?? "") : c.type === "thinking" ? (c.thinking ?? "") : c.type === "toolCall" ? `\n[call ${c.name} ${signature(c.name ?? "", c.arguments).args}]\n` : "",
			)
			.join("");
		const loop = detectTextLoop(text, cfg.text, cfg.textFuzzy);
		if (loop) interrupt(ctx, loop);
	});

	function hint(ctx: ExtensionContext, loop: ToolLoop): void {
		if (hinted.has(loop.kind)) return;
		hinted.add(loop.kind);
		record(`hint:${loop.kind}`, loop.detail);
		notify(ctx, `pi-unblock: ${loop.detail}`, "info");
		pi.sendMessage(
			{
				customType: "pi-unblock/hint",
				content: `[pi-unblock] Note: ${loop.detail}. If this is not converging, change the approach rather than repeating it.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	}

	function refuse(ctx: ExtensionContext, loop: ToolLoop): { block: true; reason: string; terminate: boolean } {
		record(`refused:${loop.kind}`, loop.detail);
		notify(ctx, `pi-unblock: refused ${loop.detail}`);
		const keepGoing = strike(ctx, loop.detail);
		if (!keepGoing) {
			try {
				ctx.abort();
			} catch {
				/* idle */
			}
		}
		return { block: true, reason: refusal(loop), terminate: true };
	}

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (TIMEOUT_TOOLS.has(event.toolName) && cfg.timeout.defaultSeconds > 0) applyTimeout(input, cfg.timeout);
		if (!cfg.enabled) return undefined;
		const loop = tracker.check(event.toolName, input);
		if (!loop) return undefined;
		const block =
			loop.kind === "exact" || loop.kind === "stagnant" || (loop.kind === "cycle" && loop.count >= cfg.tools.cycleBlockReps);
		if (block) return refuse(ctx, loop);
		hint(ctx, loop);
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const text = textOf(event.content);
		tracker.recordResult(event.toolName, event.input, text);
		if (!TIMEOUT_TOOLS.has(event.toolName) || !event.isError || cfg.timeout.defaultSeconds <= 0) return undefined;
		const m = TIMED_OUT_RE.exec(text);
		if (!m) return undefined;
		return { content: [...event.content, { type: "text" as const, text: `\n${timeoutHint(cfg.timeout, Number(m[1]))}` }] };
	});

	pi.on("turn_end", async () => {
		if (!turnHadLoop) strikes = 0;
		turnHadLoop = false;
		hinted.clear();
	});

	pi.registerCommand("unblock", {
		description: `Loop guard + shell timeout policy. ${describe(cfg)}. Usage: /unblock on|off | timeout <default> [max] | set <path> <value> | reset`,
		handler: async (args, ctx) => {
			try {
				const r = applyCommand(cfg, args);
				cfg = r.cfg;
				if (r.changed) {
					tracker = new ToolTracker(cfg.tools);
					pi.appendEntry(CONFIG_ENTRY, cfg);
				}
				if (r.reset) {
					tracker.reset();
					strikes = 0;
					firedAt = 0;
				}
				notify(ctx, r.message, "info");
			} catch (e) {
				notify(ctx, String((e as Error).message ?? e), "warning");
			}
		},
	});
}
