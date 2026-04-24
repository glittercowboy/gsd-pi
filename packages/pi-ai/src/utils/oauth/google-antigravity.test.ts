import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OAuthCredentials } from "./types.js";
import { antigravityOAuthProvider } from "./google-antigravity.js";

describe("Antigravity OAuth — provider structure", () => {
	test("has correct id and name", () => {
		assert.equal(antigravityOAuthProvider.id, "google-antigravity");
		assert.equal(antigravityOAuthProvider.name, "Antigravity (Gemini 3, Claude, GPT-OSS)");
	});

	test("uses callback server", () => {
		assert.equal(antigravityOAuthProvider.usesCallbackServer, true);
	});

	test("has required methods", () => {
		assert.equal(typeof antigravityOAuthProvider.login, "function");
		assert.equal(typeof antigravityOAuthProvider.refreshToken, "function");
		assert.equal(typeof antigravityOAuthProvider.getApiKey, "function");
	});

	test("getApiKey returns JSON with token and projectId", () => {
		const credentials: OAuthCredentials = {
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
			projectId: "test-project-123",
			email: "test@example.com",
		};
		const apiKey = antigravityOAuthProvider.getApiKey(credentials);
		assert.equal(typeof apiKey, "string");
		const parsed = JSON.parse(apiKey);
		assert.equal(parsed.token, "test-access-token");
		assert.equal(parsed.projectId, "test-project-123");
	});

	test("refreshToken throws when projectId is missing", async () => {
		const credentials: OAuthCredentials = {
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		};
		await assert.rejects(
			antigravityOAuthProvider.refreshToken(credentials),
			/Antigravity credentials missing projectId/,
		);
	});
});

describe("Antigravity OAuth — credential regression", () => {
	// The module-import smoke test is the de-obfuscation guard: if CLIENT_ID
	// or CLIENT_SECRET were re-obfuscated with atob(), the module would throw
	// on load and every other test in this file would fail. See #4802.
	test("module imports successfully", () => {
		assert.ok(antigravityOAuthProvider);
	});
});