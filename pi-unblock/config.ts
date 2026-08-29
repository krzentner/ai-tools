/** Defaults, the optional config file, and the `/unblock` command grammar. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TextLoopConfig } from "./detect.ts";
import type { StallPolicy } from "./stall.ts";
import type { TimeoutPolicy } from "./timeout.ts";
import type { ToolLoopConfig } from "./tools.ts";

export interface UnblockConfig {
	/** loop detection on/off (the timeout policy is controlled by `timeout.defaultSeconds`, 0 = off) */
	enabled: boolean;
	text: TextLoopConfig;
	/** run the near-duplicate / low-diversity detectors (for thinking loops) in addition to exact repetition */
	textFuzzy: boolean;
	tools: ToolLoopConfig;
	timeout: TimeoutPolicy;
	/** stalled model requests: abort and retry with growing deadlines, forever */
	stall: StallPolicy;
	/** interruptions (aborts or refusals) without a clean turn in between before pi-unblock stops re-prompting */
	maxStrikes: number;
	/** ignore streaming updates for this long after an interruption */
	cooldownMs: number;
	/** run the streaming detectors every this many new characters */
	checkEveryChars: number;
}

export const DEFAULTS: UnblockConfig = {
	enabled: true,
	text: {
		periodic: { threshold: 6, minUnit: 4, maxUnit: 400 },
		similarLines: { minLineLength: 24, similarity: 0.8, window: 6, run: 8 },
		lowDiversity: { span: 3000, n: 12, minRatio: 0.2 },
	},
	textFuzzy: true,
	tools: {
		exactBlockAfter: 2,
		stagnationBlockAfter: 3,
		cycleMaxPeriod: 4,
		cycleHintReps: 3,
		cycleBlockReps: 6,
		fuzzySimilarity: 0.85,
		fuzzyHintAfter: 5,
		ignoredTools: ["edit", "write"],
	},
	timeout: { defaultSeconds: 60, maxSeconds: 600 },
	stall: { prefillTokensPerSec: 100, baseSeconds: 30, idleSeconds: 120, maxSeconds: 3600, backoff: 2 },
	maxStrikes: 3,
	cooldownMs: 5000,
	checkEveryChars: 40,
};

export const CONFIG_ENTRY = "pi-unblock/config";
export const EVENT_ENTRY = "pi-unblock/event";

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge<T extends object>(base: T, patch: unknown): T {
	if (!isPlain(patch)) return base;
	const out: Plain = { ...(base as Plain) };
	for (const [k, v] of Object.entries(patch)) {
		out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as Plain, v) : v;
	}
	return out as T;
}

/** `$PI_UNBLOCK_CONFIG` or `~/.pi/agent/unblock.json`, merged over the defaults; errors fall back to defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): UnblockConfig {
	const path = env.PI_UNBLOCK_CONFIG ?? join(homedir(), ".pi", "agent", "unblock.json");
	if (!existsSync(path)) return structuredClone(DEFAULTS);
	try {
		return deepMerge(structuredClone(DEFAULTS), JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return structuredClone(DEFAULTS);
	}
}

function coerce(raw: string, current: unknown): unknown {
	if (Array.isArray(current)) return raw.split(",").map((s) => s.trim()).filter(Boolean);
	if (typeof current === "boolean") return raw === "true" || raw === "on";
	if (typeof current === "number") {
		const n = Number(raw);
		if (!Number.isFinite(n)) throw new Error(`${raw} is not a number`);
		return n;
	}
	return raw;
}

/** Set a dotted path (`tools.exactBlockAfter 3`), keeping the existing value's type. */
export function setPath(cfg: UnblockConfig, path: string, raw: string): UnblockConfig {
	const parts = path.split(".");
	const next = structuredClone(cfg) as unknown as Plain;
	let node: Plain = next;
	for (const p of parts.slice(0, -1)) {
		if (!isPlain(node[p])) throw new Error(`unknown setting ${path}`);
		node = node[p] as Plain;
	}
	const leaf = parts.at(-1) as string;
	if (!(leaf in node)) throw new Error(`unknown setting ${path}`);
	node[leaf] = coerce(raw, node[leaf]);
	return next as unknown as UnblockConfig;
}

export function describe(cfg: UnblockConfig): string {
	const t = cfg.tools;
	return [
		`pi-unblock: ${cfg.enabled ? "on" : "off"}`,
		`text loops: repeat x${cfg.text.periodic.threshold}, fuzzy ${cfg.textFuzzy ? "on" : "off"}`,
		`tool loops: refuse after ${t.exactBlockAfter} identical / ${t.stagnationBlockAfter} identical results, cycle hint x${t.cycleHintReps} refuse x${t.cycleBlockReps}`,
		`shell timeout: default ${cfg.timeout.defaultSeconds}s, max ${cfg.timeout.maxSeconds}s`,
		`stall: ${cfg.stall.baseSeconds}s + prompt/${cfg.stall.prefillTokensPerSec} tok/s to first token, ${cfg.stall.idleSeconds}s idle, x${cfg.stall.backoff} up to ${cfg.stall.maxSeconds}s (0 = off)`,
		`strikes before giving up: ${cfg.maxStrikes}`,
	].join(" | ");
}

export const USAGE =
	"/unblock [on|off | timeout <default-seconds> [max-seconds] | set <dotted.path> <value> | reset | status]";

export interface CommandResult {
	cfg: UnblockConfig;
	message: string;
	/** the config changed and should be persisted */
	changed: boolean;
	/** `/unblock reset`: clear trackers and strikes */
	reset: boolean;
}

function timeoutCommand(cfg: UnblockConfig, args: string[]): CommandResult {
	const [d, m] = args.map(Number);
	if (!Number.isFinite(d) || (d as number) < 0) throw new Error(USAGE);
	const next = structuredClone(cfg);
	next.timeout.defaultSeconds = d as number;
	if (m !== undefined) {
		if (!Number.isFinite(m) || m <= 0) throw new Error(USAGE);
		next.timeout.maxSeconds = m;
	}
	if (next.timeout.defaultSeconds > next.timeout.maxSeconds) next.timeout.defaultSeconds = next.timeout.maxSeconds;
	return { cfg: next, message: describe(next), changed: true, reset: false };
}

export function applyCommand(cfg: UnblockConfig, argText: string): CommandResult {
	const [verb = "status", ...rest] = argText.trim().split(/\s+/).filter(Boolean);
	switch (verb) {
		case "status":
			return { cfg, message: describe(cfg), changed: false, reset: false };
		case "on":
		case "off":
			return { cfg: { ...cfg, enabled: verb === "on" }, message: `pi-unblock: ${verb}`, changed: true, reset: false };
		case "timeout":
			return timeoutCommand(cfg, rest);
		case "set": {
			const [path, ...value] = rest;
			if (!path || value.length === 0) throw new Error(USAGE);
			const next = setPath(cfg, path, value.join(" "));
			return { cfg: next, message: describe(next), changed: true, reset: false };
		}
		case "reset":
			return { cfg, message: "pi-unblock: trackers and strikes reset", changed: false, reset: true };
		default:
			throw new Error(USAGE);
	}
}
