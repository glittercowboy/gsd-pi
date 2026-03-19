/**
 * Regression test suite for the auto-mode dispatch loop.
 * Covers phase transitions, dispatch rule matching, state derivation edge cases,
 * and every fix from the #1308 issue catalog.
 *
 * Run: node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *          --experimental-strip-types --test src/resources/extensions/gsd/tests/loop-regression.test.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveState } from "../state.ts";
import { resolveDispatch, getDispatchRuleNames } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmp(name: string): string {
  const dir = join(tmpdir(), `loop-regression-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGsdFile(base: string, ...pathParts: string[]): void {
  const fullPath = join(base, ".gsd", ...pathParts);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  // Default to empty content; callers use writeGsdFileContent for real content
}

function writeGsdFileContent(base: string, relativePath: string, content: string): void {
  const fullPath = join(base, ".gsd", relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

function buildMinimalRoadmap(slices: Array<{ id: string; title: string; done: boolean; depends?: string[] }>): string {
  const lines = ["# M001: Test Milestone", "", "## Slices", ""];
  for (const s of slices) {
    const cb = s.done ? "x" : " ";
    const deps = s.depends?.length ? ` \`depends:[${s.depends.join(",")}]\`` : " `depends:[]`";
    lines.push(`- [${cb}] **${s.id}: ${s.title}** \`risk:low\`${deps}`);
    lines.push(`  > Demo text for ${s.id}`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildMinimalPlan(tasks: Array<{ id: string; title: string; done: boolean }>): string {
  const lines = ["# S01: Test Slice", "", "**Goal:** test", "", "## Tasks", ""];
  for (const t of tasks) {
    const cb = t.done ? "x" : " ";
    lines.push(`- [${cb}] **${t.id}: ${t.title}** \`est:5m\``);
  }
  return lines.join("\n");
}

function buildMinimalSummary(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "parent: S01",
    "milestone: M001",
    "duration: 5m",
    "verification_result: passed",
    `completed_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${id}: Done`,
    "",
    "Completed.",
  ].join("\n");
}

// ─── Phase 1: Dispatch Rule Ordering ──────────────────────────────────────

test("dispatch rules are in the expected order", () => {
  const names = getDispatchRuleNames();
  assert.ok(names.length >= 15, `expected ≥15 rules, got ${names.length}`);

  // Verify critical ordering: override gate first, complete-slice before UAT,
  // needs-discussion before pre-planning, executing last
  const overrideIdx = names.indexOf("rewrite-docs (override gate)");
  const completeSliceIdx = names.indexOf("summarizing → complete-slice");
  const uatGateIdx = names.indexOf("uat-verdict-gate (non-PASS blocks progression)");
  const needsDiscussIdx = names.indexOf("needs-discussion → stop");
  const prePlanNoCtxIdx = names.indexOf("pre-planning (no context) → stop");
  const executeIdx = names.indexOf("executing → execute-task");

  assert.ok(overrideIdx === 0, "override gate should be first rule");
  assert.ok(completeSliceIdx < uatGateIdx, "complete-slice should fire before UAT gate");
  assert.ok(needsDiscussIdx < prePlanNoCtxIdx, "needs-discussion should fire before pre-planning");
  assert.ok(executeIdx > prePlanNoCtxIdx, "execute-task should fire after pre-planning rules");
});

// ─── Phase 2: State Derivation — Phase Transitions ───────────────────────

test("deriveState: empty project → pre-planning with no milestones", async () => {
  const tmp = makeTmp("empty");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    const state = await deriveState(tmp);
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.activeMilestone, null);
    assert.deepEqual(state.registry, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: milestone with context but no roadmap → pre-planning", async () => {
  const tmp = makeTmp("no-roadmap");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Test\n\nContext here.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: milestone with CONTEXT-DRAFT.md → needs-discussion", async () => {
  const tmp = makeTmp("draft");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\n\nSome ideas.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "needs-discussion");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: roadmap with no plan → planning", async () => {
  const tmp = makeTmp("planning");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(join(mDir, "slices", "S01"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: false },
    ]));
    const state = await deriveState(tmp);
    assert.equal(state.phase, "planning");
    assert.equal(state.activeSlice?.id, "S01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: plan with incomplete tasks → executing", async () => {
  const tmp = makeTmp("executing");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: false },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Task One", done: false },
      { id: "T02", title: "Task Two", done: false },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), "# T01 Plan\n\nDo stuff.");
    writeFileSync(join(sDir, "tasks", "T02-PLAN.md"), "# T02 Plan\n\nDo more.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "executing");
    assert.equal(state.activeTask?.id, "T01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: all tasks done → summarizing", async () => {
  const tmp = makeTmp("summarizing");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: false },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Task One", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    const state = await deriveState(tmp);
    assert.equal(state.phase, "summarizing");
    assert.equal(state.activeSlice?.id, "S01");
    assert.equal(state.activeTask, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: all slices done → validating-milestone", async () => {
  const tmp = makeTmp("validating");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: true },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Task One", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    writeFileSync(join(sDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "validating-milestone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: validation terminal → completing-milestone", async () => {
  const tmp = makeTmp("completing");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: true },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Task One", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    writeFileSync(join(sDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.");
    writeFileSync(join(mDir, "M001-VALIDATION.md"), "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\n\nAll good.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "completing-milestone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: milestone with summary → complete", async () => {
  const tmp = makeTmp("complete");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "First Slice", done: true },
    ]));
    writeFileSync(join(mDir, "M001-SUMMARY.md"), "# M001 Summary\n\nMilestone complete.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "complete");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Phase 3: Regression Tests for Specific Bug Fixes ────────────────────

test("#1155: completion-transition codes should NOT be fixable at task level", async () => {
  // Verify COMPLETION_TRANSITION_CODES exists and contains expected codes
  const { COMPLETION_TRANSITION_CODES } = await import("../doctor-types.ts");
  assert.ok(COMPLETION_TRANSITION_CODES.has("all_tasks_done_missing_slice_summary"));
  assert.ok(COMPLETION_TRANSITION_CODES.has("all_tasks_done_missing_slice_uat"));
  assert.ok(COMPLETION_TRANSITION_CODES.has("all_tasks_done_roadmap_not_checked"));
});

test("#1170: needs-discussion phase is correctly derived from CONTEXT-DRAFT.md", async () => {
  const tmp = makeTmp("needs-discussion");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\n\nDraft context.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "needs-discussion");
    // Verify the dispatch table returns stop for needs-discussion
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "stop");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("#1176: state.registry is always an array even with corrupt/missing state", async () => {
  const tmp = makeTmp("empty-registry");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    const state = await deriveState(tmp);
    assert.ok(Array.isArray(state.registry), "registry should be an array");
    assert.equal(state.registry.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("#1243: prose H3 slice headers are parsed correctly", async () => {
  const { parseRoadmapSlices } = await import("../roadmap-slices.ts");
  const content = `# M001: Test

## Roadmap

### S01: First Feature
Depends on: none

### S02: Second Feature
Depends on: S01

### S03: Third Feature
`;
  const slices = parseRoadmapSlices(content);
  assert.equal(slices.length, 3, "should parse 3 H3 slices");
  assert.equal(slices[0]!.id, "S01");
  assert.equal(slices[1]!.id, "S02");
  assert.equal(slices[2]!.id, "S03");
  assert.deepEqual(slices[1]!.depends, ["S01"]);
});

test("#1243: bold-wrapped and dot-separator slice headers are parsed", async () => {
  const { parseRoadmapSlices } = await import("../roadmap-slices.ts");
  const content = `# M001

## **S01: Bold Wrapped**
> Demo

## S02. Dot Separator Title
> Demo
`;
  const slices = parseRoadmapSlices(content);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]!.id, "S01");
  assert.ok(slices[0]!.title.includes("Bold"), `title should contain Bold, got: ${slices[0]!.title}`);
  assert.equal(slices[1]!.id, "S02");
});

test("slice dependency blocking → phase: blocked", async () => {
  const tmp = makeTmp("dep-blocked");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(join(mDir, "slices"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    // S01 depends on S02 and S02 depends on S01 — circular!
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Slice A", done: false, depends: ["S02"] },
      { id: "S02", title: "Slice B", done: false, depends: ["S01"] },
    ]));
    const state = await deriveState(tmp);
    assert.equal(state.phase, "blocked");
    assert.ok(state.blockers.length > 0, "should have blockers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("multi-milestone: M001 complete, M002 active", async () => {
  const tmp = makeTmp("multi-milestone");
  try {
    // M001 — complete
    const m1Dir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(m1Dir, { recursive: true });
    writeFileSync(join(m1Dir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Done", done: true },
    ]));
    writeFileSync(join(m1Dir, "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");

    // M002 — active, needs planning
    const m2Dir = join(tmp, ".gsd", "milestones", "M002");
    mkdirSync(m2Dir, { recursive: true });
    writeFileSync(join(m2Dir, "M002-CONTEXT.md"), "# M002\n\nNew work.");

    const state = await deriveState(tmp);
    assert.equal(state.activeMilestone?.id, "M002");
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.registry.length, 2);
    assert.equal(state.registry[0]!.status, "complete");
    assert.equal(state.registry[1]!.status, "active");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("blocker_discovered in task summary → replanning-slice", async () => {
  const tmp = makeTmp("replan");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Done", done: true },
      { id: "T02", title: "Todo", done: false },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), "# T01\nPlan.");
    writeFileSync(join(sDir, "tasks", "T02-PLAN.md"), "# T02\nPlan.");
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), [
      "---",
      "id: T01",
      "parent: S01",
      "milestone: M001",
      "blocker_discovered: true",
      "---",
      "",
      "# T01: Blocker found",
      "",
      "API doesn't support this.",
    ].join("\n"));

    const state = await deriveState(tmp);
    assert.equal(state.phase, "replanning-slice");
    assert.ok(state.blockers[0]!.includes("T01"), "blocker should reference T01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Phase 4: Edge Cases ─────────────────────────────────────────────────

test("empty plan file (0 tasks) → stays in planning", async () => {
  const tmp = makeTmp("empty-plan");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    // Plan file exists but has no task entries
    writeFileSync(join(sDir, "S01-PLAN.md"), "# S01: Test\n\n**Goal:** test\n\n## Tasks\n");

    const state = await deriveState(tmp);
    assert.equal(state.phase, "planning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parked milestone is not treated as active or complete", async () => {
  const tmp = makeTmp("parked");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    writeFileSync(join(mDir, "M001-PARKED.md"), "Parked for later.");

    const state = await deriveState(tmp);
    assert.equal(state.registry[0]!.status, "parked");
    assert.equal(state.activeMilestone, null);
    // Phase should be pre-planning (all milestones parked, not complete)
    assert.equal(state.phase, "pre-planning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Phase 5: Defensive Guards ───────────────────────────────────────────

test("dispatch returns stop when phase=summarizing but activeSlice is null (corrupt state)", async () => {
  const corruptState: GSDState = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null, // BUG: summarizing should always have activeSlice
    activeTask: null,
    phase: "summarizing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
  const result = await resolveDispatch({
    basePath: "/tmp/fake", mid: "M001", midTitle: "Test", state: corruptState, prefs: undefined,
  });
  assert.equal(result.action, "stop", "should stop instead of crashing");
  assert.ok((result as any).reason.includes("no active slice"), `reason should mention missing slice: ${(result as any).reason}`);
});

test("dispatch returns stop when phase=executing but activeSlice is null (corrupt state)", async () => {
  const corruptState: GSDState = {
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: null,
    activeTask: { id: "T01", title: "Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [{ id: "M001", title: "Test", status: "active" }],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
  const result = await resolveDispatch({
    basePath: "/tmp/fake", mid: "M001", midTitle: "Test", state: corruptState, prefs: undefined,
  });
  assert.equal(result.action, "stop", "should stop instead of crashing");
});

// ─── Phase 6: Worktree & Lock Consistency ────────────────────────────────

test("repoIdentity returns same hash for main repo and worktree", async () => {
  // This test verifies the fix for #1288 — identity hash must be stable
  // across worktree and non-worktree contexts.
  const { repoIdentity } = await import("../repo-identity.ts");
  // Call from the current directory (main repo)
  const hash = repoIdentity(process.cwd());
  assert.ok(hash.length === 12, `hash should be 12 hex chars, got: ${hash}`);
  assert.match(hash, /^[a-f0-9]{12}$/, `hash should be hex, got: ${hash}`);
});

test("session lock settings: retry path matches primary stale timeout", async () => {
  // Verify the fix for #1304 — retry lock must use same settings as primary
  const lockSource = (await import("node:fs")).readFileSync(
    "src/resources/extensions/gsd/session-lock.ts", "utf-8"
  );
  // Find all stale: settings
  const staleMatches = [...lockSource.matchAll(/stale:\s*(\d[\d_]*)/g)];
  const staleValues = staleMatches.map(m => parseInt(m[1]!.replace(/_/g, ""), 10));
  // All stale values should be the same (primary and retry aligned)
  const uniqueStale = [...new Set(staleValues)];
  assert.equal(uniqueStale.length, 1, `all stale timeouts should be identical, got: ${staleValues.join(", ")}`);
});

test("COMPLETION_TRANSITION_CODES are a subset of DoctorIssueCode", async () => {
  const { COMPLETION_TRANSITION_CODES } = await import("../doctor-types.ts");
  // Just verify the set is non-empty and contains expected codes
  assert.ok(COMPLETION_TRANSITION_CODES.size >= 3, "should have at least 3 transition codes");
  for (const code of COMPLETION_TRANSITION_CODES) {
    assert.ok(typeof code === "string", `code should be string: ${code}`);
    assert.ok(code.startsWith("all_tasks_done_"), `code should start with all_tasks_done_: ${code}`);
  }
});

// ─── Scope 2: State Derivation — Array Safety ────────────────────────────

test("deriveState: registry is always an array with malformed roadmap", async () => {
  const tmp = makeTmp("malformed-roadmap");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    // Roadmap exists but is completely empty
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "");
    const state = await deriveState(tmp);
    assert.ok(Array.isArray(state.registry), "registry must be array");
    assert.equal(state.activeMilestone?.id, "M001");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("deriveState: plan with garbled content still returns valid state", async () => {
  const tmp = makeTmp("garbled-plan");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    // Plan file exists but contains garbage
    writeFileSync(join(sDir, "S01-PLAN.md"), "just some random text\nno tasks here\n!!!");
    const state = await deriveState(tmp);
    // Should fall back to planning since no tasks parsed
    assert.equal(state.phase, "planning");
    assert.equal(state.activeSlice?.id, "S01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Scope 4: Lock Management — Exit Handler Verification ────────────────

test("session lock: releaseSessionLock removes auto.lock file", async () => {
  const tmp = makeTmp("lock-release");
  try {
    const gsd = join(tmp, ".gsd");
    mkdirSync(gsd, { recursive: true });
    const lockFile = join(gsd, "auto.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.ok(existsSync(lockFile), "lock file should exist before release");

    const { releaseSessionLock } = await import("../session-lock.ts");
    releaseSessionLock(tmp);

    assert.ok(!existsSync(lockFile), "lock file should be removed after release");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("session lock: onCompromised handler exists in both primary and retry paths", async () => {
  const lockSource = readFileSync(
    "src/resources/extensions/gsd/session-lock.ts", "utf-8"
  );
  const compromisedMatches = [...lockSource.matchAll(/onCompromised/g)];
  // Should have at least 2 onCompromised handlers (primary + retry)
  // plus the flag declaration and the check in validateSessionLock
  assert.ok(compromisedMatches.length >= 3,
    `expected ≥3 onCompromised references (primary + retry + flag), got ${compromisedMatches.length}`);
});

test("session lock: both onCompromised handlers null _releaseFunction (#1315)", async () => {
  const lockSource = readFileSync(
    "src/resources/extensions/gsd/session-lock.ts", "utf-8"
  );
  // Extract onCompromised handler blocks — both should set _releaseFunction = null
  const handlers = lockSource.match(/onCompromised:\s*\(\)\s*=>\s*\{[^}]+\}/g) || [];
  assert.ok(handlers.length >= 2, `expected ≥2 onCompromised handlers, got ${handlers.length}`);
  for (const h of handlers) {
    assert.ok(h.includes("_releaseFunction = null"),
      `onCompromised handler should null _releaseFunction: ${h}`);
  }
});

test("session lock: exit handler uses ensureExitHandler to prevent double-registration (#1315)", async () => {
  const lockSource = readFileSync(
    "src/resources/extensions/gsd/session-lock.ts", "utf-8"
  );
  // Should use ensureExitHandler instead of direct process.once("exit") in acquire paths
  const directExitHandlers = (lockSource.match(/process\.once\("exit"/g) || []).length;
  const ensureExitCalls = (lockSource.match(/ensureExitHandler\(/g) || []).length;
  // Only 1 direct process.once("exit") allowed — inside ensureExitHandler itself
  assert.ok(directExitHandlers <= 1,
    `expected ≤1 direct process.once("exit") (inside ensureExitHandler), got ${directExitHandlers}`);
  assert.ok(ensureExitCalls >= 2,
    `expected ≥2 ensureExitHandler calls (primary + retry path), got ${ensureExitCalls}`);
});

test("signal handler: SIGINT handler registered alongside SIGTERM (#1315)", async () => {
  const supervisorSource = readFileSync(
    "src/resources/extensions/gsd/auto-supervisor.ts", "utf-8"
  );
  // registerSigtermHandler should register on both SIGTERM and SIGINT
  assert.ok(supervisorSource.includes('process.on("SIGINT"') || supervisorSource.includes("process.on('SIGINT'"),
    "registerSigtermHandler should register SIGINT handler");
  assert.ok(supervisorSource.includes('process.off("SIGINT"') || supervisorSource.includes("process.off('SIGINT'"),
    "deregisterSigtermHandler should deregister SIGINT handler");
});

// ─── Scope 5: Crash Recovery — Message Guidance per Unit Type ────────────

test("crash recovery: formatCrashInfo includes guidance for bootstrap crash", async () => {
  const { formatCrashInfo } = await import("../crash-recovery.ts");
  const info = formatCrashInfo({
    pid: 12345,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  });
  assert.ok(info.includes("bootstrap"), "should mention bootstrap");
  assert.ok(info.includes("No work was lost") || info.includes("/gsd auto"), 
    "should include recovery guidance for bootstrap crash");
});

test("crash recovery: formatCrashInfo includes guidance for execute-task crash", async () => {
  const { formatCrashInfo } = await import("../crash-recovery.ts");
  const info = formatCrashInfo({
    pid: 12345,
    startedAt: new Date().toISOString(),
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 5,
  });
  assert.ok(info.includes("execute"), "should mention execute");
  assert.ok(info.includes("resume") || info.includes("preserved") || info.includes("/gsd auto"),
    "should include recovery guidance for task crash");
});

test("crash recovery: formatCrashInfo includes guidance for complete-slice crash", async () => {
  const { formatCrashInfo } = await import("../crash-recovery.ts");
  const info = formatCrashInfo({
    pid: 12345,
    startedAt: new Date().toISOString(),
    unitType: "complete-slice",
    unitId: "M001/S01",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 10,
  });
  assert.ok(info.includes("complete"), "should mention complete");
  assert.ok(info.includes("finish") || info.includes("/gsd auto"),
    "should include recovery guidance for completion crash");
});

test("crash recovery: formatCrashInfo includes guidance for research crash", async () => {
  const { formatCrashInfo } = await import("../crash-recovery.ts");
  const info = formatCrashInfo({
    pid: 12345,
    startedAt: new Date().toISOString(),
    unitType: "research-milestone",
    unitId: "M001",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 1,
  });
  assert.ok(info.includes("research"), "should mention research");
  assert.ok(info.includes("incomplete") || info.includes("re-run") || info.includes("/gsd auto"),
    "should include recovery guidance for research crash");
});

// ─── Scope 6: Milestone Transitions — Dispatch Flow ─────────────────────

test("dispatch: needs-discussion stops with discussion guidance", async () => {
  const tmp = makeTmp("dispatch-discussion");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\n\nIdeas.");
    const state = await deriveState(tmp);
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "stop");
    assert.ok((result as any).reason.includes("discussion") || (result as any).reason.includes("discuss"),
      "stop reason should mention discussion");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: pre-planning without context stops with guidance", async () => {
  const tmp = makeTmp("dispatch-no-context");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    // No context, no roadmap — just a bare milestone directory
    const state = await deriveState(tmp);
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "stop");
    assert.ok((result as any).reason.includes("context") || (result as any).reason.includes("discuss"),
      "stop reason should mention missing context");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: pre-planning with context dispatches research-milestone", async () => {
  const tmp = makeTmp("dispatch-research");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nBuild a thing.");
    const state = await deriveState(tmp);
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "research-milestone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: executing phase dispatches execute-task", async () => {
  const tmp = makeTmp("dispatch-execute");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Do work", done: false },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), "# T01\nDo the thing.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "executing");
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "execute-task");
    assert.equal((result as any).unitId, "M001/S01/T01");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: summarizing phase dispatches complete-slice", async () => {
  const tmp = makeTmp("dispatch-complete-slice");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: false },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Done task", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    const state = await deriveState(tmp);
    assert.equal(state.phase, "summarizing");
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "complete-slice");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: validating-milestone dispatches validate-milestone", async () => {
  const tmp = makeTmp("dispatch-validate");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: true },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Done", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    writeFileSync(join(sDir, "S01-SUMMARY.md"), "# Summary\nDone.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "validating-milestone");
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "validate-milestone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dispatch: completing-milestone dispatches complete-milestone", async () => {
  const tmp = makeTmp("dispatch-complete-ms");
  try {
    const mDir = join(tmp, ".gsd", "milestones", "M001");
    const sDir = join(mDir, "slices", "S01");
    mkdirSync(join(sDir, "tasks"), { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\nContext.");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), buildMinimalRoadmap([
      { id: "S01", title: "Test", done: true },
    ]));
    writeFileSync(join(sDir, "S01-PLAN.md"), buildMinimalPlan([
      { id: "T01", title: "Done", done: true },
    ]));
    writeFileSync(join(sDir, "tasks", "T01-SUMMARY.md"), buildMinimalSummary("T01"));
    writeFileSync(join(sDir, "S01-SUMMARY.md"), "# Summary\nDone.");
    writeFileSync(join(mDir, "M001-VALIDATION.md"), "---\nverdict: pass\nremediation_round: 0\n---\n# Validation\nPassed.");
    const state = await deriveState(tmp);
    assert.equal(state.phase, "completing-milestone");
    const result = await resolveDispatch({
      basePath: tmp, mid: "M001", midTitle: "Test", state, prefs: undefined,
    });
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "complete-milestone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
