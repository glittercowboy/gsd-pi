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
import { closeDatabase, isDbAvailable, getDecisionById } from '../gsd-db.ts';

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ensure-db-'));
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
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
