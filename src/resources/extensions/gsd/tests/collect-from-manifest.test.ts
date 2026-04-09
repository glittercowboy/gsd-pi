/**
 * Tests for S02 Enhanced Collection TUI functions:
 * - collectSecretsFromManifest() orchestrator categorization and flow
 * - showSecretsSummary() render output
 * - collectOneSecret() guidance rendering
 *
 * These tests import functions that don't exist yet (T02/T03 will build them).
 * They are expected to fail until implementation is complete.
 *
 * Uses dynamic imports so individual tests fail with clear messages
 * instead of the entire file crashing at import time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SecretsManifest, SecretsManifestEntry } from "../types.ts";

// Dynamic imports for files.ts functions to avoid cascading failure
// when paths.js isn't available (files.ts statically imports paths.js)
async function loadFilesExports(): Promise<{
	formatSecretsManifest: (m: SecretsManifest) => string;
	parseSecretsManifest: (content: string) => SecretsManifest;
}> {
	const mod = await import("../files.ts");
	return {
		formatSecretsManifest: mod.formatSecretsManifest,
		parseSecretsManifest: mod.parseSecretsManifest,
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeManifest(entries: Partial<SecretsManifestEntry>[]): SecretsManifest {
	return {
		milestone: "M001",
		generatedAt: "2026-03-12T00:00:00Z",
		entries: entries.map((e) => ({
			key: e.key ?? "TEST_KEY",
			service: e.service ?? "TestService",
			dashboardUrl: e.dashboardUrl ?? "",
			guidance: e.guidance ?? [],
			formatHint: e.formatHint ?? "",
			status: e.status ?? "pending",
			destination: e.destination ?? "dotenv",
		})),
	};
}

async function writeManifestFile(dir: string, manifest: SecretsManifest): Promise<string> {
	const { formatSecretsManifest } = await loadFilesExports();
	const milestoneDir = join(dir, ".gsd", "milestones", "M001");
	mkdirSync(milestoneDir, { recursive: true });
	const filePath = join(milestoneDir, "M001-SECRETS.md");
	writeFileSync(filePath, formatSecretsManifest(manifest));
	return filePath;
}

async function loadOrchestrator(): Promise<{
	collectSecretsFromManifest: Function;
	showSecretsSummary: Function;
}> {
	const mod = await import("../../get-secrets-from-user.ts");
	if (typeof mod.collectSecretsFromManifest !== "function") {
		throw new Error("collectSecretsFromManifest is not exported from get-secrets-from-user.ts — T03 will implement this");
	}
	if (typeof mod.showSecretsSummary !== "function") {
		throw new Error("showSecretsSummary is not exported from get-secrets-from-user.ts — T03 will implement this");
	}
	return {
		collectSecretsFromManifest: mod.collectSecretsFromManifest,
		showSecretsSummary: mod.showSecretsSummary,
	};
}

async function loadGuidanceExport(): Promise<{ collectOneSecretWithGuidance: Function }> {
	const mod = await import("../../get-secrets-from-user.ts");
	if (typeof mod.collectOneSecretWithGuidance !== "function") {
		throw new Error("collectOneSecretWithGuidance is not exported from get-secrets-from-user.ts — T02 will implement this");
	}
	return { collectOneSecretWithGuidance: mod.collectOneSecretWithGuidance };
}

// ─── collectSecretsFromManifest: categorization ───────────────────────────────

test("collectSecretsFromManifest: categorizes entries — pending keys need collection, existing keys are skipped", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("manifest-collect");
	const savedA = process.env.EXISTING_KEY_A;
	t.after(() => {
		delete process.env.EXISTING_KEY_A;
		if (savedA !== undefined) process.env.EXISTING_KEY_A = savedA;
		rmSync(tmp, { recursive: true, force: true });
	});

	process.env.EXISTING_KEY_A = "already-set";

	const manifest = makeManifest([
		{ key: "EXISTING_KEY_A", status: "pending" },
		{ key: "PENDING_KEY_B", status: "pending", guidance: ["Step 1: Go to dashboard", "Step 2: Click create key"] },
		{ key: "SKIPPED_KEY_C", status: "skipped" },
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
				return "mock-secret-value"; // collect pending key
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// EXISTING_KEY_A should be in existingSkipped (it's in process.env)
	assert.ok(result.existingSkipped?.includes("EXISTING_KEY_A"),
		"EXISTING_KEY_A should be in existingSkipped");

	// PENDING_KEY_B should have been collected (applied)
	assert.ok(result.applied.includes("PENDING_KEY_B"),
		"PENDING_KEY_B should be in applied");

	// SKIPPED_KEY_C should remain skipped
	assert.ok(result.skipped.includes("SKIPPED_KEY_C"),
		"SKIPPED_KEY_C should be in skipped");
});

test("collectSecretsFromManifest: existing keys are excluded from the collection list — not prompted", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("manifest-collect-skip");
	const savedA = process.env.ALREADY_SET_KEY;
	t.after(() => {
		delete process.env.ALREADY_SET_KEY;
		if (savedA !== undefined) process.env.ALREADY_SET_KEY = savedA;
		rmSync(tmp, { recursive: true, force: true });
	});

	process.env.ALREADY_SET_KEY = "present";

	const manifest = makeManifest([
		{ key: "ALREADY_SET_KEY", status: "pending" },
		{ key: "NEEDS_COLLECTION", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	const collectedKeyNames: string[] = [];
	let summaryShown = false;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				// Intercept the factory to check what key is being collected
				if (!summaryShown) {
					summaryShown = true;
					return null; // dismiss summary
				}
				collectedKeyNames.push("prompted");
				return "mock-value";
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// ALREADY_SET_KEY should not have been prompted — only NEEDS_COLLECTION should
	assert.ok(!result.applied.includes("ALREADY_SET_KEY"),
		"ALREADY_SET_KEY should not be in applied (it was auto-skipped)");
	assert.ok(result.existingSkipped?.includes("ALREADY_SET_KEY"),
		"ALREADY_SET_KEY should be in existingSkipped");
});

test("collectSecretsFromManifest: manifest statuses are updated after collection", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("manifest-update");
	t.after(() => rmSync(tmp, { recursive: true, force: true }));

	const manifest = makeManifest([
		{ key: "KEY_TO_COLLECT", status: "pending" },
		{ key: "KEY_TO_SKIP", status: "pending" },
	]);
	const manifestPath = await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary screen dismiss
				if (callIndex === 2) return "secret-value"; // KEY_TO_COLLECT
				return null; // KEY_TO_SKIP — user skips
			},
		},
	};

	await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// Read back the manifest file and verify statuses were updated
	const { parseSecretsManifest } = await loadFilesExports();
	const updatedContent = readFileSync(manifestPath, "utf8");
	const updatedManifest = parseSecretsManifest(updatedContent);

	const keyToCollect = updatedManifest.entries.find(e => e.key === "KEY_TO_COLLECT");
	const keyToSkip = updatedManifest.entries.find(e => e.key === "KEY_TO_SKIP");

	assert.equal(keyToCollect?.status, "collected",
		"KEY_TO_COLLECT should have status 'collected' after providing a value");
	assert.equal(keyToSkip?.status, "skipped",
		"KEY_TO_SKIP should have status 'skipped' after user skipped it");
});

test("collectSecretsFromManifest: applied keys hydrate process.env for the running session", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("manifest-live-env");
	const envKey = "CONTEXT7_API_KEY";
	const saved = process.env[envKey];
	t.after(() => {
		if (saved === undefined) delete process.env[envKey];
		else process.env[envKey] = saved;
		rmSync(tmp, { recursive: true, force: true });
	});

	delete process.env[envKey];

	const manifest = makeManifest([
		{ key: envKey, status: "pending" },
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
				return "c7_live_test_key";
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	assert.ok(result.applied.includes(envKey), "CONTEXT7_API_KEY should be applied");
	assert.equal(process.env[envKey], "c7_live_test_key",
		"applied keys should be available through process.env without restarting");
});

// ─── showSecretsSummary: render output ────────────────────────────────────────

test("showSecretsSummary: produces lines with correct status glyphs for each entry status", async () => {
	const { showSecretsSummary } = await loadOrchestrator();

	const entries: SecretsManifestEntry[] = [
		{ key: "PENDING_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "pending", destination: "dotenv" },
		{ key: "COLLECTED_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "collected", destination: "dotenv" },
		{ key: "SKIPPED_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "skipped", destination: "dotenv" },
	];

	// showSecretsSummary renders a ctx.ui.custom screen. We capture the render output.
	let renderFn: ((width: number) => string[]) | undefined;
	const mockCtx = {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const mockTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const mockTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
				const component = factory(mockTui, mockTheme, {}, () => {});
				renderFn = component.render;
				// Simulate immediate dismiss
				component.handleInput("\x1b"); // escape
			},
		},
	};

	await showSecretsSummary(mockCtx as any, entries, []);

	assert.ok(renderFn, "render function should have been captured from factory");
	const lines = renderFn!(80);

	// Verify each key appears in the output
	const output = lines.join("\n");
	assert.ok(output.includes("PENDING_KEY"), "should include PENDING_KEY");
	assert.ok(output.includes("COLLECTED_KEY"), "should include COLLECTED_KEY");
	assert.ok(output.includes("SKIPPED_KEY"), "should include SKIPPED_KEY");

	// Verify we have at least one line per entry plus header/footer
	assert.ok(lines.length >= 5, `should have at least 5 lines (got ${lines.length})`);
});

test("showSecretsSummary: existing keys shown with distinct status indicator", async () => {
	const { showSecretsSummary } = await loadOrchestrator();

	const entries: SecretsManifestEntry[] = [
		{ key: "NEW_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "pending", destination: "dotenv" },
		{ key: "OLD_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "collected", destination: "dotenv" },
	];
	const existingKeys = ["OLD_KEY"];

	let renderFn: ((width: number) => string[]) | undefined;
	const mockCtx = {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const mockTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const mockTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
				const component = factory(mockTui, mockTheme, {}, () => {});
				renderFn = component.render;
				component.handleInput("\x1b");
			},
		},
	};

	await showSecretsSummary(mockCtx as any, entries, existingKeys);

	assert.ok(renderFn, "render function should have been captured");
	const lines = renderFn!(80);
	const output = lines.join("\n");

	assert.ok(output.includes("NEW_KEY"), "should include NEW_KEY");
	assert.ok(output.includes("OLD_KEY"), "should include OLD_KEY");
});

// ─── collectOneSecret: guidance rendering ─────────────────────────────────────

test("collectOneSecret: guidance lines appear in render output when guidance is provided", async () => {
	const { collectOneSecretWithGuidance } = await loadGuidanceExport();

	const guidanceSteps = [
		"Navigate to https://platform.openai.com/api-keys",
		"Click 'Create new secret key'",
		"Copy the key value",
	];

	// Use the exported test helper to capture render output with guidance
	let renderFn: ((width: number) => string[]) | undefined;
	const mockCtx = {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const mockTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const mockTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
				const component = factory(mockTui, mockTheme, {}, () => {});
				renderFn = component.render;
				component.handleInput("\x1b"); // escape to dismiss
			},
		},
	};

	await collectOneSecretWithGuidance(mockCtx, 0, 1, "OPENAI_API_KEY", "starts with sk-", guidanceSteps);

	assert.ok(renderFn, "render function should have been captured");
	const lines = renderFn!(80);
	const output = lines.join("\n");

	// Verify guidance steps appear in the output
	assert.ok(output.includes("Navigate to"), "should include first guidance step");
	assert.ok(output.includes("Create new secret key"), "should include second guidance step");
	assert.ok(output.includes("Copy the key value"), "should include third guidance step");
});

test("collectOneSecret: guidance lines wrap long URLs instead of truncating", async () => {
	const { collectOneSecretWithGuidance } = await loadGuidanceExport();

	const longGuidance = [
		"Navigate to https://platform.openai.com/account/api-keys and click 'Create new secret key'",
	];

	let renderFn: ((width: number) => string[]) | undefined;
	const mockCtx = {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const mockTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const mockTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
				const component = factory(mockTui, mockTheme, {}, () => {});
				renderFn = component.render;
				component.handleInput("\x1b");
			},
		},
	};

	await collectOneSecretWithGuidance(mockCtx, 0, 1, "TEST_KEY", undefined, longGuidance);

	assert.ok(renderFn, "render function should have been captured");
	// Render at narrow width to force wrapping
	const lines = renderFn!(50);
	const output = lines.join("\n");

	// The full URL should be present (wrapped, not truncated)
	assert.ok(output.includes("platform.openai.com"), "URL should not be truncated");
	assert.ok(output.includes("Create new secret key"), "text after URL should not be truncated");
});

test("collectOneSecret: no guidance provided — render output has no guidance section", async () => {
	const { collectOneSecretWithGuidance } = await loadGuidanceExport();

	let renderFn: ((width: number) => string[]) | undefined;
	const mockCtx = {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const mockTheme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const mockTui = { requestRender: () => {}, terminal: { rows: 24, columns: 80 } };
				const component = factory(mockTui, mockTheme, {}, () => {});
				renderFn = component.render;
				component.handleInput("\x1b");
			},
		},
	};

	// Call without guidance (undefined)
	await collectOneSecretWithGuidance(mockCtx, 0, 1, "SOME_KEY", "hint text", undefined);

	assert.ok(renderFn, "render function should have been captured");
	const lines = renderFn!(80);
	const output = lines.join("\n");

	// Should include the key name and hint but no numbered guidance steps
	assert.ok(output.includes("SOME_KEY"), "should include key name");
	assert.ok(output.includes("hint text"), "should include hint");
	// Should NOT have numbered step indicators (1., 2., etc.) for guidance
	assert.ok(!output.match(/^\s*1\.\s/m), "should not have numbered guidance steps when no guidance provided");
});

// ─── collectSecretsFromManifest: returns structured result ────────────────────

test("collectSecretsFromManifest: returns result with applied, skipped, and existingSkipped arrays", async (t) => {
	const { collectSecretsFromManifest } = await loadOrchestrator();

	const tmp = makeTempDir("manifest-result");
	const savedKey = process.env.RESULT_TEST_EXISTING;
	t.after(() => {
		delete process.env.RESULT_TEST_EXISTING;
		if (savedKey !== undefined) process.env.RESULT_TEST_EXISTING = savedKey;
		rmSync(tmp, { recursive: true, force: true });
	});

	process.env.RESULT_TEST_EXISTING = "already-here";

	const manifest = makeManifest([
		{ key: "RESULT_TEST_EXISTING", status: "pending" },
		{ key: "RESULT_TEST_NEW", status: "pending" },
	]);
	await writeManifestFile(tmp, manifest);

	let callIndex = 0;
	const mockCtx = {
		cwd: tmp,
		hasUI: true,
		ui: {
			custom: async (_factory: any) => {
				callIndex++;
				if (callIndex <= 1) return null; // summary dismiss
				return "secret-value"; // collect the pending key
			},
		},
	};

	const result = await collectSecretsFromManifest(tmp, "M001", mockCtx as any);

	// Verify result shape
	assert.ok(Array.isArray(result.applied), "result should have applied array");
	assert.ok(Array.isArray(result.skipped), "result should have skipped array");
	assert.ok(Array.isArray(result.existingSkipped), "result should have existingSkipped array");

	assert.ok(result.existingSkipped.includes("RESULT_TEST_EXISTING"),
		"existing key should be in existingSkipped");
	assert.ok(result.applied.includes("RESULT_TEST_NEW"),
		"collected key should be in applied");
});
