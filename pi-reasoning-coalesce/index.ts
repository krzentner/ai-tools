/**
 * pi-reasoning-coalesce: keeps OpenRouter reasoning replay from teaching the
 * model to think one word per line.
 *
 * OpenRouter streams a model's reasoning as `reasoning_details`, one
 * `reasoning.text` entry per token. pi keeps that array verbatim in the
 * thinking block's `thinkingSignature` and sends it back on every later
 * request of the session (OpenRouter asks for the original sequence). Some
 * upstreams reassemble hundreds of one-token entries with separators, so
 * from the third tool call or so the model sees its own earlier reasoning as
 * one word per line and imitates it: reasoning becomes `The\n repo\n has\n…`,
 * half or more of the billed reasoning tokens are newlines, and the traces
 * are unreadable. Measured with z-ai/glm-5.3-flash across Z.AI, Wafer and
 * Modal upstreams; replaying the same reasoning as one entry per block is
 * clean at every step.
 *
 * This extension rewrites, in the `context` hook (per request, never in the
 * session file), every assistant thinking block whose signature is such an
 * array: consecutive `reasoning.text` entries with the same format and no
 * cryptographic signature are merged into one. Encrypted and summary entries
 * are left untouched and in place, so providers that verify them still get
 * the original sequence.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ReasoningDetail {
	type?: string;
	text?: string;
	format?: string;
	index?: number;
	signature?: string;
	[k: string]: unknown;
}

const mergeable = (d: ReasoningDetail): boolean =>
	d.type === "reasoning.text" && typeof d.text === "string" && !d.signature;

const sameRun = (a: ReasoningDetail, b: ReasoningDetail): boolean => {
	const { text: _a, index: _ia, ...ra } = a;
	const { text: _b, index: _ib, ...rb } = b;
	return JSON.stringify(ra) === JSON.stringify(rb);
};

/** Merge runs of plain `reasoning.text` entries; other entries keep their place. Indices are renumbered. */
export function coalesce(details: ReasoningDetail[]): ReasoningDetail[] {
	const out: ReasoningDetail[] = [];
	for (const d of details) {
		const last = out[out.length - 1];
		if (last && mergeable(last) && mergeable(d) && sameRun(last, d)) {
			last.text = `${last.text}${d.text}`;
			continue;
		}
		out.push({ ...d });
	}
	return out.map((d, i) => (typeof d.index === "number" ? { ...d, index: i } : d));
}

/** The rewritten signature when `sig` is a reasoning-details array that shrinks; undefined otherwise. */
export function coalesceSignature(sig: unknown): string | undefined {
	if (typeof sig !== "string" || !sig.startsWith("[")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(sig);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || !parsed.every((d) => d && typeof d === "object")) return undefined;
	const merged = coalesce(parsed as ReasoningDetail[]);
	return merged.length < parsed.length ? JSON.stringify(merged) : undefined;
}

interface Block {
	type?: string;
	thinkingSignature?: unknown;
	[k: string]: unknown;
}

interface Message {
	role?: string;
	content?: unknown;
}

export interface CoalesceStats {
	/** thinking blocks rewritten in the last request */
	blocks: number;
	/** reasoning entries removed by merging in the last request */
	removed: number;
}

/** Rewrite the assistant thinking signatures of one request; returns the new list only when something changed. */
export function coalesceMessages<T extends Message>(messages: T[], stats?: CoalesceStats): T[] | undefined {
	let changed = false;
	if (stats) {
		stats.blocks = 0;
		stats.removed = 0;
	}
	const out = messages.map((m) => {
		if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
		let touched = false;
		const content = (m.content as Block[]).map((b) => {
			if (b.type !== "thinking") return b;
			const next = coalesceSignature(b.thinkingSignature);
			if (next === undefined) return b;
			touched = true;
			if (stats) {
				stats.blocks++;
				stats.removed += (b.thinkingSignature as string).split('"type"').length - next.split('"type"').length;
			}
			return { ...b, thinkingSignature: next };
		});
		if (!touched) return m;
		changed = true;
		return { ...m, content };
	});
	return changed ? out : undefined;
}

export default function reasoningCoalesce(pi: ExtensionAPI): void {
	const stats: CoalesceStats = { blocks: 0, removed: 0 };
	let requests = 0;
	let rewritten = 0;

	pi.on("context", async (ev) => {
		requests++;
		const messages = coalesceMessages(ev.messages as unknown as Message[], stats);
		if (!messages) return undefined;
		rewritten++;
		return { messages: messages as unknown as typeof ev.messages };
	});

	pi.registerCommand("reasoning-coalesce", {
		description: "pi-reasoning-coalesce: how many requests had their replayed reasoning merged",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`reasoning-coalesce: ${rewritten}/${requests} requests rewritten this session; last request merged ${stats.removed} entries in ${stats.blocks} thinking block(s)`,
				"info",
			);
		},
	});
}
