import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { OAuthCredentials } from "./types.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";

describe("Gemini CLI OAuth — provider structure", () => {
	test("has correct id and name", () => {
		assert.equal(geminiCliOAuthProvider.id, "google-gemini-cli");
		assert.equal(geminiCliOAuthProvider.name, "Google Cloud Code Assist (Gemini CLI)");
	});

	test("uses callback server", () => {
		assert.equal(geminiCliOAuthProvider.usesCallbackServer, true);
	});

	test("has required methods", () => {
		assert.equal(typeof geminiCliOAuthProvider.login, "function");
		assert.equal(typeof geminiCliOAuthProvider.refreshToken, "function");
		assert.equal(typeof geminiCliOAuthProvider.getApiKey, "function");
	});

	test("getApiKey returns JSON with token and projectId", () => {
		const credentials: OAuthCredentials = {
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
			projectId: "test-project-456",
			email: "test@example.com",
		};
		const apiKey = geminiCliOAuthProvider.getApiKey(credentials);
		assert.equal(typeof apiKey, "string");
		const parsed = JSON.parse(apiKey);
		assert.equal(parsed.token, "test-access-token");
		assert.equal(parsed.projectId, "test-project-456");
	});

	test("refreshToken throws when projectId is missing", async () => {
		const credentials: OAuthCredentials = {
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		};
		await assert.rejects(
			geminiCliOAuthProvider.refreshToken(credentials),
			/Google Cloud credentials missing projectId/,
		);
	});
});

describe("Gemini CLI OAuth — credential regression", () => {
	// The module-import smoke test is the de-obfuscation guard: if CLIENT_ID
	// or CLIENT_SECRET were re-obfuscated with atob(), the module would throw
	// on load and every other test in this file would fail. See #4802.
	test("module imports successfully", () => {
		assert.ok(geminiCliOAuthProvider);
	});
});