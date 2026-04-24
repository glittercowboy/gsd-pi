import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
  insertRequirement,
  insertArtifact,
  insertMilestone,
  getMilestone,
  getDecisionById,
  getRequirementById,
  _getAdapter,
  copyWorktreeDb,
  reconcileWorktreeDb,
} from "../gsd-db.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gsd-wt-test-"));
}

function seedMainDb(dbPath: string): void {
  openDatabase(dbPath);
  insertDecision({
    id: "D001",
    when_context: "2025-01-01",
    scope: "M001/S01",
    decision: "Use SQLite",
    choice: "node:sqlite",
    rationale: "Built-in",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "Must store decisions",
    why: "Core feature",
    source: "design",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "test",
    notes: "",
    full_content: "Full requirement text",
    superseded_by: null,
  });
  insertArtifact({
    path: "docs/arch.md",
    artifact_type: "plan",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "Architecture document",
  });
}

function registerCleanup(t: { after: (fn: () => void) => void }, ...dirs: string[]) {
  t.after(() => {
    closeDatabase();
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });
}

// ─── copyWorktreeDb ───────────────────────────────────────────────────────

test("copyWorktreeDb copies DB file and data is queryable", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const destDb = path.join(destDir, "nested", "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();

  const result = copyWorktreeDb(srcDb, destDb);
  assert.equal(result, true, "copyWorktreeDb returns true on success");
  assert.ok(fs.existsSync(destDb), "dest DB file exists after copy");

  openDatabase(destDb);
  const d = getDecisionById("D001");
  assert.ok(d !== null, "decision queryable in copied DB");
  assert.equal(d?.choice, "node:sqlite", "decision data preserved in copy");

  const r = getRequirementById("R001");
  assert.ok(r !== null, "requirement queryable in copied DB");
  assert.equal(r?.description, "Must store decisions", "requirement data preserved in copy");
});

test("copyWorktreeDb skips -wal and -shm files", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const destDb = path.join(destDir, "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();

  fs.writeFileSync(srcDb + "-wal", "fake wal data");
  fs.writeFileSync(srcDb + "-shm", "fake shm data");

  copyWorktreeDb(srcDb, destDb);

  assert.ok(fs.existsSync(destDb), "DB file copied");
  assert.ok(!fs.existsSync(destDb + "-wal"), "WAL file NOT copied");
  assert.ok(!fs.existsSync(destDb + "-shm"), "SHM file NOT copied");
});

test("copyWorktreeDb returns false when source doesn't exist", (t) => {
  const destDir = tempDir();
  registerCleanup(t, destDir);

  const missingSrc = path.join(destDir, "missing", "gsd.db");
  const result = copyWorktreeDb(missingSrc, path.join(destDir, "gsd.db"));
  assert.equal(result, false, "returns false for missing source");
});

test("copyWorktreeDb creates deeply nested dest directories", (t) => {
  const srcDir = tempDir();
  const destDir = tempDir();
  registerCleanup(t, srcDir, destDir);

  const srcDb = path.join(srcDir, "gsd.db");
  const deepDest = path.join(destDir, "a", "b", "c", "gsd.db");

  seedMainDb(srcDb);
  closeDatabase();

  const result = copyWorktreeDb(srcDb, deepDest);
  assert.equal(result, true, "copyWorktreeDb succeeds with nested dest");
  assert.ok(fs.existsSync(deepDest), "DB file created at deeply nested path");
});

// ─── reconcileWorktreeDb ──────────────────────────────────────────────────

test("reconcileWorktreeDb merges new decisions from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  insertDecision({
    id: "D002",
    when_context: "2025-02-01",
    scope: "M001/S02",
    decision: "Use WAL mode",
    choice: "WAL",
    rationale: "Performance",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.decisions > 0, "decisions merged count > 0");
  const d2 = getDecisionById("D002");
  assert.ok(d2 !== null, "D002 from worktree now in main");
  assert.equal(d2?.choice, "WAL", "D002 data correct after merge");
});

test("reconcileWorktreeDb merges new requirements from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertRequirement({
    id: "R002",
    class: "non-functional",
    status: "active",
    description: "Must be fast",
    why: "UX",
    source: "design",
    primary_owner: "S02",
    supporting_slices: "",
    validation: "benchmark",
    notes: "",
    full_content: "Performance requirement",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.requirements > 0, "requirements merged count > 0");
  const r2 = getRequirementById("R002");
  assert.ok(r2 !== null, "R002 from worktree now in main");
  assert.equal(r2?.description, "Must be fast", "R002 data correct after merge");
});

test("reconcileWorktreeDb merges new artifacts from worktree into main", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertArtifact({
    path: "docs/api.md",
    artifact_type: "reference",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "API documentation",
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.artifacts > 0, "artifacts merged count > 0");
  const adapter = _getAdapter()!;
  const row = adapter.prepare("SELECT * FROM artifacts WHERE path = ?").get("docs/api.md");
  // Statement#get returns undefined (not null) when no row matches, so use
  // loose inequality to catch both — strict `!== null` would silently let a
  // missing artifact row pass this assertion.
  assert.ok(row != null, "artifact from worktree now in main");
  assert.equal((row as any)["artifact_type"], "reference", "artifact data correct after merge");
});

test("reconcileWorktreeDb detects conflicts and applies worktree-wins policy", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  _getAdapter()!.prepare(
    `UPDATE decisions SET choice = 'better-sqlite3' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  openDatabase(wtDb);
  _getAdapter()!.prepare(
    `UPDATE decisions SET choice = 'sql.js' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(result.conflicts.length > 0, "conflicts detected");
  assert.ok(
    result.conflicts.some((c) => c.includes("D001")),
    "conflict mentions D001",
  );

  const d1 = getDecisionById("D001");
  assert.equal(d1?.choice, "sql.js", "worktree wins on conflict (INSERT OR REPLACE)");
});

test("reconcileWorktreeDb handles missing worktree DB gracefully", (t) => {
  const mainDir = tempDir();
  registerCleanup(t, mainDir);

  const mainDb = path.join(mainDir, "gsd.db");
  seedMainDb(mainDb);

  const missingWt = path.join(mainDir, "missing-worktree.db");
  const result = reconcileWorktreeDb(mainDb, missingWt);
  assert.equal(result.decisions, 0, "no decisions merged for missing worktree DB");
  assert.equal(result.requirements, 0, "no requirements merged for missing worktree DB");
  assert.equal(result.artifacts, 0, "no artifacts merged for missing worktree DB");
  assert.equal(result.conflicts.length, 0, "no conflicts for missing worktree DB");
});

test("reconcileWorktreeDb handles paths containing spaces", (t) => {
  const baseDir = tempDir();
  registerCleanup(t, baseDir);

  const mainDir = path.join(baseDir, "main dir");
  const wtDir = path.join(baseDir, "worktree dir");
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertDecision({
    id: "D003",
    when_context: "2025-03-01",
    scope: "M001/S03",
    decision: "Path spaces test",
    choice: "yes",
    rationale: "Robustness",
    revisable: "no",
    made_by: "agent",
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);
  assert.ok(result.decisions > 0, "reconciliation works with spaces in path");
  const d3 = getDecisionById("D003");
  assert.ok(d3 !== null, "D003 merged from worktree with spaces in path");
});

test("reconcileWorktreeDb leaves main DB usable after DETACH", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(isDbAvailable(), "DB still available after reconciliation");

  insertDecision({
    id: "D099",
    when_context: "2025-12-01",
    scope: "test",
    decision: "Post-reconcile insert",
    choice: "works",
    rationale: "Verify DETACH cleanup",
    revisable: "no",
    made_by: "agent",
    superseded_by: null,
  });

  const d99 = getDecisionById("D099");
  assert.ok(d99 !== null, "can insert and query after reconciliation");
  assert.equal(d99?.choice, "works", "post-reconcile data correct");

  // Verify wt database is detached
  const adapter = _getAdapter()!;
  let wtAccessible = false;
  try {
    adapter.prepare("SELECT count(*) FROM wt.decisions").get();
    wtAccessible = true;
  } catch {
    // Expected — wt should be detached
  }
  assert.ok(!wtAccessible, "wt database is detached after reconciliation");
});

test("reconcileWorktreeDb is a no-op when DBs are identical", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.equal(result.conflicts.length, 0, "no conflicts when DBs are identical");
  assert.ok(isDbAvailable(), "DB usable after no-change reconciliation");
});

test("reconcileWorktreeDb does not downgrade milestone status complete→active (#4372)", (t) => {
  const mainDir = tempDir();
  const wtDir = tempDir();
  registerCleanup(t, mainDir, wtDir);

  const mainDb = path.join(mainDir, "gsd.db");
  const wtDb = path.join(wtDir, "gsd.db");

  seedMainDb(mainDb);
  const mainAdapter = _getAdapter()!;
  insertMilestone({ id: "M-COMP", title: "Completed Milestone", status: "complete" });
  mainAdapter.prepare(`UPDATE milestones SET completed_at = '2025-06-01T00:00:00.000Z' WHERE id = 'M-COMP'`).run();
  closeDatabase();

  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  _getAdapter()!.prepare(`UPDATE milestones SET status = 'active', completed_at = NULL WHERE id = 'M-COMP'`).run();
  closeDatabase();

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  const m = getMilestone("M-COMP");
  assert.ok(m !== null, "milestone M-COMP still exists after reconcile");
  assert.equal(m!.status, "complete", "complete milestone must not be downgraded to active by stale worktree");
});
