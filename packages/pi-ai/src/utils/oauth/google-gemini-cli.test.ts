import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthCredentials } from "./types.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = join(__dirname, "..", "..", "..");
const sourceDir = existsSync(join(__dirname, "google-gemini-cli.ts"))
	? __dirname
	: join(packageRoot, "src", "utils", "oauth");

function readSourceFile(name: string): string {
	return readFileSync(join(sourceDir, name), "utf-8");
}

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
	test("module imports successfully", () => {
		assert.ok(geminiCliOAuthProvider);
	});

	test("CLIENT_ID and CLIENT_SECRET are plaintext", () => {
		const content = readSourceFile("google-gemini-cli.ts");
		assert.ok(
			content.includes(
				'CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"',
			),
		);
		assert.ok(content.includes('CLIENT_SECRET = "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"'));
		assert.ok(!content.includes("atob("));
	});

	test("security explanation comments are present", () => {
		const content = readSourceFile("google-gemini-cli.ts");
		assert.ok(content.includes("NOTE: These credentials are public"));
		assert.ok(content.includes("obfuscated") || content.includes("security scanners"));
	});
});