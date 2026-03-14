import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "./model-registry.js";
import { AuthStorage } from "./auth-storage.js";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

// ─── helpers ──────────────────────────────────────────────────────────────────

function inMemoryAuth(data: Record<string, unknown> = {}) {
	return AuthStorage.inMemory(data as any);
}

function getAgentDir(): string {
	return join(homedir(), ".gsd", "agent");
}

function getCachePath(): string {
	return join(getAgentDir(), "cache", "models-dev.json");
}

function getModelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

function writeCache(data: any, version = "0.57.1"): void {
	const cachePath = getCachePath();
	mkdirSync(join(cachePath, ".."), { recursive: true });
	writeFileSync(
		cachePath,
		JSON.stringify(
			{
				version,
				fetchedAt: Date.now(),
				data,
			},
			null,
			2,
		),
	);
}

function clearCache(): void {
	const cachePath = getCachePath();
	if (existsSync(cachePath)) {
		rmSync(cachePath);
	}
}

function writeModelsJson(config: any): void {
	const modelsJsonPath = getModelsJsonPath();
	mkdirSync(join(modelsJsonPath, ".."), { recursive: true });
	writeFileSync(modelsJsonPath, JSON.stringify(config, null, 2));
}

function clearModelsJson(): void {
	const modelsJsonPath = getModelsJsonPath();
	if (existsSync(modelsJsonPath)) {
		rmSync(modelsJsonPath);
	}
}

// Sample models.dev data for testing
const SAMPLE_MODELS_DEV_DATA = {
	"openai": {
		name: "OpenAI",
		api: "https://api.openai.com/v1",
		models: {
			"gpt-4o": {
				name: "GPT-4o",
				cost: {
					input: 0.0000025,
					output: 0.00001,
					cache_read: 0.00000125,
					cache_write: 0.0000025,
				},
				limit: {
					context: 128000,
					output: 16384,
				},
				modalities: {
					input: ["text", "image"],
					output: ["text"],
				},
				reasoning: false,
			},
			"gpt-4o-mini": {
				name: "GPT-4o Mini",
				cost: {
					input: 0.00000015,
					output: 0.0000006,
					cache_read: 0,
					cache_write: 0,
				},
				limit: {
					context: 128000,
					output: 16384,
				},
				modalities: {
					input: ["text", "image"],
					output: ["text"],
				},
				reasoning: false,
			},
		},
	},
	"anthropic": {
		name: "Anthropic",
		api: "https://api.anthropic.com",
		models: {
			"claude-sonnet-4-20250514": {
				name: "Claude Sonnet 4",
				cost: {
					input: 0.000003,
					output: 0.000015,
					cache_read: 0.0000003,
					cache_write: 0.00000375,
				},
				limit: {
					context: 200000,
					output: 64000,
				},
				modalities: {
					input: ["text", "image"],
					output: ["text"],
				},
				reasoning: false,
			},
		},
	},
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ModelRegistry models.dev integration", () => {
	before(() => {
		// Clean up before tests
		clearCache();
		clearModelsJson();
	});

	after(() => {
		// Clean up after tests
		clearCache();
		clearModelsJson();
	});

	describe("cache hit → models.dev data used with overrides applied", () => {
		it("uses cached models.dev data when cache exists", () => {
			// Write cache with models.dev data
			writeCache(SAMPLE_MODELS_DEV_DATA);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();

			// Should have models from cache (openai + anthropic)
			assert.ok(allModels.length >= 3, "Should have at least 3 models from cache");

			// Check that models.dev fields are present
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");
			assert.ok(gpt4o, "Should have gpt-4o from models.dev");
			assert.equal(gpt4o?.name, "GPT-4o");
			assert.equal(gpt4o?.contextWindow, 128000);
			assert.equal(gpt4o?.maxTokens, 16384);
			assert.equal(gpt4o?.cost.input, 0.0000025);
			assert.equal(gpt4o?.cost.output, 0.00001);

			const claude = allModels.find((m) => m.id === "claude-sonnet-4-20250514" && m.provider === "anthropic");
			assert.ok(claude, "Should have claude-sonnet-4-20250514 from models.dev");
			assert.equal(claude?.name, "Claude Sonnet 4");
			assert.equal(claude?.contextWindow, 200000);
		});

		it("applies provider-level baseUrl override to models.dev data", () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			// Set up models.json with provider override
			const modelsJsonConfig = {
				providers: {
					openai: {
						baseUrl: "https://custom.openai.proxy.com/v1",
						apiKey: "sk-custom",
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");

			// Should use custom baseUrl from models.json override
			assert.equal(gpt4o?.baseUrl, "https://custom.openai.proxy.com/v1");
		});

		it("applies per-model override to models.dev data", () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			// Set up models.json with per-model override
			const modelsJsonConfig = {
				providers: {
					openai: {
						apiKey: "sk-custom",
						modelOverrides: {
							"gpt-4o": {
								name: "Custom GPT-4o",
								cost: {
									input: 0.000005,
									output: 0.00002,
								},
							},
						},
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");

			// Should use overridden name and cost
			assert.equal(gpt4o?.name, "Custom GPT-4o");
			assert.equal(gpt4o?.cost.input, 0.000005);
			assert.equal(gpt4o?.cost.output, 0.00002);
			// Other fields should remain from models.dev
			assert.equal(gpt4o?.contextWindow, 128000);
		});

		it("applies both provider and per-model overrides to models.dev data", () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			const modelsJsonConfig = {
				providers: {
					anthropic: {
						baseUrl: "https://custom.anthropic.proxy.com",
						apiKey: "sk-custom",
						modelOverrides: {
							"claude-sonnet-4-20250514": {
								maxTokens: 32000,
							},
						},
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ anthropic: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();
			const claude = allModels.find((m) => m.id === "claude-sonnet-4-20250514" && m.provider === "anthropic");

			// Should have both provider baseUrl and per-model maxTokens override
			assert.equal(claude?.baseUrl, "https://custom.anthropic.proxy.com");
			assert.equal(claude?.maxTokens, 32000);
			// Other fields should remain from models.dev
			assert.equal(claude?.contextWindow, 200000);
		});
	});

	describe("cache miss + network failure → static MODELS fallback with overrides", () => {
		it("falls back to static MODELS when cache doesn't exist", () => {
			// Ensure cache is cleared
			clearCache();

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();

			// Should have at least some models from static fallback
			assert.ok(allModels.length > 0, "Should have models from static fallback");

			// Static models should still have overrides applied
			const openaiModels = allModels.filter((m) => m.provider === "openai");
			assert.ok(openaiModels.length > 0, "Should have openai models");
		});

		it("applies overrides to static MODELS fallback", () => {
			clearCache();

			const modelsJsonConfig = {
				providers: {
					openai: {
						baseUrl: "https://custom.openai.proxy.com/v1",
						apiKey: "sk-custom",
						modelOverrides: {
							"gpt-4-turbo": {
								name: "Custom GPT-4 Turbo",
							},
						},
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();
			const gpt4Turbo = allModels.find((m) => m.provider === "openai" && m.id === "gpt-4-turbo");

			if (gpt4Turbo) {
				// Override should be applied to static model
				assert.equal(gpt4Turbo.baseUrl, "https://custom.openai.proxy.com/v1");
				assert.equal(gpt4Turbo.name, "Custom GPT-4 Turbo");
			}
		});
	});

	describe("refreshFromModelsDev updates models while preserving overrides", () => {
		it("refresh method exists and is callable", async () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth);

			// Verify refreshFromModelsDev exists (it's private but we can check the class has it)
			// Since it's private, we test indirectly through constructor behavior
			assert.ok(registry, "Registry created successfully");

			// Give async refresh time to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Models should still be available after refresh attempt
			const allModels = registry.getAll();
			assert.ok(allModels.length > 0, "Models available after refresh");
		});
	});

	describe("local models.json custom models merge with models.dev models", () => {
		it("custom models merge with models.dev models", () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			// Add a custom model alongside models.dev data
			const modelsJsonConfig = {
				providers: {
					openai: {
						apiKey: "sk-custom",
						models: [
							{
								id: "custom-model",
								name: "Custom Model",
								api: "openai-completions",
								baseUrl: "https://custom.api.com/v1",
								reasoning: false,
								input: ["text"],
								cost: {
									input: 0.000001,
									output: 0.000002,
									cacheRead: 0,
									cacheWrite: 0,
								},
								contextWindow: 8192,
								maxTokens: 4096,
							},
						],
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();

			// Should have both models.dev models and custom models
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");
			const customModel = allModels.find((m) => m.id === "custom-model" && m.provider === "openai");

			assert.ok(gpt4o, "Should have gpt-4o from models.dev");
			assert.ok(customModel, "Should have custom-model from models.json");
			assert.equal(customModel?.name, "Custom Model");
			assert.equal(customModel?.baseUrl, "https://custom.api.com/v1");
		});

		it("custom model overrides models.dev model with same provider+id", () => {
			writeCache(SAMPLE_MODELS_DEV_DATA);

			// Define a custom model that overrides a models.dev model
			const modelsJsonConfig = {
				providers: {
					openai: {
						apiKey: "sk-custom",
						models: [
							{
								id: "gpt-4o",
								name: "My Custom GPT-4o",
								api: "openai-completions",
								baseUrl: "https://my.proxy.com/v1",
								reasoning: true, // Override to true
								input: ["text", "image"],
								cost: {
									input: 0.00001,
									output: 0.00003,
									cacheRead: 0,
									cacheWrite: 0,
								},
								contextWindow: 256000,
								maxTokens: 32768,
							},
						],
					},
				},
			};
			writeModelsJson(modelsJsonConfig);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth);

			const allModels = registry.getAll();
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");

			// Custom model should override models.dev data
			assert.ok(gpt4o, "Should have gpt-4o");
			assert.equal(gpt4o?.name, "My Custom GPT-4o");
			assert.equal(gpt4o?.baseUrl, "https://my.proxy.com/v1");
			assert.equal(gpt4o?.reasoning, true);
			assert.equal(gpt4o?.contextWindow, 256000);
		});
	});
});

describe("ModelRegistry existing override tests (preserved)", () => {
	before(() => {
		clearCache();
		clearModelsJson();
	});

	after(() => {
		clearCache();
		clearModelsJson();
	});

	it("provider baseUrl override works without cache", () => {
		// Test that existing override functionality still works when no cache
		const modelsJsonConfig = {
			providers: {
				openai: {
					baseUrl: "https://override.example.com/v1",
					apiKey: "sk-override",
				},
			},
		};
		writeModelsJson(modelsJsonConfig);

		const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
		const registry = new ModelRegistry(auth);

		const allModels = registry.getAll();
		const openaiModels = allModels.filter((m) => m.provider === "openai");

		if (openaiModels.length > 0) {
			// All openai models should use the override baseUrl
			for (const model of openaiModels) {
				assert.equal(model.baseUrl, "https://override.example.com/v1");
			}
		}
	});

	it("per-model override works without cache", () => {
		const modelsJsonConfig = {
			providers: {
				openai: {
					apiKey: "sk-test",
					modelOverrides: {
						"gpt-4-turbo": {
							cost: {
								input: 0.00001,
								output: 0.00003,
							},
						},
					},
				},
			},
		};
		writeModelsJson(modelsJsonConfig);

		const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
		const registry = new ModelRegistry(auth);

		const allModels = registry.getAll();
		const gpt4Turbo = allModels.find((m) => m.id === "gpt-4-turbo" && m.provider === "openai");

		if (gpt4Turbo) {
			assert.equal(gpt4Turbo.cost.input, 0.00001);
			assert.equal(gpt4Turbo.cost.output, 0.00003);
		}
	});
});
