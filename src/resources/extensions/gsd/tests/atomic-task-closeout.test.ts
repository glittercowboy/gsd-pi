/**
 * Tests for atomic task closeout (#1650):
 * Doctor no longer does checkbox reconciliation (reconciliation removed in S06).
 * This file retains only the non-reconciliation behavior tests.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../doctor.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `atomic-closeout-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("doctor does not touch task with checkbox AND summary both present", async () => {
  const base = makeTmp("doctor-ok");
  const gsd = join(base, ".gsd");
  const m = join(gsd, "milestones", "M001");
  const s = join(m, "slices", "S01");
  const t = join(s, "tasks");
  mkdirSync(t, { recursive: true });

  writeFileSync(join(m, "M001-ROADMAP.md"), `# M001: Test

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > Demo
`);

  writeFileSync(join(s, "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [x] **T01: Do stuff** \`est:5m\`
`);

  writeFileSync(join(t, "T01-SUMMARY.md"), `---
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

  const report = await runGSDDoctor(base, { fix: true });
  // Doctor should not produce any task_done_missing_summary issue (code removed)
  const hasOldCode = report.issues.some(i =>
    i.code === "task_done_missing_summary" as any ||
    i.code === "task_summary_without_done_checkbox" as any
  );
  assert.ok(!hasOldCode, "should not produce removed reconciliation issue codes");

  // Plan should still have T01 checked
  const planContent = readFileSync(join(s, "S01-PLAN.md"), "utf-8");
  assert.ok(planContent.includes("- [x] **T01:"), "T01 should remain checked");

  rmSync(base, { recursive: true, force: true });
});
