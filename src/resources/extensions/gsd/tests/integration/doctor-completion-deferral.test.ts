/**
 * Regression test for #1808: Completion-transition doctor fix deferral.
 *
 * Reconciliation codes are removed — doctor no longer creates summary/UAT
 * stubs or reports checkbox/file mismatch issues.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../../doctor.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `doctor-deferral-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

test("doctor does not report any reconciliation issue codes", async (t) => {
  const tmp = makeTmp("no-reconciliation");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  buildScaffold(tmp);

  const report = await runGSDDoctor(tmp, { fix: true, fixLevel: "task" });

  const REMOVED_CODES = [
    "task_done_missing_summary",
    "task_summary_without_done_checkbox",
    "all_tasks_done_missing_slice_summary",
    "all_tasks_done_missing_slice_uat",
    "all_tasks_done_roadmap_not_checked",
    "slice_checked_missing_summary",
    "slice_checked_missing_uat",
  ];

  const codes = report.issues.map(i => i.code);
  for (const removed of REMOVED_CODES) {
    assert.ok(!codes.includes(removed as any), `should NOT report removed code: ${removed}`);
  }

  // No summary or UAT stubs should be created
  const sliceSummaryPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  assert.ok(!existsSync(sliceSummaryPath), "should NOT have created summary stub");

  const sliceUatPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md");
  assert.ok(!existsSync(sliceUatPath), "should NOT have created UAT stub");
});
