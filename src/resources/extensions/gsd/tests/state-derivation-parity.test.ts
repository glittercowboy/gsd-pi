// GSD State Machine Regression Tests — Completion Hierarchy & State Derivation (#3161)

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveState, isGhostMilestone, invalidateStateCache } from "../state.ts";

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-parity-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeMilestoneFile(base: string, mid: string, suffix: string, content: string): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}

function writeMilestoneValidation(base: string, mid: string, verdict: string = "pass"): void {
  const dir = join(base, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${mid}-VALIDATION.md`),
    `---\nverdict: ${verdict}\nremediation_round: 0\n---\n\n# Validation\nValidated.`,
  );
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  invalidateStateCache();
});

afterEach(() => {
  invalidateStateCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("state-derivation-parity", () => {

  // ─── Test 1: ghost milestone with only META.json ─────────────────────────
  test("ghost milestone with only META.json is correctly detected", () => {
    const base = createFixtureBase();
    try {
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      // Write only META.json — no CONTEXT, CONTEXT-DRAFT, ROADMAP, or SUMMARY
      writeFileSync(join(dir, "META.json"), JSON.stringify({ id: "M001", createdAt: new Date().toISOString() }));

      assert.ok(
        isGhostMilestone(base, "M001"),
        "milestone with only META.json is a ghost",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 2: non-ghost milestone with CONTEXT is not ghost ───────────────
  test("non-ghost milestone with CONTEXT is not ghost", () => {
    const base = createFixtureBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT", "# M001 Context\n\nThis milestone has real content.");

      assert.ok(
        !isGhostMilestone(base, "M001"),
        "milestone with CONTEXT.md is not a ghost",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 3: empty milestones dir derives pre-planning phase ─────────────
  test("empty milestones dir derives pre-planning phase", async () => {
    const base = createFixtureBase();
    try {
      const state = await deriveState(base);
      assert.equal(state.phase, "pre-planning", "empty milestones dir yields pre-planning phase");
      assert.equal(state.activeMilestone, null, "no active milestone for empty dir");
      assert.equal(state.activeSlice, null, "no active slice for empty dir");
      assert.deepEqual(state.registry, [], "registry is empty for empty dir");
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 4: state includes blockers field for future blocked-phase detection ──
  test("deriveState result always includes a defined phase and nextAction", async () => {
    // Document that the state shape includes a `phase` string and `nextAction` string.
    // Triggering "blocked" via filesystem alone requires circular dep setup which
    // is outside the scope of these parity tests. Instead we verify the shape.
    const base = createFixtureBase();
    try {
      // Provide a milestone with a ROADMAP that has a single incomplete slice
      const dir = join(base, ".gsd", "milestones", "M001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "M001-ROADMAP.md"),
        `# M001: Test\n\n**Vision:** Parity check.\n\n## Slices\n\n- [ ] **S01: First Slice** \`risk:low\` \`depends:[]\`\n  > After this: First slice done.\n`,
      );

      const state = await deriveState(base);

      assert.ok(typeof state.phase === "string", "state.phase is a string");
      assert.ok(typeof state.nextAction === "string", "state.nextAction is a string");
      // The state object is the same shape regardless of phase — blockers would
      // appear when the phase is "blocked". We document that the field may exist.
      assert.ok("activeMilestone" in state, "state has activeMilestone field");
      assert.ok("registry" in state, "state has registry field");
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 5: CONTEXT-DRAFT but no CONTEXT returns needs-discussion ────────
  test("deriveState with CONTEXT-DRAFT but no CONTEXT returns needs-discussion", async () => {
    const base = createFixtureBase();
    try {
      writeMilestoneFile(
        base,
        "M001",
        "CONTEXT-DRAFT",
        "# Draft Context\n\nSeed discussion material for M001.",
      );

      const state = await deriveState(base);
      assert.equal(
        state.phase,
        "needs-discussion",
        "CONTEXT-DRAFT with no CONTEXT yields needs-discussion phase",
      );
      assert.equal(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.equal(state.activeSlice, null, "no active slice in needs-discussion phase");
    } finally {
      cleanup(base);
    }
  });

  // ─── Test 6: deriveState skips ghost milestones when finding active milestone ──
  test("deriveState skips ghost milestones when finding active milestone", async () => {
    const base = createFixtureBase();
    try {
      // M001: ghost — just an empty directory
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

      // M002: has CONTEXT-DRAFT — should become active
      writeMilestoneFile(
        base,
        "M002",
        "CONTEXT-DRAFT",
        "# Draft for M002\n\nThis is the real milestone.",
      );

      const state = await deriveState(base);

      // M001 is a ghost so it is skipped; M002 becomes the active milestone
      assert.equal(
        state.activeMilestone?.id,
        "M002",
        "ghost M001 is skipped; M002 is the active milestone",
      );
      assert.equal(
        state.phase,
        "needs-discussion",
        "phase is needs-discussion because M002 has only CONTEXT-DRAFT",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Bonus: isGhostMilestone returns true for fully empty directory ───────
  test("isGhostMilestone returns true for milestone directory with no files", () => {
    const base = createFixtureBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      // No files at all in the directory
      assert.ok(
        isGhostMilestone(base, "M001"),
        "milestone directory with no files is a ghost",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Bonus: isGhostMilestone returns false when ROADMAP exists ────────────
  test("isGhostMilestone returns false when ROADMAP exists", () => {
    const base = createFixtureBase();
    try {
      writeMilestoneFile(base, "M001", "ROADMAP", "# M001\n\n## Slices\n\n- [ ] **S01: First** `risk:low` `depends:[]`\n  > After this: done.\n");
      assert.ok(
        !isGhostMilestone(base, "M001"),
        "milestone with ROADMAP is not a ghost",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Bonus: isGhostMilestone returns false when CONTEXT-DRAFT exists ──────
  test("isGhostMilestone returns false when CONTEXT-DRAFT exists", () => {
    const base = createFixtureBase();
    try {
      writeMilestoneFile(base, "M001", "CONTEXT-DRAFT", "# Draft\n\nSeed material.");
      assert.ok(
        !isGhostMilestone(base, "M001"),
        "milestone with CONTEXT-DRAFT is not a ghost",
      );
    } finally {
      cleanup(base);
    }
  });

  // ─── Bonus: multiple ghost milestones before a real one are all skipped ───
  test("deriveState skips multiple ghost milestones to find the first real one", async () => {
    const base = createFixtureBase();
    try {
      // M001 and M002: ghosts
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      mkdirSync(join(base, ".gsd", "milestones", "M002"), { recursive: true });

      // M003: has CONTEXT-DRAFT — first real milestone
      writeMilestoneFile(base, "M003", "CONTEXT-DRAFT", "# M003 Draft\n\nFirst substantive milestone.");

      const state = await deriveState(base);

      assert.equal(
        state.activeMilestone?.id,
        "M003",
        "both ghost milestones skipped; M003 is active",
      );
      assert.equal(
        state.phase,
        "needs-discussion",
        "phase is needs-discussion for M003 with CONTEXT-DRAFT",
      );
    } finally {
      cleanup(base);
    }
  });

});
