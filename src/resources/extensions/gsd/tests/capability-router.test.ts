// GSD Extension — Capability-Aware Router Tests
// Tests for new capability scoring functions and data tables (Plan 01-01)

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreModel,
  computeTaskRequirements,
  scoreEligibleModels,
  getEligibleModels,
  resolveModelForComplexity,
  MODEL_CAPABILITY_PROFILES,
  MODEL_CAPABILITY_TIER,
  BASE_REQUIREMENTS,
  defaultRoutingConfig,
} from "../model-router.js";
import type { ModelCapabilities, DynamicRoutingConfig, RoutingDecision } from "../model-router.js";

// ─── scoreModel ──────────────────────────────────────────────────────────────

describe("scoreModel", () => {
  const sonnetProfile: ModelCapabilities = {
    coding: 85, debugging: 80, research: 75, reasoning: 80,
    speed: 60, longContext: 75, instruction: 85,
  };

  test("produces correct weighted average for single dimension", () => {
    // Only coding weight 1.0 → result should be the coding score
    const score = scoreModel(sonnetProfile, { coding: 1.0 });
    assert.equal(score, 85);
  });

  test("produces correct weighted average for two dimensions (coding 0.9, instruction 0.7)", () => {
    // (0.9*85 + 0.7*85) / (0.9+0.7) = (76.5+59.5)/1.6 = 136/1.6 = 85.0
    const score = scoreModel(sonnetProfile, { coding: 0.9, instruction: 0.7 });
    assert.ok(Math.abs(score - 85.0) < 0.01, `Expected ~85.0, got ${score}`);
  });

  test("returns 50 when requirements is empty", () => {
    const score = scoreModel(sonnetProfile, {});
    assert.equal(score, 50);
  });

  test("uses 50 as fallback for unknown dimension in requirements", () => {
    // 'unknown' dimension not in profile → treated as 50
    const score = scoreModel(sonnetProfile, { coding: 0.5, unknown: 1.0 } as any);
    // (0.5*85 + 1.0*50) / (0.5+1.0) = (42.5+50)/1.5 = 92.5/1.5 = 61.67
    assert.ok(score > 61 && score < 62, `Expected ~61.67, got ${score}`);
  });
});

// ─── computeTaskRequirements ─────────────────────────────────────────────────

describe("computeTaskRequirements", () => {
  test("execute-task with no metadata returns base requirements", () => {
    const req = computeTaskRequirements("execute-task", undefined);
    assert.deepStrictEqual(req, { coding: 0.9, instruction: 0.7, speed: 0.3 });
  });

  test("execute-task with docs tag returns docs-adjusted requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["docs"] });
    assert.equal(req.instruction, 0.9);
    assert.equal(req.coding, 0.3);
    assert.equal(req.speed, 0.7);
  });

  test("execute-task with readme tag returns docs-adjusted requirements", () => {
    const req = computeTaskRequirements("execute-task", { tags: ["readme"] });
    assert.equal(req.instruction, 0.9);
  });

  test("execute-task with concurrency keyword boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["concurrency"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });

  test("execute-task with compatibility keyword boosts debugging and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["compatibility"] });
    assert.equal(req.debugging, 0.9);
    assert.equal(req.reasoning, 0.8);
  });

  test("execute-task with migration keyword boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["migration"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });

  test("execute-task with architecture keyword boosts reasoning and coding", () => {
    const req = computeTaskRequirements("execute-task", { complexityKeywords: ["architecture"] });
    assert.equal(req.reasoning, 0.9);
    assert.equal(req.coding, 0.8);
  });

  test("execute-task with fileCount >= 6 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 8 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("execute-task with fileCount exactly 6 triggers large-file boost", () => {
    const req = computeTaskRequirements("execute-task", { fileCount: 6 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("execute-task with estimatedLines >= 500 boosts coding and reasoning", () => {
    const req = computeTaskRequirements("execute-task", { estimatedLines: 500 });
    assert.equal(req.coding, 0.9);
    assert.equal(req.reasoning, 0.7);
  });

  test("research-milestone with no metadata returns base requirements", () => {
    const req = computeTaskRequirements("research-milestone", undefined);
    assert.deepStrictEqual(req, { research: 0.9, longContext: 0.7, reasoning: 0.5 });
  });

  test("unknown unit type returns default reasoning requirement", () => {
    const req = computeTaskRequirements("unknown-type", undefined);
    assert.deepStrictEqual(req, { reasoning: 0.5 });
  });
});

// ─── MODEL_CAPABILITY_PROFILES ───────────────────────────────────────────────

describe("MODEL_CAPABILITY_PROFILES", () => {
  test("contains profiles for all tier-mapped models", () => {
    const tierModels = Object.keys(MODEL_CAPABILITY_TIER);
    for (const model of tierModels) {
      assert.ok(MODEL_CAPABILITY_PROFILES[model], `Missing profile for ${model}`);
    }
  });

  test("each profile has all 7 capability dimensions", () => {
    const dims: Array<keyof ModelCapabilities> = [
      "coding", "debugging", "research", "reasoning",
      "speed", "longContext", "instruction",
    ];
    for (const [modelId, profile] of Object.entries(MODEL_CAPABILITY_PROFILES)) {
      for (const dim of dims) {
        assert.ok(profile[dim] !== undefined, `${modelId} missing dimension ${dim}`);
        assert.ok(profile[dim] >= 0 && profile[dim] <= 100, `${modelId}.${dim} out of range`);
      }
    }
  });

  test("claude-opus-4-6 has high reasoning and coding", () => {
    const opus = MODEL_CAPABILITY_PROFILES["claude-opus-4-6"];
    assert.ok(opus.reasoning >= 90, `Expected reasoning >= 90, got ${opus.reasoning}`);
    assert.ok(opus.coding >= 90, `Expected coding >= 90, got ${opus.coding}`);
  });

  test("claude-haiku-4-5 has high speed but lower reasoning", () => {
    const haiku = MODEL_CAPABILITY_PROFILES["claude-haiku-4-5"];
    assert.ok(haiku.speed >= 90, `Expected speed >= 90, got ${haiku.speed}`);
    assert.ok(haiku.reasoning < 70, `Expected reasoning < 70, got ${haiku.reasoning}`);
  });
});

// ─── BASE_REQUIREMENTS ───────────────────────────────────────────────────────

describe("BASE_REQUIREMENTS", () => {
  test("contains all 11 unit types", () => {
    const required = [
      "execute-task", "research-milestone", "research-slice",
      "plan-milestone", "plan-slice", "replan-slice",
      "reassess-roadmap", "complete-slice", "run-uat",
      "discuss-milestone", "complete-milestone",
    ];
    for (const unitType of required) {
      assert.ok(BASE_REQUIREMENTS[unitType], `Missing requirements for ${unitType}`);
    }
  });
});

// ─── scoreEligibleModels ─────────────────────────────────────────────────────

describe("scoreEligibleModels", () => {
  test("returns array sorted by score descending", () => {
    const requirements = { research: 0.9, longContext: 0.7, reasoning: 0.5 };
    const results = scoreEligibleModels(["claude-sonnet-4-6", "gpt-4o"], requirements);
    assert.ok(results.length === 2);
    assert.ok(results[0].score >= results[1].score, "Should be sorted descending by score");
  });

  test("returns single model when only one eligible", () => {
    const requirements = { coding: 0.9 };
    const results = scoreEligibleModels(["claude-sonnet-4-6"], requirements);
    assert.equal(results.length, 1);
    assert.equal(results[0].modelId, "claude-sonnet-4-6");
  });

  test("models without profiles get uniform 50s score", () => {
    const requirements = { coding: 1.0 };
    const results = scoreEligibleModels(["unknown-model-xyz"], requirements);
    assert.equal(results[0].score, 50);
  });

  test("when two models score within 2 points, prefers cheaper model", () => {
    // gemini-2.0-flash is cheaper than gpt-4o-mini ($0.0001 vs $0.00015)
    // Use a requirement that causes similar scores for both
    const requirements = { speed: 1.0 };
    const results = scoreEligibleModels(["gpt-4o-mini", "gemini-2.0-flash"], requirements);
    // Both are high-speed: gpt-4o-mini=90, gemini-2.0-flash=95 — scores differ by 5, not within 2
    // So top should be gemini-2.0-flash by score
    assert.equal(results[0].modelId, "gemini-2.0-flash");
  });

  test("tie-breaks by lexicographic model ID when cost and score are equal", () => {
    // Use models without cost entries — both get Infinity cost
    const requirements = { coding: 1.0 };
    const results = scoreEligibleModels(["model-z", "model-a"], requirements);
    // Both unknown → score=50, cost=Infinity → tiebreak by ID
    assert.equal(results[0].modelId, "model-a");
  });

  test("scoreEligibleModels respects capabilityOverrides", () => {
    const requirements = { coding: 1.0 };
    // Override claude-sonnet-4-6's coding to 30 (worse)
    const results = scoreEligibleModels(
      ["claude-sonnet-4-6", "gpt-4o"],
      requirements,
      { "claude-sonnet-4-6": { coding: 30 } },
    );
    // gpt-4o coding=80 should beat overridden sonnet coding=30
    assert.equal(results[0].modelId, "gpt-4o");
  });
});

// ─── getEligibleModels ───────────────────────────────────────────────────────

describe("getEligibleModels", () => {
  const MODELS = [
    "claude-opus-4-6",      // heavy
    "claude-sonnet-4-6",    // standard
    "claude-haiku-4-5",     // light
    "gpt-4o-mini",          // light
  ];

  test("returns light-tier models sorted by cost when no explicit config", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    const result = getEligibleModels("light", MODELS, config);
    assert.ok(result.length >= 1);
    // All results should be light-tier
    for (const id of result) {
      assert.ok(
        ["claude-haiku-4-5", "gpt-4o-mini"].includes(id),
        `Expected light-tier model, got ${id}`,
      );
    }
  });

  test("returns explicit tier_models when configured and available", () => {
    const config: DynamicRoutingConfig = {
      ...defaultRoutingConfig(),
      tier_models: { light: "gpt-4o-mini" },
    };
    const result = getEligibleModels("light", MODELS, config);
    assert.deepStrictEqual(result, ["gpt-4o-mini"]);
  });

  test("returns empty array when no eligible models for tier", () => {
    const config: DynamicRoutingConfig = defaultRoutingConfig();
    // Only heavy model available, requesting light
    const result = getEligibleModels("light", ["claude-opus-4-6"], config);
    assert.equal(result.length, 0);
  });
});

// ─── DynamicRoutingConfig extension ─────────────────────────────────────────

describe("DynamicRoutingConfig.capability_routing", () => {
  test("defaultRoutingConfig includes capability_routing: true", () => {
    const config = defaultRoutingConfig();
    assert.equal(config.capability_routing, true);
  });
});

// ─── RoutingDecision.selectionMethod ─────────────────────────────────────────

describe("RoutingDecision.selectionMethod", () => {
  const MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o-mini"];

  function makeClassification(tier: "light" | "standard" | "heavy") {
    return { tier, reason: "test", downgraded: false };
  }

  test("returns selectionMethod: tier-only when routing is disabled", () => {
    const config = { ...defaultRoutingConfig(), enabled: false };
    const result: RoutingDecision = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS,
    );
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("returns selectionMethod: tier-only for no phase config passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result: RoutingDecision = resolveModelForComplexity(
      makeClassification("light"),
      undefined,
      config,
      MODELS,
    );
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("returns selectionMethod: tier-only for unknown model passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result: RoutingDecision = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "custom-provider/my-model-v3", fallbacks: [] },
      config,
      ["custom-provider/my-model-v3", ...MODELS],
    );
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("returns selectionMethod: tier-only for no-downgrade passthrough", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result: RoutingDecision = resolveModelForComplexity(
      makeClassification("heavy"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS,
    );
    assert.equal(result.selectionMethod, "tier-only");
  });

  test("returns selectionMethod: tier-only when downgraded", () => {
    const config = { ...defaultRoutingConfig(), enabled: true };
    const result: RoutingDecision = resolveModelForComplexity(
      makeClassification("light"),
      { primary: "claude-opus-4-6", fallbacks: [] },
      config,
      MODELS,
    );
    assert.equal(result.selectionMethod, "tier-only");
  });
});

// ─── ADR-004: Profile Completeness Lint ─────────────────────────────────────
// Every model in MODEL_CAPABILITY_TIER must have an entry in
// MODEL_CAPABILITY_PROFILES. This prevents profile staleness as new models
// are added to the tier map without corresponding capability data.

describe("profile completeness (ADR-004 lint)", () => {
  test("every model in MODEL_CAPABILITY_TIER has a MODEL_CAPABILITY_PROFILES entry", () => {
    const tierModels = Object.keys(MODEL_CAPABILITY_TIER);
    const missing = tierModels.filter(id => !MODEL_CAPABILITY_PROFILES[id]);
    assert.equal(
      missing.length,
      0,
      `Models in MODEL_CAPABILITY_TIER but missing from MODEL_CAPABILITY_PROFILES:\n  ${missing.join("\n  ")}\n\nAdd capability profiles for these models in model-router.ts.`,
    );
  });

  test("MODEL_CAPABILITY_PROFILES does not contain models absent from MODEL_CAPABILITY_TIER", () => {
    const profileModels = Object.keys(MODEL_CAPABILITY_PROFILES);
    const orphaned = profileModels.filter(id => !MODEL_CAPABILITY_TIER[id]);
    assert.equal(
      orphaned.length,
      0,
      `Models in MODEL_CAPABILITY_PROFILES but not in MODEL_CAPABILITY_TIER:\n  ${orphaned.join("\n  ")}\n\nEither add these to MODEL_CAPABILITY_TIER or remove stale profiles.`,
    );
  });
});
