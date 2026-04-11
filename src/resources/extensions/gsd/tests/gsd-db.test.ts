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
    assert.deepStrictEqual(version?.['version'], 14, 'schema version should be 14');

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

  test('gsd-db: wasDbOpenAttempted tracks openDatabase calls', () => {
    // wasDbOpenAttempted should return true once openDatabase has been called
    // (previous tests in this suite already called openDatabase, so the flag is set)
    assert.ok(wasDbOpenAttempted(), 'wasDbOpenAttempted should be true after openDatabase was called');

    // Verify the flag persists even after closeDatabase
    closeDatabase();
    assert.ok(!isDbAvailable(), 'DB should not be available after close');
    assert.ok(wasDbOpenAttempted(), 'wasDbOpenAttempted should remain true after closeDatabase');
  });

  // ─── Final Report ──────────────────────────────────────────────────────────

});
