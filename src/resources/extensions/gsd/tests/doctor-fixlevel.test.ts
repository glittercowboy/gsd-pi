/**
 * Tests that doctor's fixLevel option correctly separates task-level
 * bookkeeping from completion state transitions.
 *
 * fixLevel:"task" — fixes task checkboxes, does NOT create slice summary
 *   stubs, UAT stubs, or mark slices done in the roadmap.
 * fixLevel:"all" (default) — fixes everything including completion transitions.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../doctor.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-fixlevel-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal .gsd structure: milestone with one slice, one task
 * marked done with a summary — but no slice summary and roadmap unchecked.
 * This is exactly the state after the last task completes.
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

test("fixLevel:task — defers only summary stub, fixes roadmap and UAT immediately (#1808)", async () => {
  const tmp = makeTmp("task-level");
  try {
    buildScaffold(tmp);

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Should detect the issues
    const codes = report.issues.map(i => i.code);
    assert.ok(codes.includes("all_tasks_done_missing_slice_summary"), "should detect missing summary");
    assert.ok(codes.includes("all_tasks_done_roadmap_not_checked"), "should detect unchecked roadmap");

    // Summary should NOT be created (still deferred — needs LLM content)
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(!existsSync(sliceSummaryPath), "should NOT have created summary stub");

    // Roadmap SHOULD be marked done (mechanical bookkeeping, no longer deferred)
    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(roadmapContent.includes("- [x] **S01"), "roadmap should show S01 as checked");

    // Fixes applied should NOT include summary but SHOULD include roadmap
    for (const f of report.fixesApplied) {
      assert.ok(!f.includes("SUMMARY"), `should not have fixed summary: ${f}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:all (default) — detects AND fixes completion issues", async () => {
  const tmp = makeTmp("all-level");
  try {
    buildScaffold(tmp);

    const report = await runGSDDoctor(tmp, { fix: true });

    // Should detect the issues
    const codes = report.issues.map(i => i.code);
    assert.ok(codes.includes("all_tasks_done_missing_slice_summary"), "should detect missing summary");
    assert.ok(codes.includes("all_tasks_done_roadmap_not_checked"), "should detect unchecked roadmap");

    // SHOULD have fixed them
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(existsSync(sliceSummaryPath), "should have created summary stub");

    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(roadmapContent.includes("- [x] **S01"), "roadmap should show S01 as checked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:all — marks indented roadmap checkboxes done (#1063)", async () => {
  const tmp = makeTmp("indented-roadmap");
  try {
    buildScaffold(tmp);

    // Overwrite roadmap with indented checkbox (LLM formatting drift)
    writeFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), `# M001: Test

## Slices

  - [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
    > Demo text
`);

    const report = await runGSDDoctor(tmp, { fix: true });

    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    // Should mark [x] while preserving the leading whitespace
    assert.ok(roadmapContent.includes("  - [x] **S01"), "indented roadmap checkbox should be marked done");
    // Verify indentation is preserved: line should start with "  -", not just "-"
    const checkedLine = roadmapContent.split("\n").find(l => l.includes("[x] **S01"));
    assert.ok(checkedLine?.startsWith("  -"), `should preserve leading whitespace, got: "${checkedLine}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:all — marks indented task checkboxes done (#1063)", async () => {
  const tmp = makeTmp("indented-task");
  try {
    const gsd = join(tmp, ".gsd");
    const m = join(gsd, "milestones", "M001");
    const s = join(m, "slices", "S01", "tasks");
    mkdirSync(s, { recursive: true });

    writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
`);

    // Plan with indented checkbox
    writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

  - [ ] **T01: Do stuff** \`est:5m\`
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

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    const planContent = readFileSync(join(m, "slices", "S01", "S01-PLAN.md"), "utf8");
    assert.ok(planContent.includes("  - [x] **T01"), "indented task checkbox should be marked done");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:task — still fixes task-level bookkeeping (checkbox marking)", async () => {
  const tmp = makeTmp("task-checkbox");
  try {
    const gsd = join(tmp, ".gsd");
    const m = join(gsd, "milestones", "M001");
    const s = join(m, "slices", "S01", "tasks");
    mkdirSync(s, { recursive: true });

    writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > Demo text
`);

    // Task NOT checked in plan but has a summary — doctor should mark it done
    writeFileSync(join(m, "slices", "S01", "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [ ] **T01: Do stuff** \`est:5m\`
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

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Should have fixed the task checkbox
    const planContent = readFileSync(join(m, "slices", "S01", "S01-PLAN.md"), "utf8");
    assert.ok(planContent.includes("- [x] **T01"), "should have marked T01 done in plan");

    // Should NOT have touched slice-level completion
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(!existsSync(sliceSummaryPath), "should NOT have created summary stub");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
