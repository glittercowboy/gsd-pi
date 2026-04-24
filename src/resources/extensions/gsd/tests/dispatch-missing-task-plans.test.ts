/**
 * Regression test for issue #909.
 *
 * When S##-PLAN.md exists (causing deriveState → phase:'executing') but the
 * individual task plan files (tasks/T01-PLAN.md, etc.) are absent, the dispatch
 * table must recover by re-running plan-slice — NOT hard-stop.
 *
 * Prior behaviour: action:"stop" → infinite loop on restart.
 * Fixed behaviour: action:"dispatch" unitType:"plan-slice".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M002", title: "Test Milestone" },
    activeSlice: { id: "S03", title: "Third Slice" },
    activeTask: { id: "T01", title: "First Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeContext(basePath: string, stateOverrides?: Partial<GSDState>): DispatchContext {
  return {
    basePath,
    mid: "M002",
    midTitle: "Test Milestone",
    state: makeState(stateOverrides),
    prefs: undefined,
  };
}

// ─── Scaffold helpers ──────────────────────────────────────────────────────

function scaffoldSlicePlan(basePath: string, mid: string, sid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), [
    `# ${sid}: Third Slice`,
    "",
    "## Tasks",
    "- [ ] **T01: Do something** `est:1h`",
    "- [ ] **T02: Do another thing** `est:30m`",
    "",
  ].join("\n"));
}

function scaffoldMilestoneContext(basePath: string, mid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), [
    `# ${mid}: Test Milestone`,
    "",
    "Context for dispatch recovery tests.",
    "",
  ].join("\n"));
}

function scaffoldTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-PLAN.md`), [
    `# ${tid}: Do something`,
    "",
    "## Steps",
    "- [ ] Step 1",
    "",
  ].join("\n"));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("dispatch: missing task plan triggers plan-slice (not stop) — issue #909", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Slice plan exists with tasks, but tasks/ directory is empty
  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch", "should dispatch, not stop");
  assert.ok(result.action === "dispatch" && result.unitType === "plan-slice",
    `unitType should be plan-slice, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03",
    `unitId should be M002/S03, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: present task plan proceeds to execute-task normally", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-ok-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");
  scaffoldTaskPlan(tmp, "M002", "S03", "T01");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03/T01",
    `unitId should be M002/S03/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: plan-slice recovery loop — second call after plan-slice still recovers cleanly", async (t) => {
  // Simulate: plan-slice ran but T01-PLAN.md is still missing (e.g. agent crashed mid-write).
  // Dispatch should still re-dispatch plan-slice, not hard-stop.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-loop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const r1 = await resolveDispatch(ctx);
  assert.equal(r1.action, "dispatch");
  assert.ok(r1.action === "dispatch" && r1.unitType === "plan-slice");

  // Still no task plan written — dispatch again
  const r2 = await resolveDispatch(ctx);
  assert.equal(r2.action, "dispatch");
  assert.ok(r2.action === "dispatch" && r2.unitType === "plan-slice",
    "should keep dispatching plan-slice until task plans appear");
});
