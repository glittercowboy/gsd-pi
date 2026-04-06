/**
 * GSD-2 — Regression tests for startup model validation (#3534)
 *
 * Verifies that validateConfiguredModel() correctly handles extension-provided
 * models and that stale model IDs (e.g. claude-opus-4-6[1m]) trigger fallback.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { validateConfiguredModel } from "../startup-model-validation.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface MockModel {
	provider: string;
	id: string;
}

function createMockRegistry(allModels: MockModel[], availableModels?: MockModel[]) {
	return {
		getAll: () => allModels,
		getAvailable: () => availableModels ?? allModels,
	};
}

function createMockSettings(defaults: { provider?: string; model?: string; thinking?: "off" | "high" }) {
	let currentProvider = defaults.provider;
	let currentModel = defaults.model;
	let currentThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = defaults.thinking ?? "off";

	return {
		getDefaultProvider: () => currentProvider,
		getDefaultModel: () => currentModel,
		getDefaultThinkingLevel: () => currentThinking,
		setDefaultModelAndProvider: (provider: string, modelId: string) => {
			currentProvider = provider;
			currentModel = modelId;
		},
		setDefaultThinkingLevel: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => {
			currentThinking = level;
		},
		// Expose for assertions
		get _provider() { return currentProvider; },
		get _model() { return currentModel; },
		get _thinking() { return currentThinking; },
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("validateConfiguredModel — regression #3534", () => {
	it("preserves valid extension-provided model without overwriting", () => {
		// Simulate: user configured claude-code/claude-opus-4-6, extension has registered it
		const registry = createMockRegistry([
			{ provider: "claude-code", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "claude-code", model: "claude-opus-4-6" });

		validateConfiguredModel(registry, settings);

		// Should NOT have changed the settings — the model is valid
		assert.equal(settings._provider, "claude-code");
		assert.equal(settings._model, "claude-opus-4-6");
	});

	it("falls back when configured model ID does not exist in registry", () => {
		// Simulate: user configured claude-opus-4-6[1m] but registry only has claude-opus-4-6
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "claude-opus-4-6[1m]" });

		validateConfiguredModel(registry, settings);

		// Should have replaced with a fallback — the [1m] variant doesn't exist
		assert.notEqual(settings._model, "claude-opus-4-6[1m]");
	});

	it("does not fall back to google when anthropic models are available", () => {
		// Simulate: stale setting triggers fallback, anthropic should be preferred over google
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: "anthropic", model: "nonexistent-model" });

		validateConfiguredModel(registry, settings);

		// Should pick anthropic fallback, not google
		assert.equal(settings._provider, "anthropic");
		assert.equal(settings._model, "claude-opus-4-6");
	});

	it("resets thinking level when model is replaced", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
		]);
		const settings = createMockSettings({
			provider: "anthropic",
			model: "nonexistent-model",
			thinking: "high",
		});

		validateConfiguredModel(registry, settings);

		assert.equal(settings._thinking, "off");
	});

	it("is a no-op when no model is configured at all", () => {
		const registry = createMockRegistry([
			{ provider: "anthropic", id: "claude-opus-4-6" },
			{ provider: "google", id: "gemini-2.5-pro" },
		]);
		const settings = createMockSettings({ provider: undefined, model: undefined });

		validateConfiguredModel(registry, settings);

		// Should pick a fallback since nothing was configured
		assert.ok(settings._provider);
		assert.ok(settings._model);
	});
});
