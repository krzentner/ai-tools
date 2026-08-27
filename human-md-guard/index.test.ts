// Run with: node index.test.ts   (Node >= 22.18, for built-in TypeScript type stripping)
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bashMayWriteHumanMd, humanMdPathsInInput, isHumanMdPath, judgeToolCall } from "./guard.ts";
import registerExtension from "./index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(here, "agent-guard-human-md");

// --- path matching ---------------------------------------------------------

assert.equal(isHumanMdPath("notes.human.md"), true);
assert.equal(isHumanMdPath("/abs/dir/NOTES.Human.MD"), true);
assert.equal(isHumanMdPath("  docs/plan.human.md\n"), true);
assert.equal(isHumanMdPath("notes.md"), false);
assert.equal(isHumanMdPath("human.md"), false);
assert.equal(isHumanMdPath("notes.human.mdx"), false);
assert.equal(isHumanMdPath(42), false);

// Path-named fields at any depth; content fields are ignored so writing a
// README that *mentions* a human file is fine.
assert.deepEqual(humanMdPathsInInput({ file_path: "a.human.md", content: "b.human.md" }), ["a.human.md"]);
assert.deepEqual(humanMdPathsInInput({ path: "a.md", content: "see x.human.md" }), []);
assert.deepEqual(humanMdPathsInInput({ notebook_path: "n.human.md" }), ["n.human.md"]);
assert.deepEqual(humanMdPathsInInput({ edits: [{ path: "x.human.md" }, { path: "y.md" }] }), ["x.human.md"]);
assert.deepEqual(humanMdPathsInInput({ args: { destination: "out.human.md" } }), ["out.human.md"]);

// Codex apply_patch bodies name their files in headers.
const patch = "*** Begin Patch\n*** Update File: docs/spec.human.md\n@@\n-a\n+b\n*** End Patch\n";
assert.deepEqual(humanMdPathsInInput({ input: patch }), ["docs/spec.human.md"]);
assert.deepEqual(humanMdPathsInInput({ input: patch.replace("Update", "Delete") }), ["docs/spec.human.md"]);
assert.deepEqual(humanMdPathsInInput({ input: "*** Update File: a.md\n*** Move to: a.human.md\n" }), ["a.human.md"]);
assert.deepEqual(humanMdPathsInInput({ input: "*** Update File: a.md\n+see b.human.md\n" }), []);

// --- bash heuristic --------------------------------------------------------

// No mention → never blocked, whatever the command.
assert.equal(bashMayWriteHumanMd("rm -rf build && sed -i s/a/b/ notes.md"), false);

// Read-only pipelines are allowed.
assert.equal(bashMayWriteHumanMd("cat notes.human.md"), false);
assert.equal(bashMayWriteHumanMd("cd docs && grep -n TODO plan.human.md | head -20"), false);
assert.equal(bashMayWriteHumanMd("git diff HEAD~1 -- spec.human.md"), false);
assert.equal(bashMayWriteHumanMd("sed -n 1,40p spec.human.md"), false);
assert.equal(bashMayWriteHumanMd("find . -name '*.human.md'"), false);
assert.equal(bashMayWriteHumanMd("FOO=1 wc -l a.human.md 2>/dev/null"), false);
assert.equal(bashMayWriteHumanMd("ls a.human.md 2>&1"), false);

// Data isn't commands: quoted strings and heredoc bodies may mention the
// file freely, as long as what consumes them is read-only.
assert.equal(bashMayWriteHumanMd("grep '>' notes.human.md"), false);
assert.equal(bashMayWriteHumanMd("grep -n \"rm x; tee y\" notes.human.md"), false);
assert.equal(bashMayWriteHumanMd("git add -A && git commit -m 'guard *.human.md files' && git log -1"), false);
assert.equal(
	bashMayWriteHumanMd("git commit -q -F - <<'EOF'\nGuard *.human.md\n\n`*.human.md` files are human-authored.\nrm nothing.human.md\nEOF\ngit status"),
	false,
);
assert.equal(bashMayWriteHumanMd("cat <<EOF\nsee notes.human.md\nEOF"), false);
// ...but the consumer is still judged, and redirects outside quotes still count.
assert.equal(bashMayWriteHumanMd("bash <<'EOF'\nrm notes.human.md\nEOF"), true);
assert.equal(bashMayWriteHumanMd("cat <<EOF > notes.human.md\nx\nEOF"), true);
assert.equal(bashMayWriteHumanMd("echo 'x' > 'notes.human.md'"), true);
assert.equal(bashMayWriteHumanMd("sed -i 's/a/b/' 'notes.human.md'"), true);
assert.equal(bashMayWriteHumanMd("git commit -m 'x' && git checkout -- notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("git stash && cat notes.human.md"), true);

// Writers are blocked.
assert.equal(bashMayWriteHumanMd("echo hi > notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("cat a.md >> notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("printf x &> notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("sed -i 's/a/b/' notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("sed --in-place 's/a/b/' notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("awk -i inplace '{print}' notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("mv notes.human.md old.md"), true);
assert.equal(bashMayWriteHumanMd("cp a.md notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("rm notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("cat a.md | tee notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("python3 fix.py notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("git checkout -- notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("find . -name '*.human.md' -delete"), true);
assert.equal(bashMayWriteHumanMd("fd -e human.md -x rm"), false, "no '.human.md' token, so not our concern");
assert.equal(bashMayWriteHumanMd("fd -g '*.human.md' -x rm"), true);
assert.equal(bashMayWriteHumanMd("/usr/bin/touch notes.human.md"), true);
assert.equal(bashMayWriteHumanMd("cat a.human.md\nrm a.human.md"), true);

// --- tool-level verdicts (pi + hook share these) ----------------------------

assert.equal(judgeToolCall("write", { path: "a.human.md", content: "" }).block, true);
assert.equal(judgeToolCall("edit", { path: "a.md", oldText: "", newText: "" }).block, false);
assert.equal(judgeToolCall("bash", { command: "cat a.human.md" }).block, false);
assert.equal(judgeToolCall("Bash", { command: "echo > a.human.md" }).block, true);
// Reading is the whole point; pi routes read/grep/find through tool_call too.
assert.equal(judgeToolCall("read", { path: "a.human.md" }).block, false);
assert.equal(judgeToolCall("grep", { path: "docs", pattern: "x" }).block, false);
assert.equal(judgeToolCall("Read", { file_path: "a.human.md" }).block, false);
assert.equal(judgeToolCall("mcp__filesystem__read_file", { path: "a.human.md" }).block, false);
assert.equal(judgeToolCall("mcp__filesystem__write_file", { path: "a.human.md", content: "" }).block, true);
assert.equal(judgeToolCall("mcp__filesystem__move_file", { source: "a.md", destination: "a.human.md" }).block, true);
assert.match(judgeToolCall("Write", { file_path: "a.human.md" }).reason ?? "", /a\.human\.md/);

// --- pi extension wiring: the registered tool_call handler blocks -----------

const handlers: Record<string, (event: unknown) => unknown> = {};
registerExtension({ on: (name: string, handler: (event: unknown) => unknown) => { handlers[name] = handler; } });
assert.ok(handlers.tool_call, "extension registers a tool_call handler");
const blocked = handlers.tool_call({ type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "/tmp/a.human.md", content: "" } });
assert.deepEqual(blocked && (blocked as { block?: boolean }).block, true);
assert.match((blocked as { reason: string }).reason, /a\.human\.md/);
assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "/tmp/a.human.md" } }), undefined);
assert.equal(handlers.tool_call({ type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "cat /tmp/a.human.md" } }), undefined);

// --- hook end-to-end, through the wrapper Claude Code and Codex call --------

function runHook(payload: unknown, useWrapper = true) {
	const cmd = useWrapper ? [wrapper] : ["node", "--no-warnings", path.join(here, "hook.ts")];
	const result = spawnSync(cmd[0], cmd.slice(1), {
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf8",
	});
	return { status: result.status, stderr: result.stderr };
}

let r = runHook({ tool_name: "Write", tool_input: { file_path: "/tmp/x.human.md", content: "hi" } });
assert.equal(r.status, 2);
assert.match(r.stderr, /x\.human\.md/);

r = runHook({ tool_name: "Bash", tool_input: { command: "cat /tmp/x.human.md" } });
assert.equal(r.status, 0, r.stderr);

r = runHook({ tool_name: "Bash", tool_input: { command: "echo hi > /tmp/x.human.md" } });
assert.equal(r.status, 2);

r = runHook({ tool_name: "apply_patch", tool_input: { input: patch } });
assert.equal(r.status, 2);

r = runHook({ tool_name: "Edit", tool_input: { file_path: "/tmp/x.md", old_string: "a", new_string: "b" } });
assert.equal(r.status, 0, r.stderr);

// Garbage in → allow, never crash (a hook error would also allow, but noisily).
r = runHook("not json", false);
assert.equal(r.status, 0);

// The no-node fallback in the wrapper: plain grep, blocks any mention. Build
// a PATH that has grep but no node.
const grepOnlyBin = fs.mkdtempSync(path.join(os.tmpdir(), "human-md-guard-"));
fs.symlinkSync(execSync("command -v grep", { encoding: "utf8" }).trim(), path.join(grepOnlyBin, "grep"));
try {
	// Absolute bash: the child's PATH is what resolves the executable.
	const bash = execSync("command -v bash", { encoding: "utf8" }).trim();
	const fallback = spawnSync(bash, [wrapper], {
		input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat x.human.md" } }),
		encoding: "utf8",
		env: { ...process.env, PATH: grepOnlyBin },
	});
	assert.equal(fallback.status, 2, fallback.stderr);
	assert.match(fallback.stderr, /node unavailable/);
} finally {
	fs.rmSync(grepOnlyBin, { recursive: true, force: true });
}

// --- installer: merges into fresh and pre-populated settings, and undoes it --

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "human-md-guard-home-"));
try {
	// Pre-existing content that must survive untouched.
	fs.mkdirSync(path.join(fakeHome, ".claude"));
	fs.writeFileSync(
		path.join(fakeHome, ".claude/settings.json"),
		JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "atuin hook claude-code" }] }] } }),
	);
	const env = { ...process.env, HOME: fakeHome };
	const installer = path.join(here, "install.py");

	let out = spawnSync("python3", [installer], { encoding: "utf8", env });
	assert.equal(out.status, 0, out.stderr + out.stdout);

	const claude = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude/settings.json"), "utf8"));
	assert.equal(claude.model, "opus");
	assert.deepEqual(claude.permissions.deny, ["Edit(//**/*.human.md)"]);
	assert.equal(claude.hooks.PreToolUse.length, 2);
	assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, "atuin hook claude-code");
	assert.equal(claude.hooks.PreToolUse[1].hooks[0].command, wrapper);

	const codex = JSON.parse(fs.readFileSync(path.join(fakeHome, ".codex/hooks.json"), "utf8"));
	assert.equal(codex.hooks.PreToolUse[0].hooks[0].command, wrapper);

	assert.equal(fs.realpathSync(path.join(fakeHome, ".pi/agent/extensions/human-md-guard")), fs.realpathSync(here));

	// Idempotent.
	out = spawnSync("python3", [installer], { encoding: "utf8", env });
	assert.equal(out.status, 0, out.stderr + out.stdout);
	assert.equal(JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude/settings.json"), "utf8")).hooks.PreToolUse.length, 2);

	// Uninstall leaves only what was there before.
	out = spawnSync("python3", [installer, "--uninstall"], { encoding: "utf8", env });
	assert.equal(out.status, 0, out.stderr + out.stdout);
	const after = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude/settings.json"), "utf8"));
	assert.equal(after.model, "opus");
	assert.equal(after.permissions, undefined);
	assert.equal(after.hooks.PreToolUse.length, 1);
	assert.equal(fs.existsSync(path.join(fakeHome, ".pi/agent/extensions/human-md-guard")), false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(fakeHome, ".codex/hooks.json"), "utf8")).hooks.PreToolUse.length, 0);
} finally {
	fs.rmSync(fakeHome, { recursive: true, force: true });
}

console.log("PASS: human-md-guard self-check");
