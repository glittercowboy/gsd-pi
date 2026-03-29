/**
 * Regression test for #2661: Auto-mode dispatches deferred slices.
 *
 * When a decision defers a slice, the dispatcher must skip it and advance
 * to the next eligible slice. This tests both:
 *   1. deriveStateFromDb skips slices with status "deferred"
 *   2. saveDecisionToDb updates the slice status when the decision is a deferral
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  updateSliceStatus,
} from "../gsd-db.ts";
import { isDeferredStatus } from "../status-guards.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-deferred-dispatch-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("deferred-slice-dispatch (#2661)", () => {
  test("isDeferredStatus returns true for 'deferred'", () => {
    assert.ok(isDeferredStatus("deferred"), "should recognize 'deferred'");
    assert.ok(!isDeferredStatus("active"), "should not match 'active'");
    assert.ok(!isDeferredStatus("complete"), "should not match 'complete'");
    assert.ok(!isDeferredStatus("pending"), "should not match 'pending'");
  });

  test("deriveStateFromDb skips deferred slice and picks next eligible", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");
      assert.ok(isDbAvailable());

      // M001 with three slices: S01 complete, S02 deferred, S03 pending
      insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });

      insertSlice({ id: "S01", milestoneId: "M001", title: "Done Slice", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred Slice", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Next Slice", status: "pending", risk: "low", depends: [] });

      // S01 needs a SUMMARY file to count as complete for milestone-level checks
      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001: Test Milestone

**Vision:** Test deferred slices.

## Slices

- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > Done.

- [ ] **S02: Deferred Slice** \`risk:low\` \`depends:[]\`
  > Deferred.

- [ ] **S03: Next Slice** \`risk:low\` \`depends:[]\`
  > Next.
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# S01 Summary\nDone.");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // The active slice must be S03, NOT S02 (which is deferred)
      assert.equal(state.activeMilestone?.id, "M001", "active milestone is M001");
      assert.equal(state.activeSlice?.id, "S03", "active slice should skip deferred S02 and land on S03");
      assert.notEqual(state.activeSlice?.id, "S02", "active slice must NOT be the deferred S02");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test("deriveStateFromDb does not count deferred slices as done for progress", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");

      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Complete", status: "complete", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Pending", status: "pending", risk: "low", depends: [] });

      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [x] **S01: Complete** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred** \`risk:low\` \`depends:[]\`
- [ ] **S03: Pending** \`risk:low\` \`depends:[]\`
`);
      writeFile(base, "milestones/M001/slices/S01/S01-SUMMARY.md", "# Done");

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // Deferred slices should not count as "done" in progress
      // Only S01 (complete) counts as done
      assert.equal(state.progress?.slices?.done, 1, "only 1 slice (S01) should be done");
      // Total should still be 3 (deferred slices are still part of the milestone)
      assert.equal(state.progress?.slices?.total, 3, "all 3 slices counted in total");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test("all slices deferred results in blocked state", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");

      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S01", milestoneId: "M001", title: "Deferred A", status: "deferred", risk: "low", depends: [] });
      insertSlice({ id: "S02", milestoneId: "M001", title: "Deferred B", status: "deferred", risk: "low", depends: [] });

      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [ ] **S01: Deferred A** \`risk:low\` \`depends:[]\`
- [ ] **S02: Deferred B** \`risk:low\` \`depends:[]\`
`);

      invalidateStateCache();
      const state = await deriveStateFromDb(base);

      // No eligible slice — should be blocked
      assert.equal(state.activeSlice, null, "no active slice when all deferred");
      assert.equal(state.phase, "blocked", "phase should be blocked when all slices deferred");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });

  test("saveDecisionToDb marks slice as deferred when decision is a deferral", async () => {
    const base = createFixtureBase();
    try {
      openDatabase(":memory:");

      insertMilestone({ id: "M001", title: "Test", status: "active" });
      insertSlice({ id: "S03", milestoneId: "M001", title: "Target Slice", status: "active", risk: "low", depends: [] });

      writeFile(base, "milestones/M001/M001-ROADMAP.md", `# M001
## Slices
- [ ] **S03: Target Slice** \`risk:low\` \`depends:[]\`
`);

      const { saveDecisionToDb } = await import("../db-writer.ts");
      const { getSlice } = await import("../gsd-db.ts");

      // Save a deferral decision that references M001/S03
      await saveDecisionToDb(
        {
          scope: "deferral",
          decision: "Defer S03 to focus on higher priority work",
          choice: "defer M001/S03",
          rationale: "Not ready yet",
        },
        base,
      );

      // The slice status should now be "deferred"
      const slice = getSlice("M001", "S03");
      assert.equal(slice?.status, "deferred", "slice status should be updated to 'deferred' after deferral decision");

      closeDatabase();
    } finally {
      closeDatabase();
      cleanup(base);
    }
  });
});
