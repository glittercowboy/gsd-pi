import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, Api } from "../../types.js";
import type { OAuthCredentials } from "./types.js";

// Test files that need to import from the OAuth modules
import {
	githubCopilotOAuthProvider,
	normalizeDomain,
	getGitHubCopilotBaseUrl,
} from "./github-copilot.js";
import { antigravityOAuthProvider } from "./google-antigravity.js";
import { geminiCliOAuthProvider } from "./google-gemini-cli.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Local type for Copilot credentials (includes optional fields)
type CopilotCredentials = OAuthCredentials & {
	enterpriseUrl?: string;
	modelLimits?: Record<string, { contextWindow: number; maxTokens: number }>;
};

// Helper to create a minimal model for testing
function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}

// ═══════════════════════════════════════════════════════════════════════════
// GitHub Copilot OAuth Provider Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("GitHub Copilot OAuth — normalizeDomain", () => {
	test("returns null for empty input", () => {
		assert.equal(normalizeDomain(""), null);
		assert.equal(normalizeDomain("   "), null);
	});

	test("returns null for invalid domain", () => {
		assert.equal(normalizeDomain("not a domain!@#"), null);
	});

	test("extracts hostname from full URL", () => {
		assert.equal(normalizeDomain("https://github.com"), "github.com");
		assert.equal(normalizeDomain("https://company.ghe.com"), "company.ghe.com");
		assert.equal(normalizeDomain("http://example.com/path"), "example.com");
	});

	test("returns domain as-is when no protocol", () => {
		assert.equal(normalizeDomain("github.com"), "github.com");
		assert.equal(normalizeDomain("company.ghe.com"), "company.ghe.com");
	});

	test("trims whitespace", () => {
		assert.equal(normalizeDomain("  github.com  "), "github.com");
	});
});

describe("GitHub Copilot OAuth — getBaseUrlFromToken", () => {
	test("extracts API URL from token with proxy-ep", () => {
		// Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
		const token = "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;other=value";
		const baseUrl = getGitHubCopilotBaseUrl(token);
		assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
	});

	test("extracts API URL from enterprise proxy-ep", () => {
		const token = "tid=123;exp=1234567890;proxy-ep=proxy.company.ghe.com;other=value";
		const baseUrl = getGitHubCopilotBaseUrl(token);
		assert.equal(baseUrl, "https://api.company.ghe.com");
	});

	test("falls back to default when no token provided", () => {
		const baseUrl = getGitHubCopilotBaseUrl();
		assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
	});

	test("falls back to default when token has no proxy-ep", () => {
		const token = "tid=123;exp=1234567890;other=value";
		const baseUrl = getGitHubCopilotBaseUrl(token);
		assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
	});

	test("uses enterprise domain when provided", () => {
		const baseUrl = getGitHubCopilotBaseUrl(undefined, "company.ghe.com");
		assert.equal(baseUrl, "https://copilot-api.company.ghe.com");
	});

	test("prioritizes token proxy-ep over enterprise domain", () => {
		const token = "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;other=value";
		const baseUrl = getGitHubCopilotBaseUrl(token, "company.ghe.com");
		assert.equal(baseUrl, "https://api.individual.githubcopilot.com");
	});
});

describe("GitHub Copilot OAuth — provider structure", () => {
	test("has correct id and name", () => {
		assert.equal(githubCopilotOAuthProvider.id, "github-copilot");
		assert.equal(githubCopilotOAuthProvider.name, "GitHub Copilot");
	});

	test("has required methods", () => {
		assert.equal(typeof githubCopilotOAuthProvider.login, "function");
		assert.equal(typeof githubCopilotOAuthProvider.refreshToken, "function");
		assert.equal(typeof githubCopilotOAuthProvider.getApiKey, "function");
	});

	test("getApiKey returns access token", () => {
		const credentials: OAuthCredentials = {
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		};
		const apiKey = githubCopilotOAuthProvider.getApiKey(credentials);
		assert.equal(apiKey, "test-access-token");
	});

	test("modifyModels preserves non-Copilot models", () => {
		if (!githubCopilotOAuthProvider.modifyModels) return;
		const models = [createModel({ id: "gpt-4", provider: "openai" })];
		const credentials: OAuthCredentials = {
			access: "test-token",
			refresh: "test-refresh",
			expires: Date.now() + 3600000,
		};
		const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
		assert.deepEqual(result, models);
	});

	test("modifyModels updates Copilot model baseUrl when token has proxy-ep", () => {
		if (!githubCopilotOAuthProvider.modifyModels) return;
		const models = [
			createModel({
				id: "claude-3.5-sonnet",
				provider: "github-copilot",
				baseUrl: "https://api.default.com",
			}),
		];
		const credentials: CopilotCredentials = {
			access: "tid=123;exp=1234567890;proxy-ep=proxy.individual.githubcopilot.com;",
			refresh: "test-refresh",
			expires: Date.now() + 3600000,
		};
		const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
		assert.equal(result[0].baseUrl, "https://api.individual.githubcopilot.com");
	});

	test("modifyModels applies model limits when available", () => {
		if (!githubCopilotOAuthProvider.modifyModels) return;
		const models = [
			createModel({
				id: "claude-3.5-sonnet",
				provider: "github-copilot",
				baseUrl: "https://api.default.com",
			}),
		];
		const credentials: CopilotCredentials = {
			access: "test-token",
			refresh: "test-refresh",
			expires: Date.now() + 3600000,
			modelLimits: {
				"claude-3.5-sonnet": { contextWindow: 123456, maxTokens: 4096 },
			},
		};
		const result = githubCopilotOAuthProvider.modifyModels(models, credentials);
		assert.equal(result[0].contextWindow, 123456);
		assert.equal(result[0].maxTokens, 4096);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Antigravity OAuth Provider Tests
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Gemini CLI OAuth Provider Tests
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Regression tests for credential de-obfuscation
//
// These tests verify that OAuth credentials are stored in plaintext
// (not base64-encoded) after the refactor in commit 289bb325c.
// ═══════════════════════════════════════════════════════════════════════════

describe("OAuth credentials — de-obfuscated regression", () => {
	// Verify we can import the modules without decoding errors
	test("GitHub Copilot module imports successfully", () => {
		// If the module imports, the CLIENT_ID is valid plaintext
		assert.ok(githubCopilotOAuthProvider);
	});

	test("Antigravity module imports successfully", () => {
		assert.ok(antigravityOAuthProvider);
	});

	test("Gemini CLI module imports successfully", () => {
		assert.ok(geminiCliOAuthProvider);
	});

	test("GitHub Copilot CLIENT_ID is plaintext (not base64)", () => {
		const content = readFileSync(join(__dirname, "github-copilot.ts"), "utf-8");
		// Should contain plaintext CLIENT_ID
		assert.ok(content.includes('CLIENT_ID = "Iv1.b507a08c87ecfe98"'));
		// Should NOT contain atob calls for de-obfuscation
		assert.ok(!content.includes("atob("));
	});

	test("Antigravity CLIENT_ID and CLIENT_SECRET are plaintext", () => {
		const content = readFileSync(join(__dirname, "google-antigravity.ts"), "utf-8");
		// Should contain plaintext credentials
		assert.ok(
			content.includes(
				'CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"',
			),
		);
		assert.ok(
			content.includes('CLIENT_SECRET = "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"'),
		);
		// Should NOT contain atob calls for de-obfuscation
		assert.ok(!content.includes("atob("));
	});

	test("Gemini CLI CLIENT_ID and CLIENT_SECRET are plaintext", () => {
		const content = readFileSync(join(__dirname, "google-gemini-cli.ts"), "utf-8");
		// Should contain plaintext credentials
		assert.ok(
			content.includes(
				'CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"',
			),
		);
		assert.ok(
			content.includes('CLIENT_SECRET = "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"'),
		);
		// Should NOT contain atob calls for de-obfuscation
		assert.ok(!content.includes("atob("));
	});

	test("all OAuth files include security explanation comments", () => {
		const files = [
			"github-copilot.ts",
			"google-antigravity.ts",
			"google-gemini-cli.ts",
		];

		for (const file of files) {
			const content = readFileSync(join(__dirname, file), "utf-8");
			// Should include explanation of why credentials are public
			assert.ok(
				content.includes("NOTE: This credential is public") ||
					content.includes("NOTE: These credentials are public"),
				`${file} should explain why credentials are public`,
			);
			assert.ok(
				content.includes("obfuscated") ||
					content.includes("security scanners"),
				`${file} should reference the security scanner issue`,
			);
		}
	});
});
