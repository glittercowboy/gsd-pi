import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPriorSliceCompletionBlocker } from "../dispatch-guard.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";

/** Helper: create temp dir and open an in-dir DB for dispatch-guard tests */
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-dispatch-guard-"));
  mkdirSync(join(repo, ".gsd"), { recursive: true });
  openDatabase(join(repo, ".gsd", "gsd.db"));
  return repo;
}

/** Helper: tear down repo (close DB then remove dir) */
function teardownRepo(repo: string): void {
  closeDatabase();
  rmSync(repo, { recursive: true, force: true });
}

test("dispatch guard blocks when prior milestone has incomplete slices", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  // Seed DB: M002 with S01 complete, S02 pending
  insertMilestone({ id: "M002", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Pending", status: "pending", depends: ["S01"], sequence: 2 });

  // M003 with two pending slices
  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"], sequence: 2 });

  // Need ROADMAP files for milestone discovery (findMilestoneIds reads disk)
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M003/S01"),
    "Cannot dispatch plan-slice M003/S01: earlier slice M002/S02 is not complete.",
  );
});

test("dispatch guard blocks later slice in same milestone when earlier incomplete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M002", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M002", title: "Done", status: "complete", depends: ["S01"], sequence: 2 });

  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "pending", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"),
    "Cannot dispatch execute-task M003/S02/T01: dependency slice M003/S01 is not complete.",
  );
});

test("dispatch guard allows dispatch when all earlier slices complete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M003"), { recursive: true });

  insertMilestone({ id: "M003", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "First", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M003", title: "Second", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M003", "M003-ROADMAP.md"), "# M003\n");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "execute-task", "M003/S02/T01"), null);
  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-milestone", "M003"), null);
});

test("dispatch guard unblocks slice when positionally-earlier slice depends on it (#1638)", (t) => {
  // S05 depends on S06, but S05 appears first positionally.
  // Old behavior: S06 blocked because S05 (positionally earlier) is incomplete.
  // Fixed behavior: S06 has no unmet dependencies, so it can dispatch.
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Setup", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Core", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "API", status: "complete", depends: ["S02"], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Auth", status: "complete", depends: ["S03"], sequence: 4 });
  insertSlice({ id: "S05", milestoneId: "M001", title: "Integration", status: "pending", depends: ["S04", "S06"], sequence: 5 });
  insertSlice({ id: "S06", milestoneId: "M001", title: "Data Layer", status: "pending", depends: ["S04"], sequence: 6 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S06 depends only on S04 (complete) — should be unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S06"),
    null,
  );

  // S05 depends on S04 (complete) and S06 (incomplete) — should be blocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S05"),
    "Cannot dispatch plan-slice M001/S05: dependency slice M001/S06 is not complete.",
  );
});

test("dispatch guard falls back to positional ordering when no dependencies declared", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "First", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Second", status: "pending", depends: [], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Third", status: "pending", depends: [], sequence: 3 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S03 has no dependencies — positional fallback blocks on S02
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
    "Cannot dispatch plan-slice M001/S03: earlier slice M001/S02 is not complete.",
  );

  // S02 has no dependencies — positional fallback: S01 is done, so unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"),
    null,
  );
});

test("dispatch guard allows slice with all declared dependencies complete", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Setup", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Core", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03", milestoneId: "M001", title: "Feature A", status: "pending", depends: ["S01", "S02"], sequence: 3 });
  insertSlice({ id: "S04", milestoneId: "M001", title: "Feature B", status: "pending", depends: ["S01"], sequence: 4 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  // S03 depends on S01 (done) and S02 (done) — unblocked
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S03"),
    null,
  );

  // S04 depends only on S01 (done) — unblocked even though S03 is incomplete
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S04"),
    null,
  );
});

test("dispatch guard skips completed milestone with SUMMARY even if it has unchecked remediation slices (#1716)", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "milestones", "M002"), { recursive: true });

  // M001 is complete (has SUMMARY) but has unchecked remediation slices in DB
  insertMilestone({ id: "M001", title: "Previous" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Core", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Tests", status: "complete", depends: ["S01"], sequence: 2 });
  insertSlice({ id: "S03-R", milestoneId: "M001", title: "Remediation", status: "pending", depends: ["S02"], sequence: 3 });
  insertSlice({ id: "S04-R", milestoneId: "M001", title: "Remediation 2", status: "pending", depends: ["S02"], sequence: 4 });

  insertMilestone({ id: "M002", title: "Current" });
  insertSlice({ id: "S01", milestoneId: "M002", title: "Start", status: "pending", depends: [], sequence: 1 });

  // M001 SUMMARY on disk triggers skip
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "---\nstatus: complete\n---\n# M001 Summary\nDone.\n");
  writeFileSync(join(repo, ".gsd", "milestones", "M002", "M002-ROADMAP.md"), "# M002\n");

  // M001 has SUMMARY — should be skipped, not block M002/S01
  assert.equal(
    getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M002/S01"),
    null,
  );
});

test("dispatch guard works without git repo", (t) => {
  const repo = setupRepo();
  t.after(() => teardownRepo(repo));

  mkdirSync(join(repo, ".gsd", "milestones", "M001"), { recursive: true });

  insertMilestone({ id: "M001", title: "Test" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete", depends: [], sequence: 1 });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Pending", status: "pending", depends: ["S01"], sequence: 2 });

  writeFileSync(join(repo, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# M001\n");

  assert.equal(getPriorSliceCompletionBlocker(repo, "main", "plan-slice", "M001/S02"), null);
});
