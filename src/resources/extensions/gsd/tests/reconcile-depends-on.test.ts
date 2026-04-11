/**
 * reconcile-depends-on.test.ts — Regression test for #3340
 *
 * When milestones exist on disk but not in the DB, reconciliation in
 * deriveStateFromDb() inserts them via insertMilestone() without parsing
 * depends_on from CONTEXT.md. The DB row is then read back in Phase 2 and
 * m.depends_on comes back as [], so depsUnmet is always false. A milestone
 * whose dependency is incomplete gets promoted to 'active' — the wrong
 * milestone is dispatched.
 *
 * Two fixes are covered:
 *   1. insertMilestone() at the incremental disk→DB sync site must be called
 *      with the depends_on parsed from CONTEXT.md (or CONTEXT-DRAFT.md).
 *   2. The allMilestones.push() fallback that synthesises a MilestoneRow for
 *      disk-only milestones must also populate depends_on from disk.
 *   3. milestoneIdSort() must return a stable order for same-sequence IDs
 *      (e.g. M001-fkbvng vs M001-1jp4m8) by adding a suffix tiebreaker.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { milestoneIdSort } from "../milestone-ids.ts";

// ─── Fixture Helpers ─────────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-reconcile-deps-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeGsdFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("reconcile-depends-on (#3340)", async () => {
  let base: string;

  beforeEach(() => {
    base = createFixtureBase();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  // ── Test 1: reconciliation drops depends_on → wrong milestone dispatched ──
  //
  // Setup:
  //   M001 — complete (DB + SUMMARY on disk)
  //   M002 — disk-only, depends_on: [M003] (dep M003 is not yet complete)
  //   M003 — disk-only, no deps
  //
  // Expected (correct) behaviour:
  //   M002 is pending (dep M003 not complete)
  //   M003 is active  (no unmet deps)
  //
  // Before the fix, reconciliation inserted both M002 and M003 with depends_on:[].
  // When Phase 2 evaluated M002 (processed before M003 numerically), it saw
  // deps=[] → depsUnmet=false → promoted M002 to 'active' — skipping M003
  // entirely. The wrong milestone was dispatched and M003 was silently blocked.
  test("disk-only milestone with unmet depends_on must not be promoted to active", async () => {
    openDatabase(":memory:");

    // M001: complete in DB + SUMMARY on disk
    insertMilestone({ id: "M001", title: "M001: Done", status: "complete", depends_on: [] });
    insertSlice({ id: "S01", milestoneId: "M001", title: "S01: Done", status: "complete", depends: [] });
    writeGsdFile(base, "milestones/M001/M001-SUMMARY.md", "# M001: Done\n\nComplete.");

    // M002: disk-only, depends_on: [M003] — M003 is not complete yet
    writeGsdFile(
      base,
      "milestones/M002/M002-CONTEXT.md",
      [
        "---",
        "depends_on: [M003]",
        "---",
        "",
        "# M002: Blocked Milestone",
        "",
        "Depends on M003 which is not yet done.",
      ].join("\n"),
    );
    writeGsdFile(
      base,
      "milestones/M002/M002-ROADMAP.md",
      [
        "# M002: Blocked Milestone",
        "",
        "**Vision:** Must wait for M003.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Work** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"),
    );

    // M003: disk-only, no deps — should be the active milestone
    writeGsdFile(
      base,
      "milestones/M003/M003-CONTEXT.md",
      [
        "---",
        "depends_on: []",
        "---",
        "",
        "# M003: Independent Milestone",
        "",
        "No dependencies.",
      ].join("\n"),
    );
    writeGsdFile(
      base,
      "milestones/M003/M003-ROADMAP.md",
      [
        "# M003: Independent Milestone",
        "",
        "**Vision:** No dependencies.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Work** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"),
    );

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // M003 has no unmet deps and must be the active milestone
    assert.equal(
      state.activeMilestone?.id,
      "M003",
      "M003 (no deps) must be the active milestone, not M002 (#3340)",
    );

    // M002 depends on incomplete M003 — must be pending, not active
    const m002 = state.registry.find((m) => m.id === "M002");
    assert.ok(m002 !== undefined, "M002 should appear in registry");
    assert.equal(
      m002?.status,
      "pending",
      "M002 depends on incomplete M003 — must be pending (#3340: was incorrectly 'active' before fix)",
    );
  });

  // ── Test 2: CONTEXT-DRAFT depends_on is also preserved ───────────────────
  // Same bug via the draft-only code path: a disk-only milestone that has only
  // CONTEXT-DRAFT.md (not CONTEXT.md) must also have its depends_on parsed.
  test("disk-only milestone with CONTEXT-DRAFT must also have depends_on preserved", async () => {
    openDatabase(":memory:");

    // M001: complete in DB + SUMMARY
    insertMilestone({ id: "M001", title: "M001: Done", status: "complete", depends_on: [] });
    writeGsdFile(base, "milestones/M001/M001-SUMMARY.md", "# M001: Done\n\nComplete.");

    // M002: disk-only CONTEXT-DRAFT only, depends_on: [M003]
    writeGsdFile(
      base,
      "milestones/M002/M002-CONTEXT-DRAFT.md",
      [
        "---",
        "depends_on: [M003]",
        "---",
        "",
        "# M002: Draft Milestone",
        "",
        "Draft depends on M003.",
      ].join("\n"),
    );

    // M003: disk-only, no deps
    writeGsdFile(
      base,
      "milestones/M003/M003-CONTEXT.md",
      [
        "---",
        "depends_on: []",
        "---",
        "",
        "# M003: Independent Milestone",
        "",
        "No deps.",
      ].join("\n"),
    );
    writeGsdFile(
      base,
      "milestones/M003/M003-ROADMAP.md",
      [
        "# M003: Independent Milestone",
        "",
        "**Vision:** No deps.",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Work** `risk:low` `depends:[]`",
        "  > After this: done.",
      ].join("\n"),
    );

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // M003 must be active (no unmet deps)
    assert.equal(
      state.activeMilestone?.id,
      "M003",
      "M003 must be active when M002 (CONTEXT-DRAFT) has unmet dep on M003 (#3340)",
    );

    // M002 draft-only with unmet dep must be pending
    const m002 = state.registry.find((m) => m.id === "M002");
    assert.ok(m002 !== undefined, "draft M002 should appear in registry");
    assert.equal(
      m002?.status,
      "pending",
      "draft M002 with unmet depends_on must be pending (#3340)",
    );
  });

  // ── Test 3: milestoneIdSort tiebreaker for same-sequence IDs ─────────────
  // milestoneIdSort returned 0 for M001-fkbvng vs M001-1jp4m8, making sort
  // non-deterministic. The fix adds a suffix comparison as tiebreaker.
  test("milestoneIdSort: deterministic ordering for same-sequence unique IDs", () => {
    const ids = ["M001-zzz000", "M001-aaa111", "M002-abc123", "M001-mmm555"];
    const sorted = [...ids].sort(milestoneIdSort);

    // All M001-* variants must come before M002-*
    const m002Index = sorted.indexOf("M002-abc123");
    const lastM001Index = Math.max(
      sorted.indexOf("M001-zzz000"),
      sorted.indexOf("M001-aaa111"),
      sorted.indexOf("M001-mmm555"),
    );
    assert.ok(
      lastM001Index < m002Index,
      "All M001-* IDs should sort before M002-abc123",
    );

    // Among M001-* variants, order must be deterministic (lexicographic by suffix)
    const m001Variants = sorted.filter((id) => id.startsWith("M001-"));
    assert.deepEqual(
      m001Variants,
      ["M001-aaa111", "M001-mmm555", "M001-zzz000"],
      "M001-* variants must be sorted lexicographically by suffix for deterministic dispatch",
    );

    // Two independent sorts must agree
    const sorted2 = [...ids].sort(milestoneIdSort);
    assert.deepEqual(sorted, sorted2, "sort must produce identical results across calls");
  });
});
