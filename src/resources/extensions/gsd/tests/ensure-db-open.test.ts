import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// ensureDbOpen — Tests that the lazy DB opener creates + migrates the database
// when .gsd/ exists with Markdown content but no gsd.db file.
//
// This covers the bug where interactive (non-auto) sessions got
// "GSD database is not available" because ensureDbOpen only opened
// existing DB files but never created them.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { closeDatabase, isDbAvailable, getDecisionById, _getAdapter } from '../gsd-db.ts';

const _require = createRequire(import.meta.url);

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ensure-db-'));
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

function createLegacyV15Db(dbPath: string): void {
  const sqlite = _require('node:sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at) VALUES (15, '2026-01-01T00:00:00.000Z');

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
      hit_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE memory_processed_units (
      unit_key TEXT PRIMARY KEY,
      activity_file TEXT,
      processed_at TEXT NOT NULL
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

// ═══════════════════════════════════════════════════════════════════════════
// ensureDbOpen creates DB + migrates when .gsd/ has Markdown
// ═══════════════════════════════════════════════════════════════════════════

describe('ensure-db-open', () => {
  test('ensureDbOpen: creates DB from Markdown', async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });

    // Write a minimal DECISIONS.md so migration has content
    const decisionsContent = `# Decisions

  | # | When | Scope | Decision | Choice | Rationale | Revisable |
  |---|------|-------|----------|--------|-----------|-----------|
  | D001 | M001 | architecture | Use SQLite | SQLite | Sync API | Yes |
  `;
    fs.writeFileSync(path.join(gsdDir, 'DECISIONS.md'), decisionsContent);

    // Verify no DB file exists yet
    const dbPath = path.join(gsdDir, 'gsd.db');
    assert.ok(!fs.existsSync(dbPath), 'DB file should not exist before ensureDbOpen');

    // Close any previously open DB
    try { closeDatabase(); } catch { /* ok */ }

    // Override process.cwd to point at tmpDir for ensureDbOpen
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      // Dynamic import to get the freshest version
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');

      const result = await ensureDbOpen();

      assert.ok(result === true, 'ensureDbOpen should return true when .gsd/ has Markdown');
      assert.ok(fs.existsSync(dbPath), 'DB file should be created after ensureDbOpen');
      assert.ok(isDbAvailable(), 'DB should be available after ensureDbOpen');

      // Verify that Markdown migration actually ran
      const decision = getDecisionById('D001');
      assert.ok(decision !== null, 'D001 should be migrated from DECISIONS.md');
      if (decision) {
        assert.deepStrictEqual(decision.scope, 'architecture', 'Migrated decision scope should match');
        assert.deepStrictEqual(decision.choice, 'SQLite', 'Migrated decision choice should match');
      }
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('ensureDbOpen: explicit basePath opens target project without cwd override', async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    fs.writeFileSync(path.join(gsdDir, 'DECISIONS.md'), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D777 | M001 | architecture | Use explicit basePath | BasePath | Avoid cwd coupling | Yes |
`);

    try {
      closeDatabase();
    } catch { /* ok */ }

    const originalCwd = process.cwd();
    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      const result = await ensureDbOpen(tmpDir);

      assert.ok(result === true, 'ensureDbOpen should honor explicit basePath');
      assert.equal(process.cwd(), originalCwd, 'ensureDbOpen should not mutate process.cwd');
      assert.ok(isDbAvailable(), 'DB should be available after explicit open');
      assert.ok(getDecisionById('D777') !== null, 'explicit basePath DB should be opened');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('ensureDbOpen: migrates legacy v15 DB before bootstrap indexes touch new columns', async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    const dbPath = path.join(gsdDir, 'gsd.db');
    createLegacyV15Db(dbPath);

    try {
      closeDatabase();
    } catch { /* ok */ }

    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      const result = await ensureDbOpen(tmpDir);

      assert.equal(result, true, 'legacy v15 DB should open and migrate');
      assert.ok(isDbAvailable(), 'DB should be available after migrating v15');

      const db = _getAdapter();
      assert.ok(db, 'adapter should be available after ensureDbOpen');
      assert.equal(
        db.prepare('SELECT MAX(version) as version FROM schema_version').get()?.version,
        21,
        'legacy DB should migrate to current schema version',
      );

      const memoryColumns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name));
      const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
      assert.ok(memoryColumns.has('scope'), 'memory scope column should be present');
      assert.ok(memoryColumns.has('tags'), 'memory tags column should be present');
      assert.ok(taskColumns.has('escalation_pending'), 'task escalation_pending column should be present');
      assert.ok(
        db.prepare("SELECT 1 as present FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_scope'").get(),
        'memory scope index should be created after migration-safe bootstrap',
      );
      assert.ok(
        db.prepare("SELECT 1 as present FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_escalation_pending'").get(),
        'task escalation index should be created after migration-safe bootstrap',
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ensureDbOpen returns false when no .gsd/ exists
  // ═══════════════════════════════════════════════════════════════════════════

  test('ensureDbOpen: no .gsd/ returns false', async () => {
    const tmpDir = makeTmpDir();
    // No .gsd/ directory at all

    try { closeDatabase(); } catch { /* ok */ }
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      const result = await ensureDbOpen();
      assert.ok(result === false, 'ensureDbOpen should return false when no .gsd/ exists');
      assert.ok(!isDbAvailable(), 'DB should not be available');
    } finally {
      process.cwd = origCwd;
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ensureDbOpen opens existing DB without re-migration
  // ═══════════════════════════════════════════════════════════════════════════

  test('ensureDbOpen: opens existing DB', async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });

    // Create a DB file first
    const dbPath = path.join(gsdDir, 'gsd.db');
    const { openDatabase } = await import('../gsd-db.ts');
    openDatabase(dbPath);
    closeDatabase();

    assert.ok(fs.existsSync(dbPath), 'DB file should exist from manual create');

    const origCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      const result = await ensureDbOpen();
      assert.ok(result === true, 'ensureDbOpen should open existing DB');
      assert.ok(isDbAvailable(), 'DB should be available');
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ensureDbOpen returns false for empty .gsd/ (no Markdown, no DB)
  // ═══════════════════════════════════════════════════════════════════════════

  test('ensureDbOpen: empty .gsd/ creates empty DB (#2510)', async () => {
    const tmpDir = makeTmpDir();
    const gsdDir = path.join(tmpDir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    // .gsd/ exists but no DECISIONS.md, REQUIREMENTS.md, or milestones/

    try { closeDatabase(); } catch { /* ok */ }
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;

    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      const result = await ensureDbOpen();
      assert.ok(result === true, 'ensureDbOpen should create empty DB for fresh .gsd/');
      assert.ok(fs.existsSync(path.join(gsdDir, 'gsd.db')), 'DB file should be created');
      assert.ok(isDbAvailable(), 'DB should be available');
    } finally {
      process.cwd = origCwd;
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('ensureDbOpen: switches open database when basePath changes', async () => {
    const firstDir = makeTmpDir();
    const secondDir = makeTmpDir();
    fs.mkdirSync(path.join(firstDir, '.gsd'), { recursive: true });
    fs.mkdirSync(path.join(secondDir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(firstDir, '.gsd', 'DECISIONS.md'), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D101 | M001 | architecture | First DB | First | First rationale | Yes |
`);
    fs.writeFileSync(path.join(secondDir, '.gsd', 'DECISIONS.md'), `# Decisions

| # | When | Scope | Decision | Choice | Rationale | Revisable |
|---|------|-------|----------|--------|-----------|-----------|
| D202 | M001 | architecture | Second DB | Second | Second rationale | Yes |
`);

    try {
      closeDatabase();
    } catch { /* ok */ }

    try {
      const { ensureDbOpen } = await import('../bootstrap/dynamic-tools.ts');
      assert.equal(await ensureDbOpen(firstDir), true);
      assert.ok(getDecisionById('D101') !== null, 'first DB should be active');
      assert.equal(await ensureDbOpen(secondDir), true);
      assert.ok(getDecisionById('D202') !== null, 'second DB should be active after switch');
      assert.equal(getDecisionById('D101'), null, 'first DB should no longer be active after switch');
    } finally {
      closeDatabase();
      cleanupDir(firstDir);
      cleanupDir(secondDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════

});
