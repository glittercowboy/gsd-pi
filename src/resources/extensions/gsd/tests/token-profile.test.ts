/**
 * Token Profile — behavioral unit tests for M004/S01.
 *
 * Tests profile resolution, preference validation, phase skip defaults,
 * subagent model routing, and dispatch table guard clauses by calling
 * exported functions directly with controlled inputs.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { resolveProfileDefaults, resolveEffectiveProfile, resolveInlineLevel, resolveModelWithFallbacksForUnit } =
  await import("../preferences-models.js");
const { validatePreferences } = await import("../preferences-validation.js");
const { KNOWN_PREFERENCE_KEYS } = await import("../preferences-types.js");
const { DISPATCH_RULES } = await import("../auto-dispatch.js");

// ═══════════════════════════════════════════════════════════════════════════
// Known Preference Keys
// ═══════════════════════════════════════════════════════════════════════════

test("preferences: KNOWN_PREFERENCE_KEYS includes token_profile", () => {
  assert.ok(KNOWN_PREFERENCE_KEYS.has("token_profile"), "token_profile should be a known preference key");
});

test("preferences: KNOWN_PREFERENCE_KEYS includes phases", () => {
  assert.ok(KNOWN_PREFERENCE_KEYS.has("phases"), "phases should be a known preference key");
});

// ═══════════════════════════════════════════════════════════════════════════
// Profile Resolution — resolveProfileDefaults
// ═══════════════════════════════════════════════════════════════════════════

test("profile: resolveProfileDefaults returns an object for all three tiers", () => {
  assert.ok(resolveProfileDefaults("budget"), "budget should return a preferences object");
  assert.ok(resolveProfileDefaults("balanced"), "balanced should return a preferences object");
  assert.ok(resolveProfileDefaults("quality"), "quality should return a preferences object");
});

test("profile: budget profile sets all phase skips to true", () => {
  const result = resolveProfileDefaults("budget");
  assert.equal(result.phases?.skip_research, true, "budget should skip research");
  assert.equal(result.phases?.skip_reassess, true, "budget should skip reassess");
  assert.equal(result.phases?.skip_slice_research, true, "budget should skip slice research");
});

test("profile: balanced profile skips research, reassess, and slice research (ADR-003)", () => {
  const result = resolveProfileDefaults("balanced");
  assert.equal(result.phases?.skip_research, true, "balanced should skip research");
  assert.equal(result.phases?.skip_reassess, true, "balanced should skip reassess");
  assert.equal(result.phases?.skip_slice_research, true, "balanced should skip slice research");
});

test("profile: quality profile skips research, slice research, and reassess (ADR-003)", () => {
  const result = resolveProfileDefaults("quality");
  assert.equal(result.phases?.skip_research, true, "quality should skip research");
  assert.equal(result.phases?.skip_slice_research, true, "quality should skip slice research");
  assert.equal(result.phases?.skip_reassess, true, "quality should skip reassess");
});

test("profile: PhaseSkipPreferences fields are present on budget profile defaults", () => {
  const phases = resolveProfileDefaults("budget").phases!;
  assert.ok("skip_research" in phases, "should include skip_research");
  assert.ok("skip_reassess" in phases, "should include skip_reassess");
  assert.ok("skip_slice_research" in phases, "should include skip_slice_research");
});

// ═══════════════════════════════════════════════════════════════════════════
// Effective Profile & Inline Level
// ═══════════════════════════════════════════════════════════════════════════

test("profile: resolveEffectiveProfile returns a valid token profile (defaults to balanced per D046)", () => {
  const profile = resolveEffectiveProfile();
  assert.ok(
    (["budget", "balanced", "quality"] as const).includes(profile as "budget" | "balanced" | "quality"),
    `resolveEffectiveProfile must return a valid profile, got: ${profile}`,
  );
});

test("profile: resolveInlineLevel returns a valid inline level", () => {
  const level = resolveInlineLevel();
  assert.ok(
    (["minimal", "standard", "full"] as const).includes(level as "minimal" | "standard" | "full"),
    `resolveInlineLevel must return a valid level, got: ${level}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Subagent Model Routing
// ═══════════════════════════════════════════════════════════════════════════

test("subagent: budget profile defaults set a subagent model", () => {
  const result = resolveProfileDefaults("budget");
  assert.ok(result.models?.subagent, "budget profile should set a subagent model");
  assert.equal(typeof result.models!.subagent, "string", "subagent model should be a string");
});

test("subagent: balanced profile defaults set a subagent model", () => {
  const result = resolveProfileDefaults("balanced");
  assert.ok(result.models?.subagent, "balanced profile should set a subagent model");
  assert.equal(typeof result.models!.subagent, "string", "subagent model should be a string");
});

test("subagent: resolveModelWithFallbacksForUnit accepts 'subagent' unit type without throwing", () => {
  // The function returns a ResolvedModelConfig or undefined — we verify it does not throw
  assert.doesNotThrow(() => resolveModelWithFallbacksForUnit("subagent"));
  assert.doesNotThrow(() => resolveModelWithFallbacksForUnit("subagent/planning"));
});

// ═══════════════════════════════════════════════════════════════════════════
// Preference Validation — token_profile
// ═══════════════════════════════════════════════════════════════════════════

test("validate: valid token_profile is accepted without errors", () => {
  for (const profile of ["budget", "balanced", "quality"] as const) {
    const { errors } = validatePreferences({ token_profile: profile });
    assert.equal(errors.length, 0, `${profile} should be a valid token_profile`);
  }
});

test("validate: invalid token_profile produces an error referencing valid values", () => {
  const { errors } = validatePreferences({ token_profile: "super-budget" as never });
  assert.ok(errors.length > 0, "invalid token_profile should produce errors");
  assert.ok(
    errors.some(e => e.includes("budget") && e.includes("balanced") && e.includes("quality")),
    "error message should list valid values",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Preference Validation — phases
// ═══════════════════════════════════════════════════════════════════════════

test("validate: phases object with known keys is accepted without errors", () => {
  const { errors } = validatePreferences({
    phases: { skip_research: true, skip_reassess: true, skip_slice_research: true },
  });
  assert.equal(errors.length, 0, "valid phases object should produce no errors");
});

test("validate: phases with unknown key produces a warning", () => {
  const { warnings } = validatePreferences({ phases: { totally_made_up: true } as never });
  assert.ok(warnings.length > 0, "unknown phases key should produce a warning");
  assert.ok(
    warnings.some(w => w.includes("unknown phases key")),
    "warning should mention unknown phases key",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch Table — Phase Skip Guards
// ═══════════════════════════════════════════════════════════════════════════

function makeState(phase: import("../types.js").Phase): import("../types.js").GSDState {
  return {
    phase,
    activeMilestone: { id: "M001", title: "Test Milestone" },
    activeSlice: null,
    activeTask: null,
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  };
}

test("dispatch: research-milestone rule returns null when skip_research is set", async () => {
  const rule = DISPATCH_RULES.find(r => r.name.includes("research-milestone"));
  assert.ok(rule, "should have a research-milestone rule");
  const result = await rule.match({
    basePath: "/tmp/gsd-token-profile-test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState("pre-planning"),
    prefs: { phases: { skip_research: true } },
  });
  assert.equal(result, null, "research-milestone rule should return null when skip_research is set");
});

test("dispatch: research-slice rule returns null when skip_research is set", async () => {
  const rule = DISPATCH_RULES.find(r => r.name.includes("research-slice"));
  assert.ok(rule, "should have a research-slice rule");
  const result = await rule.match({
    basePath: "/tmp/gsd-token-profile-test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState("planning"),
    prefs: { phases: { skip_research: true } },
  });
  assert.equal(result, null, "research-slice rule should return null when skip_research is set");
});

test("dispatch: research-slice rule returns null when skip_slice_research is set", async () => {
  const rule = DISPATCH_RULES.find(r => r.name.includes("research-slice"));
  assert.ok(rule, "should have a research-slice rule");
  const result = await rule.match({
    basePath: "/tmp/gsd-token-profile-test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState("planning"),
    prefs: { phases: { skip_slice_research: true } },
  });
  assert.equal(result, null, "research-slice rule should return null when skip_slice_research is set");
});

test("dispatch: reassess-roadmap rule returns null when skip_reassess is set", async () => {
  const rule = DISPATCH_RULES.find(r => r.name.includes("reassess-roadmap"));
  assert.ok(rule, "should have a reassess-roadmap rule");
  const result = await rule.match({
    basePath: "/tmp/gsd-token-profile-test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState("executing"),
    prefs: { phases: { skip_reassess: true, reassess_after_slice: true } },
  });
  assert.equal(result, null, "reassess-roadmap rule should return null when skip_reassess is set");
});

test("dispatch: reassess-roadmap rule returns null when reassess_after_slice is not opted in (ADR-003)", async () => {
  const rule = DISPATCH_RULES.find(r => r.name.includes("reassess-roadmap"));
  assert.ok(rule, "should have a reassess-roadmap rule");
  const result = await rule.match({
    basePath: "/tmp/gsd-token-profile-test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState("executing"),
    prefs: { phases: {} },  // reassess_after_slice not set → should skip
  });
  assert.equal(result, null, "reassess-roadmap rule should return null when reassess_after_slice is not opted in");
});
