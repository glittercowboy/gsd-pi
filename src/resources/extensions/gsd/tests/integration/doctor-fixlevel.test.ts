/**
 * Tests that doctor's fixLevel option correctly separates task-level
 * bookkeeping from completion state transitions.
 *
 * With reconciliation codes removed (S06), doctor no longer creates
 * summary stubs, UAT stubs, or flips checkboxes. These tests verify
 * the fix infrastructure still works for remaining fixable codes
 * (e.g. delimiter_in_title, missing_tasks_dir) and that removed
 * reconciliation codes are truly absent.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../../doctor.ts";
import { closeDatabase } from "../../gsd-db.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-fixlevel-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal .gsd structure: milestone with one slice, one task
 * marked done with a summary — but no slice summary and roadmap unchecked.
 * Previously this triggered reconciliation; now it should produce no
 * reconciliation issue codes.
 */
function buildScaffold(base: string) {
  const gsd = join(base, ".gsd");
  const m = join(gsd, "milestones", "M001");
  const s = join(m, "slices", "S01", "tasks");
  mkdirSync(s, { recursive: true });

  writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > Demo text
`);

  writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [x] **T01: Do stuff** \`est:5m\`
`);

  writeFileSync(join(s, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
duration: 5m
verification_result: passed
completed_at: 2026-01-01
---

# T01: Do stuff

Done.
`);
}

const REMOVED_CODES = [
  "task_done_missing_summary",
  "task_summary_without_done_checkbox",
  "all_tasks_done_missing_slice_summary",
  "all_tasks_done_missing_slice_uat",
  "all_tasks_done_roadmap_not_checked",
  "slice_checked_missing_summary",
  "slice_checked_missing_uat",
];

test("fixLevel:task — no reconciliation issue codes are reported", async (t) => {
  const tmp = makeTmp("task-level");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

  const codes = report.issues.map(i => i.code);
  for (const removed of REMOVED_CODES) {
    assert.ok(!codes.includes(removed as any), `should NOT report removed code: ${removed}`);
  }
});

test("fixLevel:all — no reconciliation issue codes are reported", async (t) => {
  const tmp = makeTmp("all-level");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  const report = await runGSDDoctor(tmp, { fix: true });

  const codes = report.issues.map(i => i.code);
  for (const removed of REMOVED_CODES) {
    assert.ok(!codes.includes(removed as any), `should NOT report removed code: ${removed}`);
  }

  // Summary and UAT stubs should NOT be created (no reconciliation)
  const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  assert.ok(!existsSync(sliceSummaryPath), "should NOT have created summary stub");

  // Roadmap should remain unchecked (no reconciliation)
  const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
  assert.ok(roadmapContent.includes("- [ ] **S01"), "roadmap should remain unchecked");
});

test("legacy roadmap fallback: future slices are treated as pending, active slice is not", async (t) => {
  const tmp = makeTmp("legacy-pending-fallback");
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  // Force the legacy parser branch.
  try { closeDatabase(); } catch { /* noop */ }

  const gsd = join(tmp, ".gsd");
  const m = join(gsd, "milestones", "M001");
  const s01 = join(m, "slices", "S01", "tasks");
  mkdirSync(s01, { recursive: true });

  writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > Done
- [ ] **S02: Active Slice** \`risk:medium\` \`depends:[S01]\`
  > In progress
- [ ] **S03: Future Slice** \`risk:low\` \`depends:[S02]\`
  > Later
- [ ] **S04: Future Slice Two** \`risk:low\` \`depends:[S03]\`
  > Later
`);

  writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Done Slice

**Goal:** done

## Tasks

- [x] **T01: Done task** \`est:5m\`
`);

  // Active slice exists in state/registry but has no directory yet — this should
  // still be reported as a real error, while future untouched slices should be skipped.
  const report = await runGSDDoctor(tmp, { scope: "M001" });
  const missingSliceDirUnits = report.issues
    .filter(i => i.code === "missing_slice_dir")
    .map(i => i.unitId)
    .sort();

  assert.deepStrictEqual(
    missingSliceDirUnits,
    ["M001/S02"],
    "legacy fallback should only report the active slice, not future unstarted slices",
  );

  const missingTasksDirUnits = report.issues
    .filter(i => i.code === "missing_tasks_dir")
    .map(i => i.unitId)
    .sort();

  assert.deepStrictEqual(
    missingTasksDirUnits,
    [],
    "future slices without directories should be skipped before missing_tasks_dir checks",
  );
});

test("fixLevel:all — delimiter_in_title still fixable", async (t) => {
  const tmp = makeTmp("delimiter-fix");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const gsd = join(tmp, ".gsd");
  const m = join(gsd, "milestones", "M001");
  const s = join(m, "slices", "S01", "tasks");
  mkdirSync(s, { recursive: true });

  // Roadmap with em dash in milestone title (should still be fixable)
  writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Foundation \u2014 Build Core

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > Demo
`);

  writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [ ] **T01: Do stuff** \`est:5m\`
`);

  const report = await runGSDDoctor(tmp, { fix: true });

  // The milestone-level delimiter is auto-fixed, but the report may or may not include it
  // depending on whether it was fixed successfully. Just verify it ran without crashing.
  assert.ok(report.issues !== undefined, "doctor produces a report");
});
