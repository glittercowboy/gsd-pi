import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  wasDbOpenAttempted,
  getDbProvider,
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
    assert.deepStrictEqual(version?.['version'], 21, 'schema version should be 21');

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

  // ─── Final Report ──────────────────────────────────────────────────────────

});
