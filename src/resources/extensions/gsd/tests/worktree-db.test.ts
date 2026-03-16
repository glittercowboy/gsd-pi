import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  insertDecision,
  insertRequirement,
  insertArtifact,
  getDecisionById,
  getRequirementById,
  _getAdapter,
  copyWorktreeDb,
  reconcileWorktreeDb,
} from '../gsd-db.ts';

const { assertEq, assertTrue, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wt-test-'));
}

function cleanup(...dirs: string[]): void {
  closeDatabase();
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function seedMainDb(dbPath: string): void {
  openDatabase(dbPath);
  insertDecision({
    id: 'D001',
    when_context: '2025-01-01',
    scope: 'M001/S01',
    decision: 'Use SQLite',
    choice: 'node:sqlite',
    rationale: 'Built-in',
    revisable: 'yes',
    superseded_by: null,
  });
  insertRequirement({
    id: 'R001',
    class: 'functional',
    status: 'active',
    description: 'Must store decisions',
    why: 'Core feature',
    source: 'design',
    primary_owner: 'S01',
    supporting_slices: '',
    validation: 'test',
    notes: '',
    full_content: 'Full requirement text',
    superseded_by: null,
  });
  insertArtifact({
    path: 'docs/arch.md',
    artifact_type: 'plan',
    milestone_id: 'M001',
    slice_id: null,
    task_id: null,
    full_content: 'Architecture document',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// copyWorktreeDb tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== worktree-db: copyWorktreeDb ===');

// Test: copies DB file and data is queryable
{
  const srcDir = tempDir();
  const destDir = tempDir();
  const srcDb = path.join(srcDir, 'gsd.db');
  const destDb = path.join(destDir, 'nested', 'gsd.db');

  seedMainDb(srcDb);
  closeDatabase();

  const result = copyWorktreeDb(srcDb, destDb);
  assertTrue(result === true, 'copyWorktreeDb returns true on success');
  assertTrue(fs.existsSync(destDb), 'dest DB file exists after copy');

  // Open the copy and verify data is queryable
  openDatabase(destDb);
  const d = getDecisionById('D001');
  assertTrue(d !== null, 'decision queryable in copied DB');
  assertEq(d?.choice, 'node:sqlite', 'decision data preserved in copy');

  const r = getRequirementById('R001');
  assertTrue(r !== null, 'requirement queryable in copied DB');
  assertEq(r?.description, 'Must store decisions', 'requirement data preserved in copy');

  cleanup(srcDir, destDir);
}

// Test: skips -wal and -shm files
{
  const srcDir = tempDir();
  const destDir = tempDir();
  const srcDb = path.join(srcDir, 'gsd.db');
  const destDb = path.join(destDir, 'gsd.db');

  seedMainDb(srcDb);
  closeDatabase();

  // Create fake WAL/SHM files
  fs.writeFileSync(srcDb + '-wal', 'fake wal data');
  fs.writeFileSync(srcDb + '-shm', 'fake shm data');

  copyWorktreeDb(srcDb, destDb);

  assertTrue(fs.existsSync(destDb), 'DB file copied');
  assertTrue(!fs.existsSync(destDb + '-wal'), 'WAL file NOT copied');
  assertTrue(!fs.existsSync(destDb + '-shm'), 'SHM file NOT copied');

  cleanup(srcDir, destDir);
}

// Test: returns false when source doesn't exist (no throw)
{
  const destDir = tempDir();
  const result = copyWorktreeDb('/nonexistent/path/gsd.db', path.join(destDir, 'gsd.db'));
  assertEq(result, false, 'returns false for missing source');
  cleanup(destDir);
}

// Test: creates dest directory if needed
{
  const srcDir = tempDir();
  const destDir = tempDir();
  const srcDb = path.join(srcDir, 'gsd.db');
  const deepDest = path.join(destDir, 'a', 'b', 'c', 'gsd.db');

  seedMainDb(srcDb);
  closeDatabase();

  const result = copyWorktreeDb(srcDb, deepDest);
  assertTrue(result === true, 'copyWorktreeDb succeeds with nested dest');
  assertTrue(fs.existsSync(deepDest), 'DB file created at deeply nested path');

  cleanup(srcDir, destDir);
}

// ═══════════════════════════════════════════════════════════════════════════
// reconcileWorktreeDb tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== worktree-db: reconcileWorktreeDb ===');

// Test: merges new decisions from worktree into main
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  // Seed main with D001
  seedMainDb(mainDb);
  closeDatabase();

  // Copy to worktree, add D002 in worktree
  copyWorktreeDb(mainDb, wtDb);
  openDatabase(wtDb);
  insertDecision({
    id: 'D002',
    when_context: '2025-02-01',
    scope: 'M001/S02',
    decision: 'Use WAL mode',
    choice: 'WAL',
    rationale: 'Performance',
    revisable: 'yes',
    superseded_by: null,
  });
  closeDatabase();

  // Re-open main and reconcile
  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assertTrue(result.decisions > 0, 'decisions merged count > 0');
  const d2 = getDecisionById('D002');
  assertTrue(d2 !== null, 'D002 from worktree now in main');
  assertEq(d2?.choice, 'WAL', 'D002 data correct after merge');

  cleanup(mainDir, wtDir);
}

// Test: merges new requirements from worktree into main
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertRequirement({
    id: 'R002',
    class: 'non-functional',
    status: 'active',
    description: 'Must be fast',
    why: 'UX',
    source: 'design',
    primary_owner: 'S02',
    supporting_slices: '',
    validation: 'benchmark',
    notes: '',
    full_content: 'Performance requirement',
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assertTrue(result.requirements > 0, 'requirements merged count > 0');
  const r2 = getRequirementById('R002');
  assertTrue(r2 !== null, 'R002 from worktree now in main');
  assertEq(r2?.description, 'Must be fast', 'R002 data correct after merge');

  cleanup(mainDir, wtDir);
}

// Test: merges new artifacts from worktree into main
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(wtDb);
  insertArtifact({
    path: 'docs/api.md',
    artifact_type: 'reference',
    milestone_id: 'M001',
    slice_id: 'S01',
    task_id: 'T01',
    full_content: 'API documentation',
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assertTrue(result.artifacts > 0, 'artifacts merged count > 0');
  const adapter = _getAdapter()!;
  const row = adapter.prepare('SELECT * FROM artifacts WHERE path = ?').get('docs/api.md');
  assertTrue(row !== null, 'artifact from worktree now in main');
  assertEq(row?.['artifact_type'], 'reference', 'artifact data correct after merge');

  cleanup(mainDir, wtDir);
}

// Test: detects conflicts (same PK, different content in both DBs)
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  // Seed main with D001
  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  // Modify D001 in main
  openDatabase(mainDb);
  const mainAdapter = _getAdapter()!;
  mainAdapter.prepare(
    `UPDATE decisions SET choice = 'better-sqlite3' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  // Modify D001 in worktree differently
  openDatabase(wtDb);
  const wtAdapter = _getAdapter()!;
  wtAdapter.prepare(
    `UPDATE decisions SET choice = 'sql.js' WHERE id = 'D001'`,
  ).run();
  closeDatabase();

  // Reconcile
  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assertTrue(result.conflicts.length > 0, 'conflicts detected');
  assertTrue(
    result.conflicts.some(c => c.includes('D001')),
    'conflict mentions D001',
  );

  // Worktree-wins: D001 should now have worktree's value
  const d1 = getDecisionById('D001');
  assertEq(d1?.choice, 'sql.js', 'worktree wins on conflict (INSERT OR REPLACE)');

  cleanup(mainDir, wtDir);
}

// Test: handles missing worktree DB gracefully
{
  const mainDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');

  seedMainDb(mainDb);

  const result = reconcileWorktreeDb(mainDb, '/nonexistent/worktree.db');
  assertEq(result.decisions, 0, 'no decisions merged for missing worktree DB');
  assertEq(result.requirements, 0, 'no requirements merged for missing worktree DB');
  assertEq(result.artifacts, 0, 'no artifacts merged for missing worktree DB');
  assertEq(result.conflicts.length, 0, 'no conflicts for missing worktree DB');

  cleanup(mainDir);
}

// Test: path with spaces works
{
  const baseDir = tempDir();
  const mainDir = path.join(baseDir, 'main dir');
  const wtDir = path.join(baseDir, 'worktree dir');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(wtDir, { recursive: true });

  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  // Add a decision in worktree
  openDatabase(wtDb);
  insertDecision({
    id: 'D003',
    when_context: '2025-03-01',
    scope: 'M001/S03',
    decision: 'Path spaces test',
    choice: 'yes',
    rationale: 'Robustness',
    revisable: 'no',
    superseded_by: null,
  });
  closeDatabase();

  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);
  assertTrue(result.decisions > 0, 'reconciliation works with spaces in path');
  const d3 = getDecisionById('D003');
  assertTrue(d3 !== null, 'D003 merged from worktree with spaces in path');

  cleanup(baseDir);
}

// Test: main DB is usable after reconciliation (DETACH cleanup verified)
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  openDatabase(mainDb);
  reconcileWorktreeDb(mainDb, wtDb);

  // Verify main DB is still fully usable after DETACH
  assertTrue(isDbAvailable(), 'DB still available after reconciliation');

  insertDecision({
    id: 'D099',
    when_context: '2025-12-01',
    scope: 'test',
    decision: 'Post-reconcile insert',
    choice: 'works',
    rationale: 'Verify DETACH cleanup',
    revisable: 'no',
    superseded_by: null,
  });

  const d99 = getDecisionById('D099');
  assertTrue(d99 !== null, 'can insert and query after reconciliation');
  assertEq(d99?.choice, 'works', 'post-reconcile data correct');

  // Verify no "wt" database still attached
  const adapter = _getAdapter()!;
  let wtAccessible = false;
  try {
    adapter.prepare('SELECT count(*) FROM wt.decisions').get();
    wtAccessible = true;
  } catch {
    // Expected — wt should be detached
  }
  assertTrue(!wtAccessible, 'wt database is detached after reconciliation');

  cleanup(mainDir, wtDir);
}

// Test: reconcile with empty worktree DB (no new rows, no conflicts)
{
  const mainDir = tempDir();
  const wtDir = tempDir();
  const mainDb = path.join(mainDir, 'gsd.db');
  const wtDb = path.join(wtDir, 'gsd.db');

  seedMainDb(mainDb);
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  // Don't modify the worktree DB at all — reconcile the identical copy
  openDatabase(mainDb);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  // Should still report counts for the existing rows (INSERT OR REPLACE touches them)
  assertTrue(result.conflicts.length === 0, 'no conflicts when DBs are identical');
  assertTrue(isDbAvailable(), 'DB usable after no-change reconciliation');

  cleanup(mainDir, wtDir);
}

// ─── Final Report ──────────────────────────────────────────────────────────
report();
