/**
 * Regression test for #2626: Extension-provided models silently overwritten on startup.
 *
 * The startup model-validation logic must run AFTER extensions register their
 * models in the ModelRegistry.  When validation runs before extensions load,
 * extension-provided models (e.g. claude-code/claude-sonnet-4-6) are not yet
 * in the registry, so configuredExists is always false and the user's choice
 * is silently replaced with a built-in fallback.
 *
 * This test exercises `validateConfiguredModel()` directly (once extracted) to
 * verify that:
 *   (a) extension models present in the registry are preserved,
 *   (b) genuinely missing models still trigger fallback selection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { validateConfiguredModel } = await import("../startup-model-validation.js");

/**
 * Minimal stub of ModelRegistry with just getAll() / getAvailable().
 */
function fakeModelRegistry(models: Array<{ provider: string; id: string }>) {
  const available = models.map((m) => ({
    ...m,
    name: m.id,
    contextWindow: 128_000,
    maxTokens: 4096,
    reasoning: false,
  }));
  return {
    getAll: () => available,
    getAvailable: () => available,
  };
}

/**
 * Minimal stub of SettingsManager backed by plain objects.
 */
function fakeSettingsManager(initial: { provider?: string; model?: string }) {
  let provider = initial.provider;
  let model = initial.model;
  let thinkingLevel = "off" as string;
  return {
    getDefaultProvider: () => provider,
    getDefaultModel: () => model,
    getDefaultThinkingLevel: () => thinkingLevel,
    setDefaultModelAndProvider(p: string, m: string) {
      provider = p;
      model = m;
    },
    setDefaultThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    // Expose for assertions
    get currentProvider() { return provider; },
    get currentModel() { return model; },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Test: extension-provided model in registry must NOT be overwritten
// ──────────────────────────────────────────────────────────────────────
test("validateConfiguredModel preserves extension-provided model when present in registry", () => {
  const settings = fakeSettingsManager({
    provider: "claude-code",
    model: "claude-sonnet-4-6",
  });

  // Registry includes the extension model (simulating post-extension-load state)
  const registry = fakeModelRegistry([
    { provider: "openai", id: "gpt-5.4" },
    { provider: "claude-code", id: "claude-sonnet-4-6" },
  ]);

  validateConfiguredModel(registry as any, settings as any);

  assert.equal(settings.currentProvider, "claude-code",
    "provider must remain the user-configured extension provider");
  assert.equal(settings.currentModel, "claude-sonnet-4-6",
    "model must remain the user-configured extension model");
});

// ──────────────────────────────────────────────────────────────────────
// Test: genuinely removed model still triggers fallback
// ──────────────────────────────────────────────────────────────────────
test("validateConfiguredModel falls back when model is not in registry", () => {
  const settings = fakeSettingsManager({
    provider: "openai",
    model: "grok-2",  // hypothetical removed model
  });

  const registry = fakeModelRegistry([
    { provider: "openai", id: "gpt-5.4" },
    { provider: "anthropic", id: "claude-opus-4-6" },
  ]);

  validateConfiguredModel(registry as any, settings as any);

  // Should have been overwritten to one of the available models
  assert.notEqual(settings.currentModel, "grok-2",
    "stale model must be replaced by a fallback");
  assert.ok(settings.currentProvider, "a fallback provider must be set");
  assert.ok(settings.currentModel, "a fallback model must be set");
});

// ──────────────────────────────────────────────────────────────────────
// Test: no configured model at all triggers fallback
// ──────────────────────────────────────────────────────────────────────
test("validateConfiguredModel picks a fallback when nothing is configured", () => {
  const settings = fakeSettingsManager({
    provider: undefined,
    model: undefined,
  });

  const registry = fakeModelRegistry([
    { provider: "openai", id: "gpt-5.4" },
  ]);

  validateConfiguredModel(registry as any, settings as any);

  assert.equal(settings.currentProvider, "openai");
  assert.equal(settings.currentModel, "gpt-5.4");
});

// ──────────────────────────────────────────────────────────────────────
// Test: thinking level reset when model doesn't exist
// ──────────────────────────────────────────────────────────────────────
test("validateConfiguredModel resets thinking level when model was replaced", () => {
  const settings = fakeSettingsManager({
    provider: "openai",
    model: "grok-2",
  });
  // Simulate non-off thinking level
  settings.setDefaultThinkingLevel("high");

  const registry = fakeModelRegistry([
    { provider: "openai", id: "gpt-5.4" },
  ]);

  validateConfiguredModel(registry as any, settings as any);

  assert.equal(settings.getDefaultThinkingLevel(), "off",
    "thinking level must be reset to off when model was not found");
});

// ──────────────────────────────────────────────────────────────────────
// Test: thinking level NOT reset when model exists
// ──────────────────────────────────────────────────────────────────────
test("validateConfiguredModel preserves thinking level when model exists", () => {
  const settings = fakeSettingsManager({
    provider: "openai",
    model: "gpt-5.4",
  });
  settings.setDefaultThinkingLevel("high");

  const registry = fakeModelRegistry([
    { provider: "openai", id: "gpt-5.4" },
  ]);

  validateConfiguredModel(registry as any, settings as any);

  assert.equal(settings.getDefaultThinkingLevel(), "high",
    "thinking level must be preserved when configured model exists");
});
