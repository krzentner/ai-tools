// Run with: node --test index.test.ts   (Node >= 22.18: built-in TypeScript type stripping)
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, DEFAULTS, deepMerge, setPath } from "./config.ts";
import { detectLowDiversity, detectPeriodic, detectSimilarLines, detectTextLoop, jaccard, wordSet } from "./detect.ts";
import registerExtension, { refusal, reminder } from "./index.ts";
import { applyTimeout, timeoutHint } from "./timeout.ts";
import { ToolTracker, signature } from "./tools.ts";

// ---------------------------------------------------------------- detect.ts

const call = (name: string, args: unknown): string => `\n[call ${name} ${JSON.stringify(args)}]\n`;

test("periodic: a stream of identical tool calls is caught early", () => {
	let text = "Now I'll extend the tokenizer, language map, and selector keyword maps.";
	let firedAt = -1;
	for (let i = 1; i <= 50; i++) {
		text += call("bash", { command: "true" });
		if (detectPeriodic(text, DEFAULTS.text.periodic)) {
			firedAt = i;
			break;
		}
	}
	assert.ok(firedAt > 0 && firedAt <= DEFAULTS.text.periodic.threshold + 1, `fired at call ${firedAt}`);
});

test("periodic: repeated sentence, and not formatting or ordinary prose", () => {
	const loop = "I need to check the file again. ".repeat(7);
	assert.equal(detectPeriodic(loop, DEFAULTS.text.periodic)?.kind, "periodic");
	assert.equal(detectPeriodic("─".repeat(80), DEFAULTS.text.periodic), null);
	assert.equal(detectPeriodic("- item\n".repeat(3) + "=".repeat(40), DEFAULTS.text.periodic), null);
	const prose = Array.from({ length: 30 }, (_, i) => `Step ${i}: read file ${i}.ts and note what function ${i} returns.`).join("\n");
	assert.equal(detectPeriodic(prose, DEFAULTS.text.periodic), null);
});

test("similar-lines: a Gemma/Qwen-style thinking loop with variations", () => {
	const variants = [
		"Wait, let me reconsider the problem statement once more before answering.",
		"Hmm, let me reconsider the problem statement again before I answer.",
		"Actually, let me reconsider the problem statement one more time before answering.",
	];
	const loop = Array.from({ length: 12 }, (_, i) => variants[i % 3]).join("\n");
	const det = detectSimilarLines(loop, DEFAULTS.text.similarLines);
	assert.equal(det?.kind, "similar-lines");
	// twelve genuinely different reasoning lines are fine
	const ok = [
		"The function takes a list of records and returns the ones matching the query.",
		"First I should look at how the parser tokenizes the input string.",
		"The tests expect an empty result when the query has no terms at all.",
		"There is an off-by-one in the range check on line 42, probably.",
		"Let me read the README to see which flags the CLI is supposed to accept.",
		"The regression suite runs in under a second, so I can iterate quickly.",
		"I will add a guard for the None case before touching the loop body.",
		"The YAML schedule uses weekday names, so the parser needs a lookup table.",
		"Exclusion rules apply after the job is selected, judging by the fixture.",
		"Output is JSON Lines on stdout; errors go to stderr with a non-zero exit.",
		"Timezone handling goes through zoneinfo, which is already imported.",
		"Next step: write the failing test for the duration window, then fix it.",
	].join("\n");
	assert.equal(detectSimilarLines(ok, DEFAULTS.text.similarLines), null);
});

test("low-diversity: recombined phrases are caught; code and prose are not", () => {
	const churn = "the answer is the answer is the answer so the answer is ".repeat(80);
	assert.equal(detectLowDiversity(churn, DEFAULTS.text.lowDiversity)?.kind, "low-diversity");
	const code = Array.from(
		{ length: 120 },
		(_, i) => `def handler_${i}(event, context):\n    return {"status": ${200 + (i % 7)}, "body": json.dumps(event.get("k${i}"))}`,
	).join("\n\n");
	assert.equal(detectLowDiversity(code, DEFAULTS.text.lowDiversity), null);
});

test("detectTextLoop: fuzzy detectors can be switched off", () => {
	const loop = Array.from({ length: 12 }, (_, i) => `Let me reconsider the problem statement again, take ${i % 2}.`).join("\n");
	assert.ok(detectTextLoop(loop, DEFAULTS.text, true));
	assert.equal(detectTextLoop(loop, DEFAULTS.text, false), null);
});

test("jaccard / wordSet", () => {
	assert.equal(jaccard(wordSet("ls -la /tmp"), wordSet("ls -la /tmp")), 1);
	assert.ok(jaccard(wordSet("pytest tests/test_a.py -q -x"), wordSet("pytest tests/test_a.py -q")) > 0.8);
	assert.equal(jaccard(new Set(), new Set()), 1);
});

// ----------------------------------------------------------------- tools.ts

test("tool tracker: identical repeats are refused after the allowance", () => {
	const t = new ToolTracker(DEFAULTS.tools);
	assert.equal(t.check("bash", { command: "true" }), null);
	assert.equal(t.check("bash", { command: "true" }), null);
	const third = t.check("bash", { command: "true" });
	assert.equal(third?.kind, "exact");
	assert.equal(third?.count, 3);
	// argument order does not matter
	const u = new ToolTracker(DEFAULTS.tools);
	u.check("read", { path: "a", offset: 1 });
	u.check("read", { offset: 1, path: "a" });
	assert.equal(u.check("read", { path: "a", offset: 1 })?.kind, "exact");
});

test("tool tracker: ignored tools, stagnant results, cycles, near-repeats", () => {
	const t = new ToolTracker(DEFAULTS.tools);
	for (let i = 0; i < 6; i++) assert.equal(t.check("edit", { path: "x", old: "a", new: "b" }), null);

	for (let i = 0; i < 3; i++) t.recordResult("bash", { command: "cat log" }, "same output");
	assert.equal(t.check("bash", { command: "cat log" })?.kind, "stagnant");

	const c = new ToolTracker(DEFAULTS.tools);
	let cyc = null;
	for (let i = 0; i < 6 && !cyc; i++) {
		cyc = c.check("read", { path: "f" }) ?? c.check("bash", { command: "pytest -q" });
	}
	assert.equal(cyc?.kind, "cycle");
	assert.equal(cyc?.count, DEFAULTS.tools.cycleHintReps);

	const f = new ToolTracker(DEFAULTS.tools);
	let fz = null;
	for (let i = 0; i < 8 && !fz; i++) fz = f.check("bash", { command: `pytest tests/test_scheduler.py::test_case --tb=short --color=no --maxfail=1 -q -k variant${i}` });
	assert.equal(fz?.kind, "fuzzy");
});

test("signature canonicalizes", () => {
	assert.equal(signature("t", { b: 1, a: [{ d: 1, c: 2 }] }).args, '{"a":[{"c":2,"d":1}],"b":1}');
});

// --------------------------------------------------------------- timeout.ts

test("applyTimeout: default, pass-through, clamp, garbage", () => {
	const p = DEFAULTS.timeout;
	const a: Record<string, unknown> = { command: "ls" };
	assert.deepEqual(applyTimeout(a, p), { seconds: 60, clamped: false, defaulted: true });
	assert.equal(a.timeout, 60);
	const b: Record<string, unknown> = { command: "make", timeout: 300 };
	assert.deepEqual(applyTimeout(b, p), { seconds: 300, clamped: false, defaulted: false });
	const c: Record<string, unknown> = { command: "make", timeout: 99999 };
	assert.deepEqual(applyTimeout(c, p), { seconds: 600, clamped: true, defaulted: false });
	const d: Record<string, unknown> = { command: "make", timeout: -5 };
	assert.equal(applyTimeout(d, p).seconds, 60);
	assert.match(timeoutHint(p, 60), /up to 600 seconds/);
	assert.match(timeoutHint(p, 600), /600 seconds is the maximum/);
});

// ---------------------------------------------------------------- config.ts

test("config: deepMerge, setPath, commands", () => {
	const merged = deepMerge(structuredClone(DEFAULTS), { timeout: { defaultSeconds: 30 }, tools: { ignoredTools: ["x"] } });
	assert.equal(merged.timeout.defaultSeconds, 30);
	assert.equal(merged.timeout.maxSeconds, 600);
	assert.deepEqual(merged.tools.ignoredTools, ["x"]);

	const set = setPath(DEFAULTS, "tools.exactBlockAfter", "5");
	assert.equal(set.tools.exactBlockAfter, 5);
	assert.throws(() => setPath(DEFAULTS, "tools.nope", "1"), /unknown setting/);
	assert.throws(() => setPath(DEFAULTS, "maxStrikes", "abc"), /not a number/);

	const t = applyCommand(DEFAULTS, "timeout 30 900");
	assert.deepEqual(t.cfg.timeout, { defaultSeconds: 30, maxSeconds: 900 });
	assert.ok(t.changed);
	assert.equal(applyCommand(DEFAULTS, "timeout 900 300").cfg.timeout.defaultSeconds, 300);
	assert.equal(applyCommand(DEFAULTS, "off").cfg.enabled, false);
	assert.equal(applyCommand(DEFAULTS, "reset").reset, true);
	assert.throws(() => applyCommand(DEFAULTS, "bogus"), /\/unblock/);
});

// ----------------------------------------------------------------- index.ts

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function harness() {
	const handlers = new Map<string, Handler[]>();
	const sent: { kind: string; payload: unknown; options: unknown }[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let aborts = 0;
	const notices: string[] = [];
	const pi = {
		on(name: string, h: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), h]);
		},
		sendMessage(payload: unknown, options: unknown) {
			sent.push({ kind: "message", payload, options });
		},
		sendUserMessage(payload: unknown, options: unknown) {
			sent.push({ kind: "user", payload, options });
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, def);
		},
	};
	const ctx = {
		abort() {
			aborts++;
		},
		ui: {
			notify(msg: string) {
				notices.push(msg);
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	const emit = async (name: string, event: unknown): Promise<unknown> => {
		let out: unknown;
		for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out;
		return out;
	};
	return { pi, ctx, emit, sent, entries, commands, aborts: () => aborts, notices };
}

const assistant = { role: "assistant" };
const toolcallEnd = (name: string, args: unknown) => ({
	message: assistant,
	assistantMessageEvent: { type: "toolcall_end", toolCall: { name, arguments: args } },
});
const delta = (type: string, text: string) => ({ message: assistant, assistantMessageEvent: { type, delta: text } });

test("extension: a spinning tool-call stream is aborted and the model is re-prompted", async () => {
	const h = harness();
	registerExtension(h.pi as never);
	await h.emit("message_start", { message: assistant });
	await h.emit("message_update", delta("text_delta", "Now I'll extend the tokenizer."));
	let calls = 0;
	while (h.aborts() === 0 && calls < 50) {
		calls++;
		await h.emit("message_update", toolcallEnd("bash", { command: "true" }));
	}
	assert.equal(h.aborts(), 1);
	assert.ok(calls <= DEFAULTS.text.periodic.threshold + 1, `aborted after ${calls} calls`);
	const followUp = h.sent.find((s) => s.kind === "user");
	assert.ok(followUp, "follow-up user message queued");
	assert.match(String(followUp?.payload), /repeating yourself/);
	assert.deepEqual(followUp?.options, { deliverAs: "followUp" });
	assert.ok(h.entries.some((e) => e.type === "pi-unblock/event"));
});

test("extension: a thinking loop is caught from thinking deltas", async () => {
	const h = harness();
	registerExtension(h.pi as never);
	await h.emit("message_start", { message: assistant });
	for (let i = 0; i < 40 && h.aborts() === 0; i++) {
		await h.emit("message_update", delta("thinking_delta", `Wait, let me reconsider the problem statement again (${i % 2}).\n`));
	}
	assert.equal(h.aborts(), 1);
});

test("extension: strikes reset on a clean turn, and it gives up after maxStrikes", async () => {
	const h = harness();
	registerExtension(h.pi as never);
	const spin = async () => {
		await h.emit("message_start", { message: assistant });
		for (let i = 0; i < 12; i++) await h.emit("message_update", toolcallEnd("bash", { command: "true" }));
	};
	// cooldown would suppress back-to-back detections; bypass it by resetting via the command
	const reset = async () => h.commands.get("unblock")?.handler("reset", h.ctx);
	for (let i = 0; i < DEFAULTS.maxStrikes; i++) {
		await spin();
		await reset();
	}
	assert.equal(h.sent.filter((s) => s.kind === "user").length, DEFAULTS.maxStrikes);
	// /unblock reset also clears strikes, so simulate the escalation without it: strikes accumulate across aborted turns
	const h2 = harness();
	registerExtension(h2.pi as never);
	let prompts = 0;
	for (let i = 0; i < DEFAULTS.maxStrikes + 2; i++) {
		await h2.emit("message_start", { message: assistant });
		// three refusals in one batch: each counts a strike
		for (let j = 0; j < 4; j++) await h2.emit("tool_call", { toolName: "bash", input: { command: "true" }, toolCallId: "x" });
		prompts = h2.sent.filter((s) => s.kind === "user").length;
	}
	assert.equal(prompts, 0, "refusals never re-prompt; they terminate the batch");
	assert.ok(h2.notices.some((n) => /giving up/.test(n)));
	assert.ok(h2.aborts() >= 1, "gave up: aborts the run");
});

test("extension: identical tool calls are refused with terminate; hints steer", async () => {
	const h = harness();
	registerExtension(h.pi as never);
	const ev = { toolName: "bash", input: { command: "true" }, toolCallId: "1" };
	assert.equal(await h.emit("tool_call", ev), undefined);
	assert.equal(await h.emit("tool_call", ev), undefined);
	const r = (await h.emit("tool_call", ev)) as { block: boolean; reason: string; terminate: boolean };
	assert.equal(r.block, true);
	assert.equal(r.terminate, true);
	assert.match(r.reason, /Refused/);
	await h.emit("turn_end", {});
	// cycle hint after 3 reps
	for (let i = 0; i < 3; i++) {
		await h.emit("tool_call", { toolName: "read", input: { path: "f" }, toolCallId: "a" });
		await h.emit("tool_call", { toolName: "bash", input: { command: "pytest -q" }, toolCallId: "b" });
	}
	const steer = h.sent.find((s) => s.kind === "message");
	assert.ok(steer, "steer hint sent");
	assert.deepEqual(steer?.options, { deliverAs: "steer" });
});

test("extension: shell timeout default, clamp, hint on timeout, and system prompt", async () => {
	const h = harness();
	registerExtension(h.pi as never);
	const a = { toolName: "bash", input: { command: "sleep 1" } as Record<string, unknown>, toolCallId: "1" };
	await h.emit("tool_call", a);
	assert.equal(a.input.timeout, 60);
	const b = { toolName: "bash", input: { command: "make", timeout: 5000 } as Record<string, unknown>, toolCallId: "2" };
	await h.emit("tool_call", b);
	assert.equal(b.input.timeout, 600);
	const c = { toolName: "read", input: { path: "x" } as Record<string, unknown>, toolCallId: "3" };
	await h.emit("tool_call", c);
	assert.equal(c.input.timeout, undefined);

	const res = (await h.emit("tool_result", {
		toolName: "bash",
		input: { command: "make" },
		isError: true,
		content: [{ type: "text", text: "partial output\nCommand timed out after 60 seconds" }],
	})) as { content: { type: string; text: string }[] };
	assert.equal(res.content.length, 2);
	assert.match(res.content[1]?.text ?? "", /\[pi-unblock\].*60-second timeout/);

	const sp = (await h.emit("before_agent_start", { systemPrompt: "BASE" })) as { systemPrompt: string };
	assert.match(sp.systemPrompt, /^BASE\n\nShell commands time out after 60 seconds/);

	await h.commands.get("unblock")?.handler("timeout 0", h.ctx);
	assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined);
	const d = { toolName: "bash", input: { command: "x" } as Record<string, unknown>, toolCallId: "4" };
	await h.emit("tool_call", d);
	assert.equal(d.input.timeout, undefined, "timeout policy off");
	assert.ok(h.entries.some((e) => e.type === "pi-unblock/config"), "config persisted");
});

test("messages read well", () => {
	assert.match(reminder({ kind: "periodic", detail: "x repeated", sample: "s" }), /interrupted/);
	assert.match(refusal({ kind: "exact", count: 3, detail: "bash called 3 times" }), /Refused: bash called 3 times/);
});
