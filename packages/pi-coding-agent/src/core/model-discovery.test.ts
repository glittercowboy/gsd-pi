import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DISCOVERY_TTLS,
	getDefaultTTL,
	getDiscoverableProviders,
	getDiscoveryAdapter,
	supportsDiscoveryForApi,
} from "./model-discovery.js";

// ─── getDiscoveryAdapter ─────────────────────────────────────────────────────

describe("getDiscoveryAdapter", () => {
	it("returns an adapter for openai", () => {
		const adapter = getDiscoveryAdapter("openai");
		assert.equal(adapter.provider, "openai");
		assert.equal(adapter.supportsDiscovery, true);
	});

	it("returns an adapter for ollama", () => {
		const adapter = getDiscoveryAdapter("ollama");
		assert.equal(adapter.provider, "ollama");
		assert.equal(adapter.supportsDiscovery, true);
	});

	it("returns an adapter for openrouter", () => {
		const adapter = getDiscoveryAdapter("openrouter");
		assert.equal(adapter.provider, "openrouter");
		assert.equal(adapter.supportsDiscovery, true);
	});

	it("returns an adapter for google", () => {
		const adapter = getDiscoveryAdapter("google");
		assert.equal(adapter.provider, "google");
		assert.equal(adapter.supportsDiscovery, true);
	});

	it("returns a static adapter for anthropic", () => {
		const adapter = getDiscoveryAdapter("anthropic");
		assert.equal(adapter.provider, "anthropic");
		assert.equal(adapter.supportsDiscovery, false);
	});

	it("returns a static adapter for bedrock", () => {
		const adapter = getDiscoveryAdapter("bedrock");
		assert.equal(adapter.provider, "bedrock");
		assert.equal(adapter.supportsDiscovery, false);
	});

	it("returns a static adapter for unknown providers", () => {
		const adapter = getDiscoveryAdapter("unknown-provider");
		assert.equal(adapter.provider, "unknown-provider");
		assert.equal(adapter.supportsDiscovery, false);
	});

	it("returns OpenAI-style adapter for unknown provider with OpenAI-compatible API", () => {
		const adapter = getDiscoveryAdapter("my-proxy", ["openai-completions"]);
		assert.equal(adapter.provider, "my-proxy");
		assert.equal(adapter.supportsDiscovery, true);
	});

	it("static adapter fetchModels returns empty array", async () => {
		const adapter = getDiscoveryAdapter("anthropic");
		const models = await adapter.fetchModels("key");
		assert.deepEqual(models, []);
	});
});

// ─── getDiscoverableProviders ────────────────────────────────────────────────

describe("getDiscoverableProviders", () => {
	it("returns only providers that support discovery", () => {
		const providers = getDiscoverableProviders();
		assert.ok(providers.includes("openai"));
		assert.ok(providers.includes("ollama"));
		assert.ok(providers.includes("openrouter"));
		assert.ok(providers.includes("google"));
		assert.ok(!providers.includes("anthropic"));
		assert.ok(!providers.includes("bedrock"));
	});

	it("returns an array of strings", () => {
		const providers = getDiscoverableProviders();
		assert.ok(Array.isArray(providers));
		for (const p of providers) {
			assert.equal(typeof p, "string");
		}
	});
});

// ─── getDefaultTTL ───────────────────────────────────────────────────────────

describe("getDefaultTTL", () => {
	it("returns 5 minutes for ollama", () => {
		assert.equal(getDefaultTTL("ollama"), 5 * 60 * 1000);
	});

	it("returns 1 hour for openai", () => {
		assert.equal(getDefaultTTL("openai"), 60 * 60 * 1000);
	});

	it("returns 1 hour for google", () => {
		assert.equal(getDefaultTTL("google"), 60 * 60 * 1000);
	});

	it("returns 1 hour for openrouter", () => {
		assert.equal(getDefaultTTL("openrouter"), 60 * 60 * 1000);
	});

	it("returns 24 hours for unknown providers", () => {
		assert.equal(getDefaultTTL("some-custom"), 24 * 60 * 60 * 1000);
	});
});

// ─── DISCOVERY_TTLS ──────────────────────────────────────────────────────────

describe("DISCOVERY_TTLS", () => {
	it("has expected keys", () => {
		assert.ok("ollama" in DISCOVERY_TTLS);
		assert.ok("openai" in DISCOVERY_TTLS);
		assert.ok("google" in DISCOVERY_TTLS);
		assert.ok("openrouter" in DISCOVERY_TTLS);
		assert.ok("default" in DISCOVERY_TTLS);
	});

	it("all values are positive numbers", () => {
		for (const [, value] of Object.entries(DISCOVERY_TTLS)) {
			assert.equal(typeof value, "number");
			assert.ok(value > 0);
		}
	});
});

describe("supportsDiscoveryForApi", () => {
	it("returns true for OpenAI-compatible APIs", () => {
		assert.equal(supportsDiscoveryForApi("openai-completions"), true);
		assert.equal(supportsDiscoveryForApi("openai-responses"), true);
	});

	it("returns false for non-discoverable APIs", () => {
		assert.equal(supportsDiscoveryForApi("anthropic-messages"), false);
		assert.equal(supportsDiscoveryForApi(undefined), false);
	});
});

describe("OpenRouter discovery — request URL", () => {
	const expectedOpenRouterModelsUrl = "https://openrouter.ai/api/v1/models";

	async function captureOpenRouterRequest<T>(run: () => Promise<T>): Promise<string> {
		const prevFetch = globalThis.fetch;
		let requestedUrl = "";
		globalThis.fetch = (async (input: string | URL | Request) => {
			requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			return new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		try {
			await run();
			return requestedUrl;
		} finally {
			globalThis.fetch = prevFetch;
		}
	}

	it("requests /api/v1/models when baseUrl is omitted", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels("test-key"),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});

	it("requests /api/v1/models when baseUrl is registry-style …/api/v1", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels(
				"test-key",
				"https://openrouter.ai/api/v1",
			),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});

	it("requests /api/v1/models when baseUrl is registry-style …/api/v1/ (trailing slash)", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels(
				"test-key",
				"https://openrouter.ai/api/v1/",
			),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});

	it("requests /api/v1/models when baseUrl is host root only", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels("test-key", "https://openrouter.ai"),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});

	it("requests /api/v1/models when baseUrl already includes …/api/v1/models", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels(
				"test-key",
				"https://openrouter.ai/api/v1/models",
			),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});

	it("requests /api/v1/models for a custom OpenRouter origin", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels("test-key", "https://openrouter.example"),
		);
		assert.equal(url, "https://openrouter.example/api/v1/models");
	});

	it("falls back to default OpenRouter origin when baseUrl is not a valid URL", async () => {
		const url = await captureOpenRouterRequest(() =>
			getDiscoveryAdapter("openrouter").fetchModels("test-key", "not a valid url :::"),
		);
		assert.equal(url, expectedOpenRouterModelsUrl);
	});
});
