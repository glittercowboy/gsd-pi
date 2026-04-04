import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveModelForComplexity,
  escalateTier,
  defaultRoutingConfig,
  scoreModel,
  computeTaskRequirements,
  MODEL_CAPABILITY_PROFILES,
} from "../model-router.js";
import type { DynamicRoutingConfig, RoutingDecision, ModelCapabilities } from "../model-router.js";
import type { ClassificationResult } from "../complexity-classifier.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClassification(tier: "light" | "standard" | "heavy", reason = "test"): ClassificationResult {
  return { tier, reason, downgraded: false };
}

const AVAILABLE_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-4o-mini",
];

// ─── Passthrough when disabled ───────────────────────────────────────────────

test("returns configured model when routing is disabled", () => {
  const config = { ...defaultRoutingConfig(), enabled: false };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("returns configured model when no phase config", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    undefined,
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "");
  assert.equal(result.wasDowngraded, false);
});

// ─── Downgrade-only semantics ────────────────────────────────────────────────

test("does not downgrade when tier matches configured model tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("does not upgrade beyond configured model", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Configured model is sonnet (standard), classification says heavy
  const result = resolveModelForComplexity(
    makeClassification("heavy"),
    { primary: "claude-sonnet-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, false);
});

test("downgrades from opus to haiku for light tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  // Should pick haiku or gpt-4o-mini (cheapest light tier)
  assert.ok(
    result.modelId === "claude-haiku-4-5" || result.modelId === "gpt-4o-mini",
    `Expected light-tier model, got ${result.modelId}`,
  );
  assert.equal(result.wasDowngraded, true);
});

test("downgrades from opus to sonnet for standard tier", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "claude-sonnet-4-6");
  assert.equal(result.wasDowngraded, true);
});

// ─── Explicit tier_models ────────────────────────────────────────────────────

test("uses explicit tier_models when configured", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    tier_models: { light: "gpt-4o-mini", standard: "claude-sonnet-4-6" },
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.modelId, "gpt-4o-mini");
  assert.equal(result.wasDowngraded, true);
});

// ─── Fallback chain construction ─────────────────────────────────────────────

test("fallback chain includes configured primary as last resort", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: ["claude-sonnet-4-6"] },
    config,
    AVAILABLE_MODELS,
  );
  assert.ok(result.wasDowngraded);
  // Fallbacks should include the configured fallbacks and primary
  assert.ok(result.fallbacks.includes("claude-opus-4-6"), "primary should be in fallbacks");
  assert.ok(result.fallbacks.includes("claude-sonnet-4-6"), "configured fallback should be in fallbacks");
});

// ─── Escalation ──────────────────────────────────────────────────────────────

test("escalateTier moves light → standard", () => {
  assert.equal(escalateTier("light"), "standard");
});

test("escalateTier moves standard → heavy", () => {
  assert.equal(escalateTier("standard"), "heavy");
});

test("escalateTier returns null for heavy (max)", () => {
  assert.equal(escalateTier("heavy"), null);
});

// ─── No suitable model available ─────────────────────────────────────────────

test("falls back to configured model when no light-tier model available", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // Only heavy-tier models available
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6"],
  );
  assert.equal(result.modelId, "claude-opus-4-6");
  assert.equal(result.wasDowngraded, false);
});

// ─── #2192: Unknown models honor explicit config ─────────────────────────────

test("#2192: unknown model is not downgraded — respects user config", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "some-future-unknown-model-v9", fallbacks: [] },
    config,
    ["some-future-unknown-model-v9", ...AVAILABLE_MODELS],
  );
  assert.equal(result.modelId, "some-future-unknown-model-v9", "unknown model should be used as-is");
  assert.equal(result.wasDowngraded, false, "should not be downgraded");
  assert.ok(result.reason.includes("not in the known tier map"), "reason should explain why");
});

test("#2192: unknown model with provider prefix is not downgraded", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("standard"),
    { primary: "custom-provider/my-model-v3", fallbacks: [] },
    config,
    ["custom-provider/my-model-v3", ...AVAILABLE_MODELS],
  );
  assert.equal(result.modelId, "custom-provider/my-model-v3");
  assert.equal(result.wasDowngraded, false);
});

test("#2192: known model is still downgraded normally", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  // claude-opus-4-6 is known as "heavy" — a light request should downgrade
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    AVAILABLE_MODELS,
  );
  assert.equal(result.wasDowngraded, true, "known heavy model should still be downgraded for light tasks");
  assert.notEqual(result.modelId, "claude-opus-4-6");
});

// ─── Capability Scoring (ADR-004 Phase 2) ───────────────────────────────────

test("defaultRoutingConfig includes capability_routing: false", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.capability_routing, false);
});

test("scoreModel computes weighted average of capability × requirement", () => {
  const caps: ModelCapabilities = {
    coding: 90, debugging: 80, research: 70,
    reasoning: 85, speed: 50, longContext: 60, instruction: 75,
  };
  const reqs = { coding: 0.9, reasoning: 0.5 };
  const score = scoreModel(caps, reqs);
  // Expected: (0.9*90 + 0.5*85) / (0.9 + 0.5) = (81 + 42.5) / 1.4 = 88.21...
  assert.ok(Math.abs(score - 88.21) < 0.1, `score ${score} should be ~88.21`);
});

test("scoreModel returns 50 for empty requirements", () => {
  const caps: ModelCapabilities = {
    coding: 90, debugging: 80, research: 70,
    reasoning: 85, speed: 50, longContext: 60, instruction: 75,
  };
  const score = scoreModel(caps, {});
  assert.equal(score, 50);
});

test("computeTaskRequirements returns base vector for known unit type", () => {
  const reqs = computeTaskRequirements("execute-task");
  assert.ok(reqs.coding !== undefined && reqs.coding > 0);
});

test("computeTaskRequirements boosts instruction for docs-tagged tasks", () => {
  const reqs = computeTaskRequirements("execute-task", { tags: ["docs"] });
  assert.ok((reqs.instruction ?? 0) >= 0.8);
  assert.ok((reqs.coding ?? 1) <= 0.4);
});

test("computeTaskRequirements returns generic vector for unknown unit type", () => {
  const reqs = computeTaskRequirements("unknown-unit");
  assert.ok(reqs.reasoning !== undefined);
});

test("resolveModelForComplexity uses capability scoring when enabled", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: true,
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
    "execute-task",
  );
  assert.equal(result.wasDowngraded, true);
  assert.equal(result.selectionMethod, "capability-scored");
});

test("resolveModelForComplexity falls back to tier-only when capability_routing is false", () => {
  const config: DynamicRoutingConfig = {
    ...defaultRoutingConfig(),
    enabled: true,
    capability_routing: false,
  };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "claude-opus-4-6", fallbacks: [] },
    config,
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
  );
  assert.equal(result.wasDowngraded, true);
  assert.ok(!result.selectionMethod || result.selectionMethod === "tier-only");
});

test("MODEL_CAPABILITY_PROFILES has entries for core models", () => {
  const profiledModels = Object.keys(MODEL_CAPABILITY_PROFILES);
  assert.ok(profiledModels.length >= 9, `Expected ≥9 profiles, got ${profiledModels.length}`);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-opus-4-6"]);
  assert.ok(MODEL_CAPABILITY_PROFILES["claude-haiku-4-5"]);
});

// ─── #2885: openai-codex and modern OpenAI models in tier map ────────────────

test("#2885: openai-codex light-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const lightModels = ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-5-mini", "gpt-5-nano", "gpt-5.1-codex-mini", "gpt-5.3-codex-spark"];
  for (const model of lightModels) {
    const result = resolveModelForComplexity(
      makeClassification("light"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    // Model is known AND light-tier, so requesting light should NOT downgrade
    assert.equal(result.wasDowngraded, false, `${model} should be known as light tier (wasDowngraded)`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for light tier`);
    // Verify it IS known (not hitting the unknown-model bail-out)
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: openai-codex standard-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const standardModels = ["gpt-4.1", "gpt-5.1-codex-max"];
  for (const model of standardModels) {
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as standard tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for standard tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: openai-codex heavy-tier models are recognized", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const heavyModels = ["gpt-5", "gpt-5-pro", "gpt-5.1", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "o4-mini", "o4-mini-deep-research"];
  for (const model of heavyModels) {
    const result = resolveModelForComplexity(
      makeClassification("heavy"),
      { primary: model, fallbacks: [] },
      config,
      [model, ...AVAILABLE_MODELS],
    );
    assert.equal(result.wasDowngraded, false, `${model} should be known as heavy tier`);
    assert.equal(result.modelId, model, `${model} should be returned as-is for heavy tier`);
    assert.ok(!result.reason.includes("not in the known tier map"), `${model} should be in the known tier map`);
  }
});

test("#2885: heavy openai-codex model downgrades to light for light task", () => {
  const config = { ...defaultRoutingConfig(), enabled: true };
  const result = resolveModelForComplexity(
    makeClassification("light"),
    { primary: "gpt-5.4", fallbacks: [] },
    config,
    ["gpt-5.4", "gpt-4.1-nano", ...AVAILABLE_MODELS],
  );
  assert.equal(result.wasDowngraded, true, "heavy model should downgrade for light task");
  // Should pick a light-tier model
  assert.notEqual(result.modelId, "gpt-5.4", "should not use the heavy model for light task");
});
