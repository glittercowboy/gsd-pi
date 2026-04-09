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
		execFileSync("claude", ["--version"], { timeout: 5_000, stdio: "pipe" });
		cachedBinaryPresent = true;
	} catch {
		cachedBinaryPresent = false;
		cachedAuthed = false;
		return;
	}

	// Check auth status — exit code 0 with non-error output means authenticated
	try {
		const output = execFileSync("claude", ["auth", "status"], { timeout: 5_000, stdio: "pipe" })
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
