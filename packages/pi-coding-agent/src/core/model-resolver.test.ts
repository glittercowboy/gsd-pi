/**
 * Regression test for the #unconfigured-models fix: findInitialModel() must
 * skip the saved default when its provider has no working auth, rather than
 * returning an unusable model that every selector surface would display as
 * "current".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { findInitialModel } from "./model-resolver.js";

function fakeRegistry(options: {
	models: Array<{ provider: string; id: string }>;
	readyProviders: Set<string>;
}) {
	const fullModels = options.models.map((m) => ({
		...m,
		name: m.id,
		api: "anthropic-messages",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	}));
	const available = fullModels.filter((m) => options.readyProviders.has(m.provider));
	return {
		find(provider: string, id: string) {
			return fullModels.find((m) => m.provider === provider && m.id === id);
		},
		getAvailable() {
			return available;
		},
		isProviderRequestReady(provider: string) {
			return options.readyProviders.has(provider);
		},
	};
}

test("findInitialModel skips saved default when provider has no auth", async () => {
	// User saved xai/grok-4 as default, but XAI_API_KEY is unset so xai is
	// in the registry but not ready. Previously findInitialModel() step 3
	// returned xai anyway — now it must fall through to step 4 and pick
	// an available model.
	const registry = fakeRegistry({
		models: [
			{ provider: "xai", id: "grok-4-fast-non-reasoning" },
			{ provider: "anthropic", id: "claude-opus-4-6" },
		],
		readyProviders: new Set(["anthropic"]),
	});

	const result = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: "xai",
		defaultModelId: "grok-4-fast-non-reasoning",
		modelRegistry: registry as any,
	});

	assert.ok(result.model, "a model must be returned");
	assert.equal(result.model!.provider, "anthropic", "unauth'd saved default must be skipped");
});

test("findInitialModel keeps saved default when provider has auth", async () => {
	const registry = fakeRegistry({
		models: [
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "openai", id: "gpt-5.4" },
		],
		readyProviders: new Set(["anthropic", "openai"]),
	});

	const result = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: "openai",
		defaultModelId: "gpt-5.4",
		modelRegistry: registry as any,
	});

	assert.equal(result.model?.provider, "openai");
	assert.equal(result.model?.id, "gpt-5.4");
});
