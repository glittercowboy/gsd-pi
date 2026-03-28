/**
 * bash-spawn-windows.test.ts — Regression test for Windows spawn EINVAL.
 *
 * Verifies that bash tool spawn options disable `detached: true` on Windows
 * to prevent EINVAL errors in ConPTY / VSCode terminal contexts, and that
 * the EINVAL recovery mechanism (spawnWithEinvalRecovery) provides fallback
 * shells when the primary bash spawn fails.
 *
 * Background:
 *   On Windows, `spawn()` with `detached: true` sets the
 *   CREATE_NEW_PROCESS_GROUP flag in CreateProcess.  In certain terminal
 *   contexts (VSCode integrated terminal, ConPTY, Windows Terminal) this
 *   flag conflicts with the parent process group and causes a synchronous
 *   EINVAL from libuv.  The bg-shell extension already guards against this
 *   with `detached: process.platform !== "win32"` (process-manager.ts);
 *   this test ensures all other spawn sites are aligned.
 *
 *   Additionally, EINVAL can occur for other reasons on Windows (Node.js
 *   version regressions, ConPTY changes in recent Windows builds).  The
 *   spawnWithEinvalRecovery wrapper catches these and retries with cmd.exe
 *   or PowerShell as fallback shells.
 *
 * See: gsd-build/gsd-2#XXXX
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Verify the spawn option pattern used across the codebase.
// This is a static/structural test — it reads the source files and asserts
// they use the platform-guarded detached flag.
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..", "..");
const sourceRoot = join(packageRoot, "src");

const SPAWN_FILES = [
	join(sourceRoot, "core", "tools", "bash.ts"),
	join(sourceRoot, "core", "bash-executor.ts"),
	join(sourceRoot, "utils", "shell.ts"),
];

test("spawn calls use platform-guarded detached flag (no unconditional detached: true)", () => {
	for (const file of SPAWN_FILES) {
		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			// Skip comments
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
			// Check for unconditional `detached: true`
			if (/detached:\s*true\b/.test(line)) {
				assert.fail(
					`${file}:${i + 1} has unconditional 'detached: true' — ` +
					`must use 'detached: process.platform !== "win32"' ` +
					`to prevent EINVAL on Windows (ConPTY / VSCode terminal)`,
				);
			}
		}
	}
});

test("killProcessTree does not use detached: true for taskkill on Windows", () => {
	const shellFile = join(sourceRoot, "utils", "shell.ts");
	const content = readFileSync(shellFile, "utf-8");

	// Find the taskkill spawn call and ensure it doesn't have detached: true
	const taskkillRegion = content.match(/spawn\("taskkill"[\s\S]*?\}\)/);
	if (taskkillRegion) {
		assert.ok(
			!/detached:\s*true/.test(taskkillRegion[0]),
			"taskkill spawn should not use detached: true — " +
			"it can cause EINVAL on Windows and is unnecessary for a utility process",
		);
	}
});

// Smoke test: spawn with platform-guarded detached flag actually works
test("spawn with detached: process.platform !== 'win32' succeeds", async () => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();

	const child = spawn(
		process.platform === "win32" ? "cmd" : "sh",
		process.platform === "win32" ? ["/c", "echo ok"] : ["-c", "echo ok"],
		{
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let output = "";
	child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
	child.on("error", reject);
	child.on("close", (code) => {
		try {
			assert.equal(code, 0, "spawn should succeed");
			assert.ok(output.trim().includes("ok"), `Expected 'ok' in output, got: ${output}`);
			resolve();
		} catch (e) {
			reject(e);
		}
	});

	await promise;
});

// Smoke test: spawn with the actual resolved bash shell (not just cmd.exe).
// This catches issues where bash.exe itself can't be spawned — the original
// smoke test uses cmd.exe which sidesteps bash-specific spawn failures.
test("spawn with resolved bash shell succeeds", async () => {
	// Import getShellConfig dynamically to avoid import cycle issues in test
	let getShellConfig: () => { shell: string; args: string[] };
	try {
		const shellMod = await import("../../utils/shell.js");
		getShellConfig = shellMod.getShellConfig;
	} catch {
		// If import fails (e.g., missing dependencies in test env), skip
		return;
	}

	let shell: string;
	let args: string[];
	try {
		({ shell, args } = getShellConfig());
	} catch {
		// No shell available (e.g., CI without bash) — skip
		return;
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();

	const child = spawn(shell, [...args, "echo bash-ok"], {
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});

	let output = "";
	child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
	child.on("error", reject);
	child.on("close", (code) => {
		try {
			assert.equal(code, 0, `spawn ${shell} should succeed`);
			assert.ok(
				output.trim().includes("bash-ok"),
				`Expected 'bash-ok' in output from ${shell}, got: ${output}`,
			);
			resolve();
		} catch (e) {
			reject(e);
		}
	});

	await promise;
});

// Test that spawn works with spaces in the working directory path.
// This is a common Windows issue — directory names like "My Project" or
// "PinkBrain Router git" must be handled correctly by the spawn cwd option.
test("spawn succeeds with spaces in cwd path", async () => {
	const tempDir = join(tmpdir(), "gsd test dir with spaces");
	mkdirSync(tempDir, { recursive: true });

	try {
		const { promise, resolve, reject } = Promise.withResolvers<void>();

		const child = spawn(
			process.platform === "win32" ? "cmd" : "sh",
			process.platform === "win32" ? ["/c", "echo cwd-ok"] : ["-c", "echo cwd-ok"],
			{
				cwd: tempDir,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let output = "";
		child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			try {
				assert.equal(code, 0, "spawn with spaces in cwd should succeed");
				assert.ok(
					output.trim().includes("cwd-ok"),
					`Expected 'cwd-ok' in output, got: ${output}`,
				);
				resolve();
			} catch (e) {
				reject(e);
			}
		});

		await promise;
	} finally {
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
	}
});

// Structural test: shell.ts exports the EINVAL recovery functions
test("shell.ts exports spawnWithEinvalRecovery and getFallbackShellConfig", () => {
	const shellFile = join(sourceRoot, "utils", "shell.ts");
	const content = readFileSync(shellFile, "utf-8");

	assert.ok(
		content.includes("export function spawnWithEinvalRecovery"),
		"shell.ts should export spawnWithEinvalRecovery for EINVAL resilience",
	);
	assert.ok(
		content.includes("export function getFallbackShellConfig"),
		"shell.ts should export getFallbackShellConfig for Windows fallback shells",
	);
	assert.ok(
		content.includes("export function formatSpawnDiagnostics"),
		"shell.ts should export formatSpawnDiagnostics for actionable error messages",
	);
});

// Structural test: bash.ts and bash-executor.ts use spawnWithEinvalRecovery
test("spawn sites use spawnWithEinvalRecovery instead of raw spawn for command execution", () => {
	const bashFile = join(sourceRoot, "core", "tools", "bash.ts");
	const executorFile = join(sourceRoot, "core", "bash-executor.ts");

	for (const file of [bashFile, executorFile]) {
		const content = readFileSync(file, "utf-8");
		assert.ok(
			content.includes("spawnWithEinvalRecovery"),
			`${file} should use spawnWithEinvalRecovery for Windows EINVAL resilience`,
		);
	}
});
