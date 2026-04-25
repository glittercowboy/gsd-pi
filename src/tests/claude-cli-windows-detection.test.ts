import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level regression test for Issue #4424: the Claude Code CLI
 * binary check must use the `.cmd` shim on Windows. Node's
 * `execFileSync('claude', ...)` does not resolve `.cmd`/`.bat` endings
 * automatically on win32, so npm-global installs fail to be detected and
 * the "Use Claude Code CLI" onboarding option silently disappears.
 *
 * Both the lightweight onboarding check (`src/claude-cli-check.ts`) and
 * the cached readiness check
 * (`src/resources/extensions/claude-code-cli/readiness.ts`) must carry
 * the `process.platform === 'win32' ? 'claude.cmd' : 'claude'` guard —
 * analogous to the existing `NPM_COMMAND` pattern in
 * `src/resources/extensions/gsd/pre-execution-checks.ts`.
 */

/**
 * Proximity regex matching the full ternary expression. Validates the
 * real command-selection logic rather than individual tokens — keyword-
 * only assertions (e.g. `/win32/`, `/claude\.cmd/`) can be satisfied by
 * documentation or comments alone and would fail to catch a regression
 * that removes the code path while leaving the JSDoc in place.
 */
const WINDOWS_CLAUDE_SELECTOR =
	/process\.platform\s*===\s*['"]win32['"]\s*\?\s*['"]claude\.cmd['"]\s*:\s*['"]claude['"]/;

const WINDOWS_CMD_SHELL_GUARD =
	/shell\s*:\s*process\.platform\s*===\s*['"]win32['"]/;

/**
 * Verifies the onboarding-level readiness check (`claude-cli-check.ts`)
 * carries the `process.platform === 'win32' ? 'claude.cmd' : 'claude'`
 * selector used by `execFileSync`. Guards the wizard path from Issue
 * #4424 where Windows users never saw the "Use Claude Code CLI" option.
 */
function verifyCliCheckSelector(): void {
	const source = readFileSync(
		join(import.meta.dirname, "..", "claude-cli-check.ts"),
		"utf-8",
	);

	assert.match(
		source,
		WINDOWS_CLAUDE_SELECTOR,
		"claude-cli-check.ts must implement process.platform === 'win32' ? 'claude.cmd' : 'claude'",
	);

	assert.match(
		source,
		WINDOWS_CMD_SHELL_GUARD,
		"claude-cli-check.ts must pass shell: process.platform === 'win32' when spawning claude.cmd",
	);
}

/**
 * Verifies the cached extension-level readiness check (`readiness.ts`)
 * carries the same Windows shim selector, so provider gating succeeds
 * on Windows installs where `claude` is an npm-shipped `.cmd` shim.
 */
function verifyReadinessSelector(): void {
	const source = readFileSync(
		join(
			import.meta.dirname,
			"..",
			"resources",
			"extensions",
			"claude-code-cli",
			"readiness.ts",
		),
		"utf-8",
	);

	assert.match(
		source,
		WINDOWS_CLAUDE_SELECTOR,
		"readiness.ts must implement process.platform === 'win32' ? 'claude.cmd' : 'claude'",
	);

	assert.match(
		source,
		WINDOWS_CMD_SHELL_GUARD,
		"readiness.ts must pass shell: process.platform === 'win32' when spawning claude.cmd",
	);
}

test("claude-cli-check.ts selects claude.cmd on win32", verifyCliCheckSelector);
test("readiness.ts selects claude.cmd on win32", verifyReadinessSelector);
