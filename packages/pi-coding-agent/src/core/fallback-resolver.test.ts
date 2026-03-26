// GSD Provider Fallback Resolver Tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { FallbackResolver } from "./fallback-resolver.js";
import type { Api, Model } from "@gsd/pi-ai";
import type { AuthStorage } from "./auth-storage.js";
import type { ModelRegistry } from "./model-registry.js";
import type { FallbackChainEntry, SettingsManager } from "./settings-manager.js";

function createMockModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: `https://api.${provider}.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	} as Model<Api>;
}

const zaiModel = createMockModel("zai", "glm-5");
const alibabaModel = createMockModel("alibaba", "glm-5");
const openaiModel = createMockModel("openai", "gpt-4.1");

const defaultChain: FallbackChainEntry[] = [
	{ provider: "zai", model: "glm-5", priority: 1 },
	{ provider: "alibaba", model: "glm-5", priority: 2 },
	{ provider: "openai", model: "gpt-4.1", priority: 3 },
];

function createResolver(overrides?: {
	enabled?: boolean;
	isProviderAvailable?: (provider: string) => boolean;
	hasAuth?: (provider: string) => boolean;
	isProviderRequestReady?: (provider: string) => boolean;
	find?: (provider: string, modelId: string) => Model<Api> | undefined;
}) {
	const settingsManager = {
		getFallbackSettings: () => ({
			enabled: overrides?.enabled ?? true,
			chains: { coding: defaultChain },
		}),
	} as unknown as SettingsManager;

	const authStorage = {
		markProviderExhausted: mock.fn(),
		isProviderAvailable: overrides?.isProviderAvailable ?? (() => true),
		hasAuth: overrides?.hasAuth ?? (() => true),
	} as unknown as AuthStorage;

	const modelRegistry = {
		find: overrides?.find ?? ((provider: string, modelId: string) => {
			if (provider === "zai" && modelId === "glm-5") return zaiModel;
			if (provider === "alibaba" && modelId === "glm-5") return alibabaModel;
			if (provider === "openai" && modelId === "gpt-4.1") return openaiModel;
			return undefined;
		}),
		isProviderRequestReady: overrides?.isProviderRequestReady ?? overrides?.hasAuth ?? (() => true),
	} as unknown as ModelRegistry;

	return { resolver: new FallbackResolver(settingsManager, authStorage, modelRegistry), authStorage };
}

// ─── findFallback ────────────────────────────────────────────────────────────

describe("FallbackResolver — findFallback", () => {
	it("returns next available provider when current fails", async () => {
		const { resolver } = createResolver();
		const result = await resolver.findFallback(zaiModel, "quota_exhausted");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "alibaba");
		assert.equal(result!.model.id, "glm-5");
		assert.equal(result!.chainName, "coding");
	});

	it("marks current provider as exhausted", async () => {
		const { resolver, authStorage } = createResolver();
		await resolver.findFallback(zaiModel, "rate_limit");

		const fn = authStorage.markProviderExhausted as any;
		assert.equal(fn.mock.calls.length, 1);
		assert.equal(fn.mock.calls[0].arguments[0], "zai");
		assert.equal(fn.mock.calls[0].arguments[1], "rate_limit");
	});

	it("skips backed-off providers", async () => {
		const { resolver } = createResolver({
			isProviderAvailable: (provider: string) => provider !== "alibaba",
		});

		const result = await resolver.findFallback(zaiModel, "quota_exhausted");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "openai");
		assert.equal(result!.model.id, "gpt-4.1");
	});

	it("returns null when all providers are backed off", async () => {
		const { resolver } = createResolver({
			isProviderAvailable: () => false,
		});

		const result = await resolver.findFallback(zaiModel, "quota_exhausted");
		assert.equal(result, null);
	});

	it("returns null when fallback is disabled", async () => {
		const { resolver } = createResolver({ enabled: false });
		const result = await resolver.findFallback(zaiModel, "quota_exhausted");
		assert.equal(result, null);
	});

	it("returns null when model is not in any chain", async () => {
		const { resolver } = createResolver();
		const unknownModel = createMockModel("unknown", "some-model");
		const result = await resolver.findFallback(unknownModel, "quota_exhausted");
		assert.equal(result, null);
	});

	it("skips providers that are not request-ready", async () => {
		const { resolver } = createResolver({
			isProviderRequestReady: (provider: string) => provider !== "alibaba",
		});

		const result = await resolver.findFallback(zaiModel, "quota_exhausted");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "openai");
	});

	it("allows fallback to external-cli style providers without stored auth", async () => {
		const { resolver } = createResolver({
			hasAuth: () => false,
			isProviderRequestReady: (provider: string) => provider === "alibaba",
		});

		const result = await resolver.findFallback(zaiModel, "quota_exhausted");
		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "alibaba");
	});

	it("skips providers with no model in registry", async () => {
		const { resolver } = createResolver({
			find: (provider: string, modelId: string) => {
				if (provider === "alibaba") return undefined;
				if (provider === "openai" && modelId === "gpt-4.1") return openaiModel;
				return undefined;
			},
		});

		const result = await resolver.findFallback(zaiModel, "quota_exhausted");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "openai");
	});
});

// ─── checkForRestoration ─────────────────────────────────────────────────────

describe("FallbackResolver — checkForRestoration", () => {
	it("returns higher-priority provider when recovered", async () => {
		const { resolver } = createResolver();
		const result = await resolver.checkForRestoration(alibabaModel);

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "zai");
		assert.equal(result!.model.id, "glm-5");
	});

	it("returns null when already at highest priority", async () => {
		const { resolver } = createResolver();
		const result = await resolver.checkForRestoration(zaiModel);
		assert.equal(result, null);
	});

	it("returns null when higher-priority provider is still backed off", async () => {
		const { resolver } = createResolver({
			isProviderAvailable: (provider: string) => provider !== "zai",
		});

		const result = await resolver.checkForRestoration(alibabaModel);
		assert.equal(result, null);
	});

	it("returns null when fallback is disabled", async () => {
		const { resolver } = createResolver({ enabled: false });
		const result = await resolver.checkForRestoration(alibabaModel);
		assert.equal(result, null);
	});
});

// ─── getBestAvailable ────────────────────────────────────────────────────────

describe("FallbackResolver — getBestAvailable", () => {
	it("returns highest-priority available provider", async () => {
		const { resolver } = createResolver();
		const result = await resolver.getBestAvailable("coding");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "zai");
	});

	it("skips backed-off providers", async () => {
		const { resolver } = createResolver({
			isProviderAvailable: (provider: string) => provider !== "zai",
		});

		const result = await resolver.getBestAvailable("coding");

		assert.notEqual(result, null);
		assert.equal(result!.model.provider, "alibaba");
	});

	it("returns null for unknown chain", async () => {
		const { resolver } = createResolver();
		const result = await resolver.getBestAvailable("nonexistent");
		assert.equal(result, null);
	});
});

// ─── findChainsForModel ──────────────────────────────────────────────────────

describe("FallbackResolver — findChainsForModel", () => {
	it("finds chains containing a model", () => {
		const { resolver } = createResolver();
		const chains = resolver.findChainsForModel("zai", "glm-5");
		assert.deepEqual(chains, ["coding"]);
	});

	it("returns empty array for model not in any chain", () => {
		const { resolver } = createResolver();
		const chains = resolver.findChainsForModel("unknown", "model");
		assert.deepEqual(chains, []);
	});
});
