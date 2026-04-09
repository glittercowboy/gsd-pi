/**
 * Tests for secure_env_collect utility functions:
 * - checkExistingEnvKeys: detects keys already present in .env file or process.env
 * - detectDestination: infers write destination from project files
 *
 * Uses temp directories for filesystem isolation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkExistingEnvKeys, detectDestination } from "../../get-secrets-from-user.ts";

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── checkExistingEnvKeys ─────────────────────────────────────────────────────

test("secure_env_collect: checkExistingEnvKeys — key found in .env file", async () => {
	const tmp = makeTempDir("sec-env-test");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "API_KEY=secret123\nOTHER=val\n");
		const result = await checkExistingEnvKeys(["API_KEY"], envPath);
		assert.deepStrictEqual(result, ["API_KEY"]);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key found in process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_ENV_KEY_12345;
	try {
		process.env.GSD_TEST_ENV_KEY_12345 = "some-value";
		const envPath = join(tmp, ".env"); // file doesn't exist
		const result = await checkExistingEnvKeys(["GSD_TEST_ENV_KEY_12345"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_ENV_KEY_12345"]);
	} finally {
		delete process.env.GSD_TEST_ENV_KEY_12345;
		if (savedVal !== undefined) process.env.GSD_TEST_ENV_KEY_12345 = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key found in both .env and process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_BOTH_KEY;
	try {
		process.env.GSD_TEST_BOTH_KEY = "from-env";
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "GSD_TEST_BOTH_KEY=from-file\n");
		const result = await checkExistingEnvKeys(["GSD_TEST_BOTH_KEY"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_BOTH_KEY"]);
	} finally {
		delete process.env.GSD_TEST_BOTH_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_BOTH_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — key not found anywhere", async () => {
	const tmp = makeTempDir("sec-env-test");
	try {
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "OTHER_KEY=val\n");
		// Ensure it's not in process.env
		delete process.env.DEFINITELY_NOT_SET_KEY_XYZ;
		const result = await checkExistingEnvKeys(["DEFINITELY_NOT_SET_KEY_XYZ"], envPath);
		assert.deepStrictEqual(result, []);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — .env file doesn't exist (ENOENT), still checks process.env", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_ENOENT_KEY;
	try {
		process.env.GSD_TEST_ENOENT_KEY = "exists-in-process";
		const envPath = join(tmp, "nonexistent.env");
		const result = await checkExistingEnvKeys(["GSD_TEST_ENOENT_KEY", "MISSING_KEY_XYZ"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_ENOENT_KEY"]);
	} finally {
		delete process.env.GSD_TEST_ENOENT_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_ENOENT_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — empty-string value in process.env counts as existing", async () => {
	const tmp = makeTempDir("sec-env-test");
	const savedVal = process.env.GSD_TEST_EMPTY_KEY;
	try {
		process.env.GSD_TEST_EMPTY_KEY = "";
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "");
		const result = await checkExistingEnvKeys(["GSD_TEST_EMPTY_KEY"], envPath);
		assert.deepStrictEqual(result, ["GSD_TEST_EMPTY_KEY"]);
	} finally {
		delete process.env.GSD_TEST_EMPTY_KEY;
		if (savedVal !== undefined) process.env.GSD_TEST_EMPTY_KEY = savedVal;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: checkExistingEnvKeys — returns only existing keys from input list", async () => {
	const tmp = makeTempDir("sec-env-test");
	const saved1 = process.env.GSD_TEST_EXISTS_A;
	const saved2 = process.env.GSD_TEST_EXISTS_B;
	try {
		process.env.GSD_TEST_EXISTS_A = "val-a";
		delete process.env.GSD_TEST_EXISTS_B;
		const envPath = join(tmp, ".env");
		writeFileSync(envPath, "FILE_KEY=val\n");
		const result = await checkExistingEnvKeys(
			["GSD_TEST_EXISTS_A", "GSD_TEST_EXISTS_B", "FILE_KEY", "NOPE_KEY"],
			envPath,
		);
		assert.deepStrictEqual(result.sort(), ["FILE_KEY", "GSD_TEST_EXISTS_A"]);
	} finally {
		delete process.env.GSD_TEST_EXISTS_A;
		delete process.env.GSD_TEST_EXISTS_B;
		if (saved1 !== undefined) process.env.GSD_TEST_EXISTS_A = saved1;
		if (saved2 !== undefined) process.env.GSD_TEST_EXISTS_B = saved2;
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── detectDestination ────────────────────────────────────────────────────────

test("secure_env_collect: detectDestination — returns 'vercel' when vercel.json exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "vercel.json"), "{}");
		assert.equal(detectDestination(tmp), "vercel");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — returns 'convex' when convex/ dir exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		mkdirSync(join(tmp, "convex"));
		assert.equal(detectDestination(tmp), "convex");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — returns 'dotenv' when neither exists", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		assert.equal(detectDestination(tmp), "dotenv");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — vercel takes priority when both exist", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "vercel.json"), "{}");
		mkdirSync(join(tmp, "convex"));
		assert.equal(detectDestination(tmp), "vercel");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("secure_env_collect: detectDestination — convex file (not dir) does not trigger convex", () => {
	const tmp = makeTempDir("sec-dest-test");
	try {
		writeFileSync(join(tmp, "convex"), "not a directory");
		assert.equal(detectDestination(tmp), "dotenv");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Bug #2997: undefined vs null handling ──────────────────────────────────

/**
 * When ctx.ui.custom() returns undefined (e.g. noOpUIContext, component
 * disposal, abort), the strict null checks (=== null / !== null) let
 * undefined slip through as a "provided" value, crashing writeEnvKey
 * which calls .replace() on it.
 *
 * These tests verify the fix: loose equality (== null / != null) so that
 * both null AND undefined are treated as "skipped".
 */

// Helper to dynamically load the orchestrator
async function loadOrchestrator(): Promise<{
	collectSecretsFromManifest: Function;
}> {
	const mod = await import("../../get-secrets-from-user.ts");
	return { collectSecretsFromManifest: mod.collectSecretsFromManifest };
}

// Helper to dynamically load files.ts functions
async function loadFilesExports(): Promise<{
	formatSecretsManifest: (m: any) => string;
}> {
	const mod = await import("../files.ts");
	return { formatSecretsManifest: mod.formatSecretsManifest };
}

function makeManifest(entries: Array<{ key: string; status?: string; formatHint?: string; guidance?: string[] }>): any {
	return {
		milestone: "M001",
		generatedAt: "2026-03-12T00:00:00Z",
		entries: entries.map((e) => ({
			key: e.key,
			service: "TestService",
			dashboardUrl: "",
			guidance: e.guidance ?? [],
			formatHint: e.formatHint ?? "",
			status: e.status ?? "pending",
			destination: "dotenv",
		})),
	};
}

async function writeManifestFile(dir: string, manifest: any): Promise<string> {
	const { formatSecretsManifest } = await loadFilesExports();
	const milestoneDir = join(dir, ".gsd", "milestones", "M001");
	mkdirSync(milestoneDir, { recursive: true });
	const filePath = join(milestoneDir, "M001-SECRETS.md");
	writeFileSync(filePath, formatSecretsManifest(manifest));
	return filePath;
}

test("secure_env_collect #2997: undefined from ctx.ui.custom() is treated as skipped, not provided", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("sec-undefined-test");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const manifest = makeManifest([
		{ key: "SECRET_THAT_RETURNS_UNDEFINED", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			// First call is summary screen, second is collect — return undefined
			// to simulate noOpUIContext or component disposal
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				return undefined; // BUG TRIGGER: should be treated as skipped
			},
		},
	};

	// Before the fix, this crashes with:
	// "Cannot read properties of undefined (reading 'replace')"
	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// The undefined-returning key must appear in skipped, not in applied
	assert.ok(
		result.skipped.includes("SECRET_THAT_RETURNS_UNDEFINED"),
		"Key returning undefined should be in skipped list",
	);
	assert.ok(
		!result.applied.includes("SECRET_THAT_RETURNS_UNDEFINED"),
		"Key returning undefined must NOT be in applied list",
	);
});

test("secure_env_collect #2997: null from ctx.ui.custom() is still treated as skipped (regression guard)", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("sec-null-test");
	t.after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const manifest = makeManifest([
		{ key: "SECRET_THAT_RETURNS_NULL", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				return null; // explicit null skip
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	assert.ok(
		result.skipped.includes("SECRET_THAT_RETURNS_NULL"),
		"Key returning null should be in skipped list",
	);
	assert.ok(
		!result.applied.includes("SECRET_THAT_RETURNS_NULL"),
		"Key returning null must NOT be in applied list",
	);
});
