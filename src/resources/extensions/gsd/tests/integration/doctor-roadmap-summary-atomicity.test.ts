/**
 * Regression test for #1910: Doctor marks roadmap checkbox at fixLevel="task"
 * without summary on disk.
 *
 * With reconciliation codes removed (S06), doctor no longer marks roadmap
 * checkboxes at all. These tests verify the reconciliation is truly gone:
 * no checkbox toggling, no stub creation.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../../doctor.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-roadmap-summary-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

test("fixLevel:task — roadmap checkbox is never toggled by doctor (reconciliation removed)", async (t) => {
  const tmp = makeTmp("no-roadmap-toggle");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

  // Roadmap must remain unchecked — doctor no longer touches checkboxes
  const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
  assert.ok(
    roadmapContent.includes("- [ ] **S01"),
    "roadmap should remain unchecked — doctor no longer toggles checkboxes"
  );

  // No summary or UAT stubs created
  const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  assert.ok(!existsSync(sliceSummaryPath), "summary should NOT be created");
});

test("fixLevel:all — roadmap checkbox is never toggled by doctor (reconciliation removed)", async (t) => {
  const tmp = makeTmp("all-no-toggle");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  const report = await runGSDDoctor(tmp, { fix: true });

  // Even at fixLevel:all, doctor no longer creates stubs or toggles checkboxes
  const roadmapContent = readFileSync(join(tmp, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "utf8");
  assert.ok(
    roadmapContent.includes("- [ ] **S01"),
    "roadmap should remain unchecked — reconciliation removed"
  );

  const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  assert.ok(!existsSync(sliceSummaryPath), "summary should NOT be created");
});

test("consecutive doctor runs produce no reconciliation codes", async (t) => {
  const tmp = makeTmp("consecutive-clean");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });
  const report2 = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

  const REMOVED_CODES = [
    "task_done_missing_summary",
    "task_summary_without_done_checkbox",
    "all_tasks_done_missing_slice_summary",
    "all_tasks_done_missing_slice_uat",
    "all_tasks_done_roadmap_not_checked",
    "slice_checked_missing_summary",
    "slice_checked_missing_uat",
  ];

  const codes = report2.issues.map(i => i.code);
  for (const removed of REMOVED_CODES) {
    assert.ok(!codes.includes(removed as any), `should NOT report removed code: ${removed}`);
  }
});
