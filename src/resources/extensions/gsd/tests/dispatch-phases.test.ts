/**
 * Tests for dispatch phase rules not covered by dispatch-missing-task-plans.test.ts.
 *
 * Covers: needs-discussion, complete, unhandled, pre-planning (no context),
 * pre-planning (skip_research), pre-planning (research-milestone), completing-milestone
 * (missing summary), and planning (plan-slice basic).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M002", title: "Test Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeContext(
  basePath: string,
  stateOverrides?: Partial<GSDState>,
  prefs?: any,
): DispatchContext {
  return {
    basePath,
    mid: "M002",
    midTitle: "Test Milestone",
    state: makeState(stateOverrides),
    prefs: prefs as any,
  };
}

// ─── Test 1: needs-discussion → discuss-milestone ──────────────────────────

test("dispatch: needs-discussion phase → discuss-milestone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const ctx = makeContext(tmp, { phase: "needs-discussion" });
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "dispatch", "should dispatch");
    assert.ok(
      result.action === "dispatch" && result.unitType === "discuss-milestone",
      `unitType should be discuss-milestone, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 2: complete → stop info ─────────────────────────────────────────

test("dispatch: complete phase → stop info with 'All milestones complete'", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const ctx = makeContext(tmp, { phase: "complete" });
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "stop", "should stop");
    assert.ok(
      result.action === "stop" && result.level === "info",
      `level should be info, got: ${result.action === "stop" ? result.level : "(dispatch)"}`,
    );
    assert.ok(
      result.action === "stop" && result.reason.includes("All milestones complete"),
      `reason should mention "All milestones complete", got: ${result.action === "stop" ? result.reason : "(dispatch)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 3: unhandled phase → stop info ──────────────────────────────────

test("dispatch: unhandled phase → stop info with 'Unhandled phase'", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const ctx = makeContext(tmp, { phase: "some-unknown-phase" as never });
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "stop", "should stop");
    assert.ok(
      result.action === "stop" && result.level === "info",
      `level should be info, got: ${result.action === "stop" ? result.level : "(dispatch)"}`,
    );
    assert.ok(
      result.action === "stop" && result.reason.includes("Unhandled phase"),
      `reason should mention "Unhandled phase", got: ${result.action === "stop" ? result.reason : "(dispatch)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 4: pre-planning with no context → discuss-milestone ─────────────

test("dispatch: pre-planning with no CONTEXT file → discuss-milestone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    // Create the milestone directory but no CONTEXT file
    mkdirSync(join(tmp, ".gsd", "milestones", "M002"), { recursive: true });

    const ctx = makeContext(tmp, { phase: "pre-planning" });
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "dispatch", "should dispatch");
    assert.ok(
      result.action === "dispatch" && result.unitType === "discuss-milestone",
      `unitType should be discuss-milestone, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 5: pre-planning with context + skip_research → plan-milestone ───

test("dispatch: pre-planning with context and skip_research:true → dispatch plan-milestone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M002");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M002-CONTEXT.md"), "# M002 Context\n\nSome context.\n");

    const ctx = makeContext(
      tmp,
      { phase: "pre-planning" },
      { phases: { skip_research: true } },
    );
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "dispatch", "should dispatch");
    assert.ok(
      result.action === "dispatch" && result.unitType === "plan-milestone",
      `unitType should be plan-milestone, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 6: pre-planning with context, no research, no skip → research-milestone ──

test("dispatch: pre-planning with context, no research, skip_research false → dispatch research-milestone", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M002");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M002-CONTEXT.md"), "# M002 Context\n\nSome context.\n");
    // Deliberately no RESEARCH file

    const ctx = makeContext(tmp, { phase: "pre-planning" }, undefined);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "dispatch", "should dispatch");
    assert.ok(
      result.action === "dispatch" && result.unitType === "research-milestone",
      `unitType should be research-milestone, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 7: completing-milestone with missing slice SUMMARY → stop error ──

test("dispatch: completing-milestone with missing S02 SUMMARY → stop error mentioning S02", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M002");
    mkdirSync(mDir, { recursive: true });

    // SUMMARY guard is now DB-gated — open a DB with both slices so the check fires
    const dbPath = join(tmp, "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M002", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M002", title: "First slice", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M002", title: "Second slice", status: "complete" });

    // S01 has a SUMMARY, S02 does not
    const s01Dir = join(mDir, "slices", "S01");
    mkdirSync(s01Dir, { recursive: true });
    writeFileSync(join(s01Dir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.\n");

    // Create S02 directory but no SUMMARY
    mkdirSync(join(mDir, "slices", "S02"), { recursive: true });

    const ctx = makeContext(tmp, { phase: "completing-milestone" });
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "stop", "should stop when a slice is missing its SUMMARY file");
    assert.equal(
      result.action === "stop" ? result.level : null,
      "error",
      "stop level should be error",
    );
    assert.ok(
      result.action === "stop" && result.reason.includes("S02"),
      `stop reason should mention the missing slice S02, got: ${result.action === "stop" ? result.reason : "(dispatch)"}`,
    );
  } finally {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 8: planning → plan-slice (basic) ────────────────────────────────

test("dispatch: planning phase with active slice and research skipped → dispatch plan-slice", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-phases-"));
  try {
    mkdirSync(join(tmp, ".gsd", "milestones", "M002"), { recursive: true });

    const ctx = makeContext(
      tmp,
      {
        phase: "planning",
        activeSlice: { id: "S01", title: "First Slice" },
      },
      { phases: { skip_research: true, skip_slice_research: true } },
    );
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "dispatch", "should dispatch");
    assert.ok(
      result.action === "dispatch" && result.unitType === "plan-slice",
      `unitType should be plan-slice, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`,
    );
    assert.ok(
      result.action === "dispatch" && result.unitId === "M002/S01",
      `unitId should be M002/S01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
