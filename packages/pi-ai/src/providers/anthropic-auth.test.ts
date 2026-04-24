import test from "node:test";
import assert from "node:assert/strict";

import {
	buildAnthropicClientConfig,
	resolveAnthropicBaseUrl,
	usesAnthropicBearerAuth,
} from "./anthropic.js";
import type { Model } from "../types.js";

function makeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5-20250929",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		name: "Claude",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	} as Model<"anthropic-messages">;
}

test("usesAnthropicBearerAuth covers Bearer-only Anthropic-compatible providers (#3783)", () => {
	assert.equal(usesAnthropicBearerAuth("alibaba-coding-plan"), true);
	assert.equal(usesAnthropicBearerAuth("minimax"), true);
	assert.equal(usesAnthropicBearerAuth("minimax-cn"), true);
	assert.equal(usesAnthropicBearerAuth("anthropic"), false);
});

test("buildAnthropicClientConfig routes Bearer-auth providers through authToken (#3783)", () => {
	for (const provider of ["alibaba-coding-plan", "minimax", "minimax-cn"] as const) {
		const config = buildAnthropicClientConfig(
			makeModel({ provider: provider as Model<"anthropic-messages">["provider"] }),
			"secret-key",
			false,
		);
		assert.equal(config.apiKey, null, `${provider} must not send x-api-key`);
		assert.equal(config.authToken, "secret-key", `${provider} must send apiKey as authToken`);
	}
});

test("buildAnthropicClientConfig routes regular Anthropic through apiKey / x-api-key (#3783)", () => {
	const config = buildAnthropicClientConfig(makeModel({ provider: "anthropic" }), "sk-ant-123", false);
	assert.equal(config.apiKey, "sk-ant-123");
	assert.equal(config.authToken, undefined);
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

test("buildAnthropicClientConfig uses resolveAnthropicBaseUrl for every auth path (#4140)", (t) => {
	// Behaviour: flipping ANTHROPIC_BASE_URL must reroute EVERY createClient
	// branch (github-copilot, known-bearer-auth, default). Each branch builds
	// its config via resolveAnthropicBaseUrl, so setting the env var must
	// override model.baseUrl for all three.
	const saved = process.env.ANTHROPIC_BASE_URL;
	t.after(() => {
		if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
		else process.env.ANTHROPIC_BASE_URL = saved;
	});
	process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";

	const branches = [
		{ provider: "github-copilot", label: "copilot bearer path" },
		{ provider: "minimax", label: "known bearer-auth path" },
		{ provider: "anthropic", label: "default api-key path" },
	] as const;

	for (const { provider, label } of branches) {
		const config = buildAnthropicClientConfig(
			makeModel({ provider: provider as Model<"anthropic-messages">["provider"], baseUrl: "https://api.anthropic.com" }),
			"some-key",
			false,
		);
		assert.equal(
			config.baseURL,
			"https://proxy.example.com",
			`${label}: baseURL must come from resolveAnthropicBaseUrl, not model.baseUrl`,
		);
	}
});
