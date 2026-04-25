import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { usesAnthropicBearerAuth, resolveAnthropicBaseUrl } from "./anthropic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("usesAnthropicBearerAuth covers Bearer-only Anthropic-compatible providers (#3783)", () => {
	assert.equal(usesAnthropicBearerAuth("alibaba-coding-plan"), true);
	assert.equal(usesAnthropicBearerAuth("minimax"), true);
	assert.equal(usesAnthropicBearerAuth("minimax-cn"), true);
	assert.equal(usesAnthropicBearerAuth("anthropic"), false);
});

test("createClient routes Bearer-auth providers through authToken (#3783)", () => {
	const source = readFileSync(join(__dirname, "..", "..", "src", "providers", "anthropic.ts"), "utf-8");
	assert.ok(
		source.includes("const usesBearerAuth = usesAnthropicBearerAuth(model.provider)"),
		"createClient should derive auth mode from usesAnthropicBearerAuth",
	);
	assert.ok(
		source.includes("apiKey: usesBearerAuth ? null : apiKey"),
		"Bearer-auth providers should skip x-api-key auth",
	);
	assert.ok(
		source.includes("authToken: usesBearerAuth ? apiKey : undefined"),
		"Bearer-auth providers should send authToken instead",
	);
});

// Minimal model stub — only the field resolveAnthropicBaseUrl cares about.
const stubModel = { baseUrl: "https://api.anthropic.com" } as Parameters<typeof resolveAnthropicBaseUrl>[0];

test("resolveAnthropicBaseUrl returns model.baseUrl when ANTHROPIC_BASE_URL is unset (#4140)", (t) => {
	const saved = process.env.ANTHROPIC_BASE_URL;
	t.after(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = saved;
	});

	delete process.env.ANTHROPIC_BASE_URL;
	assert.equal(resolveAnthropicBaseUrl(stubModel), "https://api.anthropic.com");
});

test("resolveAnthropicBaseUrl prefers ANTHROPIC_BASE_URL over model.baseUrl (#4140)", (t) => {
	const saved = process.env.ANTHROPIC_BASE_URL;
	t.after(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = saved;
	});

	process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
	assert.equal(resolveAnthropicBaseUrl(stubModel), "https://proxy.example.com");
});

test("resolveAnthropicBaseUrl ignores whitespace-only ANTHROPIC_BASE_URL (#4140)", (t) => {
	const saved = process.env.ANTHROPIC_BASE_URL;
	t.after(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = saved;
	});

	process.env.ANTHROPIC_BASE_URL = "   ";
	assert.equal(resolveAnthropicBaseUrl(stubModel), "https://api.anthropic.com");
});

test("createClient uses resolveAnthropicBaseUrl for all auth paths (#4140)", () => {
	const source = readFileSync(join(__dirname, "..", "..", "src", "providers", "anthropic.ts"), "utf-8");
	const directUsages = (source.match(/baseURL:\s*model\.baseUrl/g) ?? []).length;
	assert.equal(directUsages, 0, "createClient must not use model.baseUrl directly — use resolveAnthropicBaseUrl(model)");
	assert.ok(
		source.includes("baseURL: resolveAnthropicBaseUrl(model)"),
		"all createClient branches should pass baseURL through resolveAnthropicBaseUrl",
	);
});
