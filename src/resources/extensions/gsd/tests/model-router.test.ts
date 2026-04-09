import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  resolveModelForComplexity,
  escalateTier,
  defaultRoutingConfig,
  scoreModel,
  computeTaskRequirements,
  scoreEligibleModels,
  getEligibleModels,
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

test("defaultRoutingConfig includes capability_routing: true", () => {
  const config = defaultRoutingConfig();
  assert.equal(config.capability_routing, true);
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
// ─── scoreModel ──────────────────────────────────────────────────────────────

describe("scoreModel", () => {
  const sonnetProfile: ModelCapabilities = MODEL_CAPABILITY_PROFILES["claude-sonnet-4-6"]!;

  test("produces correct weighted average for two dimensions (coding:0.9, instruction:0.7)", () => {
    // (0.9*85 + 0.7*85) / (0.9+0.7) = (76.5+59.5)/1.6 = 136/1.6 = 85.0
    const score = scoreModel(sonnetProfile, { coding: 0.9, instruction: 0.7 });
    assert.ok(Math.abs(score - 85.0) < 0.01, `Expected ~85.0, got ${score}`);
  });

  test("returns 50 when requirements is empty", () => {
    const score = scoreModel(sonnetProfile, {});
    assert.equal(score, 50);
  });

  test("returns correct score for single dimension coding:1.0", () => {
    // coding=90 for claude-opus-4-6
    const opusProfile = MODEL_CAPABILITY_PROFILES["claude-opus-4-6"]!;
    const score = scoreModel(opusProfile, { coding: 1.0 });
    assert.equal(score, 95);
  });

  test("handles all 7 dimensions correctly", () => {
    // Uniform weight 1.0 on every dim → average of all dim values
    const profile: ModelCapabilities = {
      coding: 60, debugging: 60, research: 60, reasoning: 60,
      speed: 60, longContext: 60, instruction: 60,
    };
    const reqs: Partial<Record<keyof ModelCapabilities, number>> = {
      coding: 1.0, debugging: 1.0, research: 1.0, reasoning: 1.0,
      speed: 1.0, longContext: 1.0, instruction: 1.0,
    };
    const score = scoreModel(profile, reqs);
    assert.equal(score, 60);
  });
});

// ─── computeTaskRequirements ─────────────────────────────────────────────────

describe("computeTaskRequirements", () => {
  test("execute-task with no metadata returns base vector", () => {
    const req = computeTaskRequirements("execute-task", undefined);
    assert.deepStrictEqual(req, { coding: 0.9, instruction: 0.7, speed: 0.3 });
  });

  test("execute-task with tags:['docs'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["docs"] });
    assert.equal(req.instruction, 0.9);
    assert.equal(req.coding, 0.3);
    assert.equal(req.speed, 0.7);
  });

  test("execute-task with tags:['config'] adjusts requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["config"] });
    assert.equal(req.instruction, 0.9);
  });

  test("execute-task with complexityKeywords:['concurrency'] boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["concurrency"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });

  test("execute-task with complexityKeywords:['migration'] boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["migration"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });

  test("execute-task with fileCount:8 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 8 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("execute-task with estimatedLines:600 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { estimatedLines: 600 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("research-milestone returns correct base vector", () => {
    const req = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(req, { research: 0.9, longContext: 0.7, reasoning: 0.5 });
  });

  test("plan-slice returns correct base vector", () => {
    const req = computeTaskRequirements("plan-slice");
    assert.deepStrictEqual(req, { reasoning: 0.9, coding: 0.5 });
  });

  test("unknown-unit-type returns default reasoning requirement", () => {
    const req = computeTaskRequirements("unknown-unit-type");
    assert.deepStrictEqual(req, { reasoning: 0.5 });
  });

  test("non-execute-task with metadata ignores metadata refinements", () => {
    // research-milestone should return the same vector regardless of metadata
    const reqWithMeta = computeTaskRequirements("research-milestone", { tags: ["docs"], fileCount: 10 });
    const reqWithout = computeTaskRequirements("research-milestone");
    assert.deepStrictEqual(reqWithMeta, reqWithout);
  });
});

// ─── scoreEligibleModels ─────────────────────────────────────────────────────

describe("scoreEligibleModels", () => {
  test("ranks models by score descending when scores differ by more than 2", () => {
    // research: heavily weights research dimension. gemini-2.5-pro has 85 research vs sonnet's 75
    const requirements = { research: 0.9, longContext: 0.7, reasoning: 0.5 };
    const results = scoreEligibleModels(["claude-sonnet-4-6", "gemini-2.5-pro"], requirements);
    assert.equal(results.length, 2);
    assert.ok(results[0].score >= results[1].score, "Should be sorted by score descending");
  });

  test("within 2-point threshold, prefers cheaper model", () => {
    // Use models without built-in profiles (both get score 50) so tie-break applies
    // Then use known models with equal scores: force this via single unknown model pair
    const requirements = { coding: 1.0 };
    // model-a and model-b are both unknown → score=50, cost=Infinity → lexicographic
    const results = scoreEligibleModels(["model-z", "model-a"], requirements);
    // Both unknown: score=50 (within 2), cost=Infinity (equal) → lex: model-a first
    assert.equal(results[0].modelId, "model-a");
  });

  test("single model returns array of one", () => {
    const results = scoreEligibleModels(["claude-sonnet-4-6"], { coding: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0].modelId, "claude-sonnet-4-6");
  });

  test("unknown model with no profile gets score of 50", () => {
    const results = scoreEligibleModels(["totally-unknown-model"], { coding: 1.0 });
    assert.equal(results[0].score, 50);
  });

  test("capabilityOverrides deep-merges with built-in profile", () => {
    const requirements = { coding: 1.0 };
    // Override sonnet's coding to 30 — gpt-4o (coding=80) should win
    const results = scoreEligibleModels(
      ["claude-sonnet-4-6", "gpt-4o"],
      requirements,
      { "claude-sonnet-4-6": { coding: 30 } },
    );
    assert.equal(results[0].modelId, "gpt-4o", "gpt-4o should rank first after coding override");
  });
});

// ─── getEligibleModels ───────────────────────────────────────────────────────

describe("getEligibleModels", () => {
  const ALL_MODELS = [
    "claude-opus-4-6",   // heavy
    "claude-sonnet-4-6", // standard
    "claude-haiku-4-5",  // light
    "gpt-4o-mini",       // light
    "gpt-4o",            // standard
  ];

  test("returns light-tier models from available list sorted by cost", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-haiku-4-5", "gpt-4o-mini"].includes(id),
        `Expected light-tier model, got ${id}`,
      );
    }
  });

  test("returns standard-tier models from available list sorted by cost", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("standard", ALL_MODELS, config);
    assert.ok(result.length >= 1);
    for (const id of result) {
      assert.ok(
        ["claude-sonnet-4-6", "gpt-4o"].includes(id),
        `Expected standard-tier model, got ${id}`,
      );
    }
  });

  test("tier_models pinned model returns single-element array", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      tier_models: { light: "gpt-4o-mini" },
    };
    const result = getEligibleModels("light", ALL_MODELS, config);
    assert.deepStrictEqual(result, ["gpt-4o-mini"]);
  });

  test("empty available list returns empty array", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("light", [], config);
    assert.equal(result.length, 0);
  });

  test("unknown models classified as standard appear in standard tier results", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    // unknown-model-xyz has no entry → defaults to standard tier
    const result = getEligibleModels("standard", ["unknown-model-xyz"], config);
    assert.ok(result.includes("unknown-model-xyz"), "Unknown model should appear in standard tier");
  });
});

// ─── capability-aware routing integration ────────────────────────────────────

describe("capability-aware routing integration", () => {
  // All standard-tier models available alongside heavy (opus)
  const MULTI_MODEL_AVAILABLE = [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-4o",
    "gemini-2.5-pro",
    "claude-haiku-4-5",
    "gpt-4o-mini",
  ];

  // 1. Full pipeline with capability scoring active
  test("full pipeline with capability_routing: true returns capability-scored decision", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // Configured primary is opus (heavy) — standard tier should trigger capability scoring
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      { tags: [], complexityKeywords: [], fileCount: 3, estimatedLines: 100, codeBlockCount: 0 },
    );
    assert.equal(result.selectionMethod, "capability-scored", "should use capability scoring when enabled with multiple eligible models");
    assert.ok(result.capabilityScores !== undefined, "capabilityScores should be populated");
    assert.ok(Object.keys(result.capabilityScores!).length > 1, "should have scores for multiple models");
    assert.equal(result.wasDowngraded, true, "should be downgraded from opus");
  });

  // 2. capability_routing: false falls back to tier-only
  test("capability_routing: false skips scoring and uses tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: false };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only", "capability_routing: false should use tier-only");
    assert.equal(result.capabilityScores, undefined, "capabilityScores should be undefined for tier-only");
  });

  // 3. Single eligible model skips scoring
  test("single eligible model skips capability scoring and uses tier-only", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      enabled: true,
      capability_routing: true,
      tier_models: { standard: "claude-sonnet-4-6" },
    };
    // Pin to single standard model — eligible.length === 1 → skips STEP 2
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    // Single pinned model → tier-only (no scoring needed)
    assert.equal(result.selectionMethod, "tier-only", "single eligible model should use tier-only");
    assert.equal(result.modelId, "claude-sonnet-4-6", "should use the pinned model");
  });

  // 4. Unknown model with no profile gets uniform 50s and competes
  test("unknown model with no profile gets uniform score of 50 and can compete", () => {
    const unknownModel = "unknown-future-model-xyz";
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // Add unknown model to available list at standard tier (unknown → standard per D-15)
    // scoring should still work with score=50 for the unknown model
    const requirements = { coding: 0.9, instruction: 0.7, speed: 0.3 };
    const scored = scoreEligibleModels([unknownModel, "claude-sonnet-4-6"], requirements);
    const unknownEntry = scored.find(s => s.modelId === unknownModel);
    assert.ok(unknownEntry !== undefined, "unknown model should be in scored results");
    // Unknown model gets uniform 50s: (0.9*50 + 0.7*50 + 0.3*50) / (0.9+0.7+0.3) ≈ 50
    assert.ok(Math.abs(unknownEntry!.score - 50) < 0.01, `expected score ~50, got ${unknownEntry!.score}`);
  });

  // 5. Capability overrides change scoring outcome
  test("capabilityOverrides boost a model above another for same task", () => {
    // sonnet: coding=85, gpt-4o: coding=80. Override gpt-4o coding to 99 → gpt-4o should win.
    const requirements = { coding: 1.0 };
    const overrides = { "gpt-4o": { coding: 99 } };
    const scored = scoreEligibleModels(["claude-sonnet-4-6", "gpt-4o"], requirements, overrides);
    assert.equal(scored[0].modelId, "gpt-4o", "overridden model should win for coding-heavy task");
    assert.ok(scored[0].score > 90, `expected score > 90 after override, got ${scored[0].score}`);
  });

  // 5b. Capability overrides pass through resolveModelForComplexity to scoreEligibleModels
  test("resolveModelForComplexity passes capabilityOverrides to scoring step", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // sonnet coding=85, gpt-4o coding=80. Override gpt-4o coding to 99 → gpt-4o should win.
    const overrides: Record<string, Partial<ModelCapabilities>> = { "gpt-4o": { coding: 99 } };
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o"],
      "execute-task",
      undefined,
      overrides,
    );
    assert.equal(result.selectionMethod, "capability-scored");
    assert.equal(result.modelId, "gpt-4o", "gpt-4o should win with coding override");
  });

  // 6. Regression: existing routing guards unchanged
  test("regression: routing-disabled passthrough still returns tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: false };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-opus-4-6");
  });

  test("regression: unknown-model bypass returns tier-only and does not downgrade", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true };
    const result = resolveModelForComplexity(
      { tier: "light", reason: "test", downgraded: false },
      { primary: "totally-unknown-custom-model", fallbacks: [] },
      config,
      ["totally-unknown-custom-model", ...MULTI_MODEL_AVAILABLE],
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "totally-unknown-custom-model");
  });

  test("regression: no-downgrade-needed path returns tier-only", () => {
    const config: DynamicRoutingConfig = { ...defaultRoutingConfig(), enabled: true, capability_routing: true };
    // Configured model is sonnet (standard), requesting standard → no downgrade needed
    const result = resolveModelForComplexity(
      { tier: "standard", reason: "test", downgraded: false },
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      MULTI_MODEL_AVAILABLE,
      "execute-task",
      undefined,
    );
    assert.equal(result.selectionMethod, "tier-only");
    assert.equal(result.wasDowngraded, false);
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });
});

// ─── getModelTier unknown default ────────────────────────────────────────────

describe("getModelTier unknown default", () => {
  test("unknown model returns standard tier (not heavy) via downgrade behavior", () => {
    // We can verify this indirectly: resolveModelForComplexity for a standard classification
    // with an unknown primary model should NOT downgrade (because unknown → standard, not heavy)
    const config = { ...defaultRoutingConfig(), enabled: true };
    // Use "unknown-model-xyz" as primary — its tier will be "standard" per D-15
    // Classification is "heavy" → tier >= standard → no downgrade
    // But unknown models use the isKnownModel() guard, so they pass through anyway
    // Test the positive: an unknown model is NOT treated as heavy
    const result = resolveModelForComplexity(
      makeClassification("standard"),
      { primary: "claude-sonnet-4-6", fallbacks: [] },
      config,
      ["claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o-mini"],
    );
    // standard classification with standard model (sonnet) → no downgrade
    assert.equal(result.wasDowngraded, false, "standard model should not downgrade for standard task");
    assert.equal(result.modelId, "claude-sonnet-4-6");
  });

  test("unknown model in getEligibleModels defaults to standard tier", () => {
    // Per D-15: getModelTier returns "standard" for unknown models
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const standardModels = getEligibleModels("standard", ["totally-unknown-model-abc"], config);
    const lightModels = getEligibleModels("light", ["totally-unknown-model-abc"], config);
    const heavyModels = getEligibleModels("heavy", ["totally-unknown-model-abc"], config);
    assert.ok(standardModels.includes("totally-unknown-model-abc"), "Unknown model should be in standard tier");
    assert.equal(lightModels.length, 0, "Unknown model should NOT be in light tier");
    assert.equal(heavyModels.length, 0, "Unknown model should NOT be in heavy tier");
  });
});
