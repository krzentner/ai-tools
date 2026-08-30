import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesce, coalesceMessages, coalesceSignature } from "./index.ts";

const t = (text: string, i: number) => ({ type: "reasoning.text", text, format: "unknown", index: i });

test("coalesce: runs of plain reasoning.text merge into one entry", () => {
	const out = coalesce([t("The", 0), t("\n", 1), t(" repo", 2), t(" is", 3)]);
	assert.deepEqual(out, [{ type: "reasoning.text", text: "The\n repo is", format: "unknown", index: 0 }]);
});

test("coalesce: encrypted and signed entries stay separate and in place", () => {
	const enc = { type: "reasoning.encrypted", data: "abc", index: 2 };
	const signed = { type: "reasoning.text", text: "x", signature: "sig", index: 3 };
	const out = coalesce([t("a", 0), t("b", 1), enc, signed, t("c", 4), t("d", 5)]);
	assert.deepEqual(
		out.map((d) => [d.type, d.text ?? (d as { data?: string }).data, d.index]),
		[
			["reasoning.text", "ab", 0],
			["reasoning.encrypted", "abc", 1],
			["reasoning.text", "x", 2],
			["reasoning.text", "cd", 3],
		],
	);
});

test("coalesce: a format change starts a new entry", () => {
	const out = coalesce([t("a", 0), { ...t("b", 1), format: "other" }]);
	assert.equal(out.length, 2);
});

test("coalesceSignature: only shrinking arrays are rewritten", () => {
	assert.equal(coalesceSignature("reasoning"), undefined);
	assert.equal(coalesceSignature(undefined), undefined);
	assert.equal(coalesceSignature("[not json"), undefined);
	assert.equal(coalesceSignature(JSON.stringify([t("one", 0)])), undefined);
	assert.equal(coalesceSignature(JSON.stringify([1, 2])), undefined);
	const sig = coalesceSignature(JSON.stringify([t("a", 0), t("b", 1)]));
	assert.deepEqual(JSON.parse(sig ?? "[]"), [t("ab", 0)]);
});

test("coalesceMessages: rewrites assistant thinking blocks only, reports stats, leaves others untouched", () => {
	const sig = JSON.stringify([t("a", 0), t("b", 1), t("c", 2)]);
	const messages = [
		{ role: "user", content: "hi" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "abc", thinkingSignature: sig },
				{ type: "text", text: "ok" },
			],
		},
		{ role: "assistant", content: [{ type: "thinking", thinking: "z", thinkingSignature: "reasoning_content" }] },
	];
	const stats = { blocks: 0, removed: 0 };
	const out = coalesceMessages(messages, stats);
	assert.ok(out);
	assert.equal(out[0], messages[0]);
	assert.equal(out[2], messages[2]);
	const block = (out[1]?.content as { thinkingSignature: string }[])[0];
	assert.deepEqual(JSON.parse(block?.thinkingSignature ?? ""), [t("abc", 0)]);
	assert.equal((messages[1]?.content as { thinkingSignature: string }[])[0]?.thinkingSignature, sig); // input untouched
	assert.deepEqual(stats, { blocks: 1, removed: 2 });
	assert.equal(coalesceMessages([messages[0] ?? {}, messages[2] ?? {}]), undefined);
});
