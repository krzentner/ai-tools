/**
 * Stalled-request watchdog. Pure timing logic; the extension wires it to pi.
 *
 * A model request is given a first-token deadline derived from a conservative
 * prefill estimate (prompt tokens / `prefillTokensPerSec`, plus a base), and an
 * idle deadline once tokens are flowing. On a stall the extension aborts the
 * run and re-prompts; each consecutive stall multiplies the limits by
 * `backoff`, capped at `maxSeconds`. A successful response resets the
 * attempt counter. There is no attempt limit: at the cap the watchdog keeps
 * retrying every `maxSeconds`.
 */

export interface StallPolicy {
	/** conservative prompt-processing speed used for the first-token deadline */
	prefillTokensPerSec: number;
	/** seconds added to every first-token deadline (network, queueing) */
	baseSeconds: number;
	/** seconds without a new token, once streaming, before the request counts as stalled */
	idleSeconds: number;
	/** ceiling for both deadlines after backoff */
	maxSeconds: number;
	/** multiplier applied per consecutive stall */
	backoff: number;
}

export type StallKind = "first-token" | "idle";

export interface Stall {
	kind: StallKind;
	/** how long the watchdog waited before declaring the stall */
	waitedMs: number;
	/** consecutive stalls including this one */
	attempt: number;
	/** the deadline the next attempt will get */
	nextMs: number;
}

const grow = (seconds: number, attempt: number, p: StallPolicy): number =>
	Math.min(p.maxSeconds, seconds * p.backoff ** attempt) * 1000;

/** Milliseconds allowed before the first token, for the given attempt (0 = first try). */
export function firstTokenTimeoutMs(promptTokens: number, attempt: number, p: StallPolicy): number {
	const prefill = p.prefillTokensPerSec > 0 ? promptTokens / p.prefillTokensPerSec : 0;
	return grow(p.baseSeconds + prefill, attempt, p);
}

/** Milliseconds allowed between tokens, for the given attempt. */
export function idleTimeoutMs(attempt: number, p: StallPolicy): number {
	return grow(p.idleSeconds, attempt, p);
}

type Timer = ReturnType<typeof setTimeout>;

export class StallWatch {
	private attempt = 0;
	private timer: Timer | undefined;
	private armedAt = 0;
	private kind: StallKind = "first-token";
	private readonly policyOf: () => StallPolicy;
	private readonly onStall: (s: Stall) => void;

	/** `policy` may be a getter so `/unblock set stall.*` takes effect on the next request. */
	constructor(policy: StallPolicy | (() => StallPolicy), onStall: (s: Stall) => void) {
		this.policyOf = typeof policy === "function" ? policy : () => policy;
		this.onStall = onStall;
	}

	private get policy(): StallPolicy {
		return this.policyOf();
	}

	get attempts(): number {
		return this.attempt;
	}

	/** A request went out; arm the first-token deadline. */
	start(promptTokens: number): void {
		this.arm("first-token", firstTokenTimeoutMs(promptTokens, this.attempt, this.policy));
	}

	/** A token arrived; from now on the idle deadline applies. */
	activity(): void {
		if (!this.timer) return;
		this.arm("idle", idleTimeoutMs(this.attempt, this.policy));
	}

	/** The request finished (any way); disarm. */
	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** A complete response arrived: back to first-try limits. */
	succeeded(): void {
		this.stop();
		this.attempt = 0;
	}

	reset(): void {
		this.succeeded();
	}

	private arm(kind: StallKind, ms: number): void {
		this.stop();
		this.kind = kind;
		this.armedAt = Date.now();
		this.timer = setTimeout(() => this.fire(), ms);
		// never keep the process alive just to watch for a stall
		(this.timer as { unref?: () => void }).unref?.();
	}

	private fire(): void {
		this.timer = undefined;
		this.attempt++;
		const next =
			this.kind === "first-token"
				? firstTokenTimeoutMs(0, this.attempt, this.policy)
				: idleTimeoutMs(this.attempt, this.policy);
		this.onStall({ kind: this.kind, waitedMs: Date.now() - this.armedAt, attempt: this.attempt, nextMs: next });
	}
}

/** What the model sees after a stalled request was aborted. */
export function stallReminder(s: Stall, nextFirstTokenSeconds: number): string {
	const what = s.kind === "first-token" ? "did not start responding" : "stopped streaming";
	return (
		`[pi-unblock] The previous model request ${what} for ${Math.round(s.waitedMs / 1000)} seconds and was ` +
		`abandoned (stall ${s.attempt}; the next attempt is allowed ${nextFirstTokenSeconds} seconds). ` +
		"Nothing was lost on your side: continue from where you were."
	);
}
