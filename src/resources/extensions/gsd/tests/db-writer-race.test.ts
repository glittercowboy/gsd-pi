// Regression test for issue #3185 — concurrent saveDecisionToDb calls collide on D001
//
// Before the fix: nextDecisionId() does SELECT MAX(...) and returns 'D001' when the
// table is empty. saveDecisionToDb calls nextDecisionId() and then upsertDecision()
// separately. Two concurrent callers both see MAX=0 before either INSERT runs, both
// compute 'D001', and one silently overwrites the other.
//
// After the fix: saveDecisionToDb uses a single atomic INSERT...SELECT MAX that
// computes and claims the ID in one statement, closing the TOCTOU window.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  _getAdapter,
} from '../gsd-db.ts';
import {
  saveDecisionToDb,
  nextDecisionId,
} from '../db-writer.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-race-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

const DECISION_FIELDS = {
  scope: 'arch',
  decision: 'Test decision',
  choice: 'Option A',
  rationale: 'Best option',
  when_context: 'M001',
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('db-writer race condition (#3185)', () => {

  // Test A: concurrent saveDecisionToDb calls must return unique IDs
  // FAILS before fix — both callers see MAX=0 and both return D001
  test('concurrent saveDecisionToDb calls return unique IDs (no collision)', async () => {
    const tmpDir = makeTmpDir();
    openDatabase(':memory:');

    try {
      // Fire two saves concurrently via Promise.all
      const [r1, r2] = await Promise.all([
        saveDecisionToDb({ ...DECISION_FIELDS }, tmpDir),
        saveDecisionToDb({ ...DECISION_FIELDS, decision: 'Second decision' }, tmpDir),
      ]);

      // Both must return IDs but they must differ
      assert.ok(r1.id, 'first concurrent save returned an ID');
      assert.ok(r2.id, 'second concurrent save returned an ID');
      assert.notStrictEqual(
        r1.id,
        r2.id,
        `concurrent saves must produce different IDs, both got: ${r1.id}`,
      );

      // DB must contain exactly 2 rows with unique IDs
      const adapter = _getAdapter();
      assert.ok(adapter, 'adapter must be available');
      const countRow = adapter!.prepare('SELECT COUNT(*) as n FROM decisions').get();
      assert.strictEqual(
        countRow!['n'] as number,
        2,
        `DB must have 2 rows after 2 concurrent saves, got: ${countRow!['n']}`,
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // Test B: documents the TOCTOU window — nextDecisionId() called twice before
  // any INSERT both return D001. This is the root cause; it's informational only.
  test('nextDecisionId returns D001 twice when called before any INSERT (TOCTOU demo)', async () => {
    openDatabase(':memory:');

    try {
      const a = await nextDecisionId();
      const b = await nextDecisionId();

      // Both return D001 because no row exists yet — this is the bug root cause
      assert.strictEqual(a, 'D001', 'first nextDecisionId() returns D001 on empty table');
      assert.strictEqual(b, 'D001', 'second nextDecisionId() also returns D001 — TOCTOU window documented');
    } finally {
      closeDatabase();
    }
  });

  // Test C: sequential saveDecisionToDb calls produce D001, D002, D003 in order
  // Must pass before AND after the fix.
  test('sequential saveDecisionToDb calls produce D001, D002, D003 in order', async () => {
    const tmpDir = makeTmpDir();
    openDatabase(':memory:');

    try {
      const r1 = await saveDecisionToDb({ ...DECISION_FIELDS }, tmpDir);
      const r2 = await saveDecisionToDb({ ...DECISION_FIELDS, decision: 'Second' }, tmpDir);
      const r3 = await saveDecisionToDb({ ...DECISION_FIELDS, decision: 'Third' }, tmpDir);

      assert.strictEqual(r1.id, 'D001', 'first sequential save gets D001');
      assert.strictEqual(r2.id, 'D002', 'second sequential save gets D002');
      assert.strictEqual(r3.id, 'D003', 'third sequential save gets D003');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // Test D: 5 concurrent saves produce 5 unique IDs and exactly 5 DB rows
  // FAILS before fix — collisions reduce the row count below 5
  test('5 concurrent saves produce 5 unique IDs with no DB collisions', async () => {
    const tmpDir = makeTmpDir();
    openDatabase(':memory:');

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          saveDecisionToDb(
            { ...DECISION_FIELDS, decision: `Decision ${i + 1}` },
            tmpDir,
          ),
        ),
      );

      const ids = results.map(r => r.id);
      const uniqueIds = new Set(ids);

      assert.strictEqual(
        uniqueIds.size,
        5,
        `all 5 concurrent saves must produce unique IDs, got: [${ids.join(', ')}]`,
      );

      // DB row count must equal 5 — no silent overwrites
      const adapter = _getAdapter();
      assert.ok(adapter, 'adapter must be available');
      const countRow = adapter!.prepare('SELECT COUNT(*) as n FROM decisions').get();
      assert.strictEqual(
        countRow!['n'] as number,
        5,
        `DB must have 5 rows, got ${countRow!['n']} — silent overwrites detected`,
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

});
