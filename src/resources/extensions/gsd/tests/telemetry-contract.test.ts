/**
 * Telemetry Contract Test — JSONL Schema Round-Trip Fidelity
 *
 * Validates that UnitMetrics objects serialize to JSON and deserialize back
 * without data loss. This is the contract that S02 (metrics aggregation) and
 * S03 (fixture harness) depend on for JSONL persistence.
 *
 * Tests cover:
 * - All required fields on UnitMetrics
 * - All optional fields including M007 additions (interventions, factCheck, wallClockMs, skills)
 * - Nested TokenCounts, InterventionCounts, FactCheckMetrics
 * - Optional field presence/absence preservation
 */

import {
  type UnitMetrics,
  type TokenCounts,
  type InterventionCounts,
  type FactCheckMetrics,
} from "../metrics.js";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, assertNoMatch, report } = createTestContext();

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

function makeFullUnitMetrics(): UnitMetrics {
  return {
    // Required fields
    type: "execute-task",
    id: "M007/S01/T02",
    model: "claude-sonnet-4-20250514",
    startedAt: 1710000000000,
    finishedAt: 1710000100000,
    tokens: {
      input: 50000,
      output: 12500,
      cacheRead: 8000,
      cacheWrite: 2000,
      total: 72500,
    },
    cost: 0.1575,
    toolCalls: 42,
    assistantMessages: 15,
    userMessages: 8,
    // Budget fields (optional)
    contextWindowTokens: 200000,
    truncationSections: 3,
    continueHereFired: true,
    promptCharCount: 45000,
    baselineCharCount: 12000,
    tier: "heavy",
    modelDowngraded: false,
    skills: ["python3-development", "uv", "modernpython"],
    // M007 additions (optional)
    interventions: {
      blocker: 1,
      correction: 2,
      redirect: 0,
    },
    factCheck: {
      claimsChecked: 5,
      verified: 3,
      refuted: 1,
      inconclusive: 1,
      scoutTokens: 15000,
    },
    wallClockMs: 100000,
  };
}

function makeMinimalUnitMetrics(): UnitMetrics {
  return {
    type: "research-milestone",
    id: "M007/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1710000000000,
    finishedAt: 1710000100000,
    tokens: {
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1500,
    },
    cost: 0.01,
    toolCalls: 5,
    assistantMessages: 2,
    userMessages: 1,
  };
}

// ─── Round-Trip Test Helpers ───────────────────────────────────────────────────

function roundTrip<T>(obj: T): T {
  const json = JSON.stringify(obj);
  return JSON.parse(json) as T;
}

function assertTokenCountsEqual(actual: TokenCounts | undefined, expected: TokenCounts, prefix: string): void {
  assertTrue(actual !== undefined, `${prefix}: tokens should be defined`);
  assertEq(actual!.input, expected.input, `${prefix}: tokens.input`);
  assertEq(actual!.output, expected.output, `${prefix}: tokens.output`);
  assertEq(actual!.cacheRead, expected.cacheRead, `${prefix}: tokens.cacheRead`);
  assertEq(actual!.cacheWrite, expected.cacheWrite, `${prefix}: tokens.cacheWrite`);
  assertEq(actual!.total, expected.total, `${prefix}: tokens.total`);
}

function assertInterventionsEqual(
  actual: InterventionCounts | undefined,
  expected: InterventionCounts,
  prefix: string
): void {
  assertTrue(actual !== undefined, `${prefix}: interventions should be defined`);
  assertEq(actual!.blocker, expected.blocker, `${prefix}: interventions.blocker`);
  assertEq(actual!.correction, expected.correction, `${prefix}: interventions.correction`);
  assertEq(actual!.redirect, expected.redirect, `${prefix}: interventions.redirect`);
}

function assertFactCheckEqual(
  actual: FactCheckMetrics | undefined,
  expected: FactCheckMetrics,
  prefix: string
): void {
  assertTrue(actual !== undefined, `${prefix}: factCheck should be defined`);
  assertEq(actual!.claimsChecked, expected.claimsChecked, `${prefix}: factCheck.claimsChecked`);
  assertEq(actual!.verified, expected.verified, `${prefix}: factCheck.verified`);
  assertEq(actual!.refuted, expected.refuted, `${prefix}: factCheck.refuted`);
  assertEq(actual!.inconclusive, expected.inconclusive, `${prefix}: factCheck.inconclusive`);
  assertEq(actual!.scoutTokens, expected.scoutTokens, `${prefix}: factCheck.scoutTokens`);
}

// ─── Tests: Full Metrics Round-Trip ────────────────────────────────────────────

console.log("\n=== Full UnitMetrics round-trip (all fields present) ===");

{
  const original = makeFullUnitMetrics();
  const restored = roundTrip(original);

  // Required fields
  assertEq(restored.type, original.type, "type preserved");
  assertEq(restored.id, original.id, "id preserved");
  assertEq(restored.model, original.model, "model preserved");
  assertEq(restored.startedAt, original.startedAt, "startedAt preserved");
  assertEq(restored.finishedAt, original.finishedAt, "finishedAt preserved");
  assertEq(restored.cost, original.cost, "cost preserved");
  assertEq(restored.toolCalls, original.toolCalls, "toolCalls preserved");
  assertEq(restored.assistantMessages, original.assistantMessages, "assistantMessages preserved");
  assertEq(restored.userMessages, original.userMessages, "userMessages preserved");

  // Nested tokens
  assertTokenCountsEqual(restored.tokens, original.tokens, "tokens");

  // Budget fields
  assertEq(restored.contextWindowTokens, original.contextWindowTokens, "contextWindowTokens preserved");
  assertEq(restored.truncationSections, original.truncationSections, "truncationSections preserved");
  assertEq(restored.continueHereFired, original.continueHereFired, "continueHereFired preserved");
  assertEq(restored.promptCharCount, original.promptCharCount, "promptCharCount preserved");
  assertEq(restored.baselineCharCount, original.baselineCharCount, "baselineCharCount preserved");
  assertEq(restored.tier, original.tier, "tier preserved");
  assertEq(restored.modelDowngraded, original.modelDowngraded, "modelDowngraded preserved");

  // Skills array
  assertTrue(Array.isArray(restored.skills), "skills is array");
  assertEq(restored.skills!.length, original.skills!.length, "skills array length");
  assertEq(restored.skills![0], original.skills![0], "skills[0] preserved");
  assertEq(restored.skills![1], original.skills![1], "skills[1] preserved");
  assertEq(restored.skills![2], original.skills![2], "skills[2] preserved");

  // M007: interventions
  assertInterventionsEqual(restored.interventions, original.interventions!, "interventions");

  // M007: factCheck
  assertFactCheckEqual(restored.factCheck, original.factCheck!, "factCheck");

  // M007: wallClockMs
  assertEq(restored.wallClockMs, original.wallClockMs, "wallClockMs preserved");
}

// ─── Tests: Minimal Metrics Round-Trip ────────────────────────────────────────

console.log("\n=== Minimal UnitMetrics round-trip (optional fields omitted) ===");

{
  const original = makeMinimalUnitMetrics();
  const restored = roundTrip(original);

  // Required fields must be present
  assertEq(restored.type, original.type, "minimal: type preserved");
  assertEq(restored.id, original.id, "minimal: id preserved");
  assertEq(restored.model, original.model, "minimal: model preserved");
  assertEq(restored.startedAt, original.startedAt, "minimal: startedAt preserved");
  assertEq(restored.finishedAt, original.finishedAt, "minimal: finishedAt preserved");
  assertEq(restored.cost, original.cost, "minimal: cost preserved");
  assertEq(restored.toolCalls, original.toolCalls, "minimal: toolCalls preserved");
  assertEq(restored.assistantMessages, original.assistantMessages, "minimal: assistantMessages preserved");
  assertEq(restored.userMessages, original.userMessages, "minimal: userMessages preserved");
  assertTokenCountsEqual(restored.tokens, original.tokens, "minimal: tokens");

  // Optional fields must be absent
  assertEq(restored.contextWindowTokens, undefined, "minimal: contextWindowTokens absent");
  assertEq(restored.truncationSections, undefined, "minimal: truncationSections absent");
  assertEq(restored.continueHereFired, undefined, "minimal: continueHereFired absent");
  assertEq(restored.promptCharCount, undefined, "minimal: promptCharCount absent");
  assertEq(restored.baselineCharCount, undefined, "minimal: baselineCharCount absent");
  assertEq(restored.tier, undefined, "minimal: tier absent");
  assertEq(restored.modelDowngraded, undefined, "minimal: modelDowngraded absent");
  assertEq(restored.skills, undefined, "minimal: skills absent");
  assertEq(restored.interventions, undefined, "minimal: interventions absent");
  assertEq(restored.factCheck, undefined, "minimal: factCheck absent");
  assertEq(restored.wallClockMs, undefined, "minimal: wallClockMs absent");
}

// ─── Tests: Partial Optional Fields ────────────────────────────────────────────

console.log("\n=== Partial optional fields round-trip ===");

{
  // Only skills, no other optionals
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    skills: ["test-skill"],
  };
  const restored = roundTrip(original);

  assertEq(restored.skills!.length, 1, "partial: skills length");
  assertEq(restored.skills![0], "test-skill", "partial: skills[0]");
  assertEq(restored.interventions, undefined, "partial: interventions still absent");
  assertEq(restored.factCheck, undefined, "partial: factCheck still absent");
}

{
  // Only interventions, no other optionals
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    interventions: { blocker: 5, correction: 0, redirect: 2 },
  };
  const restored = roundTrip(original);

  assertInterventionsEqual(restored.interventions, { blocker: 5, correction: 0, redirect: 2 }, "partial: interventions");
  assertEq(restored.factCheck, undefined, "partial: factCheck still absent");
  assertEq(restored.skills, undefined, "partial: skills still absent");
}

{
  // Only factCheck, no other optionals
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    factCheck: { claimsChecked: 1, verified: 1, refuted: 0, inconclusive: 0, scoutTokens: 500 },
  };
  const restored = roundTrip(original);

  assertFactCheckEqual(
    restored.factCheck,
    { claimsChecked: 1, verified: 1, refuted: 0, inconclusive: 0, scoutTokens: 500 },
    "partial: factCheck"
  );
  assertEq(restored.interventions, undefined, "partial: interventions still absent");
  assertEq(restored.skills, undefined, "partial: skills still absent");
}

{
  // Only wallClockMs, derived from timestamps
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    wallClockMs: 25000,
  };
  const restored = roundTrip(original);

  assertEq(restored.wallClockMs, 25000, "partial: wallClockMs preserved");
  assertEq(restored.interventions, undefined, "partial: interventions still absent");
}

// ─── Tests: Edge Cases ────────────────────────────────────────────────────────

console.log("\n=== Edge cases ===");

{
  // Zero values in nested objects
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    interventions: { blocker: 0, correction: 0, redirect: 0 },
    factCheck: { claimsChecked: 0, verified: 0, refuted: 0, inconclusive: 0, scoutTokens: 0 },
  };
  const restored = roundTrip(original);

  assertInterventionsEqual(restored.interventions!, { blocker: 0, correction: 0, redirect: 0 }, "edge: zero interventions");
  assertFactCheckEqual(restored.factCheck!, { claimsChecked: 0, verified: 0, refuted: 0, inconclusive: 0, scoutTokens: 0 }, "edge: zero factCheck");
}

{
  // Empty skills array
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    skills: [],
  };
  const restored = roundTrip(original);

  assertTrue(Array.isArray(restored.skills), "edge: skills is array");
  assertEq(restored.skills!.length, 0, "edge: empty skills array preserved");
}

{
  // Very large numbers (typical for tokens and costs)
  const original: UnitMetrics = {
    ...makeMinimalUnitMetrics(),
    tokens: {
      input: 10_000_000,
      output: 5_000_000,
      cacheRead: 8_000_000,
      cacheWrite: 2_000_000,
      total: 25_000_000,
    },
    cost: 999.9999,
    wallClockMs: 86400000, // 24 hours in ms
  };
  const restored = roundTrip(original);

  assertTokenCountsEqual(restored.tokens, original.tokens, "edge: large tokens");
  assertEq(restored.cost, 999.9999, "edge: large cost preserved");
  assertEq(restored.wallClockMs, 86400000, "edge: large wallClockMs preserved");
}

// ─── Tests: JSONL Line Format ──────────────────────────────────────────────────

console.log("\n=== JSONL line format ===");

{
  const unit = makeFullUnitMetrics();
  const jsonLine = JSON.stringify(unit);

  // Must be single-line (no embedded newlines)
  assertNoMatch(jsonLine, /\n/, "JSONL: no embedded newlines");

  // Must be parseable
  const parsed = JSON.parse(jsonLine) as UnitMetrics;
  assertEq(parsed.id, unit.id, "JSONL: parseable back to object");

  // Must contain all expected fields
  assertMatch(jsonLine, /"type":"execute-task"/, "JSONL: contains type");
  assertMatch(jsonLine, /"interventions":/, "JSONL: contains interventions");
  assertMatch(jsonLine, /"factCheck":/, "JSONL: contains factCheck");
  assertMatch(jsonLine, /"wallClockMs":/, "JSONL: contains wallClockMs");
  assertMatch(jsonLine, /"skills":\[/, "JSONL: contains skills array");
}

// ─── Final Report ─────────────────────────────────────────────────────────────

report();