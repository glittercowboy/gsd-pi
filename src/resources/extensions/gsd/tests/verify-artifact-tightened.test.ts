/**
 * Regression test for #3607 — tighten verifyExpectedArtifact legacy branch.
 *
 * The legacy (pre-migration) fallback in verifyExpectedArtifact previously
 * accepted either a heading match (### T01 --) or a checked checkbox as proof
 * that gsd_complete_task ran. A heading alone does not prove completion —
 * it could result from a rogue write.
 *
 * These tests exercise verifyExpectedArtifact directly for execute-task units
 * when the DB is unavailable (legacy branch). Only a checked checkbox in the
 * slice plan counts as evidence of completion; a bare heading or an unchecked
 * checkbox must not pass.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { closeDatabase, isDbAvailable } from "../gsd-db.ts";

/** Scaffold .gsd/milestones/M001/slices/S01/ with tasks/ and a T01-SUMMARY.md. */
function scaffoldProject(t: { after: (fn: () => void) => void }): {
  base: string;
  planPath: string;
} {
  const base = mkdtempSync(join(tmpdir(), "gsd-verify-artifact-"));
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  // Summary file must exist so verifyExpectedArtifact reaches the legacy branch
  writeFileSync(join(sliceDir, "tasks", "T01-SUMMARY.md"), "# T01 summary\n");
  return { base, planPath: join(sliceDir, "S01-PLAN.md") };
}

test("#3607: execute-task legacy branch — checked checkbox [x] passes verification", (t) => {
  closeDatabase();
  assert.equal(isDbAvailable(), false, "DB must be closed to hit legacy branch");

  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T01: Implement feature**",
      "",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "checked checkbox [x] is accepted as completion evidence",
  );
});

test("#3607: execute-task legacy branch — checked checkbox [X] (uppercase) also passes", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [X] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "uppercase [X] checkbox is accepted",
  );
});

test("#3607: execute-task legacy branch — unchecked checkbox [ ] is rejected", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [ ] **T01: Implement feature**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "unchecked checkbox [ ] must not pass verification (#3607)",
  );
});

test("#3607: execute-task legacy branch — bare heading ### T01 is no longer sufficient", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  // Old buggy behaviour would pass on a heading alone. This must now fail.
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "### T01 -- Implement feature",
      "",
      "Some description here, but no checkbox.",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "heading alone must not pass verification after #3607 fix",
  );
});

test("#3607: execute-task legacy branch — missing plan file returns false", (t) => {
  closeDatabase();
  const { base } = scaffoldProject(t);
  // Do not create S01-PLAN.md at all.

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "missing plan file must cause verification to return false",
  );
});

test("#3607: execute-task legacy branch — wrong task id in checkbox does not match", (t) => {
  closeDatabase();
  const { base, planPath } = scaffoldProject(t);
  writeFileSync(
    planPath,
    [
      "# S01 plan",
      "",
      "- [x] **T02: Some other task**",
    ].join("\n"),
  );

  assert.equal(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "checkbox for a different task id must not count as T01 completion",
  );
});
