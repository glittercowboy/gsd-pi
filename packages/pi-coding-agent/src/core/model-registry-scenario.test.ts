import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { ModelRegistry } from "./model-registry.js";
import { AuthStorage } from "./auth-storage.js";
import { writeCache } from "@gsd/pi-ai";

// Sample models.dev data for testing
const SAMPLE_MODELS_DEV_DATA = {
	anthropic: {
		name: "Anthropic",
		api: "https://api.anthropic.com",
		env: ["ANTHROPIC_API_KEY"],
		id: "anthropic",
		models: {
			"claude-sonnet-4-20250514": {
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				release_date: "2025-05-14",
				attachment: true,
				reasoning: false,
				tool_call: true,
				limit: {
					context: 200000,
					output: 64000,
				},
				cost: {
					input: 0.000003,
					output: 0.000015,
					cache_read: 0.0000003,
					cache_write: 0.00000375,
				},
				modalities: {
					input: ["text", "image"] as const,
					output: ["text"] as const,
				},
			},
			"claude-3-7-sonnet-20250219": {
				id: "claude-3-7-sonnet-20250219",
				name: "Claude 3.7 Sonnet",
				release_date: "2025-02-19",
				attachment: true,
				reasoning: true,
				tool_call: true,
				limit: {
					context: 200000,
					output: 128000,
				},
				cost: {
					input: 3,
					output: 15,
					cache_read: 0.3,
					cache_write: 3.75,
				},
				modalities: {
					input: ["text", "image"] as const,
					output: ["text"] as const,
				},
			},
		},
	},
	openai: {
		name: "OpenAI",
		api: "https://api.openai.com/v1",
		env: ["OPENAI_API_KEY"],
		id: "openai",
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				name: "GPT-4o",
				release_date: "2024-05-13",
				attachment: true,
				reasoning: false,
				tool_call: true,
				limit: {
					context: 128000,
					output: 16384,
				},
				cost: {
					input: 0.0000025,
					output: 0.00001,
					cache_read: 0.00000125,
					cache_write: 0.0000025,
				},
				modalities: {
					input: ["text", "image"] as const,
					output: ["text"] as const,
				},
			},
			"gpt-4o-mini": {
				id: "gpt-4o-mini",
				name: "GPT-4o Mini",
				release_date: "2024-07-18",
				attachment: true,
				reasoning: false,
				tool_call: true,
				limit: {
					context: 128000,
					output: 16384,
				},
				cost: {
					input: 0.00000015,
					output: 0.0000006,
					cache_read: 0,
					cache_write: 0,
				},
				modalities: {
					input: ["text", "image"] as const,
					output: ["text"] as const,
				},
			},
		},
	},
};

const CURRENT_VERSION = "0.57.1";
const OLD_VERSION = "0.57.0";

// Helper to create in-memory auth
function inMemoryAuth(data: Record<string, unknown> = {}) {
	return AuthStorage.inMemory(data as any);
}

describe("ModelRegistry production-like scenarios", () => {
	let tempDir: string;
	let cachePath: string;
	let modelsJsonPath: string;

	before(() => {
		// Create isolated temp directory for each test suite
		tempDir = mkdtempSync(join(tmpdir(), "model-registry-scenario-"));
		cachePath = join(tempDir, "cache", "models-dev.json");
		modelsJsonPath = join(tempDir, "models.json");
	});

	after(() => {
		// Clean up temp directory after all tests
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe("fresh install scenario - no cache exists", () => {
		it("falls back to snapshot or static MODELS when cache doesn't exist", () => {
			// Fresh install: no cache file exists
			// Registry should still return models via snapshot or static fallback

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();

			// Should have at least some models from fallback (snapshot or static)
			assert.ok(allModels.length > 0, "Should have models from snapshot/static fallback");

			// Verify models are usable (have required fields)
			const firstModel = allModels[0];
			assert.ok(firstModel.id, "Model should have id");
			assert.ok(firstModel.provider, "Model should have provider");
			assert.ok(firstModel.name, "Model should have name");
		});
	});

	describe("cache hit scenario - valid cache with current version", () => {
		it("uses cached models.dev data when cache is valid", () => {
			// Write valid cache with current version and fresh timestamp
			writeCache(SAMPLE_MODELS_DEV_DATA as any, CURRENT_VERSION, cachePath);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();

			// Verify models.dev data is used (should have models from cache)
			assert.ok(allModels.length >= 4, `Should have at least 4 models from cache, got ${allModels.length}`);

			// Check specific models from cache are present
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");
			assert.ok(gpt4o, "Should have gpt-4o from cached models.dev data");
			assert.equal(gpt4o?.name, "GPT-4o", "Model name should match cache");
			assert.equal(gpt4o?.contextWindow, 128000, "contextWindow should match cache");
			assert.equal(gpt4o?.maxTokens, 16384, "maxTokens should match cache");
			assert.equal(gpt4o?.cost.input, 0.0000025, "cost.input should match cache");

			const claude = allModels.find(
				(m) => m.id === "claude-sonnet-4-20250514" && m.provider === "anthropic",
			);
			assert.ok(claude, "Should have claude-sonnet-4-20250514 from cached models.dev data");
			assert.equal(claude?.name, "Claude Sonnet 4", "Model name should match cache");
			assert.equal(claude?.contextWindow, 200000, "contextWindow should match cache");
		});

		it("preserves models.dev data fields in cache hit", () => {
			// Verify all models.dev specific fields are preserved
			writeCache(SAMPLE_MODELS_DEV_DATA as any, CURRENT_VERSION, cachePath);

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();
			const gpt4oMini = allModels.find((m) => m.id === "gpt-4o-mini" && m.provider === "openai");

			assert.ok(gpt4oMini, "Should have gpt-4o-mini from cache");
			// These fields come from models.dev data structure
			assert.equal(gpt4oMini?.cost.input, 0.00000015, "Should have models.dev cost data");
			assert.equal(gpt4oMini?.cost.output, 0.0000006, "Should have models.dev cost data");
		});
	});

	describe("stale cache scenario - cache older than 12h TTL", () => {
		it("gracefully handles stale cache (fetchedAt > 12h ago)", () => {
			// Write cache with old timestamp (simulating > 12h old cache)
			const oldCache = {
				version: CURRENT_VERSION,
				fetchedAt: Date.now() - 24 * 60 * 60 * 1000, // 24 hours ago
				data: SAMPLE_MODELS_DEV_DATA,
			};
			writeFileSync(cachePath, JSON.stringify(oldCache));

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();

			// Stale cache should still be used gracefully (fallback behavior)
			// The registry should return models even with stale cache
			assert.ok(allModels.length > 0, "Should return models even with stale cache");

			// Stale cache data should still be usable
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");
			assert.ok(gpt4o, "Should have models from stale cache");
		});
	});

	describe("version mismatch scenario - cache with old version string", () => {
		it("handles version-triggered refresh when cache version doesn't match", () => {
			// Write cache with old version (simulating app upgrade scenario)
			const oldVersionCache = {
				version: OLD_VERSION,
				fetchedAt: Date.now(),
				data: SAMPLE_MODELS_DEV_DATA,
			};
			writeFileSync(cachePath, JSON.stringify(oldVersionCache));

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();

			// Version mismatch should still return models (stale cache fallback)
			assert.ok(allModels.length > 0, "Should return models despite version mismatch");

			// Should still get data from stale cache as fallback
			assert.ok(allModels.length >= 4, "Should have models from stale cache fallback");
		});
	});

	describe("offline fallback scenario - stale cache with network failure", () => {
		it("uses stale cache when network is unavailable", () => {
			// Write stale cache (old version + old timestamp)
			const staleCache = {
				version: OLD_VERSION,
				fetchedAt: Date.now() - 24 * 60 * 60 * 1000, // 24 hours ago
				data: SAMPLE_MODELS_DEV_DATA,
			};
			writeFileSync(cachePath, JSON.stringify(staleCache));

			// Note: ModelRegistry constructor fires async refresh which will fail
			// (network unreachable or invalid URL), but stale cache should still be used

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-test" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			// Give async refresh time to attempt and fail
			// Using longer delay to ensure network timeout completes
			const waitForRefresh = () => new Promise((resolve) => setTimeout(resolve, 500));

			// Check models immediately - stale cache should be used synchronously
			const allModelsInitial = registry.getAll();
			assert.ok(allModelsInitial.length > 0, "Should have models from stale cache initially");

			// After refresh attempt (which fails), stale cache should still be available
			waitForRefresh();
			const allModelsAfterRefresh = registry.getAll();
			assert.ok(
				allModelsAfterRefresh.length > 0,
				"Should still have models after failed network refresh",
			);
		});
	});

	describe("override application scenario - models.json overrides applied", () => {
		it("applies provider-level baseUrl override to cached models", () => {
			// Write valid cache
			writeCache(SAMPLE_MODELS_DEV_DATA as any, CURRENT_VERSION, cachePath);

			// Write models.json with provider-level override
			const modelsConfig = {
				providers: {
					openai: {
						baseUrl: "https://custom.openai.proxy.com/v1",
						apiKey: "sk-custom",
					},
				},
			};
			writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig));

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");

			// Provider-level baseUrl override should be applied
			assert.equal(
				gpt4o?.baseUrl,
				"https://custom.openai.proxy.com/v1",
				"Provider baseUrl override should be applied",
			);

			// Other fields should remain from models.dev
			assert.equal(gpt4o?.name, "GPT-4o", "Model name should remain from models.dev");
			assert.equal(gpt4o?.contextWindow, 128000, "contextWindow should remain from models.dev");
		});

		it("applies per-model override to cached models.dev data", () => {
			// Write valid cache
			writeCache(SAMPLE_MODELS_DEV_DATA as any, CURRENT_VERSION, cachePath);

			// Write models.json with per-model override
			const modelsConfig = {
				providers: {
					openai: {
						apiKey: "sk-custom",
						modelOverrides: {
							"gpt-4o": {
								name: "Custom GPT-4o Override",
								cost: {
									input: 0.000005,
									output: 0.00002,
								},
								maxTokens: 32768,
							},
						},
					},
				},
			};
			writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig));

			const auth = inMemoryAuth({ openai: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();
			const gpt4o = allModels.find((m) => m.id === "gpt-4o" && m.provider === "openai");

			// Per-model overrides should be applied
			assert.equal(gpt4o?.name, "Custom GPT-4o Override", "Per-model name override should apply");
			assert.equal(gpt4o?.cost.input, 0.000005, "Per-model cost.input override should apply");
			assert.equal(gpt4o?.cost.output, 0.00002, "Per-model cost.output override should apply");
			assert.equal(gpt4o?.maxTokens, 32768, "Per-model maxTokens override should apply");

			// Non-overridden fields should remain from models.dev
			assert.equal(gpt4o?.contextWindow, 128000, "Non-overridden contextWindow should remain");
		});

		it("applies both provider and per-model overrides together", () => {
			// Write valid cache
			writeCache(SAMPLE_MODELS_DEV_DATA as any, CURRENT_VERSION, cachePath);

			// Write models.json with both provider and per-model overrides
			const modelsConfig = {
				providers: {
					anthropic: {
						baseUrl: "https://custom.anthropic.proxy.com",
						apiKey: "sk-custom",
						modelOverrides: {
							"claude-sonnet-4-20250514": {
								name: "Custom Claude Sonnet",
								reasoning: true, // Override from false to true
								cost: {
									input: 0.000006,
									output: 0.00003,
								},
							},
						},
					},
				},
			};
			writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig));

			const auth = inMemoryAuth({ anthropic: { type: "api_key", key: "sk-stored" } });
			const registry = new ModelRegistry(auth, modelsJsonPath, cachePath);

			const allModels = registry.getAll();
			const claude = allModels.find(
				(m) => m.id === "claude-sonnet-4-20250514" && m.provider === "anthropic",
			);

			// Provider-level override
			assert.equal(
				claude?.baseUrl,
				"https://custom.anthropic.proxy.com",
				"Provider baseUrl override should apply",
			);

			// Per-model overrides
			assert.equal(claude?.name, "Custom Claude Sonnet", "Per-model name override should apply");
			assert.equal(claude?.reasoning, true, "Per-model reasoning override should apply");
			assert.equal(claude?.cost.input, 0.000006, "Per-model cost override should apply");

			// Non-overridden fields from models.dev
			assert.equal(claude?.contextWindow, 200000, "Non-overridden contextWindow should remain");
		});
	});
});
