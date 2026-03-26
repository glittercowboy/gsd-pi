/**
 * Regression test for #2667: deriveStateFromDb must NOT treat an empty
 * slice array as "all slices done" due to JavaScript's vacuous-truth
 * behavior of Array.prototype.every on an empty array.
 *
 * [].every(predicate) === true in JavaScript. Without a length > 0 guard,
 * this causes a premature phase transition to validating-milestone when
 * the DB returns 0 slices (e.g. after a worktree DB wipe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";

test("deriveStateFromDb does NOT skip to validating when slice array is empty (#2667)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-vacuous-truth-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });

  try {
    // Set up a milestone with a roadmap that references slices,
    // but the DB has NO slice rows (simulating a worktree DB wipe)
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "### S01 — First Slice",
        "Do something.",
        "",
        "### S02 — Second Slice",
        "Do another thing.",
      ].join("\n"),
    );

    openDatabase(":memory:");
    // Milestone exists but NO slices inserted — simulates DB wipe
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // The phase must NOT be "validating-milestone" or "completing-milestone"
    // because no slices have been executed — the empty array should not
    // trigger the "all slices done" code path.
    assert.notEqual(
      state.phase,
      "validating-milestone",
      "empty slice array must not trigger validating-milestone (vacuous truth)",
    );
    assert.notEqual(
      state.phase,
      "completing-milestone",
      "empty slice array must not trigger completing-milestone (vacuous truth)",
    );

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("deriveStateFromDb correctly reaches validating when all slices are done (#2667 guard)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-vacuous-truth-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });

  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "### S01 — First Slice",
        "Do something.",
      ].join("\n"),
    );

    // Write a slice summary so the filesystem recognizes it as complete
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md"),
      "# S01 Summary\n\nDone.",
    );

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "First Slice", status: "complete", risk: "low", depends: [] });

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // With one slice that IS complete, phase should advance
    assert.ok(
      state.phase === "validating-milestone" || state.phase === "completing-milestone",
      `expected validating or completing phase, got "${state.phase}"`,
    );

    closeDatabase();
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
