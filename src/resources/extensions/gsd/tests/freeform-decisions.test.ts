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
  parseDecisionsTable,
} from '../md-importer.ts';
import {
  saveDecisionToDb,
} from '../db-writer.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-freeform-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

/** Query all decisions from the DB ordered by seq. */
function queryAllDecisions(): Array<Record<string, unknown>> {
  const adapter = _getAdapter();
  if (!adapter) return [];
  return adapter.prepare('SELECT * FROM decisions ORDER BY seq').all();
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug reproduction: freeform DECISIONS.md content destroyed (#2301)
// ═══════════════════════════════════════════════════════════════════════════

describe('freeform-decisions', () => {
  test('parseDecisionsTable silently drops freeform content', () => {
    const freeform = `# Project Decisions

  ## Architecture
  We decided to use a microservices architecture because monoliths don't scale.

  ## Database
  PostgreSQL was chosen for its reliability and JSONB support.

  ## Deployment
  - Kubernetes for orchestration
  - Helm charts for packaging
  `;

    const parsed = parseDecisionsTable(freeform);
    assert.deepStrictEqual(parsed.length, 0, 'freeform content yields zero parsed decisions (expected — it is not a table)');
  });

  test('saveDecisionToDb destroys freeform DECISIONS.md content', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
    openDatabase(dbPath);

    const freeformContent = `# Project Decisions

  ## Architecture
  We decided to use a microservices architecture because monoliths don't scale.

  ## Database
  PostgreSQL was chosen for its reliability and JSONB support.

  ## Deployment
  - Kubernetes for orchestration
  - Helm charts for packaging
  `;

    // Pre-populate DECISIONS.md with freeform content
    fs.writeFileSync(mdPath, freeformContent, 'utf-8');

    try {
      // Save a new decision — this should NOT destroy the freeform content
      const result = await saveDecisionToDb({
        scope: 'testing',
        decision: 'Use Jest for unit tests',
        choice: 'Jest',
        rationale: 'Well-known, good DX',
        when_context: 'M001',
      }, tmpDir);

      assert.deepStrictEqual(result.id, 'D001', 'decision ID assigned correctly');

      // ── Assert DB state ──
      const dbRows = queryAllDecisions();
      assert.equal(dbRows.length, 1, 'DB has exactly 1 decision after first save');
      assert.equal(dbRows[0]['id'], 'D001', 'DB row has correct ID');
      assert.equal(dbRows[0]['scope'], 'testing', 'DB row has correct scope');
      assert.equal(dbRows[0]['decision'], 'Use Jest for unit tests', 'DB row has correct decision text');

      // Read back the file
      const afterContent = fs.readFileSync(mdPath, 'utf-8');

      // The freeform content MUST still be present
      assert.ok(
        afterContent.includes('microservices architecture'),
        'freeform architecture section preserved after saveDecisionToDb',
      );
      assert.ok(
        afterContent.includes('PostgreSQL was chosen'),
        'freeform database section preserved after saveDecisionToDb',
      );
      assert.ok(
        afterContent.includes('Kubernetes for orchestration'),
        'freeform deployment section preserved after saveDecisionToDb',
      );

      // The new decision MUST also be present
      assert.ok(
        afterContent.includes('D001'),
        'new decision D001 present in file',
      );
      assert.ok(
        afterContent.includes('Use Jest for unit tests'),
        'new decision text present in file',
      );

      // Save a second decision — freeform content must still survive
      const result2 = await saveDecisionToDb({
        scope: 'ci',
        decision: 'Use GitHub Actions for CI',
        choice: 'GitHub Actions',
        rationale: 'Native integration',
        when_context: 'M001',
      }, tmpDir);

      assert.deepStrictEqual(result2.id, 'D002', 'second decision ID assigned correctly');

      // ── Assert DB state after second save ──
      const dbRows2 = queryAllDecisions();
      assert.equal(dbRows2.length, 2, 'DB has exactly 2 decisions after second save');
      assert.equal(dbRows2[0]['id'], 'D001', 'first DB row still D001');
      assert.equal(dbRows2[1]['id'], 'D002', 'second DB row is D002');
      assert.equal(dbRows2[1]['scope'], 'ci', 'second DB row has correct scope');

      const afterContent2 = fs.readFileSync(mdPath, 'utf-8');

      assert.ok(
        afterContent2.includes('microservices architecture'),
        'freeform content still preserved after second save',
      );
      assert.ok(
        afterContent2.includes('D001'),
        'first decision still present after second save',
      );
      assert.ok(
        afterContent2.includes('D002'),
        'second decision present after second save',
      );
      assert.ok(
        afterContent2.includes('Use GitHub Actions for CI'),
        'second decision text present in file',
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('saveDecisionToDb with table-format DECISIONS.md still regenerates normally', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
    openDatabase(dbPath);

    // Pre-populate with canonical table format
    const tableContent = `# Decisions Register

  <!-- Append-only. Never edit or remove existing rows.
       To reverse a decision, add a new row that supersedes it.
       Read this file at the start of any planning or research phase. -->

  | # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
  |---|------|-------|----------|--------|-----------|------------|---------|
  | D001 | M001 | arch | Use REST API | REST | Simpler | Yes | human |
  `;

    fs.writeFileSync(mdPath, tableContent, 'utf-8');

    try {
      const result = await saveDecisionToDb({
        scope: 'testing',
        decision: 'Use Vitest',
        choice: 'Vitest',
        rationale: 'Fast',
        when_context: 'M001',
      }, tmpDir);

      // The pre-existing table decision was NOT in DB, so it won't appear after regen.
      // But the new decision should be there.
      assert.deepStrictEqual(result.id, 'D001', 'gets D001 since DB was empty');

      // ── Assert DB state ──
      const dbRows = queryAllDecisions();
      assert.equal(dbRows.length, 1, 'DB has exactly 1 decision');
      assert.equal(dbRows[0]['id'], 'D001', 'DB row has correct ID');
      assert.equal(dbRows[0]['decision'], 'Use Vitest', 'DB row has correct decision text');

      const afterContent = fs.readFileSync(mdPath, 'utf-8');
      // Table-format file gets fully regenerated — this is the normal path
      assert.ok(
        afterContent.includes('# Decisions Register'),
        'table-format file still has header after save',
      );
      assert.ok(
        afterContent.includes('Use Vitest'),
        'new decision present in regenerated table',
      );
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('saveDecisionToDb with no existing DECISIONS.md creates table', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
    openDatabase(dbPath);

    // No DECISIONS.md exists at all
    assert.ok(!fs.existsSync(mdPath), 'DECISIONS.md does not exist initially');

    try {
      const result = await saveDecisionToDb({
        scope: 'arch',
        decision: 'Brand new decision',
        choice: 'Option A',
        rationale: 'Best fit',
      }, tmpDir);

      assert.deepStrictEqual(result.id, 'D001', 'first decision gets D001');
      assert.ok(fs.existsSync(mdPath), 'DECISIONS.md created');

      // ── Assert DB state ──
      const dbRows = queryAllDecisions();
      assert.equal(dbRows.length, 1, 'DB has exactly 1 decision');
      assert.equal(dbRows[0]['id'], 'D001', 'DB row ID is D001');
      assert.equal(dbRows[0]['scope'], 'arch', 'DB row scope is arch');
      assert.equal(dbRows[0]['decision'], 'Brand new decision', 'DB row decision text matches');

      const content = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(content.includes('# Decisions Register'), 'new file has header');
      assert.ok(content.includes('Brand new decision'), 'new file has decision');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  test('parallel saveDecisionToDb calls assign unique IDs', async () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);

    try {
      const [r1, r2, r3] = await Promise.all([
        saveDecisionToDb({ scope: 'a', decision: 'Decision A', choice: 'A', rationale: 'A' }, tmpDir),
        saveDecisionToDb({ scope: 'b', decision: 'Decision B', choice: 'B', rationale: 'B' }, tmpDir),
        saveDecisionToDb({ scope: 'c', decision: 'Decision C', choice: 'C', rationale: 'C' }, tmpDir),
      ]);

      const ids = new Set([r1.id, r2.id, r3.id]);
      assert.strictEqual(ids.size, 3, `expected 3 unique IDs but got: ${[r1.id, r2.id, r3.id]}`);

      // Verify all 3 decisions exist in the markdown file
      const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
      const content = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(content.includes('Decision A'), 'Decision A in file');
      assert.ok(content.includes('Decision B'), 'Decision B in file');
      assert.ok(content.includes('Decision C'), 'Decision C in file');
    } finally {
      closeDatabase();
      cleanupDir(tmpDir);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════

});
