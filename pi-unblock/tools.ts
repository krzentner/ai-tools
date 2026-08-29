/**
 * Tool-call loop tracking (the execution side). Pure; no pi dependency.
 *
 *   exact     the same tool with identical arguments, N times in a row
 *   stagnant  the same call keeps returning the identical result
 *   cycle     a short sequence of calls (read, edit, read, edit ...) repeating
 *   fuzzy     the same tool with near-identical arguments, N times in a row
 */
import { jaccard, wordSet } from "./detect.ts";

export interface ToolLoopConfig {
	/** identical consecutive calls allowed before the next one is refused */
	exactBlockAfter: number;
	/** identical results for the same call before the next one is refused */
	stagnationBlockAfter: number;
	/** longest cycle (in calls) looked for */
	cycleMaxPeriod: number;
	/** cycle repetitions that trigger a hint */
	cycleHintReps: number;
	/** cycle repetitions that trigger a refusal */
	cycleBlockReps: number;
	/** Jaccard similarity of argument words that counts as a near-repeat */
	fuzzySimilarity: number;
	/** near-repeats in a row that trigger a hint */
	fuzzyHintAfter: number;
	/** tools never tracked (edits legitimately repeat with tiny diffs) */
	ignoredTools: string[];
}

export interface CallSignature {
	name: string;
	/** canonical JSON of the arguments (sorted keys) */
	args: string;
	words: Set<string>;
}

export interface ToolLoop {
	kind: "exact" | "stagnant" | "cycle" | "fuzzy";
	count: number;
	detail: string;
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") {
		const rec = v as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(rec)
				.sort()
				.map((k) => [k, sortKeys(rec[k])]),
		);
	}
	return v;
}

export function signature(name: string, input: unknown): CallSignature {
	const args = JSON.stringify(sortKeys(input ?? {}));
	return { name, args, words: wordSet(args) };
}

const keyOf = (s: CallSignature): string => `${s.name} ${s.args}`;

/** FNV-1a: enough to compare tool results without keeping them. */
export function hashText(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${h.toString(16)}:${s.length}`;
}

export class ToolTracker {
	private calls: CallSignature[] = [];
	private readonly lastResult = new Map<string, { hash: string; count: number }>();
	private readonly cfg: ToolLoopConfig;
	private readonly keep: number;

	constructor(cfg: ToolLoopConfig, keep = 64) {
		this.cfg = cfg;
		this.keep = keep;
	}

	reset(): void {
		this.calls = [];
		this.lastResult.clear();
	}

	/** Record a call about to execute and report the loop it completes, if any. */
	check(name: string, input: unknown): ToolLoop | null {
		if (this.cfg.ignoredTools.includes(name)) return null;
		const sig = signature(name, input);
		this.calls.push(sig);
		if (this.calls.length > this.keep) this.calls = this.calls.slice(-this.keep);
		return this.exact(sig) ?? this.stagnant(sig) ?? this.cycle() ?? this.fuzzy(sig);
	}

	/** Remember a call's result so identical results can be counted. */
	recordResult(name: string, input: unknown, resultText: string): void {
		if (this.cfg.ignoredTools.includes(name)) return;
		const k = keyOf(signature(name, input));
		const hash = hashText(resultText);
		const prev = this.lastResult.get(k);
		this.lastResult.set(k, { hash, count: prev && prev.hash === hash ? prev.count + 1 : 1 });
	}

	private trailing(pred: (s: CallSignature) => boolean): number {
		let n = 0;
		for (let i = this.calls.length - 1; i >= 0 && pred(this.calls[i] as CallSignature); i--) n++;
		return n;
	}

	private exact(sig: CallSignature): ToolLoop | null {
		const k = keyOf(sig);
		const count = this.trailing((s) => keyOf(s) === k);
		if (count <= this.cfg.exactBlockAfter) return null;
		return {
			kind: "exact",
			count,
			detail: `${sig.name} called ${count} times in a row with identical arguments`,
		};
	}

	private stagnant(sig: CallSignature): ToolLoop | null {
		const r = this.lastResult.get(keyOf(sig));
		if (!r || r.count < this.cfg.stagnationBlockAfter) return null;
		return {
			kind: "stagnant",
			count: r.count,
			detail: `${sig.name} with these arguments returned the identical result ${r.count} times`,
		};
	}

	/** How many times the last `p` calls repeat back-to-back (1 = no repetition). */
	private repetitions(keys: string[], p: number): number {
		let reps = 1;
		for (let end = keys.length; end - 2 * p >= 0; end -= p) {
			const a = keys.slice(end - p, end);
			const b = keys.slice(end - 2 * p, end - p);
			if (!a.every((k, i) => k === b[i])) break;
			reps++;
		}
		return reps;
	}

	private cycle(): ToolLoop | null {
		const keys = this.calls.map(keyOf);
		for (let p = 2; p <= this.cfg.cycleMaxPeriod; p++) {
			if (keys.length < 2 * p || new Set(keys.slice(-p)).size < 2) continue; // exact repeats are handled above
			const reps = this.repetitions(keys, p);
			if (reps < this.cfg.cycleHintReps) continue;
			const names = this.calls
				.slice(-p)
				.map((s) => s.name)
				.join(" -> ");
			return { kind: "cycle", count: reps, detail: `the sequence ${names} repeated ${reps} times` };
		}
		return null;
	}

	private fuzzy(sig: CallSignature): ToolLoop | null {
		const k = keyOf(sig);
		const count = this.trailing(
			(s) => s.name === sig.name && (keyOf(s) === k || jaccard(s.words, sig.words) >= this.cfg.fuzzySimilarity),
		);
		if (count < this.cfg.fuzzyHintAfter) return null;
		return {
			kind: "fuzzy",
			count,
			detail: `${sig.name} called ${count} times in a row with near-identical arguments`,
		};
	}
}
