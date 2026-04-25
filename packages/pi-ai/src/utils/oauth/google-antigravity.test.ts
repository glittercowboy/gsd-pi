import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthCredentials } from "./types.js";
import { antigravityOAuthProvider } from "./google-antigravity.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = join(__dirname, "..", "..", "..");
const sourceDir = existsSync(join(__dirname, "google-antigravity.ts"))
	? __dirname
	: join(packageRoot, "src", "utils", "oauth");

function readSourceFile(name: string): string {
	return readFileSync(join(sourceDir, name), "utf-8");
}

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
	test("module imports successfully", () => {
		assert.ok(antigravityOAuthProvider);
	});

	test("CLIENT_ID and CLIENT_SECRET are plaintext", () => {
		const content = readSourceFile("google-antigravity.ts");
		assert.ok(
			content.includes(
				'CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"',
			),
		);
		assert.ok(content.includes('CLIENT_SECRET = "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"'));
		assert.ok(!content.includes("atob("));
	});

	test("security explanation comments are present", () => {
		const content = readSourceFile("google-antigravity.ts");
		assert.ok(content.includes("NOTE: These credentials are public"));
		assert.ok(content.includes("obfuscated") || content.includes("security scanners"));
	});
});