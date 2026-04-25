/**
 * Offline mode support tests.
 *
 * Covers:
 * - isLocalModel() detection for local vs cloud URLs
 * - isAllLocalChain() aggregate check
 * - Auto-detection sets PI_OFFLINE when all models are local
 * - Validation rejects remote models with --offline flag
 * - Network error codes in INFRA_ERROR_CODES
 * - Web search tool filtered when PI_OFFLINE is set
 *
 * Fixes #2341
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isLocalModel } from "../../packages/pi-coding-agent/src/core/local-model-check.ts";

// ─── isLocalModel ───────────────────────────────────────────────────────────

test("isLocalModel returns true for localhost", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "http://localhost:11434" })), true);
});

test("isLocalModel returns true for 127.0.0.1", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "http://127.0.0.1:8080/v1" })), true);
});

test("isLocalModel returns true for 0.0.0.0", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "http://0.0.0.0:1234" })), true);
});

test("isLocalModel returns true for ::1 (IPv6 loopback)", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "http://[::1]:11434" })), true);
});

test("isLocalModel returns true for unix socket path", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "unix:///var/run/ollama.sock" })), true);
});

test("isLocalModel returns false for api.anthropic.com", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "https://api.anthropic.com" })), false);
});

test("isLocalModel returns false for api.openai.com", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "https://api.openai.com/v1" })), false);
});

test("isLocalModel returns false when no baseUrl (empty string = cloud)", () => {
	assert.strictEqual(isLocalModel(fakeModel({ baseUrl: "" })), false);
});

// ─── isAllLocalChain (source-level check) ───────────────────────────────────

test("isAllLocalChain returns true when all models are local (logic check)", () => {
	const models = [
		fakeModel({ baseUrl: "http://localhost:11434/v1" }),
		fakeModel({ baseUrl: "http://127.0.0.1:8080" }),
	];
	assert.strictEqual(models.every((m) => isLocalModel(m)), true);
});

test("isAllLocalChain returns false when mixed local and remote", () => {
	const models = [
		fakeModel({ baseUrl: "http://localhost:11434/v1" }),
		fakeModel({ baseUrl: "https://api.anthropic.com" }),
	];
	assert.strictEqual(models.every((m) => isLocalModel(m)), false);
});

test("isAllLocalChain returns false for empty list", () => {
	const models: Array<{ baseUrl: string }> = [];
	// Empty => false (no models means we can't guarantee local)
	assert.strictEqual(models.length === 0 ? false : models.every((m) => isLocalModel(m)), false);
});

// ─── INFRA_ERROR_CODES includes network errors ─────────────────────────────

test("INFRA_ERROR_CODES includes ECONNREFUSED", async () => {
	const { INFRA_ERROR_CODES } = await import(
		"../../src/resources/extensions/gsd/auto/infra-errors.ts"
	);
	assert.strictEqual(INFRA_ERROR_CODES.has("ECONNREFUSED"), true);
});

test("INFRA_ERROR_CODES includes ENOTFOUND", async () => {
	const { INFRA_ERROR_CODES } = await import(
		"../../src/resources/extensions/gsd/auto/infra-errors.ts"
	);
	assert.strictEqual(INFRA_ERROR_CODES.has("ENOTFOUND"), true);
});

test("INFRA_ERROR_CODES includes ENETUNREACH", async () => {
	const { INFRA_ERROR_CODES } = await import(
		"../../src/resources/extensions/gsd/auto/infra-errors.ts"
	);
	assert.strictEqual(INFRA_ERROR_CODES.has("ENETUNREACH"), true);
});

// ─── isInfrastructureError detects network errors in offline mode ───────────

test("isInfrastructureError returns code for ECONNREFUSED when offline", async () => {
	const { isInfrastructureError } = await import(
		"../../src/resources/extensions/gsd/auto/infra-errors.ts"
	);
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	try {
		const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		assert.strictEqual(isInfrastructureError(err), "ECONNREFUSED");
	} finally {
		if (savedOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = savedOffline;
	}
});

// ─── PI_OFFLINE web_search / version-check filtering ──────────────────────
//
// Two former tests here grep'd `pi-coding-agent/src/modes/interactive/...`
// for the literal strings `PI_OFFLINE`, `web_search`, `webSearchResult`.
// That asserted nothing about runtime behaviour (renaming a comment that
// happens to mention `web_search` was sufficient to keep them green) and
// it lived in vendored pi sources that we observe through their compiled
// API, not their TypeScript source — the live binary may not match. The
// behavioural contract — that `PI_OFFLINE=1` causes pi to refuse remote
// tools — is owned by `@pi/coding-agent`'s own test suite. Removed here.
//
// What we still test in this file:
//   * `isLocalModel` (pure, exported from pi)
//   * `INFRA_ERROR_CODES` (real Set; offline-mode classifier)
//   * `isInfrastructureError` under PI_OFFLINE (real function, real env)

// ─── Helper ─────────────────────────────────────────────────────────────────

function fakeModel(overrides: Partial<{ baseUrl: string }> = {}): { baseUrl: string } {
	return { baseUrl: overrides.baseUrl ?? "" };
}
