/**
 * Readiness check for the Claude Code CLI provider.
 *
 * Verifies the `claude` binary is installed, responsive, AND authenticated.
 * Results are cached for 30 seconds to avoid shelling out on every
 * model-availability check.
 *
 * Auth verification follows the T3 Code pattern: run `claude auth status`
 * and check the exit code + output for an authenticated session.
 */

import { execFileSync } from "node:child_process";

/**
 * Candidate executable names for the Claude Code CLI.
 *
 * Keep the explicit win32 ternary selector for regression coverage (Issue #4424):
 * Node's execFileSync must target `claude.cmd` directly on Windows.
 */
const CLAUDE_COMMAND = process.platform === "win32" ? "claude.cmd" : "claude";

/**
 * Windows installs vary: some environments expose `claude.cmd` (npm shim),
 * `claude.exe` (direct binary install), or a bare `claude` shim on PATH
 * (for example Git Bash wrappers). Try all three to avoid false "not
 * installed" results in readiness checks.
 */
const CLAUDE_COMMAND_CANDIDATES = process.platform === "win32" ? [CLAUDE_COMMAND, "claude.exe", "claude"] : [CLAUDE_COMMAND];

function execClaude(args: string[]): Buffer {
	let lastError: unknown;
	for (const command of CLAUDE_COMMAND_CANDIDATES) {
		try {
			return execFileSync(command, args, {
				timeout: 5_000,
				stdio: "pipe",
				shell: process.platform === "win32",
			});
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			// Windows Git Bash can surface `.cmd` spawn failures as EINVAL instead
			// of ENOENT. Treat both as "try next candidate".
			if (code === "ENOENT" || code === "EINVAL") {
				continue;
			}
			throw error;
		}
	}
	throw lastError ?? new Error(`Claude CLI executable not found (tried: ${CLAUDE_COMMAND_CANDIDATES.join(", ")})`);
}

let cachedBinaryPresent: boolean | null = null;
let cachedAuthed: boolean | null = null;
let lastCheckMs = 0;
const CHECK_INTERVAL_MS = 30_000;

function refreshCache(): void {
	const now = Date.now();
	if (cachedBinaryPresent !== null && now - lastCheckMs < CHECK_INTERVAL_MS) {
		return;
	}

	// Set timestamp first to prevent re-entrant checks during the same window
	lastCheckMs = now;

	// Check binary presence
	try {
		execClaude(["--version"]);
		cachedBinaryPresent = true;
	} catch {
		cachedBinaryPresent = false;
		cachedAuthed = false;
		return;
	}

	// Check auth status — exit code 0 with non-error output means authenticated
	try {
		const output = execClaude(["auth", "status"])
			.toString()
			.toLowerCase();
		// The CLI outputs "not logged in", "no credentials", or similar when unauthenticated
		cachedAuthed = !(/not logged in|no credentials|unauthenticated|not authenticated/i.test(output));
	} catch {
		// Non-zero exit code means not authenticated
		cachedAuthed = false;
	}
}

/**
 * Whether the `claude` binary is installed (regardless of auth state).
 */
export function isClaudeBinaryPresent(): boolean {
	refreshCache();
	return cachedBinaryPresent ?? false;
}

/**
 * Whether the `claude` CLI is authenticated with a valid session.
 * Returns false if the binary is not installed.
 */
export function isClaudeCodeAuthed(): boolean {
	refreshCache();
	return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

/**
 * Full readiness check: binary installed AND authenticated.
 * This is the gating function used by the provider registration.
 */
export function isClaudeCodeReady(): boolean {
	refreshCache();
	return (cachedBinaryPresent ?? false) && (cachedAuthed ?? false);
}

/**
 * Force-clear the cached readiness state.
 * Useful after the user completes auth setup so the next check is fresh.
 */
export function clearReadinessCache(): void {
	cachedBinaryPresent = null;
	cachedAuthed = null;
	lastCheckMs = 0;
}
