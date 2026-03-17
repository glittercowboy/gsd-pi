// GSD Database Abstraction Layer
// Provides a SQLite database with provider fallback chain:
//   node:sqlite (built-in) → better-sqlite3 (npm) → null (unavailable)
//
// Exposes a unified sync API for decisions and requirements storage.
// Schema is initialized on first open with WAL mode for file-backed DBs.

import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, Requirement } from './types.js';

// Create a require function for loading native modules in ESM context
const _require = createRequire(import.meta.url);

// ─── Provider Abstraction ──────────────────────────────────────────────────

/**
 * Minimal interface over both node:sqlite DatabaseSync and better-sqlite3 Database.
 * Both expose prepare().run/get/all — the adapter normalizes row objects.
 */
interface DbStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

type ProviderName = 'node:sqlite' | 'better-sqlite3';

let providerName: ProviderName | null = null;
let providerModule: unknown = null;
let loadAttempted = false;

/**
 * Suppress the ExperimentalWarning for SQLite from node:sqlite.
 * Must be called before require('node:sqlite').
 */
function suppressSqliteWarning(): void {
  const origEmit = process.emit;
  // @ts-expect-error — overriding process.emit with filtered version
  process.emit = function (event: string, ...args: unknown[]): boolean {
    if (
      event === 'warning' &&
      args[0] &&
      typeof args[0] === 'object' &&
      'name' in args[0] &&
      (args[0] as { name: string }).name === 'ExperimentalWarning' &&
      'message' in args[0] &&
      typeof (args[0] as { message: string }).message === 'string' &&
      (args[0] as { message: string }).message.includes('SQLite')
    ) {
      return false;
    }
    return origEmit.apply(process, [event, ...args] as Parameters<typeof process.emit>) as unknown as boolean;
  };
}

function loadProvider(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  // Try node:sqlite first
  try {
    suppressSqliteWarning();
    const mod = _require('node:sqlite');
    if (mod.DatabaseSync) {
      providerModule = mod;
      providerName = 'node:sqlite';
      return;
    }
  } catch {
    // node:sqlite not available
  }

  // Try better-sqlite3
  try {
    const mod = _require('better-sqlite3');
    if (typeof mod === 'function' || (mod && mod.default)) {
      providerModule = mod.default || mod;
      providerName = 'better-sqlite3';
      return;
    }
  } catch {
    // better-sqlite3 not available
  }

  process.stderr.write('gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3)\n');
}

// ─── Database Adapter ──────────────────────────────────────────────────────

/**
 * Normalize a row from node:sqlite (null-prototype) to a plain object.
 */
function normalizeRow(row: unknown): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  if (Object.getPrototypeOf(row) === null) {
    return { ...row as Record<string, unknown> };
  }
  return row as Record<string, unknown>;
}

function normalizeRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map(r => normalizeRow(r)!);
}

function createAdapter(rawDb: unknown): DbAdapter {
  const db = rawDb as {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): DbStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): void {
          stmt.run(...params);
        },
        get(...params: unknown[]): Record<string, unknown> | undefined {
          return normalizeRow(stmt.get(...params));
        },
        all(...params: unknown[]): Record<string, unknown>[] {
          return normalizeRows(stmt.all(...params));
        },
      };
    },
    close(): void {
      db.close();
    },
  };
}

function openRawDb(path: string): unknown {
  loadProvider();
  if (!providerModule || !providerName) return null;

  if (providerName === 'node:sqlite') {
    const { DatabaseSync } = providerModule as { DatabaseSync: new (path: string) => unknown };
    return new DatabaseSync(path);
  }

  // better-sqlite3
  const Database = providerModule as new (path: string) => unknown;
  return new Database(path);
}

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 3;

function initSchema(db: DbAdapter, fileBacked: boolean): void {
  // WAL mode for file-backed databases (must be outside transaction)
  if (fileBacked) {
    db.exec('PRAGMA journal_mode=WAL');
  }

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        when_context TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        decision TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL DEFAULT '',
        rationale TEXT NOT NULL DEFAULT '',
        revisable TEXT NOT NULL DEFAULT '',
        superseded_by TEXT DEFAULT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS requirements (
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        path TEXT PRIMARY KEY,
        artifact_type TEXT NOT NULL DEFAULT '',
        milestone_id TEXT DEFAULT NULL,
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        full_content TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL DEFAULT ''
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_processed_units (
        unit_key TEXT PRIMARY KEY,
        activity_file TEXT,
        processed_at TEXT NOT NULL
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)');

    // Views — DROP + CREATE since CREATE VIEW IF NOT EXISTS doesn't update definitions
    db.exec(`CREATE VIEW IF NOT EXISTS active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL`);

    // Insert schema version if not already present
    const existing = db.prepare('SELECT count(*) as cnt FROM schema_version').get();
    if (existing && (existing['cnt'] as number) === 0) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)').run(
        { ':version': SCHEMA_VERSION, ':applied_at': new Date().toISOString() },
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Run incremental migrations for existing databases
  migrateSchema(db);
}

/**
 * Incremental schema migration. Reads current version from schema_version table
 * and applies DDL for each version step up to SCHEMA_VERSION.
 */
function migrateSchema(db: DbAdapter): void {
  const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  const currentVersion = row ? (row['v'] as number) : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  db.exec('BEGIN');
  try {
    // v1 → v2: add artifacts table
    if (currentVersion < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          path TEXT PRIMARY KEY,
          artifact_type TEXT NOT NULL DEFAULT '',
          milestone_id TEXT DEFAULT NULL,
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          full_content TEXT NOT NULL DEFAULT '',
          imported_at TEXT NOT NULL DEFAULT ''
        )
      `);

      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)').run(
        { ':version': 2, ':applied_at': new Date().toISOString() },
      );
    }

    // v2 → v3: add memories + memory_processed_units tables
    if (currentVersion < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
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
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_processed_units (
          unit_key TEXT PRIMARY KEY,
          activity_file TEXT,
          processed_at TEXT NOT NULL
        )
      `);

      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)');
      db.exec('DROP VIEW IF EXISTS active_memories');
      db.exec('CREATE VIEW active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL');

      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)').run(
        { ':version': 3, ':applied_at': new Date().toISOString() },
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Module State ──────────────────────────────────────────────────────────

let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns which SQLite provider is available, or null if none.
 */
export function getDbProvider(): ProviderName | null {
  loadProvider();
  return providerName;
}

/**
 * Returns true if a database is currently open and usable.
 */
export function isDbAvailable(): boolean {
  return currentDb !== null;
}

/**
 * Opens (or creates) a SQLite database at the given path.
 * Initializes schema if needed. Sets WAL mode for file-backed DBs.
 * Returns true on success, false if no provider is available.
 */
export function openDatabase(path: string): boolean {
  // Close existing if different path
  if (currentDb && currentPath !== path) {
    closeDatabase();
  }
  if (currentDb && currentPath === path) {
    return true; // already open
  }

  const rawDb = openRawDb(path);
  if (!rawDb) return false;

  const adapter = createAdapter(rawDb);
  const fileBacked = path !== ':memory:';

  try {
    initSchema(adapter, fileBacked);
  } catch (err) {
    try { adapter.close(); } catch { /* swallow */ }
    throw err;
  }

  currentDb = adapter;
  currentPath = path;
  return true;
}

/**
 * Closes the current database connection.
 */
export function closeDatabase(): void {
  if (currentDb) {
    try {
      currentDb.close();
    } catch {
      // swallow close errors
    }
    currentDb = null;
    currentPath = null;
  }
}

/**
 * Runs a function inside a transaction. Rolls back on error.
 */
export function transaction<T>(fn: () => T): T {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.exec('BEGIN');
  try {
    const result = fn();
    currentDb.exec('COMMIT');
    return result;
  } catch (err) {
    currentDb.exec('ROLLBACK');
    throw err;
  }
}

// ─── Decision Wrappers ────────────────────────────────────────────────────

/**
 * Insert a decision. The `seq` field is auto-generated.
 */
export function insertDecision(d: Omit<Decision, 'seq'>): void {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :superseded_by)`,
  ).run({
    ':id': d.id,
    ':when_context': d.when_context,
    ':scope': d.scope,
    ':decision': d.decision,
    ':choice': d.choice,
    ':rationale': d.rationale,
    ':revisable': d.revisable,
    ':superseded_by': d.superseded_by,
  });
}

/**
 * Get a decision by its ID (e.g. "D001"). Returns null if not found.
 */
export function getDecisionById(id: string): Decision | null {
  if (!currentDb) return null;
  const row = currentDb.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    seq: row['seq'] as number,
    id: row['id'] as string,
    when_context: row['when_context'] as string,
    scope: row['scope'] as string,
    decision: row['decision'] as string,
    choice: row['choice'] as string,
    rationale: row['rationale'] as string,
    revisable: row['revisable'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
  };
}

/**
 * Get all active (non-superseded) decisions.
 */
export function getActiveDecisions(): Decision[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare('SELECT * FROM active_decisions').all();
  return rows.map(row => ({
    seq: row['seq'] as number,
    id: row['id'] as string,
    when_context: row['when_context'] as string,
    scope: row['scope'] as string,
    decision: row['decision'] as string,
    choice: row['choice'] as string,
    rationale: row['rationale'] as string,
    revisable: row['revisable'] as string,
    superseded_by: null,
  }));
}

// ─── Requirement Wrappers ─────────────────────────────────────────────────

/**
 * Insert a requirement.
 */
export function insertRequirement(r: Requirement): void {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.prepare(
    `INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
    ':id': r.id,
    ':class': r.class,
    ':status': r.status,
    ':description': r.description,
    ':why': r.why,
    ':source': r.source,
    ':primary_owner': r.primary_owner,
    ':supporting_slices': r.supporting_slices,
    ':validation': r.validation,
    ':notes': r.notes,
    ':full_content': r.full_content,
    ':superseded_by': r.superseded_by,
  });
}

/**
 * Get a requirement by its ID (e.g. "R001"). Returns null if not found.
 */
export function getRequirementById(id: string): Requirement | null {
  if (!currentDb) return null;
  const row = currentDb.prepare('SELECT * FROM requirements WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row['id'] as string,
    class: row['class'] as string,
    status: row['status'] as string,
    description: row['description'] as string,
    why: row['why'] as string,
    source: row['source'] as string,
    primary_owner: row['primary_owner'] as string,
    supporting_slices: row['supporting_slices'] as string,
    validation: row['validation'] as string,
    notes: row['notes'] as string,
    full_content: row['full_content'] as string,
    superseded_by: (row['superseded_by'] as string) ?? null,
  };
}

/**
 * Get all active (non-superseded) requirements.
 */
export function getActiveRequirements(): Requirement[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare('SELECT * FROM active_requirements').all();
  return rows.map(row => ({
    id: row['id'] as string,
    class: row['class'] as string,
    status: row['status'] as string,
    description: row['description'] as string,
    why: row['why'] as string,
    source: row['source'] as string,
    primary_owner: row['primary_owner'] as string,
    supporting_slices: row['supporting_slices'] as string,
    validation: row['validation'] as string,
    notes: row['notes'] as string,
    full_content: row['full_content'] as string,
    superseded_by: null,
  }));
}

// ─── Worktree DB Operations ────────────────────────────────────────────────

/**
 * Copy a gsd.db file to a new worktree location.
 * Copies only the .db file — skips -wal and -shm files so the copy starts clean.
 * Returns true on success, false on failure (never throws).
 */
export function copyWorktreeDb(srcDbPath: string, destDbPath: string): boolean {
  try {
    if (!existsSync(srcDbPath)) {
      return false; // source doesn't exist — expected when no DB yet
    }
    const destDir = dirname(destDbPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(srcDbPath, destDbPath);
    return true;
  } catch (err) {
    process.stderr.write(`gsd-db: failed to copy DB to worktree: ${(err as Error).message}\n`);
    return false;
  }
}

/**
 * Reconcile rows from a worktree DB back into the main DB using ATTACH DATABASE.
 * Merges all three tables (decisions, requirements, artifacts) via INSERT OR REPLACE.
 * Detects conflicts where both DBs modified the same row.
 *
 * ATTACH must happen outside any transaction. INSERT OR REPLACE runs inside a transaction.
 * DETACH happens after commit (or rollback on error).
 */
export function reconcileWorktreeDb(
  mainDbPath: string,
  worktreeDbPath: string,
): { decisions: number; requirements: number; artifacts: number; conflicts: string[] } {
  const zero = { decisions: 0, requirements: 0, artifacts: 0, conflicts: [] as string[] };

  // Validate worktree DB exists
  if (!existsSync(worktreeDbPath)) {
    return zero;
  }

  // Safety: reject single quotes which could break the ATTACH DATABASE '...' SQL literal.
  // SQLite ATTACH doesn't support parameterized binding. We block the one dangerous char
  // rather than allowlisting, since OS temp paths vary widely (tildes, parens, unicode).
  if (worktreeDbPath.includes("'")) {
    process.stderr.write(`gsd-db: worktree DB reconciliation failed: path contains unsafe characters\n`);
    return zero;
  }

  // Ensure main DB is open
  if (!currentDb) {
    const opened = openDatabase(mainDbPath);
    if (!opened) {
      process.stderr.write(`gsd-db: worktree DB reconciliation failed: cannot open main DB\n`);
      return zero;
    }
  }

  const adapter = currentDb!;
  const conflicts: string[] = [];

  try {
    // ATTACH must be outside transaction
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);

    try {
      // ── Conflict detection phase ──
      // Decisions: same id, different content
      const decisionConflicts = adapter.prepare(
        `SELECT m.id FROM decisions m
         INNER JOIN wt.decisions w ON m.id = w.id
         WHERE m.decision != w.decision
            OR m.choice != w.choice
            OR m.rationale != w.rationale
            OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of decisionConflicts) {
        conflicts.push(`decision ${row['id']}: modified in both main and worktree`);
      }

      // Requirements: same id, different content
      const reqConflicts = adapter.prepare(
        `SELECT m.id FROM requirements m
         INNER JOIN wt.requirements w ON m.id = w.id
         WHERE m.description != w.description
            OR m.status != w.status
            OR m.notes != w.notes
            OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of reqConflicts) {
        conflicts.push(`requirement ${row['id']}: modified in both main and worktree`);
      }

      // Artifacts: same path, different content
      const artifactConflicts = adapter.prepare(
        `SELECT m.path FROM artifacts m
         INNER JOIN wt.artifacts w ON m.path = w.path
         WHERE m.full_content != w.full_content
            OR m.artifact_type != w.artifact_type`,
      ).all();
      for (const row of artifactConflicts) {
        conflicts.push(`artifact ${row['path']}: modified in both main and worktree`);
      }

      // ── Merge phase (inside manual transaction) ──
      adapter.exec('BEGIN');
      try {
        // Decisions: exclude seq to let main auto-assign
        adapter.exec(
          `INSERT OR REPLACE INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, superseded_by)
           SELECT id, when_context, scope, decision, choice, rationale, revisable, superseded_by FROM wt.decisions`,
        );
        const dCount = adapter.prepare('SELECT changes() as cnt').get();

        // Requirements: full row copy
        adapter.exec(
          `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
           SELECT id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by FROM wt.requirements`,
        );
        const rCount = adapter.prepare('SELECT changes() as cnt').get();

        // Artifacts: copy with fresh imported_at timestamp
        adapter.exec(
          `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
           SELECT path, artifact_type, milestone_id, slice_id, task_id, full_content, datetime('now') FROM wt.artifacts`,
        );
        const aCount = adapter.prepare('SELECT changes() as cnt').get();

        adapter.exec('COMMIT');

        const result = {
          decisions: (dCount?.['cnt'] as number) || 0,
          requirements: (rCount?.['cnt'] as number) || 0,
          artifacts: (aCount?.['cnt'] as number) || 0,
          conflicts,
        };

        if (conflicts.length > 0) {
          process.stderr.write(`gsd-db: reconciliation conflicts:\n${conflicts.map(c => `  - ${c}`).join('\n')}\n`);
        }
        process.stderr.write(
          `gsd-db: reconciled ${result.decisions} decisions, ${result.requirements} requirements, ${result.artifacts} artifacts (${conflicts.length} conflicts)\n`,
        );

        return result;
      } catch (err) {
        adapter.exec('ROLLBACK');
        throw err;
      }
    } finally {
      // DETACH always, even on error
      try {
        adapter.exec('DETACH DATABASE wt');
      } catch {
        // swallow — may already be detached
      }
    }
  } catch (err) {
    process.stderr.write(`gsd-db: worktree DB reconciliation failed: ${(err as Error).message}\n`);
    return zero;
  }
}

// ─── Internal Access (for testing) ─────────────────────────────────────────

/**
 * Get the raw adapter for direct queries (testing only).
 */
export function _getAdapter(): DbAdapter | null {
  return currentDb;
}

/**
 * Reset provider state (testing only — allows re-detection).
 */
export function _resetProvider(): void {
  loadAttempted = false;
  providerModule = null;
  providerName = null;
}

// ─── Upsert Wrappers (for idempotent import) ─────────────────────────────

/**
 * Insert or replace a decision. Uses the `id` UNIQUE constraint for idempotency.
 */
export function upsertDecision(d: Omit<Decision, 'seq'>): void {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.prepare(
    `INSERT OR REPLACE INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :superseded_by)`,
  ).run({
    ':id': d.id,
    ':when_context': d.when_context,
    ':scope': d.scope,
    ':decision': d.decision,
    ':choice': d.choice,
    ':rationale': d.rationale,
    ':revisable': d.revisable,
    ':superseded_by': d.superseded_by ?? null,
  });
}

/**
 * Insert or replace a requirement. Uses the `id` PK for idempotency.
 */
export function upsertRequirement(r: Requirement): void {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.prepare(
    `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
    ':id': r.id,
    ':class': r.class,
    ':status': r.status,
    ':description': r.description,
    ':why': r.why,
    ':source': r.source,
    ':primary_owner': r.primary_owner,
    ':supporting_slices': r.supporting_slices,
    ':validation': r.validation,
    ':notes': r.notes,
    ':full_content': r.full_content,
    ':superseded_by': r.superseded_by ?? null,
  });
}

/**
 * Insert or replace an artifact. Uses the `path` PK for idempotency.
 */
/**
 * Delete all rows from the artifacts table.
 * The artifacts table is a read cache — clearing it forces the next
 * deriveState() to fall through to disk reads (native Rust batch parse).
 * Safe to call when no database is open (no-op).
 */
export function clearArtifacts(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('DELETE FROM artifacts');
  } catch {
    // Clearing a cache should never be fatal
  }
}

export function insertArtifact(a: {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
}): void {
  if (!currentDb) throw new Error('gsd-db: No database open');
  currentDb.prepare(
    `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at)`,
  ).run({
    ':path': a.path,
    ':artifact_type': a.artifact_type,
    ':milestone_id': a.milestone_id,
    ':slice_id': a.slice_id,
    ':task_id': a.task_id,
    ':full_content': a.full_content,
    ':imported_at': new Date().toISOString(),
  });
}
