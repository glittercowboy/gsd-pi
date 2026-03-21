/**
 * Regression test for #1910: Doctor marks roadmap checkbox at fixLevel="task"
 * without summary on disk, causing deriveState() to skip complete-slice and
 * hard-stop at validating-milestone.
 *
 * The roadmap checkbox must only be marked when the slice summary actually
 * exists on disk (either pre-existing or created in the current doctor run).
 * At fixLevel="task", the summary is deferred (COMPLETION_TRANSITION_CODES),
 * so the roadmap checkbox must also be deferred.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../doctor.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-roadmap-summary-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build a minimal .gsd structure: milestone with one slice, one task
 * marked done with a summary — but no slice summary and roadmap unchecked.
 * This is the state after the last task completes.
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

test("fixLevel:task — must NOT mark roadmap checkbox when summary does not exist on disk (#1910)", async () => {
  const tmp = makeTmp("no-roadmap-without-summary");
  try {
    buildScaffold(tmp);

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Doctor should detect both issues
    const codes = report.issues.map(i => i.code);
    assert.ok(codes.includes("all_tasks_done_missing_slice_summary"), "should detect missing summary");
    assert.ok(codes.includes("all_tasks_done_roadmap_not_checked"), "should detect unchecked roadmap");

    // Summary should NOT exist (deferred at task level)
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(!existsSync(sliceSummaryPath), "summary should NOT be created (deferred)");

    // CRITICAL: Roadmap checkbox must NOT be checked without summary on disk.
    // If it is checked, deriveState() sees the milestone as complete and skips
    // the summarizing phase, causing a hard-stop at validating-milestone.
    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(
      roadmapContent.includes("- [ ] **S01"),
      "roadmap must NOT mark S01 as checked when summary does not exist on disk"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:task — consecutive runs must not produce slice_checked_missing_summary (#1910)", async () => {
  const tmp = makeTmp("no-cascade-error");
  try {
    buildScaffold(tmp);

    // First doctor run at task level
    await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Second doctor run — if the first run incorrectly checked the roadmap,
    // this run would detect slice_checked_missing_summary (the cascade error
    // described in the issue's forensic evidence).
    const report2 = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });
    const codes2 = report2.issues.map(i => i.code);

    assert.ok(
      !codes2.includes("slice_checked_missing_summary"),
      "must not produce slice_checked_missing_summary — roadmap should not have been checked without summary"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:all — roadmap checkbox IS marked because summary is created in same run (#1910)", async () => {
  const tmp = makeTmp("all-level-creates-both");
  try {
    buildScaffold(tmp);

    const report = await runGSDDoctor(tmp, { fix: true });

    // At fixLevel:all, summary stub is created first, then roadmap is checked.
    // Both should be fixed.
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(existsSync(sliceSummaryPath), "summary should be created at fixLevel:all");

    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(roadmapContent.includes("- [x] **S01"), "roadmap should show S01 as checked at fixLevel:all");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fixLevel:task — roadmap IS marked when summary already exists on disk (#1910)", async () => {
  const tmp = makeTmp("summary-preexists");
  try {
    buildScaffold(tmp);

    // Pre-create the slice summary (as if complete-slice already ran)
    const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    writeFileSync(sliceSummaryPath, `---
id: S01
milestone: M001
---

# S01: Test Slice

Summary content.
`);

    const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

    // Summary exists, so roadmap SHOULD be checked even at task level
    const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
    assert.ok(
      roadmapContent.includes("- [x] **S01"),
      "roadmap should be checked when summary already exists on disk"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
