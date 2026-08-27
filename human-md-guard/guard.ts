// Rules for deciding whether a tool call would write a `*.human.md` file.
//
// `*.human.md` files are human-authored: agents may read them but never edit,
// create, move or delete them. This module is the single implementation of
// that rule, shared by two consumers:
//
//   - index.ts: the pi extension, which blocks matching `tool_call` events
//   - hook.ts:  a PreToolUse hook for Claude Code and Codex, invoked through
//               bin/agent-guard-human-md
//
// No imports on purpose, so plain `node` can run it (and its tests) with
// nothing installed.

export const HUMAN_MD_RE = /\.human\.md$/i;

/** True when `value` is a path to a `*.human.md` file. */
export function isHumanMdPath(value: unknown): boolean {
	return typeof value === "string" && HUMAN_MD_RE.test(value.trim());
}

// Input fields that name a file the tool is going to act on. Covers pi's
// edit/write (`path`), Claude Code's Edit/Write/NotebookEdit (`file_path`,
// `notebook_path`), and the usual MCP filesystem-server spellings.
const PATH_KEYS = new Set([
	"path",
	"file_path",
	"filePath",
	"notebook_path",
	"notebookPath",
	"destination",
	"dest",
	"target",
	"new_path",
	"newPath",
	"to",
]);

// Codex's apply_patch tool carries its edits as a patch body rather than a
// path field. Only the file headers say which files are touched.
const PATCH_HEADER_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/**
 * Every `*.human.md` path a tool input refers to, from path-named fields at
 * any nesting depth plus apply_patch file headers in any string value.
 */
export function humanMdPathsInInput(input: unknown): string[] {
	const found: string[] = [];
	walk(input, undefined, found, 0);
	return found;
}

function walk(value: unknown, key: string | undefined, found: string[], depth: number): void {
	if (depth > 8) return;
	if (typeof value === "string") {
		if (key !== undefined && PATH_KEYS.has(key) && isHumanMdPath(value)) found.push(value.trim());
		for (const match of value.matchAll(PATCH_HEADER_RE)) {
			if (isHumanMdPath(match[1])) found.push(match[1].trim());
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walk(item, key, found, depth + 1);
		return;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) walk(v, k, found, depth + 1);
	}
}

// Shell commands can't be resolved to a file list, so the bash rule is a
// conservative heuristic: any command that mentions a `*.human.md` file is
// blocked unless every simple command in it is from this read-only list and
// nothing is redirected to a file. Reading through the dedicated read tool is
// always the safer route.
const READ_ONLY_COMMANDS = new Set([
	"cat", "less", "more", "head", "tail", "bat",
	"grep", "egrep", "fgrep", "rg", "ag",
	"wc", "diff", "cmp", "sort", "uniq", "cut", "tr", "nl", "tac", "column",
	"strings", "xxd", "hexdump", "od",
	"ls", "stat", "file", "du", "realpath", "readlink", "dirname", "basename",
	"md5sum", "sha1sum", "sha256sum", "shasum",
	"cd", "pushd", "popd", "pwd", "echo", "printf", "true", "test", "[", "type", "which",
	"sed", "awk", "find", "fd", "git",
]);

// git subcommands that never change files in the working tree. Staging or
// committing a human file the user wrote is fine; checkout/restore/stash/
// mv/rm/reset/rebase/merge are not.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"diff", "log", "show", "blame", "status", "grep", "ls-files", "rev-parse", "cat-file", "annotate",
	"add", "commit", "push", "fetch", "branch", "tag", "describe", "rev-list", "shortlog", "remote",
]);

// Flags that turn an otherwise read-only command into a writer.
const WRITING_FLAGS: Record<string, RegExp> = {
	sed: /(^|\s)(-[a-zA-Z]*i|--in-place)/,
	awk: /(^|\s)-i(\s|$)/,
	find: /(^|\s)(-delete|-exec|-execdir|-ok|-okdir|-fprint\w*)(\s|$)/,
	fd: /(^|\s)(-x|-X|--exec|--exec-batch)(\s|$)/,
};

export function commandMentionsHumanMd(command: string): boolean {
	return /\.human\.md(?![A-Za-z0-9_])/i.test(command);
}

/** True when a shell command might write a `*.human.md` file. */
export function bashMayWriteHumanMd(command: string): boolean {
	if (!commandMentionsHumanMd(command)) return false;

	// Only the command structure is parsed. Heredoc bodies and quoted strings
	// are data (a commit message, a grep pattern), not commands - but the
	// mention check above already ran on the full text, and the command that
	// consumes that data is still judged.
	const structure = stripQuotes(stripHeredocs(command));
	if (hasFileRedirect(structure)) return true;

	const segments = structure.split(/\n|;|&&|\|\||\|/);
	for (const segment of segments) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		// Leading VAR=value assignments aren't the command.
		while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
		if (!words.length) continue;

		const name = words[0].replace(/^.*\//, "");
		if (!READ_ONLY_COMMANDS.has(name)) return true;
		if (name === "git" && !READ_ONLY_GIT_SUBCOMMANDS.has(words[1] ?? "")) return true;
		const writingFlags = WRITING_FLAGS[name];
		if (writingFlags && writingFlags.test(words.slice(1).join(" "))) return true;
	}
	return false;
}

// Drop every `<<TAG` / `<<-'TAG'` body up to its terminator line, keeping the
// line that opened it so the consuming command is still judged.
export function stripHeredocs(command: string): string {
	const lines = command.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		const open = lines[i].match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (!open) continue;
		const terminator = open[2];
		while (++i < lines.length && lines[i].replace(/^\t+/, "") !== terminator) {
			// heredoc body: skipped
		}
	}
	return out.join("\n");
}

// Replace the contents of single- and double-quoted strings with nothing.
export function stripQuotes(command: string): string {
	return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// `>` / `>>` / `&>` to anything except /dev/null or another file descriptor.
function hasFileRedirect(command: string): boolean {
	for (const match of command.matchAll(/>>?\s*(\S*)/g)) {
		const target = match[1];
		if (target.startsWith("&")) continue;
		if (target === "/dev/null") continue;
		return true;
	}
	return false;
}

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "shell_command", "local_shell", "exec_command"]);

export function isShellTool(toolName: string): boolean {
	return SHELL_TOOL_NAMES.has(toolName.toLowerCase());
}

// Tools that only ever read. pi fires `tool_call` for these too, and reading
// a human file is exactly what agents are supposed to do with it. MCP tool
// names arrive as `mcp__<server>__<tool>`, so match on the last segment.
const READ_ONLY_TOOL_NAMES = new Set([
	"read", "grep", "find", "ls", "glob",
	"read_file", "read_text_file", "read_media_file", "read_multiple_files",
	"list_directory", "list_directory_with_sizes", "directory_tree",
	"search_files", "get_file_info", "list_allowed_directories",
]);

export function isReadOnlyTool(toolName: string): boolean {
	const leaf = toolName.split("__").pop() ?? toolName;
	return READ_ONLY_TOOL_NAMES.has(leaf.toLowerCase());
}

export interface Verdict {
	block: boolean;
	reason?: string;
}

/** Decide for any tool. Shell tools go by command text, everything else by path fields. */
export function judgeToolCall(toolName: string, input: unknown): Verdict {
	if (isReadOnlyTool(toolName)) return { block: false };
	if (isShellTool(toolName)) {
		const command = typeof (input as { command?: unknown })?.command === "string"
			? (input as { command: string }).command
			: JSON.stringify(input ?? "");
		if (!bashMayWriteHumanMd(command)) return { block: false };
		return {
			block: true,
			reason:
				"Blocked: this command may modify a *.human.md file. Those files are human-authored " +
				"and must not be written by agents. Read them with the read tool instead.",
		};
	}

	const paths = humanMdPathsInInput(input);
	if (!paths.length) return { block: false };
	return {
		block: true,
		reason:
			`Blocked: ${paths.join(", ")} is a *.human.md file. Those files are human-authored ` +
			"and must not be written by agents. Tell the user what you would have changed instead.",
	};
}
