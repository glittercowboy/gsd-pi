/**
 * Model UnitType Mapping — regression tests for #2865.
 *
 * Verifies that all auto-dispatch unitTypes have corresponding entries in:
 * - resolveModelWithFallbacksForUnit (preferences-models.ts)
 * - classifyUnitPhase (metrics.ts)
 * - LIFECYCLE_ONLY_UNITS (auto-post-unit.ts)
 * - unitVerb / unitPhaseLabel (auto-dashboard.ts)
 * - resolveExpectedArtifactPath (auto-artifact-paths.ts)
 *
 * Uses source-level checks to avoid import resolution issues in dev.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

function readSrc(file: string): string {
  return readFileSync(join(gsdDir, file), "utf-8");
}

const preferencesSrc = readSrc("preferences-models.ts");
const metricsSrc = readSrc("metrics.ts");
const postUnitSrc = readSrc("auto-post-unit.ts");
const dashboardSrc = readSrc("auto-dashboard.ts");
const artifactSrc = readSrc("auto-artifact-paths.ts");
const guidedFlowSrc = readSrc("guided-flow.ts");
const autoDispatchSrc = readSrc("auto-dispatch.ts");

// Derive unitTypes directly from auto-dispatch.ts source so the test
// automatically tracks dispatch rule changes (Copilot review feedback).
const AUTO_DISPATCH_UNIT_TYPES = (() => {
  const unitTypeRegex = /unitType:\s*["']([^"']+)["']/g;
  const unitTypes = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = unitTypeRegex.exec(autoDispatchSrc)) !== null) {
    unitTypes.add(match[1]);
  }
  return Array.from(unitTypes);
})();

// Additionally include unitTypes used by guided-flow but not auto-dispatch
// (e.g., discuss-slice is dispatched by guided-flow but not auto-dispatch).
const ALL_KNOWN_UNIT_TYPES = [
  ...new Set([...AUTO_DISPATCH_UNIT_TYPES, "discuss-slice"]),
];

// ═══════════════════════════════════════════════════════════════════════════
// #2865: discuss dispatches must NOT alias to plan unitTypes
// ═══════════════════════════════════════════════════════════════════════════

test("#2865: no dispatchWorkflow with gsd-discuss customType uses plan-milestone", () => {
  // Match dispatchWorkflow calls where "gsd-discuss" appears before "plan-milestone"
  // in the same call (the 5 args are on consecutive lines).
  const blocks = guidedFlowSrc.split(/dispatchWorkflow\(/);
  for (const block of blocks) {
    const callEnd = block.indexOf(");");
    if (callEnd === -1) continue;
    const call = block.slice(0, callEnd);
    if (call.includes('"gsd-discuss"') && call.includes('"plan-milestone"')) {
      assert.fail(`Discuss dispatch should not use plan-milestone: ...dispatchWorkflow(${call.slice(0, 120).trim()}...`);
    }
  }
});

test("#2865: no dispatchWorkflow with gsd-discuss customType uses plan-slice", () => {
  const blocks = guidedFlowSrc.split(/dispatchWorkflow\(/);
  for (const block of blocks) {
    const callEnd = block.indexOf(");");
    if (callEnd === -1) continue;
    const call = block.slice(0, callEnd);
    if (call.includes('"gsd-discuss"') && call.includes('"plan-slice"')) {
      assert.fail(`Discuss slice dispatch should not use plan-slice: ...dispatchWorkflow(${call.slice(0, 120).trim()}...`);
    }
  }
});

test("#2865: no buildDiscussPrompt call dispatches with plan-milestone", () => {
  const blocks = guidedFlowSrc.split(/dispatchWorkflow\(/);
  for (const block of blocks) {
    const callEnd = block.indexOf(");");
    if (callEnd === -1) continue;
    const call = block.slice(0, callEnd);
    if (call.includes("buildDiscussPrompt") && call.includes('"plan-milestone"')) {
      assert.fail(`buildDiscussPrompt dispatch should not use plan-milestone`);
    }
  }
});

test("#2865: no buildDiscussSlicePrompt call dispatches with plan-slice", () => {
  const blocks = guidedFlowSrc.split(/dispatchWorkflow\(/);
  for (const block of blocks) {
    const callEnd = block.indexOf(");");
    if (callEnd === -1) continue;
    const call = block.slice(0, callEnd);
    if (call.includes("buildDiscussSlicePrompt") && call.includes('"plan-slice"')) {
      assert.fail(`buildDiscussSlicePrompt dispatch should not use plan-slice`);
    }
  }
});

test("#2865: no guided-discuss-milestone loadPrompt dispatches with plan-milestone", () => {
  const blocks = guidedFlowSrc.split(/dispatchWorkflow\(/);
  for (const block of blocks) {
    const callEnd = block.indexOf(");");
    if (callEnd === -1) continue;
    const call = block.slice(0, callEnd);
    if (call.includes("guided-discuss-milestone") && call.includes('"plan-milestone"')) {
      assert.fail(`guided-discuss-milestone dispatch should not use plan-milestone`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// preferences-models.ts: resolveModelWithFallbacksForUnit coverage
// ═══════════════════════════════════════════════════════════════════════════

test("resolveModelWithFallbacksForUnit handles discuss-milestone", () => {
  assert.ok(preferencesSrc.includes('"discuss-milestone"'), "missing discuss-milestone case");
});

test("resolveModelWithFallbacksForUnit handles discuss-slice", () => {
  assert.ok(preferencesSrc.includes('"discuss-slice"'), "missing discuss-slice case");
});

test("discuss unitTypes fall back to planning when models.discuss is unset", () => {
  assert.ok(
    preferencesSrc.includes("m.discuss ?? m.planning"),
    "discuss should fall back to m.planning",
  );
});

test("validation unitTypes fall back to planning when models.validation is unset", () => {
  assert.ok(
    preferencesSrc.includes("m.validation ?? m.planning"),
    "validation should fall back to m.planning",
  );
});

test("all auto-dispatch unitTypes have preference mapping or subagent handling", () => {
  const unmapped: string[] = [];
  for (const ut of ALL_KNOWN_UNIT_TYPES) {
    if (!preferencesSrc.includes(`"${ut}"`)) {
      unmapped.push(ut);
    }
  }
  assert.deepEqual(unmapped, [], `Unmapped unitTypes in preferences-models.ts: ${unmapped.join(", ")}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// #2900: worktree-merge must map to completion phase
// ═══════════════════════════════════════════════════════════════════════════

test("#2900: resolveModelWithFallbacksForUnit handles worktree-merge", () => {
  assert.ok(preferencesSrc.includes('"worktree-merge"'), "missing worktree-merge case in switch");
});

// ═══════════════════════════════════════════════════════════════════════════
// #2900: KNOWN_UNIT_TYPES must include all dispatched unit types
// ═══════════════════════════════════════════════════════════════════════════

const preferenceTypesSrc = readSrc("preferences-types.ts");

test("#2900: KNOWN_UNIT_TYPES includes all auto-dispatch unit types", () => {
  const missing: string[] = [];
  for (const ut of ALL_KNOWN_UNIT_TYPES) {
    if (!preferenceTypesSrc.includes(`"${ut}"`)) {
      missing.push(ut);
    }
  }
  assert.deepEqual(missing, [], `Missing from KNOWN_UNIT_TYPES: ${missing.join(", ")}`);
});

test("#2900: KNOWN_UNIT_TYPES includes worktree-merge", () => {
  assert.ok(preferenceTypesSrc.includes('"worktree-merge"'), "worktree-merge missing from KNOWN_UNIT_TYPES");
});

// ═══════════════════════════════════════════════════════════════════════════
// metrics.ts: classifyUnitPhase coverage
// ═══════════════════════════════════════════════════════════════════════════

test("classifyUnitPhase includes discussion phase", () => {
  assert.ok(metricsSrc.includes('"discussion"'), "MetricsPhase should include discussion");
});

test("classifyUnitPhase maps discuss-milestone and discuss-slice", () => {
  assert.ok(metricsSrc.includes('"discuss-milestone"'), "missing discuss-milestone in metrics");
  assert.ok(metricsSrc.includes('"discuss-slice"'), "missing discuss-slice in metrics");
});

// ═══════════════════════════════════════════════════════════════════════════
// auto-post-unit.ts: LIFECYCLE_ONLY_UNITS
// ═══════════════════════════════════════════════════════════════════════════

test("LIFECYCLE_ONLY_UNITS includes discuss-slice", () => {
  assert.ok(postUnitSrc.includes('"discuss-slice"'), "discuss-slice should be lifecycle-only");
});

// ═══════════════════════════════════════════════════════════════════════════
// auto-dashboard.ts: display label coverage
// ═══════════════════════════════════════════════════════════════════════════

test("unitVerb handles discuss-slice", () => {
  assert.ok(dashboardSrc.includes('"discuss-slice"'), "missing discuss-slice in dashboard");
});

// ═══════════════════════════════════════════════════════════════════════════
// auto-artifact-paths.ts: artifact resolution
// ═══════════════════════════════════════════════════════════════════════════

test("resolveExpectedArtifactPath handles discuss-slice", () => {
  assert.ok(artifactSrc.includes('"discuss-slice"'), "missing discuss-slice in artifact paths");
});
