import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviders, getModels, getModel } from "./models.js";

// ═══════════════════════════════════════════════════════════════════════════
// Custom provider preservation (regression: #2339)
//
// Custom providers (like alibaba-coding-plan) are manually maintained and
// NOT sourced from models.dev. They must survive models.generated.ts
// regeneration by living in models.custom.ts.
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
		// GeneratedProvider type doesn't include it until models.custom.ts is merged.
		const model = getModel("alibaba-coding-plan" as any, "qwen3.5-plus" as any);
		assert.ok(model, "Expected getModel to return a model for alibaba-coding-plan/qwen3.5-plus");
		assert.equal(model.id, "qwen3.5-plus");
		assert.equal(model.provider, "alibaba-coding-plan");
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
