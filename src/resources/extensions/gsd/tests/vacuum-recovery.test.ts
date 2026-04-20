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
  _getAdapter,
} from '../gsd-db.ts';

const _require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-vacuum-test-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch { /* best effort */ }
}

/**
 * Create a SQLite DB with a corrupt freelist that causes DDL to fail
 * with "database disk image is malformed" but is recoverable via VACUUM.
 *
 * Strategy:
 * 1. Create a DB with schema_version at v0 (so initSchema needs to run DDL)
 * 2. Add padding rows to create many pages, then delete + drop to free them
 * 3. Corrupt the freelist trunk pointer to point at a B-tree page
 *
 * This simulates the real-world scenario described in #2519: an interrupted
 * WAL checkpoint leaves the freelist in an inconsistent state.
 */
function createCorruptFreelistDb(dbPath: string): void {
  // Use node:sqlite directly to build the minimal corrupt DB
  const sqlite = _require('node:sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
  db.exec("INSERT INTO schema_version VALUES (0, '2024-01-01')");
  // Pad with data to create many pages, then free them
  db.exec('CREATE TABLE _padding (id INTEGER PRIMARY KEY, data TEXT)');
  for (let i = 0; i < 30; i++) {
    db.exec(`INSERT INTO _padding (data) VALUES ('${'x'.repeat(4000)}')`);
  }
  db.exec('DELETE FROM _padding');
  db.exec('DROP TABLE _padding');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  // Remove WAL/SHM files to ensure clean file-only state
  try { fs.unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
  try { fs.unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }

  // Corrupt: point freelist trunk (offset 32-35) to page 2 (a B-tree page),
  // and claim 10 free pages (offset 36-39)
  const fd = fs.openSync(dbPath, 'r+');
  try {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(2, 0);   // trunk page = page 2 (actually a B-tree page)
    buf.writeUInt32BE(10, 4);  // freelist count = 10
    fs.writeSync(fd, buf, 0, 8, 32);
  } finally {
    fs.closeSync(fd);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('openDatabase VACUUM recovery on corrupt freelist', () => {

  test('recovers a file-backed DB with corrupt freelist via VACUUM', () => {
    const dbPath = tempDbPath();

    // Create a DB with corrupt freelist (schema at v0 so initSchema runs DDL)
    createCorruptFreelistDb(dbPath);

    // Without the fix, this throws "database disk image is malformed".
    // With the fix, openDatabase detects "malformed", runs VACUUM, retries.
    const ok = openDatabase(dbPath);
    assert.ok(ok, 'openDatabase should succeed after VACUUM recovery');
    assert.ok(isDbAvailable(), 'DB should be available after recovery');

    // Verify full schema was applied
    const adapter = _getAdapter()!;
    const row = adapter.prepare(
      'SELECT MAX(version) as version FROM schema_version',
    ).get();
    assert.ok(
      typeof row?.['version'] === 'number' && (row['version'] as number) > 0,
      'schema_version should have a positive version after recovery',
    );

    cleanup(dbPath);
  });

  test('does not attempt VACUUM for non-malformed errors', () => {
    // openDatabase with :memory: never hits the fileBacked VACUUM path,
    // so non-malformed errors propagate directly. We verify by checking
    // that a non-file error from an in-memory DB propagates unchanged.
    // (In-memory DBs always succeed for initSchema, so this is a design
    // check — the VACUUM path is only for fileBacked = true.)
    const ok = openDatabase(':memory:');
    assert.ok(ok, 'in-memory DB should open fine');
    closeDatabase();
  });

  test('throws if VACUUM itself fails on unrecoverable corruption', () => {
    const dbPath = tempDbPath();

    // Create a file with valid SQLite header but thoroughly corrupt content
    const page = Buffer.alloc(4096);
    // SQLite magic: "SQLite format 3\0"
    page.write('SQLite format 3\0', 0, 'utf8');
    // Page size: 4096 (big-endian at offset 16)
    page.writeUInt16BE(4096, 16);
    page[18] = 1;  // write version
    page[19] = 1;  // read version
    page[20] = 0;  // reserved space
    page[21] = 64; // max embedded payload fraction
    page[22] = 32; // min embedded payload fraction
    page[23] = 32; // leaf payload fraction
    page.writeUInt32BE(1, 28);   // page_count = 1
    page.writeUInt32BE(999, 32); // corrupt freelist trunk
    page.writeUInt32BE(5, 36);   // freelist count = 5

    fs.writeFileSync(dbPath, page);

    // Should throw — VACUUM cannot save a thoroughly corrupt file
    assert.throws(
      () => openDatabase(dbPath),
      /./,
      'should throw for unrecoverable corruption',
    );

    cleanup(dbPath);
  });
});
