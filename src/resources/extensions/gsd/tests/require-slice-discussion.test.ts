/**
 * Tests for the require_slice_discussion dispatch gate.
 *
 * When `phases.require_slice_discussion` is enabled and the active slice
 * has no CONTEXT.md, auto-mode should stop (pause) instead of dispatching
 * research-slice or plan-slice.
 *
 * When the slice has a CONTEXT.md (discussion already happened), dispatch
 * should proceed normally.
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
    activeMilestone: { id: "M001", title: "Test Milestone" },
    activeSlice: { id: "S02", title: "Second Slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function scaffoldMilestone(basePath: string, mid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  // Minimal context so milestone-level rules don't interfere
  writeFileSync(join(dir, `${mid}-CONTEXT.md`), `# ${mid} Context\n`);
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), `# ${mid} Roadmap\n`);
}

function scaffoldSliceDir(basePath: string, mid: string, sid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
}

function scaffoldSliceContext(basePath: string, mid: string, sid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-CONTEXT.md`), `# ${sid} Context\n\nDiscussion notes.\n`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("dispatch: require_slice_discussion stops when slice has no CONTEXT", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-slice-discuss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestone(tmp, "M001");
  scaffoldSliceDir(tmp, "M001", "S02");

  const ctx: DispatchContext = {
    basePath: tmp,
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState(),
    prefs: {
      phases: { require_slice_discussion: true },
    } as any,
  };

  const result = await resolveDispatch(ctx);
  assert.equal(result.action, "stop", "should stop to require discussion");
  assert.match(result.reason!, /S02.*discussion/i, "reason should mention the slice and discussion");
});

test("dispatch: require_slice_discussion allows dispatch when slice has CONTEXT", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-slice-discuss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestone(tmp, "M001");
  scaffoldSliceContext(tmp, "M001", "S02");

  const ctx: DispatchContext = {
    basePath: tmp,
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState(),
    prefs: {
      phases: { require_slice_discussion: true },
    } as any,
  };

  const result = await resolveDispatch(ctx);
  // Should fall through to research-slice or plan-slice, not stop
  assert.notEqual(result.action, "stop", "should not stop when CONTEXT exists");
  if (result.action === "dispatch") {
    assert.match(result.unitType, /slice/, "should dispatch a slice-level unit");
  }
});

test("dispatch: planning proceeds normally when require_slice_discussion is off", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-slice-discuss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestone(tmp, "M001");
  scaffoldSliceDir(tmp, "M001", "S02");

  const ctx: DispatchContext = {
    basePath: tmp,
    mid: "M001",
    midTitle: "Test Milestone",
    state: makeState(),
    prefs: undefined, // no prefs = no discussion gate
  };

  const result = await resolveDispatch(ctx);
  assert.notEqual(result.action, "stop", "should not stop when preference is off");
});
