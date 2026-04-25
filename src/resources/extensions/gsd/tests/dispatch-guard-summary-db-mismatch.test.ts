// GSD-2 dispatch-guard regression test: SUMMARY/DB mismatch fail-closed behavior (#4663)
//
// Sibling bug to #4658 / PR #4660. A failure-path SUMMARY file on disk
// must not let the cross-milestone dispatch guard treat an "active"
// milestone as complete. DB status is authoritative when available.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-4663-"));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  openDatabase(join(repo, ".gsd", "gsd.db"));
  return repo;
}

function teardownRepo(repo: string): void {
  closeDatabase();
  rmSync(repo, { recursive: true, force: true });
}

test("#4663: dispatch guard blocks when prior milestone has failure SUMMARY but DB is still active", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  // M002: DB says active with a pending slice, but a failure SUMMARY exists on disk.
  insertMilestone({ id: "M002", title: "Previous", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Pending", status: "pending", depends: [] });

  insertMilestone({ id: "M003", title: "Current", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [] });

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");
  writeFileSync(
    join(repo, ".gsd", "milestones", "M002", "M002-SUMMARY.md"),
    "# M002 Summary\nverification FAILED — not complete.\n",
  );

  // Before #4663: SUMMARY presence short-circuited the loop and M002 was skipped,
  // allowing M003/S01 to dispatch. After: DB status is consulted and M002 still blocks.
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    "Cannot dispatch plan-slice M003/S01: earlier slice M002/S01 is not complete.",
  );
});

test("#4663: dispatch guard allows dispatch when prior milestone has SUMMARY and DB is complete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M002", title: "Previous", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Done", status: "complete", depends: [] });

  insertMilestone({ id: "M003", title: "Current", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [] });

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-SUMMARY.md"), "# M002 Summary\nDone.\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    null,
  );
});
