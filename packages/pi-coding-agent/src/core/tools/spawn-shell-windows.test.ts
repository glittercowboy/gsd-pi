/**
 * spawn-shell-windows.test.ts — Regression test for Windows spawn ENOENT/EINVAL.
 *
 * On Windows, npm/npx/tsc and other tools are installed as .cmd batch scripts.
 * Node's `spawn()` without `shell: true` cannot execute .cmd files, resulting
 * in ENOENT or EINVAL errors. Every spawn site that may invoke a user-installed
 * binary (not `node` or a shell like `sh`/`bash`/`cmd`) must include
 * `shell: process.platform === "win32"` so the call is resolved through cmd.exe
 * on Windows while remaining a direct exec on POSIX.
 *
 * This test structurally scans all spawn sites and verifies the guard is present.
 *
 * Fixes: gsd-build/gsd-2#2854
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = join(__dirname, "..");

/**
 * Files that call `spawn()` with a user-facing binary (not `node`, `sh`, `bash`,
 * or `cmd`) and therefore need the Windows shell guard.
 *
 * If a file spawns only hardcoded system binaries (like `node` in rpc-client.ts),
 * it does not need the guard and should NOT appear here.
 */
const SPAWN_FILES_NEEDING_SHELL_GUARD = [
	// Extension's GSD client — spawns the `gsd` binary which is a .cmd on Windows
	join(coreDir, "..", "..", "..", "vscode-extension", "src", "gsd-client.ts"),
	// exec.ts — used by extensions to run arbitrary commands
	join(coreDir, "exec.ts"),
	// LSP index — spawns project-type commands (tsc, cargo, etc.)
	join(coreDir, "lsp", "index.ts"),
	// LSP client — spawns LSP server binaries (npx, etc.)
	join(coreDir, "lsp", "client.ts"),
	// LSP mux — spawns lspmux binary
	join(coreDir, "lsp", "lspmux.ts"),
	// Package manager — spawns npm/yarn/pnpm
	join(coreDir, "package-manager.ts"),
];

test("all spawn sites that invoke user-facing binaries include shell: process.platform === 'win32'", () => {
	const failures: string[] = [];

	for (const file of SPAWN_FILES_NEEDING_SHELL_GUARD) {
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			// File may not exist in this checkout — skip
			continue;
		}

		const lines = content.split("\n");

		// Find all spawn(..., { ... }) call sites and check each one
		// for the presence of `shell: process.platform === "win32"` within
		// 5 lines after the spawn call.
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			// Skip comments
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

			// Detect a spawn() call
			if (/\bspawn\(/.test(line)) {
				// Look ahead up to 8 lines for the shell guard
				const lookahead = lines.slice(i, i + 8).join("\n");
				const hasShellGuard =
					/shell:\s*process\.platform\s*===\s*["']win32["']/.test(lookahead);

				if (!hasShellGuard) {
					const relPath = relative(join(coreDir, "..", ".."), file);
					failures.push(`${relPath}:${i + 1}`);
				}
			}
		}
	}

	assert.deepEqual(
		failures,
		[],
		`The following spawn sites are missing 'shell: process.platform === "win32"':\n` +
		failures.map(f => `  - ${f}`).join("\n") +
		`\nOn Windows, .cmd wrapper scripts (npm, npx, tsc, gsd) require shell ` +
		`resolution. Without this guard, spawn fails with ENOENT or EINVAL.`,
	);
});
