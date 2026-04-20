import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODELS, getModel, getModels, getProviders } from "./models/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// Regression: qwen/qwen3.6-plus missing from OpenRouter (issue #3582)
// ═══════════════════════════════════════════════════════════════════════════

describe("regression #3582 — qwen/qwen3.6-plus available via openrouter", () => {
	it("qwen/qwen3.6-plus exists in MODELS['openrouter']", () => {
		const model = MODELS["openrouter"]["qwen/qwen3.6-plus" as keyof (typeof MODELS)["openrouter"]];
		assert.ok(model, "qwen/qwen3.6-plus must be present in MODELS.openrouter");
	});

	it("qwen/qwen3.6-plus is accessible via getModel()", () => {
		const model = getModel("openrouter", "qwen/qwen3.6-plus" as any);
		assert.ok(model, "getModel('openrouter', 'qwen/qwen3.6-plus') must return a model");
	});

	it("qwen/qwen3.6-plus has id matching its registry key", () => {
		const model = getModel("openrouter", "qwen/qwen3.6-plus" as any);
		assert.equal(model.id, "qwen/qwen3.6-plus");
	});

	it("qwen/qwen3.6-plus has provider set to openrouter", () => {
		const model = getModel("openrouter", "qwen/qwen3.6-plus" as any);
		assert.equal(model.provider, "openrouter");
	});

	it("qwen/qwen3.6-plus has reasoning enabled", () => {
		const model = getModel("openrouter", "qwen/qwen3.6-plus" as any);
		assert.equal(model.reasoning, true, "Qwen3.6 Plus is a reasoning model");
	});

	it("qwen/qwen3.6-plus has 1M context window", () => {
		const model = getModel("openrouter", "qwen/qwen3.6-plus" as any);
		assert.equal(model.contextWindow, 1_000_000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: z-ai/glm-5.1 missing from OpenRouter (issue #4069)
// ═══════════════════════════════════════════════════════════════════════════

describe("regression #4069 — z-ai/glm-5.1 available via openrouter", () => {
	it("z-ai/glm-5.1 exists in MODELS['openrouter']", () => {
		const model = MODELS["openrouter"]["z-ai/glm-5.1" as keyof (typeof MODELS)["openrouter"]];
		assert.ok(model, "z-ai/glm-5.1 must be present in MODELS.openrouter");
	});

	it("z-ai/glm-5.1 is accessible via getModel()", () => {
		const model = getModel("openrouter", "z-ai/glm-5.1" as any);
		assert.ok(model, "getModel('openrouter', 'z-ai/glm-5.1') must return a model");
	});

	it("z-ai/glm-5.1 has id matching its registry key", () => {
		const model = getModel("openrouter", "z-ai/glm-5.1" as any);
		assert.equal(model.id, "z-ai/glm-5.1");
	});

	it("z-ai/glm-5.1 has provider set to openrouter", () => {
		const model = getModel("openrouter", "z-ai/glm-5.1" as any);
		assert.equal(model.provider, "openrouter");
	});

	it("z-ai/glm-5.1 has a positive context window", () => {
		const model = getModel("openrouter", "z-ai/glm-5.1" as any);
		assert.ok(model.contextWindow > 0);
	});

	it("z-ai/glm-5.1 uses the OpenRouter base URL", () => {
		const model = getModel("openrouter", "z-ai/glm-5.1" as any);
		assert.equal(model.baseUrl, "https://openrouter.ai/api/v1");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Structural invariants — every model in MODELS must be well-formed
// ═══════════════════════════════════════════════════════════════════════════

describe("MODELS structural invariants", () => {
	type ModelEntry = { providerKey: string; modelKey: string; model: Record<string, unknown> };

	function allModels(): ModelEntry[] {
		const entries: ModelEntry[] = [];
		for (const [providerKey, providerModels] of Object.entries(MODELS)) {
			for (const [modelKey, model] of Object.entries(providerModels)) {
				entries.push({ providerKey, modelKey, model: model as Record<string, unknown> });
			}
		}
		return entries;
	}

	it("every model's id field matches its key in MODELS", () => {
		const mismatches: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (model["id"] !== modelKey) {
				mismatches.push(`${providerKey}/${modelKey}: id="${model["id"]}"`);
			}
		}
		assert.deepEqual(mismatches, [], `Models where 'id' doesn't match registry key:\n  ${mismatches.join("\n  ")}`);
	});

	it("every model's provider field matches its parent provider key", () => {
		const mismatches: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (model["provider"] !== providerKey) {
				mismatches.push(`${providerKey}/${modelKey}: provider="${model["provider"]}"`);
			}
		}
		assert.deepEqual(mismatches, [], `Models where 'provider' doesn't match parent key:\n  ${mismatches.join("\n  ")}`);
	});

	it("every model has a non-empty string name", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (typeof model["name"] !== "string" || model["name"].trim() === "") {
				invalid.push(`${providerKey}/${modelKey}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with missing or empty name:\n  ${invalid.join("\n  ")}`);
	});

	it("every model has a non-empty string api", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (typeof model["api"] !== "string" || model["api"].trim() === "") {
				invalid.push(`${providerKey}/${modelKey}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with missing or empty api:\n  ${invalid.join("\n  ")}`);
	});

	it("every model's baseUrl starts with https:// (or is empty for azure-openai-responses)", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (providerKey === "azure-openai-responses") continue;
			const url = model["baseUrl"];
			if (typeof url !== "string" || !url.startsWith("https://")) {
				invalid.push(`${providerKey}/${modelKey}: baseUrl="${url}"`);
			}
		}
		assert.deepEqual(invalid, [], `Models with missing or non-HTTPS baseUrl:\n  ${invalid.join("\n  ")}`);
	});

	it("azure-openai-responses models have an empty baseUrl (runtime-configured)", () => {
		const models = getModels("azure-openai-responses");
		assert.ok(models.length > 0, "azure-openai-responses must have at least one model");
		for (const model of models) {
			assert.equal(model.baseUrl, "", `azure-openai-responses/${model.id} should have empty baseUrl`);
		}
	});

	it("every model has a boolean reasoning field", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (typeof model["reasoning"] !== "boolean") {
				invalid.push(`${providerKey}/${modelKey}: reasoning=${model["reasoning"]}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with non-boolean reasoning:\n  ${invalid.join("\n  ")}`);
	});

	it("every model has a non-empty input array", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			const input = model["input"];
			if (!Array.isArray(input) || input.length === 0) {
				invalid.push(`${providerKey}/${modelKey}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with missing or empty input array:\n  ${invalid.join("\n  ")}`);
	});

	it("every model has a positive contextWindow", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			const cw = model["contextWindow"];
			if (typeof cw !== "number" || cw <= 0 || !Number.isFinite(cw)) {
				invalid.push(`${providerKey}/${modelKey}: contextWindow=${cw}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with invalid contextWindow:\n  ${invalid.join("\n  ")}`);
	});

	it("every model has a positive maxTokens", () => {
		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			const mt = model["maxTokens"];
			if (typeof mt !== "number" || mt <= 0 || !Number.isFinite(mt)) {
				invalid.push(`${providerKey}/${modelKey}: maxTokens=${mt}`);
			}
		}
		assert.deepEqual(invalid, [], `Models with invalid maxTokens:\n  ${invalid.join("\n  ")}`);
	});

	it("every model's maxTokens does not exceed contextWindow", () => {
		const knownExceptions = new Set([
			"openrouter/meta-llama/llama-3-8b-instruct",
			"openrouter/nex-agi/deepseek-v3.1-nex-n1",
			"openrouter/openai/gpt-3.5-turbo-0613",
			"openrouter/z-ai/glm-5",
		]);

		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (knownExceptions.has(`${providerKey}/${modelKey}`)) continue;
			const cw = model["contextWindow"] as number;
			const mt = model["maxTokens"] as number;
			if (typeof cw === "number" && typeof mt === "number" && mt > cw) {
				invalid.push(`${providerKey}/${modelKey}: maxTokens(${mt}) > contextWindow(${cw})`);
			}
		}
		assert.deepEqual(invalid, [], `Models where maxTokens exceeds contextWindow:\n  ${invalid.join("\n  ")}`);
	});

	it("every model has a cost object with non-negative numeric fields", () => {
		const knownNegativeCostModels = new Set([
			"openrouter/openrouter/auto",
		]);

		const invalid: string[] = [];
		for (const { providerKey, modelKey, model } of allModels()) {
			if (knownNegativeCostModels.has(`${providerKey}/${modelKey}`)) continue;
			const cost = model["cost"] as Record<string, unknown> | undefined;
			if (!cost || typeof cost !== "object") {
				invalid.push(`${providerKey}/${modelKey}: missing cost object`);
				continue;
			}
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const val = cost[field];
				if (typeof val !== "number" || val < 0 || !Number.isFinite(val)) {
					invalid.push(`${providerKey}/${modelKey}: cost.${field}=${val}`);
				}
			}
		}
		assert.deepEqual(invalid, [], `Models with invalid cost fields:\n  ${invalid.join("\n  ")}`);
	});

	it("no provider has duplicate model IDs", () => {
		const duplicates: string[] = [];
		for (const [providerKey, providerModels] of Object.entries(MODELS)) {
			const ids = Object.values(providerModels).map((m) => (m as Record<string, unknown>)["id"] as string);
			const seen = new Set<string>();
			for (const id of ids) {
				if (seen.has(id)) duplicates.push(`${providerKey}/${id}`);
				seen.add(id);
			}
		}
		assert.deepEqual(duplicates, [], `Duplicate model IDs within a provider:\n  ${duplicates.join("\n  ")}`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Registry shape
// ═══════════════════════════════════════════════════════════════════════════

describe("MODELS registry shape", () => {
	it("has exactly 23 providers", () => {
		const count = Object.keys(MODELS).length;
		assert.equal(count, 23, `Expected 23 providers, got ${count}: ${Object.keys(MODELS).join(", ")}`);
	});

	it("has at least 200 models in total (sanity check)", () => {
		let total = 0;
		for (const providerModels of Object.values(MODELS)) {
			total += Object.keys(providerModels).length;
		}
		assert.ok(total >= 200, `Registry has only ${total} models — unexpectedly small`);
	});

	it("all 23 expected providers are present", () => {
		const expected = [
			"amazon-bedrock",
			"anthropic",
			"azure-openai-responses",
			"cerebras",
			"github-copilot",
			"google",
			"google-antigravity",
			"google-gemini-cli",
			"google-vertex",
			"groq",
			"huggingface",
			"kimi-coding",
			"minimax",
			"minimax-cn",
			"mistral",
			"openai",
			"openai-codex",
			"opencode",
			"opencode-go",
			"openrouter",
			"vercel-ai-gateway",
			"xai",
			"zai",
		];
		const actual = Object.keys(MODELS).sort();
		assert.deepEqual(actual, expected.sort());
	});

	it("getProviders() returns all generated providers", () => {
		const providers = getProviders();
		for (const p of Object.keys(MODELS)) {
			assert.ok(providers.includes(p as any), `getProviders() missing generated provider: ${p}`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Removed models must not exist
// ═══════════════════════════════════════════════════════════════════════════

describe("removed models are absent from the registry", () => {
	const removedModels: Array<{ provider: string; id: string }> = [
		{ provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
		{ provider: "openrouter", id: "anthropic/claude-3.5-sonnet-20240620" },
		{ provider: "openrouter", id: "mistralai/mistral-small-24b-instruct-2501" },
		{ provider: "openrouter", id: "mistralai/mistral-small-3.1-24b-instruct:free" },
		{ provider: "openrouter", id: "qwen/qwen3-4b:free" },
		{ provider: "openrouter", id: "stepfun/step-3.5-flash:free" },
		{ provider: "openrouter", id: "x-ai/grok-4.20-beta" },
		{ provider: "openrouter", id: "arcee-ai/trinity-mini:free" },
		{ provider: "openrouter", id: "google/gemini-3-pro-preview" },
		{ provider: "openrouter", id: "kwaipilot/kat-coder-pro" },
		{ provider: "openrouter", id: "meituan/longcat-flash-thinking" },
		{ provider: "vercel-ai-gateway", id: "xai/grok-2-vision" },
		{ provider: "anthropic", id: "claude-3-7-sonnet-latest" },
		// Groq decommissioned models — issue #4257
		{ provider: "groq", id: "llama3-70b-8192" },
		{ provider: "groq", id: "llama3-8b-8192" },
		{ provider: "groq", id: "deepseek-r1-distill-llama-70b" },
		{ provider: "groq", id: "gemma2-9b-it" },
		{ provider: "groq", id: "meta-llama/llama-4-maverick-17b-128e-instruct" },
		{ provider: "groq", id: "mistral-saba-24b" },
		{ provider: "groq", id: "moonshotai/kimi-k2-instruct" },
		{ provider: "groq", id: "moonshotai/kimi-k2-instruct-0905" },
		{ provider: "groq", id: "qwen-qwq-32b" },
	];

	for (const { provider, id } of removedModels) {
		it(`${provider}/${id} has been removed`, () => {
			const model = getModel(provider as any, id as any);
			assert.equal(model, undefined, `${provider}/${id} should be removed but is still present`);
		});
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Spot-checks for notable models added in this regeneration
// ═══════════════════════════════════════════════════════════════════════════

describe("spot-checks for models added in this regeneration", () => {
	const newModels: Array<{ provider: string; id: string; reasoning?: boolean }> = [
		{ provider: "openrouter", id: "z-ai/glm-5.1" },
		{ provider: "openrouter", id: "z-ai/glm-5v-turbo" },
		{ provider: "openrouter", id: "google/gemma-4-31b-it" },
		{ provider: "openrouter", id: "google/gemma-4-26b-a4b-it" },
		{ provider: "openrouter", id: "arcee-ai/trinity-large-thinking", reasoning: true },
		{ provider: "openrouter", id: "openai/gpt-audio" },
		{ provider: "openrouter", id: "anthropic/claude-opus-4.6-fast" },
		{ provider: "openrouter", id: "anthropic/claude-opus-4.7" },
		{ provider: "amazon-bedrock", id: "anthropic.claude-opus-4-7" },
		{ provider: "amazon-bedrock", id: "us.anthropic.claude-opus-4-7" },
		{ provider: "amazon-bedrock", id: "eu.anthropic.claude-opus-4-7" },
		{ provider: "amazon-bedrock", id: "global.anthropic.claude-opus-4-7" },
		{ provider: "google-antigravity", id: "claude-opus-4-7-thinking", reasoning: true },
		{ provider: "openrouter", id: "qwen/qwen3.6-plus" },
		{ provider: "groq", id: "groq/compound" },
		{ provider: "groq", id: "groq/compound-mini" },
		{ provider: "huggingface", id: "zai-org/GLM-5.1" },
		{ provider: "openai", id: "gpt-5.3-chat-latest" },
		{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
		{ provider: "mistral", id: "mistral-small-2603" },
		{ provider: "zai", id: "glm-5.1" },
	];

	for (const { provider, id, reasoning } of newModels) {
		it(`${provider}/${id} is present in the registry`, () => {
			const model = getModel(provider as any, id as any);
			assert.ok(model, `Expected ${provider}/${id} to be present after regeneration`);
			assert.equal(model.id, id);
			assert.equal(model.provider, provider);
			if (reasoning !== undefined) {
				assert.equal(model.reasoning, reasoning, `${id} reasoning should be ${reasoning}`);
			}
		});
	}
});
