import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  wasDbOpenAttempted,
  getDbProvider,
  getDbStatus,
  insertDecision,
  getDecisionById,
  insertRequirement,
  getRequirementById,
  getActiveDecisions,
  getActiveRequirements,
  transaction,
  _getAdapter,
  _resetProvider,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  getSliceTasks,
  checkpointDatabase,
} from '../gsd-db.ts';

const _require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════
// Helper: create a temp file path for file-backed DB tests
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-db-test-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    // Remove DB file and WAL/SHM files
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch {
    // best effort
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

function openRawSqliteForTest(dbPath: string): { exec(sql: string): void; close(): void } {
  try {
    const mod = _require('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };
    return new mod.DatabaseSync(dbPath);
  } catch {
    type SqliteCtor = new (path: string) => { exec(sql: string): void; close(): void };
    const mod = _require('better-sqlite3') as
      | SqliteCtor
      | { default: SqliteCtor };
    const DatabaseCtor: SqliteCtor = typeof mod === 'function' ? mod : mod.default;
    return new DatabaseCtor(dbPath);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// gsd-db tests
// ═══════════════════════════════════════════════════════════════════════════

describe('gsd-db', () => {
  test('gsd-db: provider detection', () => {
    const provider = getDbProvider();
    assert.ok(provider !== null, 'provider should be non-null');
    assert.ok(
      provider === 'node:sqlite' || provider === 'better-sqlite3',
      `provider should be a known name, got: ${provider}`,
    );
  });

  test('gsd-db: fresh DB schema init (memory)', () => {
    const ok = openDatabase(':memory:');
    assert.ok(ok, 'openDatabase should return true');
    assert.ok(isDbAvailable(), 'isDbAvailable should be true after open');

    // Check schema_version table
    const adapter = _getAdapter()!;
    const version = adapter.prepare('SELECT MAX(version) as version FROM schema_version').get();
    assert.deepStrictEqual(version?.['version'], 22, 'schema version should be 22');

    // Check tables exist by querying them
    const dRows = adapter.prepare('SELECT count(*) as cnt FROM decisions').get();
    assert.deepStrictEqual(dRows?.['cnt'], 0, 'decisions table should exist and be empty');

    const rRows = adapter.prepare('SELECT count(*) as cnt FROM requirements').get();
    assert.deepStrictEqual(rRows?.['cnt'], 0, 'requirements table should exist and be empty');

    closeDatabase();
    assert.ok(!isDbAvailable(), 'isDbAvailable should be false after close');
  });

  test('gsd-db: double-init idempotency', () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);

    // Insert a decision so we can verify it survives re-init
    insertDecision({
      id: 'D001',
      when_context: 'test',
      scope: 'global',
      decision: 'test decision',
      choice: 'option A',
      rationale: 'because',
      revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,
    });

    closeDatabase();

    // Re-open same DB — schema init should be idempotent
    openDatabase(dbPath);
    const d = getDecisionById('D001');
    assert.ok(d !== null, 'decision should survive re-init');
    assert.deepStrictEqual(d?.id, 'D001', 'decision ID preserved after re-init');

    // Schema version should still be 1 (not duplicated)
    const adapter = _getAdapter()!;
    const versions = adapter.prepare('SELECT count(*) as cnt FROM schema_version').get();
    assert.deepStrictEqual(versions?.['cnt'], 1, 'schema_version should have exactly 1 row after double-init');

    cleanup(dbPath);
  });

  test('gsd-db: insert + get decision', () => {
    openDatabase(':memory:');
    insertDecision({
      id: 'D042',
      when_context: 'during sprint 3',
      scope: 'M001/S02',
      decision: 'use SQLite for storage',
      choice: 'node:sqlite',
      rationale: 'built-in, zero deps',
      revisable: 'yes, if perf insufficient',
      made_by: 'agent',
      superseded_by: null,
    });

    const d = getDecisionById('D042');
    assert.ok(d !== null, 'should find inserted decision');
    assert.deepStrictEqual(d?.id, 'D042', 'decision id');
    assert.deepStrictEqual(d?.scope, 'M001/S02', 'decision scope');
    assert.deepStrictEqual(d?.choice, 'node:sqlite', 'decision choice');
    assert.ok(typeof d?.seq === 'number' && d.seq > 0, 'seq should be auto-assigned positive number');
    assert.deepStrictEqual(d?.superseded_by, null, 'superseded_by should be null');

    // Non-existent
    const missing = getDecisionById('D999');
    assert.deepStrictEqual(missing, null, 'non-existent decision returns null');

    closeDatabase();
  });

  test('gsd-db: insert + get requirement', () => {
    openDatabase(':memory:');
    insertRequirement({
      id: 'R007',
      class: 'functional',
      status: 'active',
      description: 'System must persist decisions',
      why: 'decisions inform future agents',
      source: 'M001-CONTEXT',
      primary_owner: 'S01',
      supporting_slices: 'S02, S03',
      validation: 'insert and query roundtrip',
      notes: 'high priority',
      full_content: 'Full text of requirement...',
      superseded_by: null,
    });

    const r = getRequirementById('R007');
    assert.ok(r !== null, 'should find inserted requirement');
    assert.deepStrictEqual(r?.id, 'R007', 'requirement id');
    assert.deepStrictEqual(r?.class, 'functional', 'requirement class');
    assert.deepStrictEqual(r?.status, 'active', 'requirement status');
    assert.deepStrictEqual(r?.primary_owner, 'S01', 'requirement primary_owner');
    assert.deepStrictEqual(r?.superseded_by, null, 'superseded_by should be null');

    // Non-existent
    const missing = getRequirementById('R999');
    assert.deepStrictEqual(missing, null, 'non-existent requirement returns null');

    closeDatabase();
  });

  test('gsd-db: active_decisions view excludes superseded', () => {
    openDatabase(':memory:');

    insertDecision({
      id: 'D001',
      when_context: 'early',
      scope: 'global',
      decision: 'use JSON files',
      choice: 'JSON',
      rationale: 'simple',
      revisable: 'yes',
      made_by: 'agent',
      superseded_by: 'D002',  // superseded!
    });

    insertDecision({
      id: 'D002',
      when_context: 'later',
      scope: 'global',
      decision: 'use SQLite',
      choice: 'SQLite',
      rationale: 'better querying',
      revisable: 'yes',
      made_by: 'agent',
      superseded_by: null,  // active
    });

    insertDecision({
      id: 'D003',
      when_context: 'same time',
      scope: 'local',
      decision: 'use WAL mode',
      choice: 'WAL',
      rationale: 'concurrent reads',
      revisable: 'no',
      made_by: 'agent',
      superseded_by: null,  // active
    });

    const active = getActiveDecisions();
    assert.deepStrictEqual(active.length, 2, 'active_decisions should return 2 (not the superseded one)');
    const ids = active.map(d => d.id).sort();
    assert.deepStrictEqual(ids, ['D002', 'D003'], 'active decisions should be D002 and D003');

    // Verify D001 is still in the raw table
    const d1 = getDecisionById('D001');
    assert.ok(d1 !== null, 'superseded decision still exists in raw table');
    assert.deepStrictEqual(d1?.superseded_by, 'D002', 'superseded_by is set');

    closeDatabase();
  });

  test('gsd-db: active_requirements view excludes superseded', () => {
    openDatabase(':memory:');

    insertRequirement({
      id: 'R001',
      class: 'functional',
      status: 'active',
      description: 'old requirement',
      why: 'was needed',
      source: 'M001',
      primary_owner: 'S01',
      supporting_slices: '',
      validation: 'test',
      notes: '',
      full_content: '',
      superseded_by: 'R002',  // superseded!
    });

    insertRequirement({
      id: 'R002',
      class: 'functional',
      status: 'active',
      description: 'new requirement',
      why: 'replaces R001',
      source: 'M001',
      primary_owner: 'S01',
      supporting_slices: '',
      validation: 'test',
      notes: '',
      full_content: '',
      superseded_by: null,  // active
    });

    const active = getActiveRequirements();
    assert.deepStrictEqual(active.length, 1, 'active_requirements should return 1');
    assert.deepStrictEqual(active[0]?.id, 'R002', 'only R002 should be active');

    // R001 still in raw table
    const r1 = getRequirementById('R001');
    assert.ok(r1 !== null, 'superseded requirement still in raw table');

    closeDatabase();
  });

  test('gsd-db: WAL mode on file-backed DB', () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);

    const adapter = _getAdapter()!;
    const mode = adapter.prepare('PRAGMA journal_mode').get();
    assert.deepStrictEqual(mode?.['journal_mode'], 'wal', 'journal_mode should be wal for file-backed DB');

    cleanup(dbPath);
  });

  test('gsd-db: mmap stays disabled on darwin file-backed DBs', () => {
    const darwinDbPath = tempDbPath();
    withPlatform('darwin', () => {
      openDatabase(darwinDbPath);
      const adapter = _getAdapter()!;
      const mmap = adapter.prepare('PRAGMA mmap_size').get();
      assert.deepStrictEqual(mmap?.['mmap_size'], 0, 'darwin should leave mmap_size disabled');
      cleanup(darwinDbPath);
    });

    const linuxDbPath = tempDbPath();
    withPlatform('linux', () => {
      openDatabase(linuxDbPath);
      const adapter = _getAdapter()!;
      const mmap = adapter.prepare('PRAGMA mmap_size').get();
      assert.deepStrictEqual(mmap?.['mmap_size'], 67108864, 'non-darwin should still enable mmap_size');
      cleanup(linuxDbPath);
    });
  });

  test('gsd-db: transaction rollback on error', () => {
    openDatabase(':memory:');

    // Insert a decision normally
    insertDecision({
      id: 'D010',
      when_context: 'test',
      scope: 'test',
      decision: 'test',
      choice: 'test',
      rationale: 'test',
      revisable: 'test',
      made_by: 'agent',
      superseded_by: null,
    });

    // Try a transaction that fails — the insert inside should be rolled back
    let threw = false;
    try {
      transaction(() => {
        insertDecision({
          id: 'D011',
          when_context: 'should be rolled back',
          scope: 'test',
          decision: 'test',
          choice: 'test',
          rationale: 'test',
          revisable: 'test',
          made_by: 'agent',
          superseded_by: null,
        });
        throw new Error('intentional failure');
      });
    } catch (err) {
      if ((err as Error).message === 'intentional failure') {
        threw = true;
      }
    }

    assert.ok(threw, 'transaction should re-throw the error');
    const d11 = getDecisionById('D011');
    assert.deepStrictEqual(d11, null, 'D011 should be rolled back (not found)');

    // D010 should still be there
    const d10 = getDecisionById('D010');
    assert.ok(d10 !== null, 'D010 should survive the failed transaction');

    closeDatabase();
  });

  test('gsd-db: recreates missing verification evidence dedup index after removing duplicate rows', () => {
    const dbPath = tempDbPath();
    openDatabase(dbPath);

    let adapter = _getAdapter()!;
    adapter.prepare("INSERT INTO milestones (id, created_at) VALUES (?, '')").run('M001');
    adapter.prepare("INSERT INTO slices (milestone_id, id, created_at) VALUES (?, ?, '')").run('M001', 'S01');
    adapter.prepare("INSERT INTO tasks (milestone_id, slice_id, id) VALUES (?, ?, ?)").run('M001', 'S01', 'T01');
    adapter.exec('DROP INDEX IF EXISTS idx_verification_evidence_dedup');

    const insertEvidence = adapter.prepare(
      `INSERT INTO verification_evidence (
        task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEvidence.run('T01', 'S01', 'M001', 'npm test', 1, 'fail', 125, '2026-04-12T00:00:00.000Z');
    insertEvidence.run('T01', 'S01', 'M001', 'npm test', 1, 'fail', 125, '2026-04-12T00:00:01.000Z');
    insertEvidence.run('T01', 'S01', 'M001', 'npm run lint', 0, 'pass', 90, '2026-04-12T00:00:02.000Z');

    closeDatabase();

    assert.equal(openDatabase(dbPath), true, 'openDatabase should repair legacy duplicate evidence rows');

    adapter = _getAdapter()!;
    const countRow = adapter.prepare(
      `SELECT count(*) as cnt
       FROM verification_evidence
       WHERE task_id = ? AND slice_id = ? AND milestone_id = ? AND command = ? AND verdict = ?`,
    ).get('T01', 'S01', 'M001', 'npm test', 'fail');
    assert.equal(countRow?.['cnt'], 1, 'duplicate verification evidence rows should be deduplicated before index creation');

    const indexRow = adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_verification_evidence_dedup'",
    ).get();
    assert.equal(indexRow?.['name'], 'idx_verification_evidence_dedup', 'dedup index should be recreated on reopen');

    cleanup(dbPath);
  });

  test('gsd-db: legacy DB missing memories.scope opens and bootstraps index columns', () => {
    const dbPath = tempDbPath();
    const legacyDb = openRawSqliteForTest(dbPath);
    legacyDb.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_version(version, applied_at) VALUES (17, '2026-04-20T00:00:00.000Z');
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
      INSERT INTO memories(id, category, content, created_at, updated_at)
      VALUES ('legacy-memory', 'note', 'legacy row', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z');
    `);
    legacyDb.close();

    assert.equal(openDatabase(dbPath), true, 'openDatabase should succeed for legacy DB missing memories.scope');

    const adapter = _getAdapter()!;
    const columns = adapter.prepare('PRAGMA table_info(memories)').all();
    const names = columns.map((row) => row['name']);
    assert.ok(names.includes('scope'), 'memories.scope should be added during bootstrap');
    assert.ok(names.includes('tags'), 'memories.tags should be added during bootstrap');

    const row = adapter.prepare(`SELECT scope, tags FROM memories WHERE id = 'legacy-memory'`).get();
    assert.equal(row?.['scope'], 'project', 'legacy rows should receive default scope');
    assert.equal(row?.['tags'], '[]', 'legacy rows should receive default tags');

    const index = adapter.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_scope'",
    ).get();
    assert.equal(index?.['name'], 'idx_memories_scope', 'scope index should be created after bootstrap columns are present');

    cleanup(dbPath);
  });

  test('gsd-db: pre-v18 DB with memory_sources missing scope opens without crash (issue #4607)', () => {
    // Regression: initSchema() ran CREATE INDEX on memories.scope and
    // memory_sources.scope unconditionally, before the v18 migration adds those
    // columns to existing rows.  Databases at schema v17 that had a
    // memory_sources table without the scope column crashed on open with
    // "no such column: scope".
    // The fix moves those index statements inside the v18 migration guard so
    // they only execute after the column already exists.
    const dbPath = tempDbPath();
    const legacyDb = openRawSqliteForTest(dbPath);

    // Build a realistic v17 schema: full table set that existed before v18,
    // with memory_sources present but missing the scope column that v18 adds.
    legacyDb.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_version(version, applied_at) VALUES (17, '2026-01-01T00:00:00.000Z');

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

      -- memory_sources existed before v18 but lacked the scope column
      CREATE TABLE memory_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        uri TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL
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

      CREATE TABLE replan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        summary TEXT NOT NULL DEFAULT '',
        previous_artifact_path TEXT DEFAULT NULL,
        replacement_artifact_path TEXT DEFAULT NULL,
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

      CREATE INDEX idx_memories_active ON memories(superseded_by);
      CREATE INDEX idx_tasks_active ON tasks(milestone_id, slice_id, status);
      CREATE INDEX idx_slices_active ON slices(milestone_id, status);
      CREATE INDEX idx_milestones_status ON milestones(status);
      CREATE INDEX idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status);
      CREATE INDEX idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id);
      CREATE INDEX idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id);
      CREATE INDEX idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending);
    `);
    legacyDb.close();

    // This must not throw — before the fix, initSchema() crashed with
    // "no such column: scope" when it tried to CREATE INDEX on memory_sources.scope
    // before the v18 migration had added that column.
    assert.doesNotThrow(
      () => openDatabase(dbPath),
      'openDatabase must not throw on a v17 DB where memory_sources lacks scope',
    );

    const adapter = _getAdapter()!;

    // After open+migrate, memories.scope must exist
    const memCols = adapter.prepare('PRAGMA table_info(memories)').all().map((r) => r['name']);
    assert.ok(memCols.includes('scope'), 'memories.scope must be present after migration');

    // idx_memories_scope must be created by the v18 migration
    const scopeIdx = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_scope'")
      .get();
    assert.ok(scopeIdx, 'idx_memories_scope must exist after open on v17 DB');

    // idx_memory_sources_scope must be created by the v18 migration
    const srcScopeIdx = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_sources_scope'")
      .get();
    assert.ok(srcScopeIdx, 'idx_memory_sources_scope must exist after open on v17 DB');

    cleanup(dbPath);
  });

  test('gsd-db: rowToTask tolerates legacy comma-separated task arrays', () => {
    openDatabase(':memory:');

    const adapter = _getAdapter()!;
    adapter.prepare("INSERT INTO milestones (id, created_at) VALUES (?, '')").run('M001');
    adapter.prepare("INSERT INTO slices (milestone_id, id, created_at) VALUES (?, ?, '')").run('M001', 'S01');
    adapter.prepare(
      `INSERT INTO tasks (
        milestone_id, slice_id, id, key_files, key_decisions, files, inputs, expected_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'M001',
      'S01',
      'T01',
      '[]',
      '[]',
      'tests/test_verify.py, config.yaml, configs/roster_2026-05-11.yaml',
      'tests/test_verify.py',
      'reports/summary.md, artifacts/output.json',
    );

    const task = getTask('M001', 'S01', 'T01');
    assert.ok(task, 'task should load successfully from DB');
    assert.deepEqual(task?.files, [
      'tests/test_verify.py',
      'config.yaml',
      'configs/roster_2026-05-11.yaml',
    ]);
    assert.deepEqual(task?.inputs, ['tests/test_verify.py']);
    assert.deepEqual(task?.expected_output, ['reports/summary.md', 'artifacts/output.json']);

    closeDatabase();
  });

  test('gsd-db: query wrappers return null/empty when DB unavailable', () => {
    // Ensure DB is closed
    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available');

    const d = getDecisionById('D001');
    assert.deepStrictEqual(d, null, 'getDecisionById returns null when DB closed');

    const r = getRequirementById('R001');
    assert.deepStrictEqual(r, null, 'getRequirementById returns null when DB closed');

    const ad = getActiveDecisions();
    assert.deepStrictEqual(ad, [], 'getActiveDecisions returns [] when DB closed');

    const ar = getActiveRequirements();
    assert.deepStrictEqual(ar, [], 'getActiveRequirements returns [] when DB closed');
  });

  test('gsd-db: closeDatabase resets wasDbOpenAttempted after an intentional close', () => {
    openDatabase(':memory:');
    assert.ok(wasDbOpenAttempted(), 'wasDbOpenAttempted should be true after openDatabase was called');

    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available after close');
    assert.ok(!wasDbOpenAttempted(), 'wasDbOpenAttempted should reset after closeDatabase');
  });

  test('gsd-db: rowToTask tolerates corrupt comma-separated task arrays', () => {
    openDatabase(':memory:');
    insertMilestone({ id: 'M001', status: 'active' });
    insertSlice({ milestoneId: 'M001', id: 'S01', status: 'active' });
    insertTask({
      milestoneId: 'M001',
      sliceId: 'S01',
      id: 'T01',
      title: 'Recover corrupt arrays',
      planning: {
        description: 'desc',
        estimate: 'small',
        files: ['src/original.ts'],
        verify: 'npm test',
        inputs: ['docs/original.md'],
        expectedOutput: ['dist/original.md'],
        observabilityImpact: '',
      },
    });

    const adapter = _getAdapter()!;
    adapter.prepare(
      `UPDATE tasks
         SET files = ?, inputs = ?, expected_output = ?, key_files = ?, key_decisions = ?
       WHERE milestone_id = ? AND slice_id = ? AND id = ?`,
    ).run(
      'src-erf/Models/foo.cs, src-erf/Models/bar.cs',
      'docs/input-a.md, docs/input-b.md',
      'dist/out-a.md, dist/out-b.md',
      'src/resources/extensions/gsd/gsd-db.ts, src/resources/extensions/gsd/state.ts',
      '"decision-1"',
      'M001',
      'S01',
      'T01',
    );

    const task = getTask('M001', 'S01', 'T01');
    assert.ok(task, 'getTask should still return the corrupt row');
    assert.deepStrictEqual(task!.files, ['src-erf/Models/foo.cs', 'src-erf/Models/bar.cs']);
    assert.deepStrictEqual(task!.inputs, ['docs/input-a.md', 'docs/input-b.md']);
    assert.deepStrictEqual(task!.expected_output, ['dist/out-a.md', 'dist/out-b.md']);
    assert.deepStrictEqual(
      task!.key_files,
      ['src/resources/extensions/gsd/gsd-db.ts', 'src/resources/extensions/gsd/state.ts'],
    );
    assert.deepStrictEqual(task!.key_decisions, ['decision-1']);

    const sliceTasks = getSliceTasks('M001', 'S01');
    assert.equal(sliceTasks.length, 1, 'getSliceTasks should also survive corrupt rows');
    assert.deepStrictEqual(sliceTasks[0]!.files, task!.files);

    closeDatabase();
  });

  // ─── checkpointDatabase ────────────────────────────────────────────────────

  describe('checkpointDatabase', () => {
    test('checkpointDatabase: flushes WAL into base file (TRUNCATE)', (t) => {
      const dbPath = tempDbPath();
      t.after(() => cleanup(dbPath));

      openDatabase(dbPath);

      // Write enough data to ensure WAL has content
      transaction(() => {
        insertDecision({
          id: 'D001',
          when_context: 'test',
          scope: 'global',
          decision: 'WAL flush test',
          choice: 'checkpoint',
          rationale: 'WAL checkpoint regression test — #4418',
          revisable: 'yes',
          made_by: 'agent',
          superseded_by: null,
        });
      });

      const walPath = dbPath + '-wal';
      assert.ok(fs.existsSync(walPath), 'WAL file should exist after write');
      const walSizeBefore = fs.statSync(walPath).size;
      assert.ok(walSizeBefore > 0, 'WAL file should be non-empty after write');

      checkpointDatabase();

      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.equal(walSizeAfter, 0, 'WAL file should be truncated to 0 after checkpoint');
    });

    test('checkpointDatabase: is a no-op when no database is open', () => {
      closeDatabase();
      // Must not throw
      assert.doesNotThrow(() => checkpointDatabase());
    });
  });

  // ─── getDbStatus ───────────────────────────────────────────────────────────

  describe('getDbStatus', () => {
    test('getDbStatus: initial state before any open', () => {
      closeDatabase();
      const status = getDbStatus();
      assert.strictEqual(status.available, false, 'available false before open');
      assert.strictEqual(status.attempted, false, 'attempted false before open');
      assert.strictEqual(status.lastError, null, 'lastError null before open');
      assert.strictEqual(status.lastPhase, null, 'lastPhase null before open');
    });

    test('getDbStatus: available after successful open', () => {
      openDatabase(':memory:');
      const status = getDbStatus();
      assert.strictEqual(status.available, true, 'available true after open');
      assert.strictEqual(status.attempted, true, 'attempted true after open');
      assert.ok(status.provider !== null, 'provider set after open');
      assert.strictEqual(status.lastError, null, 'lastError null on success');
      assert.strictEqual(status.lastPhase, null, 'lastPhase null on success');
      closeDatabase();
    });

    test('getDbStatus: resets lastError/lastPhase after closeDatabase', () => {
      // Simulate a failed open to set error state
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from('not a sqlite file at all!!!!!'));
      try {
        openDatabase(corruptPath);
      } catch {
        // expected
      }
      assert.ok(getDbStatus().lastError !== null, 'lastError set after failed open');

      // closeDatabase should clear it even though no DB was opened
      closeDatabase();
      const status = getDbStatus();
      assert.strictEqual(status.lastError, null, 'lastError cleared by closeDatabase');
      assert.strictEqual(status.lastPhase, null, 'lastPhase cleared by closeDatabase');
      assert.strictEqual(status.attempted, false, 'attempted reset by closeDatabase');
      fs.unlinkSync(corruptPath);
    });

    test('getDbStatus: captures open-phase error on corrupt file', () => {
      closeDatabase();
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from('not a sqlite file at all!!!!!'));
      try {
        openDatabase(corruptPath);
      } catch {
        // expected — both providers should reject a non-SQLite file
      }
      const status = getDbStatus();
      if (!status.available) {
        // open failed (expected in most environments)
        assert.strictEqual(status.attempted, true, 'attempted true after failed open');
        // provider may reject at raw-open level ("open") or at SQL init level ("initSchema")
        assert.ok(
          status.lastPhase === 'open' || status.lastPhase === 'initSchema',
          `lastPhase should be "open" or "initSchema", got: ${status.lastPhase}`,
        );
        assert.ok(status.lastError instanceof Error, 'lastError is an Error');
      }
      // If somehow it succeeded (unlikely with garbage content), that's also fine
      closeDatabase();
      try { fs.unlinkSync(corruptPath); } catch { /* best effort */ }
    });

    test('getDbStatus: error state resets on next successful open', () => {
      closeDatabase();
      const corruptPath = path.join(os.tmpdir(), `gsd-corrupt-${Date.now()}.db`);
      fs.writeFileSync(corruptPath, Buffer.from('not a sqlite file at all!!!!!'));
      try { openDatabase(corruptPath); } catch { /* expected */ }
      assert.ok(!getDbStatus().available, 'DB unavailable after corrupt open');

      // Now open a valid in-memory DB — error state should clear
      openDatabase(':memory:');
      const status = getDbStatus();
      assert.strictEqual(status.available, true, 'available after valid open');
      assert.strictEqual(status.lastError, null, 'lastError cleared on successful open');
      assert.strictEqual(status.lastPhase, null, 'lastPhase cleared on successful open');
      closeDatabase();
      try { fs.unlinkSync(corruptPath); } catch { /* best effort */ }
    });
  });

  // ─── Final Report ──────────────────────────────────────────────────────────

});
