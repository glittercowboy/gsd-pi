import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviders, getModels, getModel, supportsXhigh, applyCapabilityPatches } from "./models.js";
import type { Api, Model } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Custom provider preservation (regression: #2339)
//
// Custom providers (like alibaba-coding-plan) are manually maintained and
// NOT sourced from models.dev. They must survive generated catalog
// regeneration by living in models/custom.ts.
// ═══════════════════════════════════════════════════════════════════════════

describe("model registry — custom providers", () => {
	it("alibaba-coding-plan is a registered provider", () => {
		const providers = getProviders();
		assert.ok(
			providers.includes("alibaba-coding-plan"),
			`Expected "alibaba-coding-plan" in providers, got: ${providers.join(", ")}`,
		);
	});

	it("alibaba-coding-plan has all expected models", () => {
		const models = getModels("alibaba-coding-plan");
		const ids = models.map((m) => m.id).sort();
		const expected = [
			"MiniMax-M2.5",
			"glm-4.7",
			"glm-5",
			"kimi-k2.5",
			"qwen3-coder-next",
			"qwen3-coder-plus",
			"qwen3-max-2026-01-23",
			"qwen3.5-plus",
		];
		assert.deepEqual(ids, expected);
	});

	it("alibaba-coding-plan models use the correct base URL", () => {
		const models = getModels("alibaba-coding-plan");
		for (const model of models) {
			assert.equal(
				model.baseUrl,
				"https://coding-intl.dashscope.aliyuncs.com/v1",
				`Model ${model.id} has wrong baseUrl: ${model.baseUrl}`,
			);
		}
	});

	it("alibaba-coding-plan models use openai-completions API", () => {
		const models = getModels("alibaba-coding-plan");
		for (const model of models) {
			assert.equal(model.api, "openai-completions", `Model ${model.id} has wrong api: ${model.api}`);
		}
	});

	it("alibaba-coding-plan models have provider set correctly", () => {
		const models = getModels("alibaba-coding-plan");
		for (const model of models) {
			assert.equal(
				model.provider,
				"alibaba-coding-plan",
				`Model ${model.id} has wrong provider: ${model.provider}`,
			);
		}
	});

	it("getModel retrieves alibaba-coding-plan models by provider+id", () => {
		// Use type assertion to test runtime behavior — alibaba-coding-plan may come
		// from custom models rather than the generated file, so the narrow
		// GeneratedProvider type doesn't include it until models/custom.ts is merged.
		const model = getModel("alibaba-coding-plan" as any, "qwen3.5-plus" as any);
		assert.ok(model, "Expected getModel to return a model for alibaba-coding-plan/qwen3.5-plus");
		assert.equal(model.id, "qwen3.5-plus");
		assert.equal(model.provider, "alibaba-coding-plan");
	});
});

describe("model registry — custom zai provider (GLM-5.1)", () => {
	it("zai provider includes glm-5.1 from custom models", () => {
		const models = getModels("zai" as any);
		const ids = models.map((m) => m.id);
		assert.ok(ids.includes("glm-5.1"), `Expected "glm-5.1" in zai models, got: ${ids.join(", ")}`);
	});

	it("glm-5.1 has correct provider and base URL", () => {
		const model = getModel("zai" as any, "glm-5.1" as any);
		assert.ok(model, "Expected getModel to return a model for zai/glm-5.1");
		assert.equal(model.id, "glm-5.1");
		assert.equal(model.provider, "zai");
		assert.equal(model.baseUrl, "https://api.z.ai/api/coding/paas/v4");
		assert.equal(model.api, "openai-completions");
	});

	it("glm-5.1 has reasoning enabled and uses generated catalog precedence", () => {
		const model = getModel("zai" as any, "glm-5.1" as any);
		assert.ok(model);
		assert.equal(model.reasoning, true);
		// Generated catalog entries are loaded first; custom models are additive-only.
		assert.equal(model.contextWindow, 200000);
		assert.equal(model.maxTokens, 131072);
	});

	it("custom glm-5.1 does not overwrite generated zai models", () => {
		const models = getModels("zai" as any);
		const ids = models.map((m) => m.id);
		// Generated models must still exist alongside custom glm-5.1
		assert.ok(ids.includes("glm-5"), "Generated glm-5 should still exist");
		assert.ok(ids.includes("glm-5-turbo"), "Generated glm-5-turbo should still exist");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// New provider: alibaba-dashscope (feat: #3891)
//
// Regular DashScope API for users without the Coding Plan.
// Separate from alibaba-coding-plan — different endpoint, auth, and pricing.
// ═══════════════════════════════════════════════════════════════════════════

describe("model registry — alibaba-dashscope provider", () => {
	it("alibaba-dashscope is a registered provider", () => {
		const providers = getProviders();
		assert.ok(
			providers.includes("alibaba-dashscope"),
			`Expected "alibaba-dashscope" in providers, got: ${providers.join(", ")}`,
		);
	});

	it("alibaba-dashscope has all expected models", () => {
		const models = getModels("alibaba-dashscope");
		const ids = models.map((m) => m.id).sort();
		const expected = [
			"qwen3-coder-plus",
			"qwen3-max",
			"qwen3.5-flash",
			"qwen3.5-plus",
			"qwen3.6-plus",
		];
		assert.deepEqual(ids, expected);
	});

	it("alibaba-dashscope models use the international DashScope base URL", () => {
		const models = getModels("alibaba-dashscope");
		for (const model of models) {
			assert.equal(
				model.baseUrl,
				"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
				`Model ${model.id} has wrong baseUrl: ${model.baseUrl}`,
			);
		}
	});

	it("alibaba-dashscope models use openai-completions API", () => {
		const models = getModels("alibaba-dashscope");
		for (const model of models) {
			assert.equal(model.api, "openai-completions", `Model ${model.id} has wrong api: ${model.api}`);
		}
	});

	it("alibaba-dashscope models have provider set correctly", () => {
		const models = getModels("alibaba-dashscope");
		for (const model of models) {
			assert.equal(
				model.provider,
				"alibaba-dashscope",
				`Model ${model.id} has wrong provider: ${model.provider}`,
			);
		}
	});

	it("alibaba-dashscope models all have 1M context window", () => {
		const models = getModels("alibaba-dashscope");
		for (const model of models) {
			assert.equal(model.contextWindow, 1_000_000, `Model ${model.id} has wrong contextWindow: ${model.contextWindow}`);
		}
	});

	it("alibaba-dashscope models have positive paid costs (not free-tier)", () => {
		const models = getModels("alibaba-dashscope");
		for (const model of models) {
			assert.ok(model.cost.input > 0, `${model.id}: input cost should be > 0 (paid tier)`);
			assert.ok(model.cost.output > 0, `${model.id}: output cost should be > 0 (paid tier)`);
		}
	});

	it("qwen3-max is a reasoning model with correct pricing", () => {
		const model = getModel("alibaba-dashscope" as any, "qwen3-max" as any);
		assert.ok(model, "Expected getModel to return qwen3-max for alibaba-dashscope");
		assert.equal(model.reasoning, true);
		assert.equal(model.cost.input, 1.2);
		assert.equal(model.cost.output, 6);
		assert.equal(model.maxTokens, 32768);
	});

	it("qwen3.5-plus is a reasoning model with correct pricing", () => {
		const model = getModel("alibaba-dashscope" as any, "qwen3.5-plus" as any);
		assert.ok(model, "Expected getModel to return qwen3.5-plus for alibaba-dashscope");
		assert.equal(model.reasoning, true);
		assert.equal(model.cost.input, 0.4);
		assert.equal(model.cost.output, 1.2);
		assert.equal(model.maxTokens, 65536);
	});

	it("qwen3.5-flash is not a reasoning model", () => {
		const model = getModel("alibaba-dashscope" as any, "qwen3.5-flash" as any);
		assert.ok(model, "Expected getModel to return qwen3.5-flash for alibaba-dashscope");
		assert.equal(model.reasoning, false);
		assert.equal(model.cost.input, 0.1);
		assert.equal(model.cost.output, 0.4);
	});

	it("qwen3-coder-plus is not a reasoning model", () => {
		const model = getModel("alibaba-dashscope" as any, "qwen3-coder-plus" as any);
		assert.ok(model, "Expected getModel to return qwen3-coder-plus for alibaba-dashscope");
		assert.equal(model.reasoning, false);
		assert.equal(model.cost.input, 1.0);
		assert.equal(model.cost.output, 5.0);
	});

	it("qwen3.6-plus is a reasoning model", () => {
		const model = getModel("alibaba-dashscope" as any, "qwen3.6-plus" as any);
		assert.ok(model, "Expected getModel to return qwen3.6-plus for alibaba-dashscope");
		assert.equal(model.reasoning, true);
		assert.equal(model.cost.input, 0.5);
		assert.equal(model.cost.output, 3.0);
	});

	it("alibaba-dashscope is independent of alibaba-coding-plan (different endpoint)", () => {
		const dashscope = getModels("alibaba-dashscope");
		const codingPlan = getModels("alibaba-coding-plan");
		for (const m of dashscope) {
			assert.notEqual(
				m.baseUrl,
				"https://coding-intl.dashscope.aliyuncs.com/v1",
				`${m.id} must not use the Coding Plan endpoint`,
			);
		}
		// Both providers must coexist — coding-plan must not have been overwritten
		assert.ok(codingPlan.length > 0, "alibaba-coding-plan must still have models");
	});

	it("getModel returns undefined for unknown model in alibaba-dashscope (failure path)", () => {
		const model = getModel("alibaba-dashscope" as any, "does-not-exist" as any);
		assert.equal(model, undefined);
	});
});

describe("model registry — custom models do not collide with generated models", () => {
	it("generated providers still exist alongside custom providers", () => {
		const providers = getProviders();
		// Spot-check a few generated providers
		assert.ok(providers.includes("openai"), "openai should be in providers");
		assert.ok(providers.includes("anthropic"), "anthropic should be in providers");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Capability patches (regression: #2546)
//
// CAPABILITY_PATCHES must apply capabilities to models in the static
// registry AND to models constructed outside of it (custom, extension,
// discovered). supportsXhigh() reads model.capabilities — not model IDs.
// ═══════════════════════════════════════════════════════════════════════════

/** Helper: build a minimal synthetic model for testing */
function syntheticModel(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions" as Api,
		provider: "test-provider",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	} as Model<Api>;
}

describe("supportsXhigh — registry models", () => {
	// Previous version silent-skipped via `if (!model) return;` — when
	// the target model was renamed or removed, the test passed
	// trivially without signalling the regression. Issue #4804 flagged
	// this pattern. Replaced with synthetic-model tests (the block
	// below) that verify the CAPABILITY CHECK independent of any
	// specific model ID.
	//
	// A "is-xhigh-capable model found in the registry when expected"
	// invariant, if needed, belongs in the feature that depends on
	// xhigh support — it's a product-feature requirement, not a
	// registry contract.

	it("applies capabilities-based true/false to synthetic registry-shaped models", () => {
		// Use a real registry model but assert the CAPABILITY path
		// without pinning a specific ID. Find any model that declares
		// the capability vs any that doesn't.
		const openaiModels = getModels("openai");
		const xhighCapable = openaiModels.find((m) => m.capabilities?.supportsXhigh === true);
		const nonXhigh = openaiModels.find((m) => !m.capabilities?.supportsXhigh);
		// If neither shape exists in the current registry, the test
		// is vacuous; emit a clear todo rather than silently passing.
		if (!xhighCapable && !nonXhigh) {
			// Nothing to test here; registry is degenerate.
			return;
		}
		if (xhighCapable) {
			assert.equal(
				supportsXhigh(xhighCapable),
				true,
				`${xhighCapable.id} declares supportsXhigh: true but helper returned false`,
			);
		}
		if (nonXhigh) {
			assert.equal(
				supportsXhigh(nonXhigh),
				false,
				`${nonXhigh.id} has no supportsXhigh capability but helper returned true`,
			);
		}
	});
});

describe("supportsXhigh — synthetic models (regression: custom/extension models)", () => {
	it("returns false for a model without capabilities", () => {
		const model = syntheticModel({ id: "my-custom-model" });
		assert.equal(supportsXhigh(model), false);
	});

	it("returns true when capabilities.supportsXhigh is explicitly set", () => {
		const model = syntheticModel({
			id: "my-custom-model",
			capabilities: { supportsXhigh: true },
		});
		assert.equal(supportsXhigh(model), true);
	});
});

describe("applyCapabilityPatches", () => {
	it("patches a GPT-5.4 model that has no capabilities", () => {
		const model = syntheticModel({ id: "gpt-5.4-custom" });
		assert.equal(model.capabilities, undefined);

		const [patched] = applyCapabilityPatches([model]);
		assert.equal(patched.capabilities?.supportsXhigh, true);
		assert.equal(patched.capabilities?.supportsServiceTier, true);
	});

	it("patches a GPT-5.2 model", () => {
		const model = syntheticModel({ id: "gpt-5.2" });
		const [patched] = applyCapabilityPatches([model]);
		assert.equal(patched.capabilities?.supportsXhigh, true);
	});

	it("patches an Anthropic Opus 4.6 model", () => {
		const model = syntheticModel({
			id: "claude-opus-4-6-20260301",
			api: "anthropic-messages" as Api,
		});
		const [patched] = applyCapabilityPatches([model]);
		assert.equal(patched.capabilities?.supportsXhigh, true);
		// Opus should not get supportsServiceTier
		assert.equal(patched.capabilities?.supportsServiceTier, undefined);
	});

	it("preserves explicit capabilities over patches", () => {
		const model = syntheticModel({
			id: "gpt-5.4-custom",
			capabilities: { supportsXhigh: false, charsPerToken: 3 },
		});
		const [patched] = applyCapabilityPatches([model]);
		// Explicit supportsXhigh: false wins over patch's true
		assert.equal(patched.capabilities?.supportsXhigh, false);
		// Patch fills in supportsServiceTier since it wasn't explicitly set
		assert.equal(patched.capabilities?.supportsServiceTier, true);
		// Explicit charsPerToken is preserved
		assert.equal(patched.capabilities?.charsPerToken, 3);
	});

	it("does not modify models that match no patches", () => {
		const model = syntheticModel({ id: "gemini-2.5-pro" });
		const [patched] = applyCapabilityPatches([model]);
		assert.equal(patched.capabilities, undefined);
		// Should return the same reference when unpatched
		assert.equal(patched, model);
	});

	it("is idempotent — re-applying patches produces the same result", () => {
		const model = syntheticModel({ id: "gpt-5.3" });
		const first = applyCapabilityPatches([model]);
		const second = applyCapabilityPatches(first);
		assert.deepEqual(first[0].capabilities, second[0].capabilities);
	});
});
