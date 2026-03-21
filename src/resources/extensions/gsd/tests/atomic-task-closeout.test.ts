/**
 * Tests for atomic task closeout (#1650):
 * 1. Doctor unmarks task checkbox when summary is missing (instead of creating stub)
 * 2. markTaskUndoneInPlan correctly unchecks a task in the slice plan
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { runGSDDoctor } from "../doctor.ts";
import { markTaskUndoneInPlan } from "../roadmap-mutations.ts";

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `atomic-closeout-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── markTaskUndoneInPlan ─────────────────────────────────────────────────────

test("markTaskUndoneInPlan unchecks a checked task", () => {
  const base = makeTmp("uncheck");
  const planPath = join(base, "PLAN.md");
  writeFileSync(planPath, `# S01: Demo

## Tasks

- [x] **T01: First task** \`est:5m\`
- [ ] **T02: Second task** \`est:10m\`
`);

  const changed = markTaskUndoneInPlan(base, planPath, "T01");
  assert.ok(changed, "should return true when plan was modified");

  const content = readFileSync(planPath, "utf-8");
  assert.ok(content.includes("- [ ] **T01:"), "T01 should be unchecked");
  assert.ok(content.includes("- [ ] **T02:"), "T02 should remain unchecked");

  rmSync(base, { recursive: true, force: true });
});

test("markTaskUndoneInPlan is idempotent on already-unchecked task", () => {
  const base = makeTmp("uncheck-noop");
  const planPath = join(base, "PLAN.md");
  writeFileSync(planPath, `# S01: Demo

## Tasks

- [ ] **T01: First task** \`est:5m\`
`);

  const changed = markTaskUndoneInPlan(base, planPath, "T01");
  assert.ok(!changed, "should return false when no change needed");

  rmSync(base, { recursive: true, force: true });
});

test("markTaskUndoneInPlan handles indented checkboxes", () => {
  const base = makeTmp("uncheck-indent");
  const planPath = join(base, "PLAN.md");
  writeFileSync(planPath, `# S01: Demo

## Tasks

  - [x] **T01: First task** \`est:5m\`
`);

  const changed = markTaskUndoneInPlan(base, planPath, "T01");
  assert.ok(changed, "should handle indented checkboxes");

  const content = readFileSync(planPath, "utf-8");
  assert.ok(content.includes("[ ] **T01:"), "T01 should be unchecked");

  rmSync(base, { recursive: true, force: true });
});

// ── Doctor: task_done_missing_summary unchecks instead of stubbing ────────────

test("doctor unchecks task when checkbox is marked but summary is missing", async () => {
  const base = makeTmp("doctor-uncheck");
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

  // Task is marked [x] in plan but has no summary file
  writeFileSync(join(s, "S01-PLAN.md"), `# S01: Test Slice

**Goal:** test

## Tasks

- [x] **T01: Do stuff** \`est:5m\`
- [ ] **T02: Other stuff** \`est:5m\`
`);

  // T02 has no summary either, but it's unchecked — should be left alone

  // Run doctor in diagnose mode first
  const diagnoseReport = await runGSDDoctor(base, { fix: false });
  const issue = diagnoseReport.issues.find(i => i.code === "task_done_missing_summary");
  assert.ok(issue, "should detect task_done_missing_summary");
  assert.equal(issue!.severity, "error");

  // Run doctor in fix mode
  const fixReport = await runGSDDoctor(base, { fix: true });
  const fixApplied = fixReport.fixesApplied.some(f => f.includes("unchecked T01"));
  assert.ok(fixApplied, "should have unchecked T01 in the fix log");

  // Verify the plan now has T01 unchecked
  const planContent = readFileSync(join(s, "S01-PLAN.md"), "utf-8");
  assert.ok(planContent.includes("- [ ] **T01:"), "T01 should be unchecked after doctor fix");
  assert.ok(planContent.includes("- [ ] **T02:"), "T02 should remain unchecked");

  // Verify no stub summary was created
  const stubPath = join(t, "T01-SUMMARY.md");
  assert.ok(
    !existsSync(stubPath),
    "should NOT create a stub summary — task should re-execute instead",
  );

  rmSync(base, { recursive: true, force: true });
});

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
  const hasTaskIssue = report.issues.some(i => i.code === "task_done_missing_summary");
  assert.ok(!hasTaskIssue, "should not flag task_done_missing_summary when both exist");

  // Plan should still have T01 checked
  const planContent = readFileSync(join(s, "S01-PLAN.md"), "utf-8");
  assert.ok(planContent.includes("- [x] **T01:"), "T01 should remain checked");

  rmSync(base, { recursive: true, force: true });
});
