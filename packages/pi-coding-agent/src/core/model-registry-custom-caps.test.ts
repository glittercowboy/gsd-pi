/**
 * Regression tests for #4563:
 *   Bug 1 — custom/Anthropic-compatible models were hard-capped to 32 k output tokens
 *   Bug 2 — custom models in models.json could not declare capabilities.supportsXhigh
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
	testDir = join(
		tmpdir(),
		`model-registry-custom-caps-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

function createRegistry(modelsJson: object): ModelRegistry {
	const path = join(testDir, "models.json");
	writeFileSync(path, JSON.stringify(modelsJson));
	return new ModelRegistry(AuthStorage.inMemory(), path);
}

function writeModelsJson(obj: object): string {
	const path = join(testDir, "models.json");
	writeFileSync(path, JSON.stringify(obj));
	return path;
}

// ─── Bug 1: 32 k cap must not apply to custom/OpenAI-compatible models ────────

describe("Bug 1 — maxTokens cap (#4563)", () => {
	it("custom openai-completions model with maxTokens > 32 k is not capped", () => {
		const registry = createRegistry({
			providers: {
				"kimi-custom": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [
						{
							id: "kimi-k2.6-code-preview",
							name: "Kimi K2.6 Code Preview",
							maxTokens: 131072,
							contextWindow: 262144,
						},
					],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "kimi-k2.6-code-preview");
		assert.ok(model, "model should be registered");
		assert.equal(
			model.maxTokens,
			131072,
			"maxTokens must be preserved as declared — not capped to 32 000",
		);
	});

	it("custom model with maxTokens exactly 32 k is not affected", () => {
		const registry = createRegistry({
			providers: {
				"custom-provider": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [{ id: "model-32k", maxTokens: 32000, contextWindow: 128000 }],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "model-32k");
		assert.ok(model);
		assert.equal(model.maxTokens, 32000);
	});

	it("custom model with maxTokens 65 k is stored at full value", () => {
		const registry = createRegistry({
			providers: {
				"dashscope-custom": {
					baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [
						{
							id: "qwen3.5-plus",
							name: "Qwen3.5 Plus",
							maxTokens: 65536,
							contextWindow: 1000000,
						},
					],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "qwen3.5-plus" && m.provider === "dashscope-custom");
		assert.ok(model);
		assert.equal(model.maxTokens, 65536);
	});
});

// ─── Bug 2: capabilities.supportsXhigh must be declarable in models.json ──────

describe("Bug 2 — capabilities.supportsXhigh in models.json (#4563)", () => {
	it("model with capabilities.supportsXhigh: true surfaces the flag", () => {
		const registry = createRegistry({
			providers: {
				"kimi-custom": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "anthropic-messages",
					models: [
						{
							id: "kimi-k2.6-code-preview",
							name: "Kimi K2.6 Code Preview",
							maxTokens: 131072,
							contextWindow: 262144,
							capabilities: { supportsXhigh: true },
						},
					],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "kimi-k2.6-code-preview");
		assert.ok(model, "model should be registered");
		assert.equal(
			model.capabilities?.supportsXhigh,
			true,
			"supportsXhigh must be true as declared in models.json",
		);
	});

	it("model without capabilities declaration has no supportsXhigh", () => {
		const registry = createRegistry({
			providers: {
				"plain-provider": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [{ id: "plain-model", maxTokens: 16384, contextWindow: 128000 }],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "plain-model");
		assert.ok(model);
		// supportsXhigh should be absent or explicitly false — never implicitly true
		assert.ok(
			!model.capabilities?.supportsXhigh,
			"supportsXhigh must not be set for models that don't declare it",
		);
	});

	it("capabilities.supportsXhigh: false is respected", () => {
		const registry = createRegistry({
			providers: {
				"explicit-provider": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [
						{
							id: "no-xhigh-model",
							capabilities: { supportsXhigh: false },
						},
					],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "no-xhigh-model");
		assert.ok(model);
		assert.equal(model.capabilities?.supportsXhigh, false);
	});

	it("supportsXhigh declared in models.json is not overwritten by capability patches", () => {
		// The capability-patches system must not overwrite an explicit declaration in models.json.
		// applyCapabilityPatches uses spread: { ...patch.caps, ...model.capabilities }
		// so model.capabilities wins. This test verifies the precedence end-to-end.
		const registry = createRegistry({
			providers: {
				"compat-provider": {
					baseUrl: "https://api.example.com/v1",
					apiKey: "sk-test",
					api: "openai-completions",
					models: [
						{
							id: "custom-xhigh-model",
							capabilities: { supportsXhigh: true },
						},
					],
				},
			},
		});

		const model = registry.getAll().find((m) => m.id === "custom-xhigh-model");
		assert.ok(model);
		assert.equal(model.capabilities?.supportsXhigh, true);
	});

	it("modelOverrides can set capabilities.supportsXhigh on built-in models", () => {
		// A user-facing override in models.json should be able to add supportsXhigh
		// to a built-in model that doesn't declare it.
		const path = writeModelsJson({
			providers: {
				anthropic: {
					modelOverrides: {
						"claude-3-5-haiku-20241022": {
							capabilities: { supportsXhigh: true },
						},
					},
				},
			},
		});

		const registry = new ModelRegistry(AuthStorage.inMemory(), path);
		const model = registry.getAll().find(
			(m) => m.provider === "anthropic" && m.id === "claude-3-5-haiku-20241022",
		);
		assert.ok(model, "built-in model must still be present");
		assert.equal(
			model.capabilities?.supportsXhigh,
			true,
			"modelOverrides must be able to set capabilities.supportsXhigh",
		);
	});
});
