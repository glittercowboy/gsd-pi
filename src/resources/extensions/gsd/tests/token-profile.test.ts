/**
 * Token Profile — unit tests for M004/S01.
 *
 * Tests profile resolution, preference merging, phase skip defaults,
 * subagent model routing, default-to-balanced behavior, and dispatch
 * table guard clauses (source-level structural verification).
 *
 * Uses source-level checks (readFileSync + string matching) to avoid
 * @gsd/pi-coding-agent import resolution issues in dev environments.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSourceRegion } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Source files for structural checks ───────────────────────────────────
// After decomposition, code lives across multiple modules. Concatenate them
// so structural string-matching works regardless of which file holds the code.

const dispatchSrc = readFileSync(join(__dirname, "..", "auto-dispatch.ts"), "utf-8");
const preferencesSrc = [
  readFileSync(join(__dirname, "..", "preferences.ts"), "utf-8"),
  readFileSync(join(__dirname, "..", "preferences-types.ts"), "utf-8"),
  readFileSync(join(__dirname, "..", "preferences-models.ts"), "utf-8"),
  readFileSync(join(__dirname, "..", "preferences-validation.ts"), "utf-8"),
].join("\n");
const typesSrc = readFileSync(join(__dirname, "..", "types.ts"), "utf-8");

// ═══════════════════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

test("types: TokenProfile type exported with budget/balanced/quality/burn-max", () => {
  assert.ok(typesSrc.includes("export type TokenProfile"), "TokenProfile should be exported");
  assert.match(typesSrc, /["']budget["']/, "should include budget");
  assert.match(typesSrc, /["']balanced["']/, "should include balanced");
  assert.match(typesSrc, /["']quality["']/, "should include quality");
  assert.match(typesSrc, /["']burn-max["']/, "should include burn-max");
});

test("types: InlineLevel type exported with full/standard/minimal", () => {
  assert.ok(typesSrc.includes("export type InlineLevel"), "InlineLevel should be exported");
  assert.match(typesSrc, /["']full["']/, "should include full");
  assert.match(typesSrc, /["']standard["']/, "should include standard");
  assert.match(typesSrc, /["']minimal["']/, "should include minimal");
});

test("types: PhaseSkipPreferences interface exported", () => {
  assert.ok(typesSrc.includes("export interface PhaseSkipPreferences"), "PhaseSkipPreferences should be exported");
  assert.ok(typesSrc.includes("skip_research"), "should include skip_research");
  assert.ok(typesSrc.includes("skip_reassess"), "should include skip_reassess");
  assert.ok(typesSrc.includes("skip_slice_research"), "should include skip_slice_research");
  assert.ok(typesSrc.includes("reassess_after_slice"), "should include reassess_after_slice");
});

// ═══════════════════════════════════════════════════════════════════════════
// GSDPreferences Interface
// ═══════════════════════════════════════════════════════════════════════════

test("preferences: GSDPreferences includes token_profile field", () => {
  assert.ok(
    preferencesSrc.includes("token_profile?: TokenProfile"),
    "GSDPreferences should have token_profile field",
  );
});

test("preferences: GSDPreferences includes phases field", () => {
  assert.ok(
    preferencesSrc.includes("phases?: PhaseSkipPreferences"),
    "GSDPreferences should have phases field",
  );
});

test("preferences: GSDModelConfig includes subagent field", () => {
  // Check both v1 and v2 configs
  const v1Match = preferencesSrc.match(/interface GSDModelConfig\s*\{[^}]*subagent/);
  assert.ok(v1Match, "GSDModelConfig should have subagent field");
  const v2Match = preferencesSrc.match(/interface GSDModelConfigV2\s*\{[^}]*subagent/);
  assert.ok(v2Match, "GSDModelConfigV2 should have subagent field");
});

test("preferences: KNOWN_PREFERENCE_KEYS includes token_profile and phases", () => {
  assert.ok(preferencesSrc.includes('"token_profile"'), "KNOWN_PREFERENCE_KEYS should include token_profile");
  assert.ok(preferencesSrc.includes('"phases"'), "KNOWN_PREFERENCE_KEYS should include phases");
});

// ═══════════════════════════════════════════════════════════════════════════
// Profile Resolution
// ═══════════════════════════════════════════════════════════════════════════

test("profile: resolveProfileDefaults exists and handles all 4 tiers", () => {
  assert.ok(
    preferencesSrc.includes("export function resolveProfileDefaults"),
    "resolveProfileDefaults should be exported",
  );
  assert.ok(
    preferencesSrc.includes('case "budget"') &&
    preferencesSrc.includes('case "balanced"') &&
    preferencesSrc.includes('case "quality"') &&
    preferencesSrc.includes('case "burn-max"'),
    "resolveProfileDefaults should handle all 4 tiers",
  );
});

test("profile: budget profile sets phase skips to true", () => {
  // Extract the budget case block
  const budgetIdx = preferencesSrc.indexOf('case "budget":');
  const balancedIdx = preferencesSrc.indexOf('case "balanced":');
  const budgetBlock = preferencesSrc.slice(budgetIdx, balancedIdx);
  assert.ok(budgetBlock.includes("skip_research: true"), "budget should skip research");
  assert.ok(budgetBlock.includes("skip_reassess: true"), "budget should skip reassess");
  assert.ok(budgetBlock.includes("skip_slice_research: true"), "budget should skip slice research");
});

test("profile: balanced profile skips research, reassess, and slice research (ADR-003)", () => {
  const balancedIdx = preferencesSrc.indexOf('case "balanced":');
  const qualityIdx = preferencesSrc.indexOf('case "quality":');
  const balancedBlock = preferencesSrc.slice(balancedIdx, qualityIdx);
  assert.ok(balancedBlock.includes("skip_slice_research: true"), "balanced should skip slice research");
  assert.ok(balancedBlock.includes("skip_research: true"), "balanced should skip milestone research");
  assert.ok(balancedBlock.includes("skip_reassess: true"), "balanced should skip reassess");
});

test("profile: quality profile skips research, slice research, and reassess (ADR-003)", () => {
  const qualityIdx = preferencesSrc.indexOf('case "quality":');
  // preferencesSrc is concatenated from multiple modules — bound the region
  // with the next case marker so the assertion stays tightly scoped.
  const qualityBlock = extractSourceRegion(
    preferencesSrc,
    'case "quality":',
    'case "burn-max":',
  );
  assert.ok(qualityBlock.includes("skip_research: true"), "quality should skip research");
  assert.ok(qualityBlock.includes("skip_slice_research: true"), "quality should skip slice research");
  assert.ok(qualityBlock.includes("skip_reassess: true"), "quality should skip reassess");
});

// ═══════════════════════════════════════════════════════════════════════════
// Default Behavior (D046)
// ═══════════════════════════════════════════════════════════════════════════

test("profile: resolveEffectiveProfile defaults to balanced (D046)", () => {
  assert.ok(
    preferencesSrc.includes("export function resolveEffectiveProfile"),
    "resolveEffectiveProfile should be exported",
  );
  assert.ok(
    preferencesSrc.includes('return "balanced"'),
    "resolveEffectiveProfile should default to balanced",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Inline Level Mapping
// ═══════════════════════════════════════════════════════════════════════════

test("profile: resolveInlineLevel maps profile to inline level", () => {
  assert.ok(
    preferencesSrc.includes("export function resolveInlineLevel"),
    "resolveInlineLevel should be exported",
  );
  assert.ok(preferencesSrc.includes('case "budget": return "minimal"'), "budget → minimal");
  assert.ok(preferencesSrc.includes('case "balanced": return "standard"'), "balanced → standard");
  assert.ok(preferencesSrc.includes('case "quality": return "full"'), "quality → full");
  assert.ok(preferencesSrc.includes('case "burn-max": return "full"'), "burn-max → full");
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

test("validate: validatePreferences handles token_profile", () => {
  assert.ok(
    preferencesSrc.includes("preferences.token_profile") &&
    preferencesSrc.includes("budget, balanced, quality, burn-max"),
    "validatePreferences should validate token_profile enum values",
  );
});

test("validate: validatePreferences handles phases object", () => {
  assert.ok(
    preferencesSrc.includes("preferences.phases") &&
    preferencesSrc.includes("skip_research") &&
    preferencesSrc.includes("skip_reassess") &&
    preferencesSrc.includes("skip_slice_research"),
    "validatePreferences should validate phases fields",
  );
});

test("validate: phases warns on unknown keys", () => {
  assert.ok(
    preferencesSrc.includes("knownPhaseKeys") &&
    preferencesSrc.includes("unknown phases key"),
    "validatePreferences should warn on unknown phase keys",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Merge
// ═══════════════════════════════════════════════════════════════════════════

test("merge: mergePreferences handles token_profile with nullish coalescing", () => {
  assert.ok(
    preferencesSrc.includes("token_profile: override.token_profile ?? base.token_profile"),
    "mergePreferences should use nullish coalescing for token_profile",
  );
});

test("merge: mergePreferences handles phases with spread", () => {
  assert.ok(
    preferencesSrc.includes("...(base.phases") && preferencesSrc.includes("...(override.phases"),
    "mergePreferences should spread phases objects",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Subagent Model Routing
// ═══════════════════════════════════════════════════════════════════════════

test("subagent: budget profile sets subagent model", () => {
  const budgetIdx = preferencesSrc.indexOf('case "budget":');
  const balancedIdx = preferencesSrc.indexOf('case "balanced":');
  const budgetBlock = preferencesSrc.slice(budgetIdx, balancedIdx);
  assert.ok(budgetBlock.includes("subagent:"), "budget profile should set subagent model");
});

test("subagent: resolveModelWithFallbacksForUnit handles subagent unit types", () => {
  assert.ok(
    preferencesSrc.includes('"subagent"') && preferencesSrc.includes('startsWith("subagent/")'),
    "resolveModelWithFallbacksForUnit should handle subagent and subagent/* unit types",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch Table — Phase Skip Guards
// ═══════════════════════════════════════════════════════════════════════════

test("dispatch: research-milestone rule has skip_research guard", () => {
  // Find the research-milestone rule and check it has the guard
  const ruleIdx = dispatchSrc.indexOf("research-milestone");
  assert.ok(ruleIdx > -1, "should have research-milestone rule");
  // The guard should appear near this rule
  assert.ok(
    dispatchSrc.includes("skip_research") && dispatchSrc.includes("research-milestone"),
    "research-milestone dispatch rule should check phases.skip_research",
  );
});

test("dispatch: research-slice rule has skip guards", () => {
  const ruleIdx = dispatchSrc.indexOf("research-slice");
  assert.ok(ruleIdx > -1, "should have research-slice rule");
  const afterRule = dispatchSrc.slice(ruleIdx);
  assert.ok(
    afterRule.includes("skip_research") || afterRule.includes("skip_slice_research"),
    "research-slice rule should check skip_research or skip_slice_research",
  );
});

test("dispatch: reassess-roadmap rule has reassess_after_slice opt-in guard (ADR-003)", () => {
  assert.ok(
    dispatchSrc.includes("reassess_after_slice") && dispatchSrc.includes("reassess-roadmap"),
    "reassess-roadmap dispatch rule should check phases.reassess_after_slice",
  );
});

test("dispatch: phase skip guards return null (not stop)", () => {
  // Verify skip guards use return null pattern
  const researchGuard = dispatchSrc.match(/skip_research\).*?return null/s);
  assert.ok(researchGuard, "skip_research guard should return null (fall-through)");

  const reassessGuard = dispatchSrc.match(/reassess_after_slice.*?return null/s);
  assert.ok(reassessGuard, "reassess_after_slice guard should return null (fall-through)");
});
