// GSD Extension — ADR-011 Progressive Planning tests
// Sketch detection → refining phase, dispatch routing, auto-heal, migration idempotency.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  setSliceSketchFlag,
  autoHealSketchFlags,
  getSlice,
} from "../gsd-db.ts";
import { deriveStateFromDb } from "../state.ts";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";

function makeFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  return base;
}

function writePreferences(base: string, phasesBlock: string): void {
  const prefsPath = join(base, ".gsd", "PREFERENCES.md");
  const body = [
    "---",
    "version: 1",
    phasesBlock,
    "---",
  ].join("\n");
  writeFileSync(prefsPath, body);
}

function seedMilestoneWithSketchedS02(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  // S01: full slice, complete
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Foundation",
    status: "complete",
    risk: "high",
    depends: [],
    demo: "S01 done.",
    sequence: 1,
    isSketch: false,
  });
  // S02: sketch slice, pending
  insertSlice({
    id: "S02",
    milestoneId: "M001",
    title: "Feature",
    status: "pending",
    risk: "medium",
    depends: ["S01"],
    demo: "S02 demo.",
    sequence: 2,
    isSketch: true,
    sketchScope: "Scope limited to feature X in module Y; no cross-cutting refactors.",
  });
}

function writeS01Artifacts(base: string): void {
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "# S01 Plan\n");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"), "# S01 Summary\n");
}

function cleanup(base: string, originalCwd: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  process.chdir(originalCwd);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011: sketch slice + progressive_planning ON → phase='refining'", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);

  const state = await deriveStateFromDb(base);
  assert.equal(state.activeSlice?.id, "S02", "S02 should be the active slice (S01 complete)");
  assert.equal(state.phase, "refining", "sketch slice with flag ON must yield refining phase");
});

test("ADR-011: sketch slice + progressive_planning OFF → phase='planning' (backwards compat)", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  // Write a PREFERENCES.md without the flag so loadEffectiveGSDPreferences finds
  // a valid file but progressive_planning resolves to undefined.
  writePreferences(base, "phases:\n  skip_research: false");
  process.chdir(base);

  const state = await deriveStateFromDb(base);
  assert.equal(state.activeSlice?.id, "S02");
  assert.equal(state.phase, "planning", "flag absent → must fall through to planning");
});

test("ADR-011: dispatch rule maps refining → refine-slice unit", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);

  const state = await deriveStateFromDb(base);
  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state,
    // Disable reassess-roadmap so it doesn't fire first on the just-completed S01.
    prefs: { phases: { progressive_planning: true, reassess_after_slice: false } } as any,
  };
  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "refine-slice");
    assert.equal(result.unitId, "M001/S02");
  }
});

test("ADR-011: refining + flag flipped OFF mid-milestone → falls through to plan-slice (no dead-end)", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  // prefs ON so state derivation yields 'refining'...
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);
  const state = await deriveStateFromDb(base);
  assert.equal(state.phase, "refining");

  // ...then dispatch is invoked with the flag OFF (simulates user toggling
  // progressive_planning off while a slice sits in 'refining'). The rule
  // must gracefully downgrade to plan-slice, not return null (dead-end).
  const ctx: DispatchContext = {
    basePath: base,
    mid: "M001",
    midTitle: "Test",
    state,
    prefs: { phases: { progressive_planning: false, reassess_after_slice: false } } as any,
  };
  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "dispatch");
  if (result.action === "dispatch") {
    assert.equal(result.unitType, "plan-slice", "flag-off must downgrade to plan-slice");
  }
});

test("ADR-011: autoHealSketchFlags flips is_sketch=0 when PLAN file exists", async (t) => {
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  // Simulate crash between plan-slice write and sketch flip: PLAN.md exists
  // but is_sketch is still 1.
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-PLAN.md"),
    "# S02 Plan\n",
  );
  assert.equal(getSlice("M001", "S02")?.is_sketch, 1, "pre: flagged as sketch");

  const { existsSync } = await import("node:fs");
  autoHealSketchFlags("M001", (sid) => {
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", sid, `${sid}-PLAN.md`);
    return existsSync(planPath);
  });

  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "post-heal: flag cleared");
});

test("ADR-011: schema v16 is idempotent — re-opening DB preserves is_sketch and sketch_scope columns", async (t) => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-schema-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    // Restore cwd even though this test doesn't chdir — guards against
    // leaked cwd from any earlier test in the file.
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  const dbPath = join(base, "gsd.db");
  openDatabase(dbPath);
  // Insert a sketch slice — round-trip proves the columns exist with correct
  // defaults. If migration hadn't run, insertSlice would throw on the new
  // named params.
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "X",
    isSketch: true,
    sketchScope: "narrow scope",
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "narrow scope");

  // Close and re-open — migration must be a no-op the second time and
  // data must persist.
  closeDatabase();
  openDatabase(dbPath);
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1, "data survives re-open");
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "narrow scope");

  // Inserting a full (non-sketch) slice uses the default column values.
  insertSlice({ id: "S02", milestoneId: "M001", title: "Y" });
  assert.equal(getSlice("M001", "S02")?.is_sketch, 0, "default is_sketch=0");
  assert.equal(getSlice("M001", "S02")?.sketch_scope, "", "default sketch_scope=''");

  // setSliceSketchFlag round-trip.
  setSliceSketchFlag("M001", "S01", false);
  assert.equal(getSlice("M001", "S01")?.is_sketch, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011: insertSlice ON CONFLICT sketch-flag preservation matrix
// ═══════════════════════════════════════════════════════════════════════════
// Regression coverage for the 3-valued isSketch semantics (true/false/undefined).
// Re-planning a milestone must NOT silently flip a sketch slice to non-sketch
// (or vice versa) unless the caller explicitly intends the change.

test("ADR-011 ON CONFLICT: omitted isSketch preserves existing is_sketch=1", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  // Seed: S01 is a sketch.
  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: true, sketchScope: "narrow scope",
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);

  // Re-plan with isSketch omitted (undefined) — MUST preserve sketch state.
  insertSlice({
    id: "S01", milestoneId: "M001", title: "X (updated title)",
    // isSketch intentionally omitted
  });
  assert.equal(
    getSlice("M001", "S01")?.is_sketch, 1,
    "omitted isSketch must preserve the existing sketch flag on ON CONFLICT",
  );
  assert.equal(
    getSlice("M001", "S01")?.sketch_scope, "narrow scope",
    "omitted sketchScope must preserve existing scope on ON CONFLICT",
  );
});

test("ADR-011 ON CONFLICT: explicit isSketch=false clears existing sketch flag", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-false-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: true, sketchScope: "narrow scope",
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);

  // Explicit isSketch=false intentionally clears the flag (e.g., user re-plans
  // sketch as full slice).
  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: false,
  });
  assert.equal(
    getSlice("M001", "S01")?.is_sketch, 0,
    "explicit isSketch=false must clear the sketch flag",
  );
});

test("ADR-011 ON CONFLICT: isSketch=true upgrades existing non-sketch to sketch", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-true-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  // Seed as full slice.
  insertSlice({ id: "S01", milestoneId: "M001", title: "X" });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 0);

  // Re-plan upgrading to sketch.
  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: true, sketchScope: "new scope",
  });
  assert.equal(getSlice("M001", "S01")?.is_sketch, 1);
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "new scope");
});

test("ADR-011 ON CONFLICT: empty-string sketchScope clears existing scope (not preserves it)", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-adr011-conflict-empty-"));
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  openDatabase(join(base, "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });

  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: true, sketchScope: "existing scope",
  });
  // Explicit empty string is the caller saying "clear it" — must not be
  // treated as absent (the `?? null` footgun the peer review flagged).
  insertSlice({
    id: "S01", milestoneId: "M001", title: "X",
    isSketch: false, sketchScope: "",
  });
  assert.equal(getSlice("M001", "S01")?.sketch_scope, "", "explicit '' must clear, not preserve");
});

// ═══════════════════════════════════════════════════════════════════════════
// ADR-011 Phase 3 — Integration: Progressive Planning
// ═══════════════════════════════════════════════════════════════════════════

test("ADR-011 P3 #19: refine-slice prompt incorporates prior slice findings + sketch scope as hard constraint", async (t) => {
  // Exercises the end-to-end path that makes progressive planning useful:
  //   1. M001 has 3 slices. S01 is full and complete, with a SUMMARY.md that
  //      contains specific findings. S02 is a sketch that depends on S01.
  //   2. The refining-phase dispatch builds S02's prompt via buildRefineSlicePrompt.
  //   3. The generated prompt must contain BOTH the S01 findings (via
  //      inlineDependencySummaries, same path plan-slice uses) AND the stored
  //      sketch_scope prepended as a hard-constraint block (escalation-free
  //      Phase 1 contract).
  //
  // This is the core value proposition of ADR-011: refine against the latest
  // codebase state + upstream findings, not the blank snapshot from initial
  // plan-milestone. If either piece is missing, the refine flow has regressed.
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Integration test milestone", status: "active" });
  insertSlice({
    id: "S01", milestoneId: "M001", title: "Foundation",
    status: "complete", risk: "high", depends: [], sequence: 1,
    isSketch: false,
  });
  insertSlice({
    id: "S02", milestoneId: "M001", title: "Feature built on foundation",
    status: "pending", risk: "medium", depends: ["S01"], sequence: 2,
    isSketch: true,
    sketchScope: "Feature X in module Y only; do not refactor the foundation.",
  });
  insertSlice({
    id: "S03", milestoneId: "M001", title: "Polish",
    status: "pending", risk: "low", depends: ["S02"], sequence: 3,
    isSketch: true,
    sketchScope: "Polish + docs for Feature X.",
  });

  // Minimal roadmap so inlineRoadmapExcerpt has something to read.
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "ROADMAP.md"),
    [
      "# M001: Integration test milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:high` `depends:[]`",
      "- [ ] **S02: Feature built on foundation** `risk:medium` `depends:[S01]`",
      "- [ ] **S03: Polish** `risk:low` `depends:[S02]`",
      "",
    ].join("\n"),
  );

  // Write S01 artifacts — the SUMMARY carries findings that S02's refine pass
  // must incorporate. The specific markers below are what the assertion pins.
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
    "# S01 Plan\n",
  );
  const s01Findings = [
    "# S01 Summary",
    "",
    "## Findings",
    "",
    "- FINDING-MARKER-AUTH: chose JWT over sessions for statelessness.",
    "- FINDING-MARKER-DB: schema v17 migration required before S02 can safely add the feature table.",
    "",
    "## Key Decisions",
    "",
    "- Do not introduce a background worker yet — premature.",
  ].join("\n");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
    s01Findings,
  );

  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);

  // Build the refine prompt for S02 — the same call the refining-phase
  // dispatch rule would make in production.
  const { buildRefineSlicePrompt } = await import("../auto-prompts.ts");
  const prompt = await buildRefineSlicePrompt(
    "M001", "Integration test milestone", "S02", "Feature built on foundation", base,
  );

  // ── Sketch scope injected as a hard constraint ─────────────────────────
  assert.match(
    prompt,
    /## Sketch Scope \(hard constraint\)/,
    "refine prompt must frame sketch_scope as a hard constraint",
  );
  assert.match(
    prompt,
    /Feature X in module Y only/,
    "refine prompt must include the stored sketch_scope text verbatim",
  );

  // ── Prior slice findings carried forward from S01-SUMMARY ──────────────
  assert.match(
    prompt,
    /FINDING-MARKER-AUTH/,
    "S01's auth finding must surface in the S02 refine prompt",
  );
  assert.match(
    prompt,
    /FINDING-MARKER-DB/,
    "S01's DB finding must surface in the S02 refine prompt",
  );
  assert.match(
    prompt,
    /S01 Summary/,
    "inlineDependencySummaries must label the injected block with S01's section header",
  );

  // ── Not the stale blank-slate plan-slice framing ───────────────────────
  // The refine prompt is a *transformation*, not a blank-sheet plan. Pin the
  // distinction so future prompt edits don't silently collapse the two paths.
  assert.doesNotMatch(
    prompt,
    /Prior Sketch Scope \(soft hint — non-binding\)/,
    "refine prompt must NOT use the soft-hint framing (that's the plan-slice flag-off downgrade)",
  );
});

test("ADR-011 P3 #26: refine-slice dispatch latency is bounded vs plan-slice baseline", async (t) => {
  // Pins the Zylos 2026 research claim that progressive planning trades a
  // small dispatch-time cost for significant plan quality. The refine path
  // does extra work: it reads sketch_scope from the DB and inlines the
  // dependency summaries. Neither operation should dominate the prompt build.
  //
  // Absolute: < 500ms wall clock. Relative: < 3x plan-slice baseline.
  // Both bounds are deliberately generous — this test is a regression gate,
  // not a benchmark. The goal is catching accidental O(N) fs walks or DB
  // queries that would multiply dispatch time as milestones grow.
  const originalCwd = process.cwd();
  const base = makeFixtureBase();
  t.after(() => cleanup(base, originalCwd));

  seedMilestoneWithSketchedS02(base);
  writeS01Artifacts(base);
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "## Slices",
      "",
      "- [x] **S01: Foundation** `risk:high` `depends:[]`",
      "- [ ] **S02: Feature** `risk:medium` `depends:[S01]`",
      "",
    ].join("\n"),
  );
  writePreferences(base, "phases:\n  progressive_planning: true");
  process.chdir(base);

  const { buildRefineSlicePrompt, buildPlanSlicePrompt } = await import("../auto-prompts.ts");

  // Warm-up pass — first call loads the prompt template from disk and primes
  // fs/DB caches. Measuring the cold path would be noisy and misleading.
  await buildPlanSlicePrompt("M001", "Test", "S02", "Feature", base);
  await buildRefineSlicePrompt("M001", "Test", "S02", "Feature", base);

  const planStart = Date.now();
  await buildPlanSlicePrompt("M001", "Test", "S02", "Feature", base);
  const planElapsed = Date.now() - planStart;

  const refineStart = Date.now();
  await buildRefineSlicePrompt("M001", "Test", "S02", "Feature", base);
  const refineElapsed = Date.now() - refineStart;

  assert.ok(
    refineElapsed < 500,
    `refine-slice prompt build must complete under 500ms (took ${refineElapsed}ms)`,
  );
  // Guard the ratio only when the baseline is large enough to be meaningful —
  // if plan-slice measures 0-2ms the ratio is dominated by timer noise.
  if (planElapsed >= 5) {
    assert.ok(
      refineElapsed < planElapsed * 3,
      `refine-slice must not exceed 3x plan-slice baseline (refine=${refineElapsed}ms, plan=${planElapsed}ms)`,
    );
  }
});
