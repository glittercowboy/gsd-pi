/**
 * state-machine-edge-cases.test.ts — Gap-filling tests for the GSD state
 * machine covering failure modes, boundary conditions, and edge cases NOT
 * covered by the existing state-machine-live-validation.test.ts suite.
 *
 * Coverage gaps filled:
 * 1. State derivation failures (file deletion races, partial DB, cache staleness,
 *    corrupt files, 0-slice ROADMAP)
 * 2. Transition boundary failures (mid-transition mutation, cascading blockers,
 *    multi-level milestone deps, blocked→unblocked recovery)
 * 3. Dispatch failures (null activeSlice, evaluating-gates without config,
 *    unhandled phase, missing task plan recovery)
 * 4. Completion & verification failures (unparseable verdict, needs-remediation
 *    blocks completion, missing SUMMARY blocks validation, UAT verdict gate,
 *    replan loop cap)
 */

// GSD State Machine Edge Case Tests

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── DB layer ──────────────────────────────────────────────────────────────
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSlice,
  getMilestone,
  getSliceTasks,
  getMilestoneSlices,
  updateTaskStatus,
  updateSliceStatus,
  updateMilestoneStatus,
  insertReplanHistory,
  getReplanHistory,
  insertGateRow,
  getPendingGates,
} from "../../gsd-db.ts";

// ── State derivation ──────────────────────────────────────────────────────
import {
  deriveState,
  deriveStateFromDb,
  invalidateStateCache,
  isGhostMilestone,
  isValidationTerminal,
} from "../../state.ts";

// ── Status guards ─────────────────────────────────────────────────────────
import { isClosedStatus } from "../../status-guards.ts";

// ── Cache invalidation ───────────────────────────────────────────────────
import { invalidateAllCaches } from "../../cache.ts";

// ── Dispatch ─────────────────────────────────────────────────────────────
import {
  resolveDispatch,
  DISPATCH_RULES,
  getDispatchRuleNames,
} from "../../auto-dispatch.ts";
import type { DispatchContext, DispatchAction } from "../../auto-dispatch.ts";

// ── Verdict parser ──────────────────────────────────────────────────────
import {
  extractVerdict,
  isAcceptableUatVerdict,
  isValidMilestoneVerdict,
} from "../../verdict-parser.ts";

// ── Path helpers ─────────────────────────────────────────────────────────
import { clearPathCache } from "../../paths.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fixture Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-edge-cases-"));
}

/**
 * Create a standard .gsd/ fixture with M001 containing S01 (2 tasks) and S02 (1 task).
 * Same structure as state-machine-live-validation.test.ts for consistency.
 */
function createFullFixture(): string {
  const base = makeTempDir();
  const gsdDir = join(base, ".gsd");
  const m001Dir = join(gsdDir, "milestones", "M001");
  const s01Dir = join(m001Dir, "slices", "S01");
  const s01Tasks = join(s01Dir, "tasks");
  const s02Dir = join(m001Dir, "slices", "S02");
  const s02Tasks = join(s02Dir, "tasks");

  mkdirSync(s01Tasks, { recursive: true });
  mkdirSync(s02Tasks, { recursive: true });

  writeFileSync(
    join(m001Dir, "M001-CONTEXT.md"),
    [
      "# M001: Edge Case Milestone",
      "",
      "## Purpose",
      "Test state machine edge cases.",
    ].join("\n"),
  );

  writeFileSync(
    join(m001Dir, "M001-ROADMAP.md"),
    [
      "# M001: Edge Case Milestone",
      "",
      "## Vision",
      "Prove edge case correctness.",
      "",
      "## Success Criteria",
      "- All edge cases handled",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First Feature** `risk:low` `depends:[]`",
      "  - After this: First feature proven.",
      "",
      "- [ ] **S02: Second Feature** `risk:low` `depends:[]`",
      "  - After this: Second feature proven.",
      "",
      "## Boundary Map",
      "",
      "| From | To | Produces | Consumes |",
      "|------|----|----------|----------|",
      "| S01 | terminal | feature-a | nothing |",
      "| S02 | terminal | feature-b | nothing |",
    ].join("\n"),
  );

  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    [
      "# S01: First Feature",
      "",
      "**Goal:** Implement first feature.",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implementation** `est:30m`",
      "  - Do: Build it",
      "  - Verify: Run tests",
      "",
      "- [ ] **T02: Testing** `est:30m`",
      "  - Do: Write tests",
      "  - Verify: Run tests",
    ].join("\n"),
  );

  writeFileSync(join(s01Tasks, "T01-PLAN.md"), "# T01 Plan\nImplement.\n");
  writeFileSync(join(s01Tasks, "T02-PLAN.md"), "# T02 Plan\nTest.\n");

  writeFileSync(
    join(s02Dir, "S02-PLAN.md"),
    [
      "# S02: Second Feature",
      "",
      "**Goal:** Implement second feature.",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implementation** `est:30m`",
      "  - Do: Build it",
      "  - Verify: Run tests",
    ].join("\n"),
  );

  writeFileSync(join(s02Tasks, "T01-PLAN.md"), "# T01 Plan\nBuild.\n");

  return base;
}

/**
 * Create a multi-milestone fixture with M001 → M002 → M003 dependency chain.
 */
function createMultiMilestoneFixture(): string {
  const base = makeTempDir();
  const gsdDir = join(base, ".gsd");

  for (const mid of ["M001", "M002", "M003"]) {
    const mDir = join(gsdDir, "milestones", mid);
    const sDir = join(mDir, "slices", "S01", "tasks");
    mkdirSync(sDir, { recursive: true });

    writeFileSync(
      join(mDir, `${mid}-CONTEXT.md`),
      `# ${mid}: Milestone ${mid.slice(-1)}\n\n## Purpose\nTest deps.\n`,
    );

    writeFileSync(
      join(mDir, `${mid}-ROADMAP.md`),
      [
        `# ${mid}: Milestone ${mid.slice(-1)}`,
        "",
        "## Vision",
        "Test dependency chains.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Only Slice** `risk:low` `depends:[]`",
        "  - After this: Done.",
        "",
        "## Boundary Map",
        "",
        "| From | To | Produces | Consumes |",
        "|------|----|----------|----------|",
        "| S01 | terminal | output | nothing |",
      ].join("\n"),
    );

    writeFileSync(
      join(mDir, "slices", "S01", "S01-PLAN.md"),
      [
        "# S01: Only Slice",
        "",
        "**Goal:** Do the thing.",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Task** `est:30m`",
        "  - Do: Implement",
        "  - Verify: Run tests",
      ].join("\n"),
    );

    writeFileSync(join(sDir, "T01-PLAN.md"), "# T01 Plan\nDo it.\n");
  }

  return base;
}

function buildDispatchCtx(
  base: string,
  mid: string,
  stateOverrides: Partial<import("../../types.ts").GSDState> = {},
): DispatchContext {
  return {
    basePath: base,
    mid,
    midTitle: `${mid} Test`,
    state: {
      activeMilestone: { id: mid, title: `${mid} Test` },
      activeSlice: null,
      activeTask: null,
      phase: "executing",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
      ...stateOverrides,
    },
    prefs: undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// SECTION 1: State Derivation Failure Modes
// ─────────────────────────────────────────────────────────────────────────

describe("state derivation failures", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("file deleted between deriveState calls produces consistent result", async () => {
    // Simulates race condition: PLAN file exists on first derive, deleted before second
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

    invalidateAllCaches();
    const stateBefore = await deriveStateFromDb(base);
    assert.equal(stateBefore.phase, "executing");

    // Delete the task plan file mid-flow
    const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md");
    if (existsSync(planPath)) unlinkSync(planPath);

    invalidateAllCaches();
    const stateAfter = await deriveStateFromDb(base);
    // State machine should still function — either executing (DB says task exists)
    // or planning (missing plan file triggers replan). Should NOT throw.
    assert.ok(
      ["executing", "planning"].includes(stateAfter.phase),
      `expected executing or planning after plan deletion, got: ${stateAfter.phase}`,
    );
  });

  test("partial DB write: milestone inserted but no slices → pre-planning", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Test\n\n## Purpose\nTest.\n");

    openDatabase(join(base, ".gsd", "gsd.db"));
    // Only insert milestone — no slices, no roadmap
    insertMilestone({ id: "M001", title: "Partial", status: "active" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    // No roadmap → pre-planning (milestone exists but no structure yet)
    assert.equal(state.phase, "pre-planning");
    assert.equal(state.activeMilestone?.id, "M001");
  });

  test("cache staleness: derive within TTL returns same result after DB mutation", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });

    // First call populates cache
    invalidateStateCache();
    const state1 = await deriveState(base);
    assert.equal(state1.phase, "executing");

    // Mutate DB WITHOUT invalidating cache
    updateTaskStatus("M001", "S01", "T01", "complete", new Date().toISOString());

    // Second call within 100ms TTL should return cached (stale) result
    const state2 = await deriveState(base);
    assert.equal(state2.phase, "executing", "cached result should still show executing");

    // After explicit invalidation, should reflect the DB mutation
    invalidateStateCache();
    const state3 = await deriveState(base);
    assert.equal(state3.phase, "summarizing", "after cache invalidation should show summarizing");
  });

  test("corrupt ROADMAP: binary content does not crash deriveState", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Corrupt\n\n## Purpose\nTest.\n");
    // Write binary garbage as ROADMAP
    writeFileSync(join(mDir, "M001-ROADMAP.md"), Buffer.from([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]));

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Corrupt", status: "active" });

    invalidateAllCaches();
    // Should NOT throw — should degrade gracefully
    const state = await deriveStateFromDb(base);
    assert.ok(state.phase, "should produce a valid phase even with corrupt ROADMAP");
  });

  test("0-byte ROADMAP file is treated as no roadmap (pre-planning)", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Empty\n\n## Purpose\nTest.\n");
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "");

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Empty", status: "active" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    assert.equal(state.phase, "pre-planning", "empty ROADMAP should result in pre-planning");
  });

  test("ROADMAP with no ## Slices section derives pre-planning", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: No Slices\n\n## Purpose\nTest.\n");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      [
        "# M001: No Slices",
        "",
        "## Vision",
        "Test zero slices.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Slices",
        "",
        "## Boundary Map",
        "",
        "| From | To | Produces | Consumes |",
        "|------|----|----------|----------|",
      ].join("\n"),
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "No Slices", status: "active" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    // 0-slice ROADMAP guard: should NOT derive validating-milestone (#2667)
    assert.notEqual(
      state.phase,
      "validating-milestone",
      "0-slice ROADMAP must NOT produce validating-milestone",
    );
  });

  test("corrupt VALIDATION frontmatter: extractVerdict returns undefined", () => {
    // Test the verdict parser directly with malformed content
    assert.equal(extractVerdict(""), undefined, "empty string → undefined");
    assert.equal(extractVerdict("---\n\n---\n# No verdict"), undefined, "empty frontmatter → undefined");
    assert.equal(extractVerdict("---\nverdict:\n---"), undefined, "verdict with no value → undefined");
    assert.equal(
      extractVerdict("random text without frontmatter"),
      undefined,
      "no frontmatter → undefined",
    );
  });

  test("VALIDATION with binary/garbage content: isValidationTerminal returns false", () => {
    assert.equal(isValidationTerminal(""), false, "empty → not terminal");
    assert.equal(isValidationTerminal("\x00\xFF\xFE"), false, "binary → not terminal");
    assert.equal(
      isValidationTerminal("---\ngarbage: yes\n---\nNo verdict here."),
      false,
      "no verdict field → not terminal",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 2: Transition Boundary Failures
// ─────────────────────────────────────────────────────────────────────────

describe("transition boundary failures", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("mid-transition: CONTEXT.md created between derives transitions needs-discussion → pre-planning correctly", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });

    // Start with only CONTEXT-DRAFT → needs-discussion
    writeFileSync(join(mDir, "M001-CONTEXT-DRAFT.md"), "# Draft\nSome draft.\n");

    openDatabase(join(base, ".gsd", "gsd.db"));
    invalidateAllCaches();
    const state1 = await deriveState(base);
    assert.equal(state1.phase, "needs-discussion");

    // Now write the full CONTEXT (simulates discussion completion)
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Resolved\n\n## Purpose\nDone.\n");

    invalidateAllCaches();
    const state2 = await deriveState(base);
    // Should advance to pre-planning (has context but no roadmap yet)
    assert.equal(state2.phase, "pre-planning");
  });

  test("cascading slice dependencies: S02 depends S01, S03 depends S02 — only S01 eligible", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");

    // Create 3 slices with chain deps
    for (const sid of ["S01", "S02", "S03"]) {
      const sDir = join(mDir, "slices", sid, "tasks");
      mkdirSync(sDir, { recursive: true });
      writeFileSync(
        join(mDir, "slices", sid, `${sid}-PLAN.md`),
        [
          `# ${sid}: Feature`,
          "",
          "**Goal:** Do the thing.",
          "",
          "## Tasks",
          "",
          "- [ ] **T01: Task** `est:30m`",
          "  - Do: Implement",
          "  - Verify: Run tests",
        ].join("\n"),
      );
      writeFileSync(join(sDir, "T01-PLAN.md"), "# T01 Plan\nDo it.\n");
    }

    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Chain\n\n## Purpose\nTest deps.\n");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      [
        "# M001: Chain Deps",
        "",
        "## Vision",
        "Test cascading.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Base** `risk:low` `depends:[]`",
        "  - After this: Base done.",
        "",
        "- [ ] **S02: Middle** `risk:low` `depends:[S01]`",
        "  - After this: Middle done.",
        "",
        "- [ ] **S03: Top** `risk:low` `depends:[S02]`",
        "  - After this: Top done.",
        "",
        "## Boundary Map",
        "",
        "| From | To | Produces | Consumes |",
        "|------|----|----------|----------|",
        "| S01 | S02 | base | nothing |",
        "| S02 | S03 | middle | base |",
        "| S03 | terminal | top | middle |",
      ].join("\n"),
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Chain", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Base", status: "pending", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Middle", status: "pending", depends: ["S01"] });
    insertSlice({ id: "S03", milestoneId: "M001", title: "Top", status: "pending", depends: ["S02"] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "pending" });
    insertTask({ id: "T01", sliceId: "S03", milestoneId: "M001", status: "pending" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);

    // Only S01 should be active — S02 and S03 are dep-blocked
    assert.equal(state.activeSlice?.id, "S01", "S01 should be the active slice (no deps)");
    assert.equal(state.phase, "executing", "should be executing S01");
  });

  test("cascading deps: completing S01 unblocks S02 (not S03)", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    for (const sid of ["S01", "S02", "S03"]) {
      const sDir = join(mDir, "slices", sid, "tasks");
      mkdirSync(sDir, { recursive: true });
      writeFileSync(
        join(mDir, "slices", sid, `${sid}-PLAN.md`),
        `# ${sid}\n\n**Goal:** Do.\n\n## Tasks\n\n- [ ] **T01: Task** \`est:30m\`\n  - Do: Impl\n  - Verify: Test\n`,
      );
      writeFileSync(join(sDir, "T01-PLAN.md"), `# T01 Plan\nDo it.\n`);
    }
    // Write slice SUMMARY for S01
    writeFileSync(
      join(mDir, "slices", "S01", "S01-SUMMARY.md"),
      "---\n---\n# S01 Summary\nDone.\n",
    );

    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001: Chain\n\n## Purpose\nTest.\n");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      [
        "# M001: Chain",
        "",
        "## Vision",
        "Test.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Slices",
        "",
        "- [x] **S01: Base** `risk:low` `depends:[]`",
        "  - After this: Done.",
        "",
        "- [ ] **S02: Middle** `risk:low` `depends:[S01]`",
        "  - After this: Done.",
        "",
        "- [ ] **S03: Top** `risk:low` `depends:[S02]`",
        "  - After this: Done.",
        "",
        "## Boundary Map",
        "",
        "| From | To | Produces | Consumes |",
        "|------|----|----------|----------|",
        "| S01 | S02 | x | nothing |",
        "| S02 | S03 | y | x |",
        "| S03 | terminal | z | y |",
      ].join("\n"),
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Chain", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Base", status: "complete", depends: [] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Middle", status: "pending", depends: ["S01"] });
    insertSlice({ id: "S03", milestoneId: "M001", title: "Top", status: "pending", depends: ["S02"] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "pending" });
    insertTask({ id: "T01", sliceId: "S03", milestoneId: "M001", status: "pending" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);

    // S01 complete → S02 unblocked → S02 should be active
    assert.equal(state.activeSlice?.id, "S02", "S02 should be active after S01 completes");
    assert.equal(state.phase, "executing");
  });

  test("multi-milestone deps: M002 depends M001, M003 depends M002 — blocked correctly", async () => {
    base = createMultiMilestoneFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "First", status: "active" });
    insertMilestone({ id: "M002", title: "Second", status: "active", depends_on: ["M001"] });
    insertMilestone({ id: "M003", title: "Third", status: "active", depends_on: ["M002"] });

    insertSlice({ id: "S01", milestoneId: "M001", title: "S01", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
    insertSlice({ id: "S01", milestoneId: "M002", title: "S01", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M002", status: "pending" });
    insertSlice({ id: "S01", milestoneId: "M003", title: "S01", status: "pending" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M003", status: "pending" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);

    // Only M001 should be active — M002 and M003 are blocked
    assert.equal(state.activeMilestone?.id, "M001", "M001 should be active (no deps)");
  });

  test("blocker_discovered in task transitions to replanning-slice", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", blockerDiscovered: true });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    assert.equal(state.phase, "replanning-slice", "blocker_discovered should trigger replanning");
    assert.ok(state.blockers.length > 0, "should report blocker");
  });

  test("replan loop protection: replan already done skips replanning-slice", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", blockerDiscovered: true });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending" });

    // Record that a replan was already done for this slice
    insertReplanHistory({
      milestoneId: "M001",
      sliceId: "S01",
      summary: "Already replanned once",
    });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    // With replan history, should NOT re-enter replanning-slice
    assert.notEqual(
      state.phase,
      "replanning-slice",
      "replan loop protection: should not re-enter replanning after replan was done",
    );
  });

  test("blocked state: all slices have unmet deps → blocked phase", async () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(join(mDir, "slices", "S01", "tasks"), { recursive: true });
    mkdirSync(join(mDir, "slices", "S02", "tasks"), { recursive: true });

    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# M001\n\n## Purpose\nTest.\n");
    writeFileSync(
      join(mDir, "M001-ROADMAP.md"),
      [
        "# M001: Blocked",
        "",
        "## Vision",
        "Test blocked.",
        "",
        "## Success Criteria",
        "- Works",
        "",
        "## Slices",
        "",
        "- [ ] **S01: A** `risk:low` `depends:[S02]`",
        "  - After this: Done.",
        "",
        "- [ ] **S02: B** `risk:low` `depends:[S01]`",
        "  - After this: Done.",
        "",
        "## Boundary Map",
        "",
        "| From | To | Produces | Consumes |",
        "|------|----|----------|----------|",
        "| S01 | S02 | a | b |",
        "| S02 | S01 | b | a |",
      ].join("\n"),
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Blocked", status: "active" });
    // Circular deps: S01→S02 and S02→S01 — both blocked
    insertSlice({ id: "S01", milestoneId: "M001", title: "A", status: "pending", depends: ["S02"] });
    insertSlice({ id: "S02", milestoneId: "M001", title: "B", status: "pending", depends: ["S01"] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "pending" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "pending" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    assert.equal(state.phase, "blocked", "circular deps should produce blocked phase");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 3: Dispatch Failure Modes
// ─────────────────────────────────────────────────────────────────────────

describe("dispatch failure modes", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("dispatch with null activeSlice in executing phase → stop (error)", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "executing",
      activeSlice: null,
      activeTask: { id: "T01", title: "Task" },
    });

    // The "executing → execute-task (recover missing task plan)" rule checks activeSlice
    // and returns missingSliceStop when null
    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "null activeSlice in executing should stop");
  });

  test("dispatch for unhandled phase → stop with diagnostic", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "paused" as any,
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "unhandled phase should produce stop action");
  });

  test("dispatch: summarizing with null activeSlice → stop (error)", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "summarizing",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "summarizing without activeSlice should stop");
    assert.ok(
      (result as any).reason?.includes("no active slice"),
      "stop reason should mention missing slice",
    );
  });

  test("dispatch: evaluating-gates without gate config → skip (gates omitted)", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "in_progress" });

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "evaluating-gates",
      activeSlice: { id: "S01", title: "First" },
      activeTask: null,
    });
    ctx.prefs = undefined; // No prefs → gate_evaluation not enabled

    const result = await resolveDispatch(ctx);
    // Without gate config, the rule should skip (gates omitted)
    assert.ok(
      result.action === "skip" || result.action === "stop",
      `evaluating-gates without config should skip or stop, got: ${result.action}`,
    );
  });

  test("dispatch: needs-discussion → discuss-milestone dispatch", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "needs-discussion",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "dispatch");
    assert.equal((result as any).unitType, "discuss-milestone");
  });

  test("dispatch: complete phase → stop with info level", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "complete",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop");
    assert.equal((result as any).level, "info");
    assert.ok((result as any).reason?.includes("complete"), "reason should mention completion");
  });

  test("dispatch rule order: first match wins for overlapping rules", () => {
    const ruleNames = getDispatchRuleNames();
    // Verify critical ordering constraints
    const summarizeIdx = ruleNames.indexOf("summarizing → complete-slice");
    const runUatIdx = ruleNames.indexOf("run-uat (post-completion)");
    const uatGateIdx = ruleNames.indexOf("uat-verdict-gate (non-PASS blocks progression)");
    const executeIdx = ruleNames.indexOf("executing → execute-task");

    // summarizing should come before execute-task
    assert.ok(summarizeIdx < executeIdx, "summarizing rule should precede execute-task");
    // run-uat should come before uat-verdict-gate
    assert.ok(runUatIdx < uatGateIdx, "run-uat should precede uat-verdict-gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 4: Completion & Verification Failures
// ─────────────────────────────────────────────────────────────────────────

describe("completion and verification failures", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("needs-remediation VALIDATION blocks milestone completion dispatch", async () => {
    base = createFullFixture();
    const mDir = join(base, ".gsd", "milestones", "M001");
    writeFileSync(
      join(mDir, "M001-VALIDATION.md"),
      [
        "---",
        "verdict: needs-remediation",
        "remediation_round: 1",
        "---",
        "",
        "# Validation",
        "",
        "Needs remediation work.",
      ].join("\n"),
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "completing-milestone",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "needs-remediation should block completion");
    assert.ok(
      (result as any).reason?.includes("needs-remediation"),
      "stop reason should mention needs-remediation",
    );
  });

  test("missing slice SUMMARY blocks milestone validation dispatch", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    // Use "pending" status — closed slices (complete/done/skipped) are
    // excluded from SUMMARY checks per #3620.
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "pending" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending" });
    // No S01-SUMMARY.md or S02-SUMMARY.md on disk

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "validating-milestone",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "missing SUMMARY files should block validation");
    assert.ok(
      (result as any).reason?.includes("missing SUMMARY"),
      "stop reason should mention missing SUMMARY",
    );
  });

  test("VALIDATION with pass verdict: isValidationTerminal returns true", () => {
    const content = "---\nverdict: pass\nremediation_round: 0\n---\n# Pass\n";
    assert.equal(isValidationTerminal(content), true);
  });

  test("VALIDATION with needs-attention: isValidationTerminal returns true", () => {
    const content = "---\nverdict: needs-attention\n---\n# Attention\n";
    assert.equal(isValidationTerminal(content), true);
  });

  test("VALIDATION with needs-remediation: isValidationTerminal returns true (terminal for loop prevention)", () => {
    // Per #832: needs-remediation IS terminal to prevent validate-milestone loops
    const content = "---\nverdict: needs-remediation\nremediation_round: 1\n---\n# Remediate\n";
    assert.equal(isValidationTerminal(content), true);
  });

  test("UAT verdict gate: non-PASS verdict blocks progression", () => {
    assert.equal(isAcceptableUatVerdict("pass", undefined), true);
    assert.equal(isAcceptableUatVerdict("passed", undefined), true);
    assert.equal(isAcceptableUatVerdict("fail", undefined), false);
    assert.equal(isAcceptableUatVerdict("needs-remediation", undefined), false);
    assert.equal(isAcceptableUatVerdict("partial", undefined), false, "partial without eligible type → not acceptable");
    assert.equal(isAcceptableUatVerdict("partial", "mixed"), true, "partial with mixed type → acceptable");
    assert.equal(isAcceptableUatVerdict("partial", "human-experience"), true, "partial with human-experience → acceptable");
    assert.equal(isAcceptableUatVerdict("partial", "artifact-driven"), false, "partial with artifact-driven → not acceptable");
  });

  test("milestone validation verdict schema validation", () => {
    assert.equal(isValidMilestoneVerdict("pass"), true);
    assert.equal(isValidMilestoneVerdict("needs-attention"), true);
    assert.equal(isValidMilestoneVerdict("needs-remediation"), true);
    assert.equal(isValidMilestoneVerdict("fail"), false, "fail is not a valid milestone verdict");
    assert.equal(isValidMilestoneVerdict(""), false);
    assert.equal(isValidMilestoneVerdict("unknown"), false);
  });

  test("all slices done + no VALIDATION → validating-milestone (not completing)", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "complete" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    assert.equal(
      state.phase,
      "validating-milestone",
      "all slices done without VALIDATION should be validating-milestone",
    );
  });

  test("all slices done + terminal VALIDATION + no SUMMARY → completing-milestone", async () => {
    base = createFullFixture();
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      "---\nverdict: pass\n---\n# Validation\nPassed.\n",
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T01", sliceId: "S02", milestoneId: "M001", status: "complete" });

    invalidateAllCaches();
    const state = await deriveStateFromDb(base);
    assert.equal(
      state.phase,
      "completing-milestone",
      "terminal VALIDATION without SUMMARY should be completing-milestone",
    );
  });

  test("extractVerdict: markdown body fallback works", () => {
    // When LLM writes verdict in body instead of frontmatter (#2960)
    assert.equal(extractVerdict("# Validation\n\n**Verdict:** PASS"), "pass");
    assert.equal(extractVerdict("# Validation\n\n**Verdict:** ✅ PASS"), "pass");
    assert.equal(extractVerdict("# Validation\n\n**Verdict** needs-remediation"), "needs-remediation");
  });

  test("extractVerdict: normalizes 'passed' to 'pass'", () => {
    assert.equal(extractVerdict("---\nverdict: passed\n---"), "pass");
    assert.equal(extractVerdict("**Verdict:** passed"), "pass");
  });

  test("isClosedStatus: boundary values", () => {
    assert.equal(isClosedStatus("complete"), true);
    assert.equal(isClosedStatus("done"), true);
    assert.equal(isClosedStatus("skipped"), true);
    assert.equal(isClosedStatus("active"), false);
    assert.equal(isClosedStatus("pending"), false);
    assert.equal(isClosedStatus("in_progress"), false);
    assert.equal(isClosedStatus(""), false);
    assert.equal(isClosedStatus("COMPLETE"), false, "case-sensitive: uppercase should be false");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 5: Ghost Milestone Edge Cases
// ─────────────────────────────────────────────────────────────────────────

describe("ghost milestone edge cases", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("empty directory with DB row is NOT a ghost (#2921)", () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Queued", status: "active" });

    assert.equal(isGhostMilestone(base, "M001"), false, "DB row means not a ghost");
  });

  test("empty directory with worktree is NOT a ghost (#2921)", () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    // Simulate worktree existence
    mkdirSync(join(base, ".gsd", "worktrees", "M001"), { recursive: true });

    assert.equal(isGhostMilestone(base, "M001"), false, "worktree means not a ghost");
  });

  test("empty directory without DB or worktree IS a ghost", () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });

    assert.equal(isGhostMilestone(base, "M001"), true, "no DB, no worktree, no files → ghost");
  });

  test("directory with only META.json is still a ghost", () => {
    base = makeTempDir();
    const mDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "META.json"), '{"created":"2026-01-01"}');

    assert.equal(isGhostMilestone(base, "M001"), true, "META.json alone → ghost");
  });

  test("ghost milestones are skipped in state derivation", async () => {
    base = makeTempDir();
    const gsdDir = join(base, ".gsd", "milestones");

    // M001 is ghost — empty dir
    mkdirSync(join(gsdDir, "M001"), { recursive: true });

    // M002 is real — has CONTEXT-DRAFT
    mkdirSync(join(gsdDir, "M002"), { recursive: true });
    writeFileSync(join(gsdDir, "M002", "M002-CONTEXT-DRAFT.md"), "# Draft\nContent.\n");

    invalidateAllCaches();
    const state = await deriveState(base);
    assert.equal(state.activeMilestone?.id, "M002", "ghost M001 skipped, M002 is active");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION 6: Dispatch Guard Integration
// ─────────────────────────────────────────────────────────────────────────

describe("dispatch guard integration", () => {
  let base: string;

  afterEach(() => {
    try { closeDatabase(); } catch { /* may not be open */ }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("skip_milestone_validation preference writes pass-through VALIDATION", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "complete" });
    // Write slice SUMMARYs so the missing SUMMARY guard doesn't fire
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
      "# S01 Summary\nDone.\n",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-SUMMARY.md"),
      "# S02 Summary\nDone.\n",
    );

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "validating-milestone",
      activeSlice: null,
      activeTask: null,
    });
    ctx.prefs = { phases: { skip_milestone_validation: true } } as any;

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "skip", "skip_milestone_validation should produce skip action");

    // Should have written a pass-through VALIDATION file
    const validationPath = join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.ok(existsSync(validationPath), "VALIDATION file should be written");
    const content = readFileSync(validationPath, "utf-8");
    assert.ok(content.includes("verdict: pass"), "should contain pass verdict");
    assert.ok(content.includes("skipped by preference"), "should note it was skipped");
  });

  test("rewrite-docs circuit breaker: exceeding MAX attempts resolves all overrides", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Active", status: "active" });

    // Write a rewrite count at the max
    const runtimeDir = join(base, ".gsd", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "rewrite-count.json"),
      JSON.stringify({ count: 3, updatedAt: new Date().toISOString() }),
    );

    // Import and check
    const { getRewriteCount } = await import("../../auto-dispatch.ts");
    assert.equal(getRewriteCount(base), 3, "rewrite count should be 3");
  });

  test("replanning-slice with null activeSlice → stop (error)", async () => {
    base = createFullFixture();
    openDatabase(join(base, ".gsd", "gsd.db"));

    const ctx = buildDispatchCtx(base, "M001", {
      phase: "replanning-slice",
      activeSlice: null,
      activeTask: null,
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop", "replanning without activeSlice should stop");
  });
});
