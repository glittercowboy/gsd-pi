/**
 * Regression test for issue #4591: SCHEMA_VERSION gap — v21 migration
 * existed but the constant was never bumped from 20.
 *
 * Root cause: PR #4496 added the v21 migration block but left
 * SCHEMA_VERSION = 20.  Because migrateSchema() short-circuits when
 * currentVersion >= SCHEMA_VERSION, a DB already at v20 would skip the
 * v21 block entirely, leaving memories without the structured_fields
 * column and no v21 stamp in schema_version.
 *
 * This file verifies the correct behaviour: opening a v20 DB must result
 * in the structured_fields column being present and schema_version
 * recording version 21.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
} from '../gsd-db.ts';

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-v21-'));
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

/**
 * Create a minimal SQLite DB stamped at schema v20.
 *
 * The memories table intentionally omits the structured_fields column —
 * that column is what the v21 migration adds.  All other tables that exist
 * after the v20 migration are present so that migrateSchema() can run
 * without tripping over missing prerequisites.
 */
function createV20Db(dbPath: string): void {
  const sqlite = _require('node:sqlite') as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (20, '2026-01-01T00:00:00.000Z');

    CREATE TABLE decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      when_context TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      choice TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      revisable TEXT NOT NULL DEFAULT '',
      made_by TEXT NOT NULL DEFAULT 'agent',
      source TEXT NOT NULL DEFAULT 'discussion',
      superseded_by TEXT DEFAULT NULL
    );
    CREATE TABLE requirements (
      id TEXT PRIMARY KEY,
      class TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      primary_owner TEXT NOT NULL DEFAULT '',
      supporting_slices TEXT NOT NULL DEFAULT '',
      validation TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      full_content TEXT NOT NULL DEFAULT '',
      superseded_by TEXT DEFAULT NULL
    );
    CREATE TABLE artifacts (
      path TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL DEFAULT '',
      milestone_id TEXT DEFAULT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      full_content TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE memories (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source_unit_type TEXT,
      source_unit_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_by TEXT DEFAULT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'project',
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE memory_processed_units (
      unit_key TEXT PRIMARY KEY,
      activity_file TEXT,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE memory_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      uri TEXT,
      title TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      tags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE memory_relations (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, rel)
    );

    CREATE TABLE milestones (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      depends_on TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      vision TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '[]',
      key_risks TEXT NOT NULL DEFAULT '[]',
      proof_strategy TEXT NOT NULL DEFAULT '[]',
      verification_contract TEXT NOT NULL DEFAULT '',
      verification_integration TEXT NOT NULL DEFAULT '',
      verification_operational TEXT NOT NULL DEFAULT '',
      verification_uat TEXT NOT NULL DEFAULT '',
      definition_of_done TEXT NOT NULL DEFAULT '[]',
      requirement_coverage TEXT NOT NULL DEFAULT '',
      boundary_map_markdown TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE slices (
      milestone_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      risk TEXT NOT NULL DEFAULT 'medium',
      depends TEXT NOT NULL DEFAULT '[]',
      demo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      full_summary_md TEXT NOT NULL DEFAULT '',
      full_uat_md TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '',
      proof_level TEXT NOT NULL DEFAULT '',
      integration_closure TEXT NOT NULL DEFAULT '',
      observability_impact TEXT NOT NULL DEFAULT '',
      sequence INTEGER DEFAULT 0,
      replan_triggered_at TEXT DEFAULT NULL,
      is_sketch INTEGER NOT NULL DEFAULT 0,
      sketch_scope TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (milestone_id, id)
    );
    CREATE TABLE tasks (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      one_liner TEXT NOT NULL DEFAULT '',
      narrative TEXT NOT NULL DEFAULT '',
      verification_result TEXT NOT NULL DEFAULT '',
      duration TEXT NOT NULL DEFAULT '',
      completed_at TEXT DEFAULT NULL,
      blocker_discovered INTEGER DEFAULT 0,
      deviations TEXT NOT NULL DEFAULT '',
      known_issues TEXT NOT NULL DEFAULT '',
      key_files TEXT NOT NULL DEFAULT '[]',
      key_decisions TEXT NOT NULL DEFAULT '[]',
      full_summary_md TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      estimate TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]',
      verify TEXT NOT NULL DEFAULT '',
      inputs TEXT NOT NULL DEFAULT '[]',
      expected_output TEXT NOT NULL DEFAULT '[]',
      observability_impact TEXT NOT NULL DEFAULT '',
      full_plan_md TEXT NOT NULL DEFAULT '',
      sequence INTEGER DEFAULT 0,
      blocker_source TEXT NOT NULL DEFAULT '',
      escalation_pending INTEGER NOT NULL DEFAULT 0,
      escalation_awaiting_review INTEGER NOT NULL DEFAULT 0,
      escalation_artifact_path TEXT DEFAULT NULL,
      escalation_override_applied_at TEXT DEFAULT NULL,
      PRIMARY KEY (milestone_id, slice_id, id)
    );
    CREATE TABLE verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT NOT NULL DEFAULT '',
      milestone_id TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      exit_code INTEGER DEFAULT 0,
      verdict TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE replan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      summary TEXT NOT NULL DEFAULT '',
      previous_artifact_path TEXT DEFAULT NULL,
      replacement_artifact_path TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE assessments (
      path TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL DEFAULT '',
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      full_content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE quality_gates (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'slice',
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      verdict TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '',
      evaluated_at TEXT DEFAULT NULL,
      PRIMARY KEY (milestone_id, slice_id, gate_id, task_id)
    );
    CREATE TABLE slice_dependencies (
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      depends_on_slice_id TEXT NOT NULL,
      PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id)
    );
    CREATE TABLE gate_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      gate_id TEXT NOT NULL,
      gate_type TEXT NOT NULL DEFAULT '',
      unit_type TEXT DEFAULT NULL,
      unit_id TEXT DEFAULT NULL,
      milestone_id TEXT DEFAULT NULL,
      slice_id TEXT DEFAULT NULL,
      task_id TEXT DEFAULT NULL,
      outcome TEXT NOT NULL DEFAULT 'pass',
      failure_class TEXT NOT NULL DEFAULT 'none',
      rationale TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      retryable INTEGER NOT NULL DEFAULT 0,
      evaluated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE turn_git_transactions (
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      unit_type TEXT DEFAULT NULL,
      unit_id TEXT DEFAULT NULL,
      stage TEXT NOT NULL DEFAULT 'turn-start',
      action TEXT NOT NULL DEFAULT 'status-only',
      push INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT DEFAULT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (trace_id, turn_id, stage)
    );
    CREATE TABLE audit_events (
      event_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      turn_id TEXT DEFAULT NULL,
      caused_by TEXT DEFAULT NULL,
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE audit_turn_index (
      trace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (trace_id, turn_id)
    );
  `);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* may not exist */ }
  try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* may not exist */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('schema v21 migration: structured_fields column added when upgrading from v20', () => {
  const base = makeTmp();
  const dbPath = path.join(base, 'gsd.db');
  createV20Db(dbPath);

  try {
    openDatabase(dbPath);

    const db = _getAdapter()!;

    // The v21 migration must have added the structured_fields column.
    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<Record<string, unknown>>;
    const colNames = new Set(cols.map((c) => c['name'] as string));
    assert.ok(
      colNames.has('structured_fields'),
      'v21 migration must add structured_fields column to memories table',
    );
  } finally {
    cleanup(base);
  }
});

test('schema v21 migration: version 21 is recorded in schema_version after upgrading from v20', () => {
  const base = makeTmp();
  const dbPath = path.join(base, 'gsd.db');
  createV20Db(dbPath);

  try {
    openDatabase(dbPath);

    const db = _getAdapter()!;

    // Verify that version 21 was recorded.  A missing stamp means the
    // migration code executed but never committed its version row — the
    // precise failure mode described in issue #4591.
    const versions = db
      .prepare('SELECT version FROM schema_version ORDER BY version')
      .all() as Array<Record<string, unknown>>;
    const versionNums = versions.map((r) => r['version'] as number);

    assert.ok(
      versionNums.includes(21),
      `schema_version must contain a row for version 21 after upgrade from v20; found: [${versionNums.join(', ')}]`,
    );
  } finally {
    cleanup(base);
  }
});

test('schema v21 migration: upgrading from v20 lands on current SCHEMA_VERSION', () => {
  const base = makeTmp();
  const dbPath = path.join(base, 'gsd.db');
  createV20Db(dbPath);

  try {
    openDatabase(dbPath);

    const db = _getAdapter()!;

    const maxVersion = (
      db.prepare('SELECT MAX(version) as v FROM schema_version').get() as Record<string, unknown>
    )?.['v'] as number;

    // The DB must reach the current SCHEMA_VERSION.  If the v21 block was
    // skipped (as it would be when SCHEMA_VERSION was still 20), this
    // assertion catches it.
    assert.ok(
      maxVersion >= 21,
      `DB upgraded from v20 must reach at least schema version 21; got ${maxVersion}`,
    );
  } finally {
    cleanup(base);
  }
});
