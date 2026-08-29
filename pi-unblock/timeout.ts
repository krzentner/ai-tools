/** Shell timeout policy: a default when the model passes none, a ceiling when it asks for more. */

export interface TimeoutPolicy {
	/** seconds applied when the tool call has no timeout */
	defaultSeconds: number;
	/** seconds the model may ask for at most */
	maxSeconds: number;
}

export interface AppliedTimeout {
	seconds: number;
	/** the model asked for more than the ceiling */
	clamped: boolean;
	/** the model did not pass a usable timeout */
	defaulted: boolean;
}

export const TIMEOUT_TOOLS = new Set(["bash", "powershell"]);

/** Mutates `input.timeout` in place (pi's tool_call hook lets handlers patch arguments this way). */
export function applyTimeout(input: Record<string, unknown>, policy: TimeoutPolicy): AppliedTimeout {
	const raw = input.timeout;
	const asked = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
	const seconds = asked === undefined ? policy.defaultSeconds : Math.min(asked, policy.maxSeconds);
	input.timeout = seconds;
	return {
		seconds,
		clamped: asked !== undefined && asked > policy.maxSeconds,
		defaulted: asked === undefined,
	};
}

/** System-prompt guidance: the bash tool's own description says "no default timeout", so the model has to be told. */
export function timeoutGuidance(policy: TimeoutPolicy): string {
	return [
		`Shell commands time out after ${policy.defaultSeconds} seconds unless the call sets \`timeout\` (seconds, at most ${policy.maxSeconds}).`,
		"For anything longer (builds, test suites, downloads) pass a larger timeout up front, or start the job in the background (`nohup ... > log 2>&1 &`) and poll its log.",
		"If a tool call is refused because it repeats an earlier one, do not retry it: the result will not change. Change the approach, or report what you have.",
	].join(" ");
}

export const TIMED_OUT_RE = /timed out after (\d+(?:\.\d+)?) seconds/;

/** Appended to a timed-out shell result so the model knows how to get more time. */
export function timeoutHint(policy: TimeoutPolicy, seconds: number): string {
	const more =
		seconds < policy.maxSeconds
			? `re-run with \`timeout\` up to ${policy.maxSeconds} seconds`
			: `${policy.maxSeconds} seconds is the maximum`;
	return `[pi-unblock] The command hit the ${seconds}-second timeout; ${more}, or run it in the background (\`nohup ... > log 2>&1 &\`) and poll the log.`;
}
