/**
 * slice-disk-reconcile.test.ts — #2533
 *
 * Slices that exist on disk (in ROADMAP.md) but are missing from the SQLite
 * database cause permanent "No slice eligible — check dependency ordering"
 * blocks. deriveStateFromDb must reconcile disk slices into the DB, just as
 * it already does for milestones (#2416).
 *
 * Scenario: M001 has a ROADMAP with S01-S04. S01 and S02 have SUMMARY files
 * (complete on disk). S03 depends on S01. Only S04 is in the DB (depends on
 * S03). Without slice reconciliation, S01-S03 are invisible and S04 is
 * permanently blocked.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  getMilestoneSlices,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-reconcile-"));
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

const CONTEXT_CONTENT = `# M001: Test Milestone

This milestone tests slice reconciliation.

## Must-Haves
- Something important
`;

// Roadmap with 4 slices: S01 (no deps), S02 (no deps), S03 (depends S01), S04 (depends S03)
const ROADMAP_CONTENT = `# M001: Test Milestone

**Vision:** Test slice disk→DB reconciliation.

## Slices

- [x] **S01: Foundation** \`risk:low\` \`depends:[]\`
  > Set up project structure.
- [x] **S02: Core Utils** \`risk:low\` \`depends:[]\`
  > Build utility functions.
- [ ] **S03: Integration** \`risk:medium\` \`depends:[S01]\`
  > Integrate components.
- [ ] **S04: Final Assembly** \`risk:high\` \`depends:[S03]\`
  > Assemble everything.
`;

describe("#2533: deriveStateFromDb reconciles disk slices", () => {
  test("missing DB slices cause permanent block (pre-fix)", async (t) => {
    const base = createFixtureBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    t.after(() => { closeDatabase(); cleanup(base); });

    // M001 in DB
    insertMilestone({ id: "M001", title: "M001: Test Milestone", status: "active", depends_on: [] });

    // Only S04 is in the DB — S01-S03 are missing
    insertSlice({ id: "S04", milestoneId: "M001", title: "S04: Final Assembly", status: "pending", risk: "high", depends: ["S03"] });

    // Write disk files — S01 and S02 have SUMMARY (complete on disk)
    writeFile(base, "milestones/M001/CONTEXT.md", CONTEXT_CONTENT);
    writeFile(base, "milestones/M001/ROADMAP.md", ROADMAP_CONTENT);
    writeFile(base, "milestones/M001/S01/PLAN.md", "# S01 Plan\n");
    writeFile(base, "milestones/M001/S01/SUMMARY.md", "# S01 Summary\nDone.");
    writeFile(base, "milestones/M001/S02/PLAN.md", "# S02 Plan\n");
    writeFile(base, "milestones/M001/S02/SUMMARY.md", "# S02 Summary\nDone.");
    writeFile(base, "milestones/M001/S03/PLAN.md", "# S03 Plan\n");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // After the fix, slices S01-S03 should be reconciled into DB
    const dbSlices = getMilestoneSlices("M001");
    assert.ok(
      dbSlices.length === 4,
      `All 4 roadmap slices should be in DB after reconciliation, got ${dbSlices.length}`,
    );

    // S01 and S02 should be marked complete (have SUMMARY files)
    const s01 = dbSlices.find(s => s.id === "S01");
    assert.ok(s01 !== undefined, "S01 should exist in DB after reconciliation");
    if (s01) {
      assert.deepStrictEqual(s01.status, "complete", "S01 should be 'complete' (has SUMMARY on disk)");
    }

    const s02 = dbSlices.find(s => s.id === "S02");
    assert.ok(s02 !== undefined, "S02 should exist in DB after reconciliation");
    if (s02) {
      assert.deepStrictEqual(s02.status, "complete", "S02 should be 'complete' (has SUMMARY on disk)");
    }

    // S03 should be pending (no SUMMARY)
    const s03 = dbSlices.find(s => s.id === "S03");
    assert.ok(s03 !== undefined, "S03 should exist in DB after reconciliation");
    if (s03) {
      assert.deepStrictEqual(s03.status, "pending", "S03 should be 'pending' (no SUMMARY on disk)");
    }

    // The state should NOT be blocked — S03 should be eligible (S01 dep satisfied)
    assert.ok(
      state.phase !== "blocked",
      `Phase should not be 'blocked' after reconciliation, got '${state.phase}'`,
    );

    // Active slice should be S03 (S01 dep met, S03 is first incomplete with satisfied deps)
    assert.ok(
      state.activeSlice !== null,
      "There should be an active slice after reconciliation",
    );
    if (state.activeSlice) {
      assert.deepStrictEqual(
        state.activeSlice.id,
        "S03",
        "Active slice should be S03 (its dependency S01 is complete) (#2533)",
      );
    }
  });

  test("slice reconciliation is idempotent", async (t) => {
    const base = createFixtureBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    t.after(() => { closeDatabase(); cleanup(base); });

    insertMilestone({ id: "M001", title: "M001: Test", status: "active", depends_on: [] });
    // S01 already in DB with correct status
    insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Foundation", status: "complete", depends: [] });

    writeFile(base, "milestones/M001/CONTEXT.md", CONTEXT_CONTENT);
    writeFile(base, "milestones/M001/ROADMAP.md", ROADMAP_CONTENT);
    writeFile(base, "milestones/M001/S01/PLAN.md", "# S01 Plan\n");
    writeFile(base, "milestones/M001/S01/SUMMARY.md", "# S01 Summary\nDone.");
    writeFile(base, "milestones/M001/S02/PLAN.md", "# S02 Plan\n");
    writeFile(base, "milestones/M001/S02/SUMMARY.md", "# S02 Summary\nDone.");

    invalidateStateCache();
    await deriveStateFromDb(base);

    // S01 should still be complete (not overwritten)
    const dbSlices = getMilestoneSlices("M001");
    const s01 = dbSlices.find(s => s.id === "S01");
    assert.ok(s01 !== undefined, "S01 should still exist in DB");
    if (s01) {
      assert.deepStrictEqual(s01.status, "complete", "S01 status should remain 'complete' (not overwritten)");
    }

    // S02-S04 should have been added
    assert.ok(
      dbSlices.length === 4,
      `Should have 4 slices after reconciliation (existing + new), got ${dbSlices.length}`,
    );
  });

  test("no ROADMAP file skips slice reconciliation", async (t) => {
    const base = createFixtureBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    t.after(() => { closeDatabase(); cleanup(base); });

    insertMilestone({ id: "M001", title: "M001: No Roadmap", status: "active", depends_on: [] });

    // Only a CONTEXT file, no ROADMAP
    writeFile(base, "milestones/M001/CONTEXT.md", CONTEXT_CONTENT);

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    const dbSlices = getMilestoneSlices("M001");
    assert.deepStrictEqual(dbSlices.length, 0, "No slices should be added when no ROADMAP exists");

    // Should be in pre-planning (no roadmap)
    assert.deepStrictEqual(state.phase, "pre-planning", "Phase should be pre-planning with no roadmap");
  });
});
