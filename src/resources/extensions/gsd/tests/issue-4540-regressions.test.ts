/**
 * Regression tests for issue #4540:
 *   Bug 1 — Invalid quality_gates migration bricks gsd.db
 *   Bug 2 — Artifact retries emit no journal event, look like stuck loops
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

import {
  openDatabase,
  closeDatabase,
  insertGateRow,
  getPendingGates,
  _getAdapter,
} from "../gsd-db.ts";

import { emitJournalEvent, queryJournal } from "../journal.ts";

const _require = createRequire(import.meta.url);

// ─── helpers ─────────────────────────────────────────────────────────────────

function tmpDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-4540-"));
  return { dir, dbPath: join(dir, "gsd.db") };
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Builds a v12 database with the broken quality_gates DDL:
 * task_id is nullable and there is no proper multi-column PK.
 * This simulates a DB that was created before the v12 fix was applied.
 */
function createBrokenV12Db(dbPath: string): void {
  const sqlite = _require("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");

  db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(12, "2025-01-01T00:00:00.000Z");

  db.exec(`
    CREATE TABLE decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      when_context TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '', choice TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '', revisable TEXT NOT NULL DEFAULT '',
      made_by TEXT NOT NULL DEFAULT 'agent', superseded_by TEXT DEFAULT NULL
    );
    CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL;
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY, class TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '', primary_owner TEXT NOT NULL DEFAULT '',
      supporting_slices TEXT NOT NULL DEFAULT '', validation TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', full_content TEXT NOT NULL DEFAULT '',
      superseded_by TEXT DEFAULT NULL
    );
    CREATE TABLE artifacts (
      path TEXT PRIMARY KEY, artifact_type TEXT NOT NULL DEFAULT '',
      milestone_id TEXT DEFAULT NULL, slice_id TEXT DEFAULT NULL, task_id TEXT DEFAULT NULL,
      full_content TEXT NOT NULL DEFAULT '', imported_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE memories (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL, content TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8,
      source_unit_type TEXT, source_unit_id TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, superseded_by TEXT DEFAULT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'project', tags TEXT NOT NULL DEFAULT '[]',
      structured_fields TEXT DEFAULT NULL
    );
    CREATE TABLE memory_sources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT '', path TEXT DEFAULT NULL,
      imported_at TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'project', tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE memory_relations (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (from_id, to_id)
    );
    CREATE TABLE memory_processed_units (
      unit_key TEXT PRIMARY KEY, activity_file TEXT, processed_at TEXT NOT NULL
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      depends_on TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL, vision TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '[]', key_risks TEXT NOT NULL DEFAULT '[]',
      proof_strategy TEXT NOT NULL DEFAULT '[]', verification_contract TEXT NOT NULL DEFAULT '',
      verification_integration TEXT NOT NULL DEFAULT '',
      verification_operational TEXT NOT NULL DEFAULT '', verification_uat TEXT NOT NULL DEFAULT '',
      definition_of_done TEXT NOT NULL DEFAULT '[]', requirement_coverage TEXT NOT NULL DEFAULT '',
      boundary_map_markdown TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE slices (
      milestone_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', risk TEXT NOT NULL DEFAULT 'medium',
      depends TEXT NOT NULL DEFAULT '[]', demo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '', completed_at TEXT DEFAULT NULL,
      full_summary_md TEXT NOT NULL DEFAULT '', full_uat_md TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '', success_criteria TEXT NOT NULL DEFAULT '',
      proof_level TEXT NOT NULL DEFAULT '', integration_closure TEXT NOT NULL DEFAULT '',
      observability_impact TEXT NOT NULL DEFAULT '', sequence INTEGER DEFAULT 0,
      replan_triggered_at TEXT DEFAULT NULL,
      is_sketch INTEGER NOT NULL DEFAULT 0, sketch_scope TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (milestone_id, id), FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    );
    CREATE TABLE tasks (
      milestone_id TEXT NOT NULL, slice_id TEXT NOT NULL, id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      one_liner TEXT NOT NULL DEFAULT '', narrative TEXT NOT NULL DEFAULT '',
      verification_result TEXT NOT NULL DEFAULT '',
      escalation_pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (milestone_id, slice_id, id),
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    );
    CREATE TABLE assessments (
      path TEXT PRIMARY KEY, milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL, task_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
      full_content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (milestone_id) REFERENCES milestones(id)
    );
    CREATE TABLE replan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL,
      slice_id TEXT DEFAULT NULL, task_id TEXT DEFAULT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT NOT NULL DEFAULT '', task_id TEXT NOT NULL DEFAULT '',
      unit_type TEXT NOT NULL DEFAULT '', unit_id TEXT NOT NULL DEFAULT '',
      evidence_type TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT ''
    );
  `);

  // Broken quality_gates: task_id nullable, no multi-column PK
  db.exec(`
    CREATE TABLE quality_gates (
      milestone_id TEXT NOT NULL, slice_id TEXT NOT NULL, gate_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'slice', task_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'pending', verdict TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '', findings TEXT NOT NULL DEFAULT '',
      evaluated_at TEXT DEFAULT NULL,
      FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
    )
  `);

  // Parent rows + gate row with NULL task_id
  db.prepare("INSERT INTO milestones (id, title, status) VALUES (?, ?, ?)").run("M001", "Milestone 1", "active");
  db.prepare("INSERT INTO slices (milestone_id, id, title, status, risk, depends) VALUES (?, ?, ?, ?, ?, ?)").run("M001", "S01", "Slice 1", "pending", "medium", "[]");
  db.prepare("INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status) VALUES (?, ?, ?, ?, ?, ?)").run("M001", "S01", "Q3", "slice", null, "pending");

  db.close();
}

// ─── Bug 1 tests ─────────────────────────────────────────────────────────────

describe("Bug 1 — quality_gates migration repair (#4540)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = tmpDb());
  });

  afterEach(() => {
    closeDatabase();
    cleanup(dir);
  });

  test("fresh DB: quality_gates task_id is NOT NULL with empty-string default", () => {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const cols = adapter.prepare("PRAGMA table_info(quality_gates)").all() as Array<Record<string, unknown>>;
    const col = cols.find((c) => c["name"] === "task_id");
    assert.ok(col, "task_id column must exist");
    assert.equal(col["notnull"], 1, "task_id must be NOT NULL");
    assert.equal(col["dflt_value"], "''", "task_id default must be ''");
  });

  test("fresh DB: insertGateRow with no taskId stores '' and is idempotent", () => {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    adapter.prepare("INSERT OR IGNORE INTO milestones (id, title, status) VALUES (?, ?, ?)").run("M001", "Test", "active");
    adapter.prepare("INSERT OR IGNORE INTO slices (milestone_id, id, title, status, risk, depends) VALUES (?, ?, ?, ?, ?, ?)").run("M001", "S01", "Slice", "pending", "medium", "[]");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    const rows = getPendingGates("M001", "S01");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, "");
  });

  test("v22 repair: broken v12 DB opens without error", () => {
    createBrokenV12Db(dbPath);
    assert.doesNotThrow(() => openDatabase(dbPath));
  });

  test("v22 repair: task_id becomes NOT NULL after healing broken v12 DB", () => {
    createBrokenV12Db(dbPath);
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const cols = adapter.prepare("PRAGMA table_info(quality_gates)").all() as Array<Record<string, unknown>>;
    const col = cols.find((c) => c["name"] === "task_id");
    assert.ok(col, "task_id column must exist after repair");
    assert.equal(col["notnull"], 1, "task_id must be NOT NULL after repair");
  });

  test("v22 repair: existing NULL task_id row is COALESCE'd to '' during repair", () => {
    createBrokenV12Db(dbPath);
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      "SELECT task_id FROM quality_gates WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q3'"
    ).get() as Record<string, unknown> | undefined;
    assert.ok(row, "original gate row must survive the repair migration");
    assert.equal(row["task_id"], "", "NULL task_id must be repaired to ''");
  });

  test("v22 repair: scope column present on quality_gates after open", () => {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const cols = adapter.prepare("PRAGMA table_info(quality_gates)").all() as Array<Record<string, unknown>>;
    assert.ok(cols.some((c) => c["name"] === "scope"), "quality_gates.scope must exist");
  });

  test("v22 repair: scope column present on assessments after open", () => {
    openDatabase(dbPath);
    const adapter = _getAdapter()!;
    const cols = adapter.prepare("PRAGMA table_info(assessments)").all() as Array<Record<string, unknown>>;
    assert.ok(cols.some((c) => c["name"] === "scope"), "assessments.scope must exist");
  });
});

// ─── Bug 2 tests ─────────────────────────────────────────────────────────────

describe("Bug 2 — artifact-verification-retry journal event (#4540)", () => {
  test("emitJournalEvent accepts artifact-verification-retry event type", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-journal-4540-"));
    try {
      mkdirSync(join(basePath, ".gsd"), { recursive: true });
      emitJournalEvent(basePath, {
        ts: new Date().toISOString(),
        flowId: "flow-4540",
        seq: 1,
        eventType: "artifact-verification-retry",
        data: { unitType: "plan-slice", unitId: "M001/S01", attempt: 1 },
      });
      const entries = queryJournal(basePath, { flowId: "flow-4540" });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].eventType, "artifact-verification-retry");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("artifact-verification-retry event carries attempt count", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-journal-4540b-"));
    try {
      mkdirSync(join(basePath, ".gsd"), { recursive: true });
      emitJournalEvent(basePath, {
        ts: new Date().toISOString(),
        flowId: "flow-4540b",
        seq: 1,
        eventType: "artifact-verification-retry",
        data: { unitType: "exec-slice", unitId: "M002/S02", attempt: 2 },
      });
      const entries = queryJournal(basePath, { flowId: "flow-4540b", eventType: "artifact-verification-retry" });
      assert.equal(entries.length, 1);
      const payload = entries[0].data as Record<string, unknown>;
      assert.equal(payload["attempt"], 2);
      assert.equal(payload["unitId"], "M002/S02");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
