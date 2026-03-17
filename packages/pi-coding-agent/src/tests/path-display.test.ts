/**
 * Cross-platform path display tests.
 *
 * Verifies that toPosixPath correctly normalizes Windows paths and that
 * the system prompt builder produces forward-slash paths for LLM consumption.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { toPosixPath } from "../utils/path-display.js";
import { buildSystemPrompt } from "../core/system-prompt.js";

// ─── toPosixPath ────────────────────────────────────────────────────────────

test("toPosixPath: converts Windows backslash paths to forward slashes", () => {
	assert.equal(toPosixPath("C:\\Users\\name\\project"), "C:/Users/name/project");
});

test("toPosixPath: handles mixed separators", () => {
	assert.equal(toPosixPath("C:\\Users/name\\project/src"), "C:/Users/name/project/src");
});

test("toPosixPath: no-op for Unix paths", () => {
	assert.equal(toPosixPath("/home/user/project"), "/home/user/project");
});

test("toPosixPath: handles empty string", () => {
	assert.equal(toPosixPath(""), "");
});

test("toPosixPath: handles Windows UNC paths", () => {
	assert.equal(toPosixPath("\\\\server\\share\\dir"), "//server/share/dir");
});

test("toPosixPath: handles .gsd/worktrees path on Windows", () => {
	assert.equal(
		toPosixPath("C:\\Users\\name\\project\\.gsd\\worktrees\\M001"),
		"C:/Users/name/project/.gsd/worktrees/M001",
	);
});

// ─── System prompt path normalization ───────────────────────────────────────

test("buildSystemPrompt: cwd uses forward slashes even with Windows input", () => {
	const prompt = buildSystemPrompt({
		cwd: "C:\\Users\\name\\development\\app-name",
	});
	assert.ok(
		prompt.includes("C:/Users/name/development/app-name"),
		"System prompt should contain forward-slash path",
	);
	assert.ok(
		!prompt.includes("C:\\Users\\name\\development\\app-name"),
		"System prompt must NOT contain backslash path",
	);
});

test("buildSystemPrompt: Unix paths pass through unchanged", () => {
	const prompt = buildSystemPrompt({
		cwd: "/home/user/project",
	});
	assert.ok(prompt.includes("/home/user/project"));
});

// ─── Regression: no backslash paths in LLM-visible text ────────────────────

/**
 * Pattern that matches Windows-style absolute paths with backslashes.
 * Catches: C:\Users\..., D:\Projects\..., \\server\share\...
 * Does not match: escaped chars in regex, JSON strings, etc.
 */
const WINDOWS_ABS_PATH_RE = /[A-Z]:\\[A-Za-z]/;

test("buildSystemPrompt: no Windows absolute paths with backslashes in output", () => {
	// Simulate a Windows-like cwd
	const prompt = buildSystemPrompt({
		cwd: "D:\\Projects\\my-app\\.gsd\\worktrees\\M002",
	});
	const lines = prompt.split("\n");
	const violations = lines.filter(line => WINDOWS_ABS_PATH_RE.test(line));
	assert.equal(
		violations.length, 0,
		`System prompt contains Windows backslash paths:\n${violations.join("\n")}`,
	);
});
