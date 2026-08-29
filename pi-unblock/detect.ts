/**
 * Text loop detectors for streaming assistant output (text, thinking, and
 * serialized tool calls). Pure functions; no pi dependency.
 *
 * Three complementary signals:
 *   periodic      the tail is an exact repetition of one segment (p-periodic)
 *   similar-lines a run of consecutive lines that are near-duplicates of
 *                 recent lines (thinking loops in local models rarely repeat
 *                 byte-for-byte: "Wait, let me reconsider..." with variations)
 *   low-diversity the recent output has very few distinct n-grams (the model is
 *                 recombining the same phrases)
 */

export interface PeriodicConfig {
	/** consecutive repeats of one segment that count as a loop */
	threshold: number;
	/** shortest segment length considered (chars) */
	minUnit: number;
	/** longest segment length considered (chars) */
	maxUnit: number;
}

export interface SimilarLinesConfig {
	/** lines shorter than this (after trimming) are ignored */
	minLineLength: number;
	/** Jaccard similarity of word sets that counts as "the same line" */
	similarity: number;
	/** how many earlier lines each line is compared against */
	window: number;
	/** consecutive near-duplicate lines that count as a loop */
	run: number;
}

export interface LowDiversityConfig {
	/** characters of tail examined; shorter tails are never flagged */
	span: number;
	/** n-gram length in characters */
	n: number;
	/** distinct/total n-gram ratio below which the tail is flagged */
	minRatio: number;
}

export interface TextLoopConfig {
	periodic: PeriodicConfig;
	similarLines: SimilarLinesConfig;
	lowDiversity: LowDiversityConfig;
}

export interface TextLoop {
	kind: "periodic" | "similar-lines" | "low-diversity";
	/** human-readable explanation, also shown to the model */
	detail: string;
	/** the repeating unit or a representative line */
	sample: string;
}

/** Repeating only these is formatting (rules, dot leaders, table borders), not spinning. */
const SEPARATORS = new Set(["-", "=", ".", "*", "_", "#", "|", "+", "~", "─", "━", "═"]);

const separatorOnly = (unit: string): boolean =>
	[...unit].every((ch) => SEPARATORS.has(ch) || /\s/.test(ch));

function isPeriodic(tail: string, start: number, p: number): boolean {
	for (let i = start; i < tail.length - p; i++) {
		if (tail.charCodeAt(i) !== tail.charCodeAt(i + p)) return false;
	}
	return true;
}

/**
 * Exact repetition: the last `period x threshold` characters satisfy
 * text[i] === text[i + period]. Period detection (rather than block-aligned
 * matching) fires while the next repeat is still streaming.
 */
export function detectPeriodic(text: string, cfg: PeriodicConfig): TextLoop | null {
	const { threshold, minUnit, maxUnit } = cfg;
	if (text.length < minUnit * threshold) return null;
	const tail = text.slice(Math.max(0, text.length - maxUnit * (threshold + 1)));
	for (let p = minUnit; p <= maxUnit; p++) {
		const need = p * threshold;
		if (tail.length < need) break;
		const unit = tail.slice(-p);
		if (!/\S/.test(unit) || separatorOnly(unit)) continue;
		if (!isPeriodic(tail, tail.length - need, p)) continue;
		let count = threshold;
		let pos = tail.length - need;
		while (pos - p >= 0 && tail.slice(pos - p, pos) === unit) {
			count++;
			pos -= p;
		}
		const sample = unit.trim().replace(/\s+/g, " ").slice(0, 80);
		return {
			kind: "periodic",
			detail: `the same ${p}-character segment repeated ${count} times in a row`,
			sample,
		};
	}
	return null;
}

export function wordSet(s: string): Set<string> {
	return new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

function similarToRecent(sets: Set<string>[], i: number, cfg: SimilarLinesConfig): boolean {
	const from = Math.max(0, i - cfg.window);
	for (let j = from; j < i; j++) {
		if (jaccard(sets[i] as Set<string>, sets[j] as Set<string>) >= cfg.similarity) return true;
	}
	return false;
}

/** A run of consecutive lines, each near-identical to one of the lines shortly before it. */
export function detectSimilarLines(text: string, cfg: SimilarLinesConfig): TextLoop | null {
	const lines = text
		.split(/\n+/)
		.map((l) => l.trim())
		.filter((l) => l.length >= cfg.minLineLength)
		.slice(-(cfg.run + cfg.window + 8));
	if (lines.length < cfg.run + 1) return null;
	const sets = lines.map(wordSet);
	let run = 0;
	let sample = "";
	for (let i = lines.length - 1; i > 0 && similarToRecent(sets, i, cfg); i--) {
		run++;
		sample = lines[i] as string;
	}
	if (run < cfg.run) return null;
	return {
		kind: "similar-lines",
		detail: `${run} consecutive lines are near-duplicates of lines just before them`,
		sample: sample.slice(0, 80),
	};
}

/** Distinct/total character n-gram ratio. */
export function ngramDiversity(text: string, n: number): number {
	if (text.length < n) return 1;
	const seen = new Set<string>();
	const total = text.length - n + 1;
	for (let i = 0; i < total; i++) seen.add(text.slice(i, i + n));
	return seen.size / total;
}

export function detectLowDiversity(text: string, cfg: LowDiversityConfig): TextLoop | null {
	if (text.length < cfg.span) return null;
	const tail = text.slice(-cfg.span);
	const ratio = ngramDiversity(tail, cfg.n);
	if (ratio >= cfg.minRatio) return null;
	return {
		kind: "low-diversity",
		detail: `only ${(ratio * 100).toFixed(0)}% of the ${cfg.n}-grams in the last ${cfg.span} characters are distinct`,
		sample: tail.slice(-80).replace(/\s+/g, " "),
	};
}

/**
 * All detectors, cheapest and most specific first. The fuzzy detectors
 * (near-duplicate lines, low diversity) are meant for prose and thinking;
 * pass `fuzzy = false` for content where repetition is legitimate.
 */
export function detectTextLoop(text: string, cfg: TextLoopConfig, fuzzy = true): TextLoop | null {
	const exact = detectPeriodic(text, cfg.periodic);
	if (exact || !fuzzy) return exact;
	return detectSimilarLines(text, cfg.similarLines) ?? detectLowDiversity(text, cfg.lowDiversity);
}
