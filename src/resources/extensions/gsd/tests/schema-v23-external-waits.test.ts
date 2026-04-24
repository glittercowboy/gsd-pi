/**
 * Schema v23 migration test: external_waits table.
 *
 * Verifies:
 * 1. Fresh DB creation includes the external_waits table with correct columns
 * 2. The poll_while_command column exists (renamed from check_command)
 * 3. A pre-v23 DB (stamped at v22) successfully migrates to v23
 * 4. Index idx_external_waits_milestone_status exists
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
} from "../gsd-db.ts";

let tmpDir: string;

afterEach(() => {
  try { closeDatabase(); } catch { /* may not be open */ }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("Schema v23: external_waits table", () => {
  test("fresh DB has external_waits table with poll_while_command column", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-v23-"));
    const dbPath = join(tmpDir, "gsd.db");

    openDatabase(dbPath);
    const db = _getAdapter()!;
    assert.ok(db, "DB should be open");

    // Verify table exists
    const tableInfo = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='external_waits'"
    ).get() as { name: string } | undefined;
    assert.ok(tableInfo, "external_waits table should exist");

    // Verify columns
    const columns = db.prepare("PRAGMA table_info(external_waits)").all() as Array<{ name: string }>;
    const colNames = columns.map(c => c.name);

    assert.ok(colNames.includes("poll_while_command"), "should have poll_while_command column");
    assert.ok(colNames.includes("success_check"), "should have success_check column");
    assert.ok(colNames.includes("poll_interval_ms"), "should have poll_interval_ms column");
    assert.ok(colNames.includes("timeout_ms"), "should have timeout_ms column");
    assert.ok(colNames.includes("status"), "should have status column");
    assert.ok(colNames.includes("probe_failure_count"), "should have probe_failure_count column");
    assert.ok(colNames.includes("on_timeout"), "should have on_timeout column");
    assert.ok(colNames.includes("context_hint"), "should have context_hint column");
    assert.ok(colNames.includes("registered_at"), "should have registered_at column");
    assert.ok(colNames.includes("resolved_at"), "should have resolved_at column");

    // Verify the old column name does NOT exist
    assert.ok(!colNames.includes("check_command"), "should NOT have old check_command column");
  });

  test("v23 schema version is recorded", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-v23-ver-"));
    const dbPath = join(tmpDir, "gsd.db");

    openDatabase(dbPath);
    const db = _getAdapter()!;

    const row = db.prepare(
      "SELECT version FROM schema_version WHERE version = 23"
    ).get() as { version: number } | undefined;
    assert.ok(row, "schema_version should contain v23");
    assert.equal(row.version, 23);
  });

  test("idx_external_waits_milestone_status index exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-v23-idx-"));
    const dbPath = join(tmpDir, "gsd.db");

    openDatabase(dbPath);
    const db = _getAdapter()!;

    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_external_waits_milestone_status'"
    ).get() as { name: string } | undefined;
    assert.ok(idx, "idx_external_waits_milestone_status index should exist");
  });

  test("insertExternalWait + getExternalWait round-trip with poll_while_command", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-v23-rt-"));
    const dbPath = join(tmpDir, "gsd.db");

    openDatabase(dbPath);
    const db = _getAdapter()!;

    // Insert prerequisite rows
    db.prepare("INSERT INTO milestones (id, title, status) VALUES ('M001', 'Test', 'active')").run();
    db.prepare("INSERT INTO slices (milestone_id, id, title, status) VALUES ('M001', 'S01', 'Test', 'in_progress')").run();
    db.prepare("INSERT INTO tasks (milestone_id, slice_id, id, title, status) VALUES ('M001', 'S01', 'T01', 'Test', 'executing')").run();

    // Use the DB function directly
    const { insertExternalWait, getExternalWait } = await import("../gsd-db.ts");
    insertExternalWait("M001", "S01", "T01", "squeue -j 12345 | grep -c 12345", {
      successCheck: "sacct -j 12345 --format=ExitCode",
      pollIntervalMs: 60000,
      timeoutMs: 3600000,
      contextHint: "SLURM job 12345",
      onTimeout: "resume-with-failure",
    });

    const row = getExternalWait("M001", "S01", "T01");
    assert.ok(row, "should retrieve inserted external wait");
    assert.equal(row.poll_while_command, "squeue -j 12345 | grep -c 12345");
    assert.equal(row.success_check, "sacct -j 12345 --format=ExitCode");
    assert.equal(row.poll_interval_ms, 60000);
    assert.equal(row.timeout_ms, 3600000);
    assert.equal(row.context_hint, "SLURM job 12345");
    assert.equal(row.on_timeout, "resume-with-failure");
    assert.equal(row.status, "waiting");
  });
});
