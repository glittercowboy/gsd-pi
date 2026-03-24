// GSD Database Abstraction Layer
// Provides a SQLite database with provider fallback chain:
//   node:sqlite (built-in) → better-sqlite3 (npm) → null (unavailable)
//
// Exposes a unified sync API for decisions and requirements storage.
// Schema is initialized on first open with WAL mode for file-backed DBs.

import { createRequire } from "node:module";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Requirement } from "./types.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";

// Create a require function for loading native modules in ESM context
const _require = createRequire(import.meta.url);

// ─── Provider Abstraction ──────────────────────────────────────────────────

/**
 * Minimal interface over both node:sqlite DatabaseSync and better-sqlite3 Database.
 * Both expose prepare().run/get/all — the adapter normalizes row objects.
 */
interface DbStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

type ProviderName = "node:sqlite" | "better-sqlite3";

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
      event === "warning" &&
      args[0] &&
      typeof args[0] === "object" &&
      "name" in args[0] &&
      (args[0] as { name: string }).name === "ExperimentalWarning" &&
      "message" in args[0] &&
      typeof (args[0] as { message: string }).message === "string" &&
      (args[0] as { message: string }).message.includes("SQLite")
    ) {
      return false;
    }
    return origEmit.apply(process, [event, ...args] as Parameters<
      typeof process.emit
    >) as unknown as boolean;
  };
}

function loadProvider(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  // Try node:sqlite first
  try {
    suppressSqliteWarning();
    const mod = _require("node:sqlite");
    if (mod.DatabaseSync) {
      providerModule = mod;
      providerName = "node:sqlite";
      return;
    }
  } catch {
    // node:sqlite not available
  }

  // Try better-sqlite3
  try {
    const mod = _require("better-sqlite3");
    if (typeof mod === "function" || (mod && mod.default)) {
      providerModule = mod.default || mod;
      providerName = "better-sqlite3";
      return;
    }
  } catch {
    // better-sqlite3 not available
  }

  process.stderr.write(
    "gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3)\n",
  );
}

// ─── Database Adapter ──────────────────────────────────────────────────────

/**
 * Normalize a row from node:sqlite (null-prototype) to a plain object.
 */
function normalizeRow(row: unknown): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  if (Object.getPrototypeOf(row) === null) {
    return { ...(row as Record<string, unknown>) };
  }
  return row as Record<string, unknown>;
}

function normalizeRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((r) => normalizeRow(r)!);
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
        run(...params: unknown[]): unknown {
          return stmt.run(...params);
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

  if (providerName === "node:sqlite") {
    const { DatabaseSync } = providerModule as {
      DatabaseSync: new (path: string) => unknown;
    };
    return new DatabaseSync(path);
  }

  // better-sqlite3
  const Database = providerModule as new (path: string) => unknown;
  return new Database(path);
}

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 7;

function initSchema(db: DbAdapter, fileBacked: boolean): void {
  // WAL mode for file-backed databases (must be outside transaction)
  if (fileBacked) {
    db.exec("PRAGMA journal_mode=WAL");
  }

  db.exec("BEGIN");
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
        made_by TEXT NOT NULL DEFAULT 'agent',
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        depends_on TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT DEFAULT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS slices (
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
        PRIMARY KEY (milestone_id, id),
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
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
        PRIMARY KEY (milestone_id, slice_id, id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT NOT NULL DEFAULT '',
        milestone_id TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL DEFAULT '',
        exit_code INTEGER DEFAULT 0,
        verdict TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id)
      )
    `);

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)",
    );

    // Views — DROP + CREATE since CREATE VIEW IF NOT EXISTS doesn't update definitions
    db.exec(
      `CREATE VIEW IF NOT EXISTS active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL`,
    );
    db.exec(
      `CREATE VIEW IF NOT EXISTS active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL`,
    );
    db.exec(
      `CREATE VIEW IF NOT EXISTS active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL`,
    );

    // Insert schema version if not already present
    const existing = db
      .prepare("SELECT count(*) as cnt FROM schema_version")
      .get();
    if (existing && (existing["cnt"] as number) === 0) {
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({
        ":version": SCHEMA_VERSION,
        ":applied_at": new Date().toISOString(),
      });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
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
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  const currentVersion = row ? (row["v"] as number) : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  db.exec("BEGIN");
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

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 2, ":applied_at": new Date().toISOString() });
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

      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)",
      );
      db.exec("DROP VIEW IF EXISTS active_memories");
      db.exec(
        "CREATE VIEW active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL",
      );

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 3, ":applied_at": new Date().toISOString() });
    }

    // v3 → v4: add made_by column to decisions table
    if (currentVersion < 4) {
      // Add made_by column — default 'agent' for existing rows (pre-attribution decisions)
      db.exec(`ALTER TABLE decisions ADD COLUMN made_by TEXT NOT NULL DEFAULT 'agent'`);

      // Recreate views to pick up new columns (SQLite expands SELECT * at view creation time)
      db.exec("DROP VIEW IF EXISTS active_decisions");
      db.exec(
        "CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL",
      );

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 4, ":applied_at": new Date().toISOString() });
    }

    // v4 → v5: add milestones, slices, tasks, verification_evidence tables
    if (currentVersion < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          completed_at TEXT DEFAULT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS slices (
          milestone_id TEXT NOT NULL,
          id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          risk TEXT NOT NULL DEFAULT 'medium',
          created_at TEXT NOT NULL DEFAULT '',
          completed_at TEXT DEFAULT NULL,
          PRIMARY KEY (milestone_id, id),
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
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
          PRIMARY KEY (milestone_id, slice_id, id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT NOT NULL DEFAULT '',
          milestone_id TEXT NOT NULL DEFAULT '',
          command TEXT NOT NULL DEFAULT '',
          exit_code INTEGER DEFAULT 0,
          verdict TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id)
        )
      `);

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 5, ":applied_at": new Date().toISOString() });
    }

    // v5 → v6: add full_summary_md and full_uat_md columns to slices table
    if (currentVersion < 6) {
      db.exec(`ALTER TABLE slices ADD COLUMN full_summary_md TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE slices ADD COLUMN full_uat_md TEXT NOT NULL DEFAULT ''`);

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 6, ":applied_at": new Date().toISOString() });
    }

    // v6 → v7: add depends/demo columns to slices, depends_on to milestones
    if (currentVersion < 7) {
      db.exec(`ALTER TABLE slices ADD COLUMN depends TEXT NOT NULL DEFAULT '[]'`);
      db.exec(`ALTER TABLE slices ADD COLUMN demo TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE milestones ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`);

      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)",
      ).run({ ":version": 7, ":applied_at": new Date().toISOString() });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ─── Module State ──────────────────────────────────────────────────────────

let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;
/** PID that opened the current connection — used for diagnostic logging. */
let currentPid: number = 0;
let _exitHandlerRegistered = false;

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
  const fileBacked = path !== ":memory:";

  try {
    initSchema(adapter, fileBacked);
  } catch (err) {
    try {
      adapter.close();
    } catch {
      /* swallow */
    }
    throw err;
  }

  currentDb = adapter;
  currentPath = path;
  currentPid = process.pid;

  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", () => { try { closeDatabase(); } catch {} });
  }

  return true;
}

/**
 * Closes the current database connection.
 */
export function closeDatabase(): void {
  if (currentDb) {
    try {
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { /* non-fatal — best effort before close */ }
    try {
      currentDb.close();
    } catch {
      // swallow close errors
    }
    currentDb = null;
    currentPath = null;
    currentPid = 0;
  }
}

/**
 * Runs a function inside a transaction. Rolls back on error.
 */
export function transaction<T>(fn: () => T): T {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.exec("BEGIN");
  try {
    const result = fn();
    currentDb.exec("COMMIT");
    return result;
  } catch (err) {
    currentDb.exec("ROLLBACK");
    throw err;
  }
}

// ─── Decision Wrappers ────────────────────────────────────────────────────

/**
 * Insert a decision. The `seq` field is auto-generated.
 */
export function insertDecision(d: Omit<Decision, "seq">): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :superseded_by)`,
    )
    .run({
      ":id": d.id,
      ":when_context": d.when_context,
      ":scope": d.scope,
      ":decision": d.decision,
      ":choice": d.choice,
      ":rationale": d.rationale,
      ":revisable": d.revisable,
      ":made_by": d.made_by ?? "agent",
      ":superseded_by": d.superseded_by,
    });
}

/**
 * Get a decision by its ID (e.g. "D001"). Returns null if not found.
 */
export function getDecisionById(id: string): Decision | null {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
  if (!row) return null;
  return {
    seq: row["seq"] as number,
    id: row["id"] as string,
    when_context: row["when_context"] as string,
    scope: row["scope"] as string,
    decision: row["decision"] as string,
    choice: row["choice"] as string,
    rationale: row["rationale"] as string,
    revisable: row["revisable"] as string,
    made_by: (row["made_by"] as string as import("./types.js").DecisionMadeBy) ?? "agent",
    superseded_by: (row["superseded_by"] as string) ?? null,
  };
}

/**
 * Get all active (non-superseded) decisions.
 */
export function getActiveDecisions(): Decision[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM active_decisions").all();
  return rows.map((row) => ({
    seq: row["seq"] as number,
    id: row["id"] as string,
    when_context: row["when_context"] as string,
    scope: row["scope"] as string,
    decision: row["decision"] as string,
    choice: row["choice"] as string,
    rationale: row["rationale"] as string,
    revisable: row["revisable"] as string,
    made_by: (row["made_by"] as string as import("./types.js").DecisionMadeBy) ?? "agent",
    superseded_by: null,
  }));
}

// ─── Requirement Wrappers ─────────────────────────────────────────────────

/**
 * Insert a requirement.
 */
export function insertRequirement(r: Requirement): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
    )
    .run({
      ":id": r.id,
      ":class": r.class,
      ":status": r.status,
      ":description": r.description,
      ":why": r.why,
      ":source": r.source,
      ":primary_owner": r.primary_owner,
      ":supporting_slices": r.supporting_slices,
      ":validation": r.validation,
      ":notes": r.notes,
      ":full_content": r.full_content,
      ":superseded_by": r.superseded_by,
    });
}

/**
 * Get a requirement by its ID (e.g. "R001"). Returns null if not found.
 */
export function getRequirementById(id: string): Requirement | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare("SELECT * FROM requirements WHERE id = ?")
    .get(id);
  if (!row) return null;
  return {
    id: row["id"] as string,
    class: row["class"] as string,
    status: row["status"] as string,
    description: row["description"] as string,
    why: row["why"] as string,
    source: row["source"] as string,
    primary_owner: row["primary_owner"] as string,
    supporting_slices: row["supporting_slices"] as string,
    validation: row["validation"] as string,
    notes: row["notes"] as string,
    full_content: row["full_content"] as string,
    superseded_by: (row["superseded_by"] as string) ?? null,
  };
}

/**
 * Get all active (non-superseded) requirements.
 */
export function getActiveRequirements(): Requirement[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM active_requirements").all();
  return rows.map((row) => ({
    id: row["id"] as string,
    class: row["class"] as string,
    status: row["status"] as string,
    description: row["description"] as string,
    why: row["why"] as string,
    source: row["source"] as string,
    primary_owner: row["primary_owner"] as string,
    supporting_slices: row["supporting_slices"] as string,
    validation: row["validation"] as string,
    notes: row["notes"] as string,
    full_content: row["full_content"] as string,
    superseded_by: null,
  }));
}

/**
 * Returns the PID of the process that opened the current DB connection.
 * Returns 0 if no connection is open.
 */
export function getDbOwnerPid(): number {
  return currentPid;
}

/**
 * Returns the path of the currently open database, or null if none.
 */
export function getDbPath(): string | null {
  return currentPath;
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
export function upsertDecision(d: Omit<Decision, "seq">): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR REPLACE INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :superseded_by)`,
    )
    .run({
      ":id": d.id,
      ":when_context": d.when_context,
      ":scope": d.scope,
      ":decision": d.decision,
      ":choice": d.choice,
      ":rationale": d.rationale,
      ":revisable": d.revisable,
      ":made_by": d.made_by ?? "agent",
      ":superseded_by": d.superseded_by ?? null,
    });
}

/**
 * Insert or replace a requirement. Uses the `id` PK for idempotency.
 */
export function upsertRequirement(r: Requirement): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
    )
    .run({
      ":id": r.id,
      ":class": r.class,
      ":status": r.status,
      ":description": r.description,
      ":why": r.why,
      ":source": r.source,
      ":primary_owner": r.primary_owner,
      ":supporting_slices": r.supporting_slices,
      ":validation": r.validation,
      ":notes": r.notes,
      ":full_content": r.full_content,
      ":superseded_by": r.superseded_by ?? null,
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
    currentDb.exec("DELETE FROM artifacts");
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
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at)`,
    )
    .run({
      ":path": a.path,
      ":artifact_type": a.artifact_type,
      ":milestone_id": a.milestone_id,
      ":slice_id": a.slice_id,
      ":task_id": a.task_id,
      ":full_content": a.full_content,
      ":imported_at": new Date().toISOString(),
    });
}

// ─── Milestone / Slice / Task Accessors ───────────────────────────────────

/**
 * Insert a milestone row (INSERT OR IGNORE — idempotent).
 * Parent rows may not exist yet when the first task in a milestone completes.
 */
export function insertMilestone(m: {
  id: string;
  title?: string;
  status?: string;
  depends_on?: string[];
}): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR IGNORE INTO milestones (id, title, status, depends_on, created_at)
     VALUES (:id, :title, :status, :depends_on, :created_at)`,
    )
    .run({
      ":id": m.id,
      ":title": m.title ?? "",
      ":status": m.status ?? "active",
      ":depends_on": JSON.stringify(m.depends_on ?? []),
      ":created_at": new Date().toISOString(),
    });
}

/**
 * Insert a slice row (INSERT OR IGNORE — idempotent).
 */
export function insertSlice(s: {
  id: string;
  milestoneId: string;
  title?: string;
  status?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR IGNORE INTO slices (milestone_id, id, title, status, risk, depends, demo, created_at)
     VALUES (:milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at)`,
    )
    .run({
      ":milestone_id": s.milestoneId,
      ":id": s.id,
      ":title": s.title ?? "",
      ":status": s.status ?? "pending",
      ":risk": s.risk ?? "medium",
      ":depends": JSON.stringify(s.depends ?? []),
      ":demo": s.demo ?? "",
      ":created_at": new Date().toISOString(),
    });
}

/**
 * Insert or replace a task row (full upsert for task completion).
 * key_files and key_decisions are stored as JSON arrays.
 */
export function insertTask(t: {
  id: string;
  sliceId: string;
  milestoneId: string;
  title?: string;
  status?: string;
  oneLiner?: string;
  narrative?: string;
  verificationResult?: string;
  duration?: string;
  blockerDiscovered?: boolean;
  deviations?: string;
  knownIssues?: string;
  keyFiles?: string[];
  keyDecisions?: string[];
  fullSummaryMd?: string;
}): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT OR REPLACE INTO tasks (
        milestone_id, slice_id, id, title, status, one_liner, narrative,
        verification_result, duration, completed_at, blocker_discovered,
        deviations, known_issues, key_files, key_decisions, full_summary_md
      ) VALUES (
        :milestone_id, :slice_id, :id, :title, :status, :one_liner, :narrative,
        :verification_result, :duration, :completed_at, :blocker_discovered,
        :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md
      )`,
    )
    .run({
      ":milestone_id": t.milestoneId,
      ":slice_id": t.sliceId,
      ":id": t.id,
      ":title": t.title ?? "",
      ":status": t.status ?? "pending",
      ":one_liner": t.oneLiner ?? "",
      ":narrative": t.narrative ?? "",
      ":verification_result": t.verificationResult ?? "",
      ":duration": t.duration ?? "",
      ":completed_at": t.status === "done" ? new Date().toISOString() : null,
      ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
      ":deviations": t.deviations ?? "",
      ":known_issues": t.knownIssues ?? "",
      ":key_files": JSON.stringify(t.keyFiles ?? []),
      ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
      ":full_summary_md": t.fullSummaryMd ?? "",
    });
}

/**
 * Update a task's status and optionally its completed_at timestamp.
 */
export function updateTaskStatus(
  milestoneId: string,
  sliceId: string,
  taskId: string,
  status: string,
  completedAt?: string,
): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `UPDATE tasks SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
    )
    .run({
      ":status": status,
      ":completed_at": completedAt ?? null,
      ":milestone_id": milestoneId,
      ":slice_id": sliceId,
      ":id": taskId,
    });
}

export interface SliceRow {
  milestone_id: string;
  id: string;
  title: string;
  status: string;
  risk: string;
  depends: string[];
  demo: string;
  created_at: string;
  completed_at: string | null;
  full_summary_md: string;
  full_uat_md: string;
}

function rowToSlice(row: Record<string, unknown>): SliceRow {
  return {
    milestone_id: row["milestone_id"] as string,
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    risk: row["risk"] as string,
    depends: JSON.parse((row["depends"] as string) || "[]"),
    demo: (row["demo"] as string) ?? "",
    created_at: row["created_at"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    full_summary_md: (row["full_summary_md"] as string) ?? "",
    full_uat_md: (row["full_uat_md"] as string) ?? "",
  };
}

/**
 * Get a single slice by its composite PK. Returns null if not found.
 */
export function getSlice(
  milestoneId: string,
  sliceId: string,
): SliceRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare(
      "SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid",
    )
    .get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}

/**
 * Update a slice's status and optionally its completed_at timestamp.
 */
export function updateSliceStatus(
  milestoneId: string,
  sliceId: string,
  status: string,
  completedAt?: string,
): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `UPDATE slices SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND id = :id`,
    )
    .run({
      ":status": status,
      ":completed_at": completedAt ?? null,
      ":milestone_id": milestoneId,
      ":id": sliceId,
    });
}

export interface TaskRow {
  milestone_id: string;
  slice_id: string;
  id: string;
  title: string;
  status: string;
  one_liner: string;
  narrative: string;
  verification_result: string;
  duration: string;
  completed_at: string | null;
  blocker_discovered: boolean;
  deviations: string;
  known_issues: string;
  key_files: string[];
  key_decisions: string[];
  full_summary_md: string;
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  return {
    milestone_id: row["milestone_id"] as string,
    slice_id: row["slice_id"] as string,
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    one_liner: row["one_liner"] as string,
    narrative: row["narrative"] as string,
    verification_result: row["verification_result"] as string,
    duration: row["duration"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    blocker_discovered: (row["blocker_discovered"] as number) === 1,
    deviations: row["deviations"] as string,
    known_issues: row["known_issues"] as string,
    key_files: JSON.parse((row["key_files"] as string) || "[]"),
    key_decisions: JSON.parse((row["key_decisions"] as string) || "[]"),
    full_summary_md: row["full_summary_md"] as string,
  };
}

/**
 * Get a single task by its composite PK. Returns null if not found.
 */
export function getTask(
  milestoneId: string,
  sliceId: string,
  taskId: string,
): TaskRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare(
      "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
    )
    .get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}

/**
 * Get all tasks for a given slice. Returns empty array if none found.
 */
export function getSliceTasks(
  milestoneId: string,
  sliceId: string,
): TaskRow[] {
  if (!currentDb) return [];
  const rows = currentDb
    .prepare(
      "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY id",
    )
    .all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}

/**
 * Insert a single verification evidence row for a task.
 */
export function insertVerificationEvidence(e: {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
}): void {
  if (!currentDb)
    throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
     VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`,
    )
    .run({
      ":task_id": e.taskId,
      ":slice_id": e.sliceId,
      ":milestone_id": e.milestoneId,
      ":command": e.command,
      ":exit_code": e.exitCode,
      ":verdict": e.verdict,
      ":duration_ms": e.durationMs,
      ":created_at": new Date().toISOString(),
    });
}

// ─── Worktree DB Helpers ──────────────────────────────────────────────────

// ─── Milestone Row Interface ──────────────────────────────────────────────

export interface MilestoneRow {
  id: string;
  title: string;
  status: string;
  depends_on: string[];
  created_at: string;
  completed_at: string | null;
}

function rowToMilestone(row: Record<string, unknown>): MilestoneRow {
  return {
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    depends_on: JSON.parse((row["depends_on"] as string) || "[]"),
    created_at: row["created_at"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
  };
}

// ─── Artifact Row Interface ───────────────────────────────────────────────

export interface ArtifactRow {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
  imported_at: string;
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    path: row["path"] as string,
    artifact_type: row["artifact_type"] as string,
    milestone_id: (row["milestone_id"] as string) ?? null,
    slice_id: (row["slice_id"] as string) ?? null,
    task_id: (row["task_id"] as string) ?? null,
    full_content: row["full_content"] as string,
    imported_at: row["imported_at"] as string,
  };
}

// ─── New Accessors (S03: Markdown Renderer) ───────────────────────────────

/**
 * Get all milestones ordered by ID. Returns empty array if none found.
 */
export function getAllMilestones(): MilestoneRow[] {
  if (!currentDb) return [];
  const rows = currentDb
    .prepare("SELECT * FROM milestones ORDER BY id")
    .all();
  return rows.map(rowToMilestone);
}

/**
 * Get a single milestone by ID. Returns null if not found.
 */
export function getMilestone(id: string): MilestoneRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare("SELECT * FROM milestones WHERE id = :id")
    .get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}

/**
 * Get the first active milestone (not complete or parked), sorted by ID.
 * Returns null if no active milestones exist.
 */
export function getActiveMilestoneFromDb(): MilestoneRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare(
      "SELECT * FROM milestones WHERE status NOT IN ('complete', 'parked') ORDER BY id LIMIT 1",
    )
    .get();
  if (!row) return null;
  return rowToMilestone(row);
}

/**
 * Get the first active slice for a milestone.
 * Active = status NOT IN ('complete', 'done') with all dependencies satisfied.
 * Returns null if no active slices exist.
 */
export function getActiveSliceFromDb(milestoneId: string): SliceRow | null {
  if (!currentDb) return null;
  const rows = currentDb
    .prepare(
      "SELECT * FROM slices WHERE milestone_id = :mid AND status NOT IN ('complete', 'done') ORDER BY id",
    )
    .all({ ":mid": milestoneId });
  if (rows.length === 0) return null;

  // Build set of completed slice IDs for dependency checking
  const completedRows = currentDb
    .prepare(
      "SELECT id FROM slices WHERE milestone_id = :mid AND status IN ('complete', 'done')",
    )
    .all({ ":mid": milestoneId });
  const completedIds = new Set(completedRows.map((r) => r["id"] as string));

  // Find first slice whose deps are all satisfied
  for (const row of rows) {
    const slice = rowToSlice(row);
    const deps = slice.depends;
    if (deps.length === 0 || deps.every((d) => completedIds.has(d))) {
      return slice;
    }
  }

  return null;
}

/**
 * Get the first active task for a slice.
 * Active = status NOT IN ('complete', 'done'), sorted by ID.
 * Returns null if no active tasks exist.
 */
export function getActiveTaskFromDb(
  milestoneId: string,
  sliceId: string,
): TaskRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare(
      "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY id LIMIT 1",
    )
    .get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToTask(row);
}

/**
 * Get all slices for a milestone, ordered by ID. Returns empty array if none found.
 */
export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  if (!currentDb) return [];
  const rows = currentDb
    .prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY id")
    .all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}

/**
 * Get an artifact by its path. Returns null if not found.
 */
export function getArtifact(path: string): ArtifactRow | null {
  if (!currentDb) return null;
  const row = currentDb
    .prepare("SELECT * FROM artifacts WHERE path = :path")
    .get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}

// ─── Worktree DB Helpers (continued) ──────────────────────────────────────

export function copyWorktreeDb(srcDbPath: string, destDbPath: string): boolean {
  try {
    if (!existsSync(srcDbPath)) return false;
    const destDir = dirname(destDbPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(srcDbPath, destDbPath);
    return true;
  } catch (err) {
    process.stderr.write(
      `gsd-db: failed to copy DB to worktree: ${(err as Error).message}\n`,
    );
    return false;
  }
}

export function reconcileWorktreeDb(
  mainDbPath: string,
  worktreeDbPath: string,
): {
  decisions: number;
  requirements: number;
  artifacts: number;
  conflicts: string[];
} {
  const zero = {
    decisions: 0,
    requirements: 0,
    artifacts: 0,
    conflicts: [] as string[],
  };
  if (!existsSync(worktreeDbPath)) return zero;
  if (worktreeDbPath.includes("'")) {
    process.stderr.write(
      `gsd-db: worktree DB reconciliation failed: path contains unsafe characters\n`,
    );
    return zero;
  }
  if (!currentDb) {
    const opened = openDatabase(mainDbPath);
    if (!opened) {
      process.stderr.write(
        `gsd-db: worktree DB reconciliation failed: cannot open main DB\n`,
      );
      return zero;
    }
  }
  const adapter = currentDb!;
  const conflicts: string[] = [];
  try {
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);
    try {
      // Check if attached wt database has the made_by column (legacy v3 worktrees won't)
      const wtInfo = adapter.prepare("PRAGMA wt.table_info('decisions')").all();
      const hasMadeBy = wtInfo.some((col) => col["name"] === "made_by");

      const decConf = adapter
        .prepare(
          `SELECT m.id FROM decisions m INNER JOIN wt.decisions w ON m.id = w.id WHERE m.decision != w.decision OR m.choice != w.choice OR m.rationale != w.rationale OR ${
            hasMadeBy ? "m.made_by != w.made_by" : "'agent' != 'agent'"
          } OR m.superseded_by IS NOT w.superseded_by`,
        )
        .all();
      for (const row of decConf)
        conflicts.push(
          `decision ${(row as Record<string, unknown>)["id"]}: modified in both`,
        );
      const reqConf = adapter
        .prepare(
          `SELECT m.id FROM requirements m INNER JOIN wt.requirements w ON m.id = w.id WHERE m.description != w.description OR m.status != w.status OR m.notes != w.notes OR m.superseded_by IS NOT w.superseded_by`,
        )
        .all();
      for (const row of reqConf)
        conflicts.push(
          `requirement ${(row as Record<string, unknown>)["id"]}: modified in both`,
        );
      const merged = { decisions: 0, requirements: 0, artifacts: 0 };
      adapter.exec("BEGIN");
      try {
        const dR = adapter
          .prepare(
            `
          INSERT OR REPLACE INTO decisions (
            id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by
          )
          SELECT
            id, when_context, scope, decision, choice, rationale, revisable, ${
              hasMadeBy ? "made_by" : "'agent'"
            }, superseded_by
          FROM wt.decisions
        `,
          )
          .run();
        merged.decisions =
          typeof dR === "object" && dR !== null
            ? ((dR as { changes?: number }).changes ?? 0)
            : 0;
        const rR = adapter
          .prepare(
            `
          INSERT OR REPLACE INTO requirements (
            id, class, status, description, why, source, primary_owner,
            supporting_slices, validation, notes, full_content, superseded_by
          )
          SELECT
            id, class, status, description, why, source, primary_owner,
            supporting_slices, validation, notes, full_content, superseded_by
          FROM wt.requirements
        `,
          )
          .run();
        merged.requirements =
          typeof rR === "object" && rR !== null
            ? ((rR as { changes?: number }).changes ?? 0)
            : 0;
        const aR = adapter
          .prepare(
            `
          INSERT OR REPLACE INTO artifacts (
            path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          )
          SELECT
            path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          FROM wt.artifacts
        `,
          )
          .run();
        merged.artifacts =
          typeof aR === "object" && aR !== null
            ? ((aR as { changes?: number }).changes ?? 0)
            : 0;
        adapter.exec("COMMIT");
      } catch (txErr) {
        try {
          adapter.exec("ROLLBACK");
        } catch {
          /* best-effort */
        }
        throw txErr;
      }
      return { ...merged, conflicts };
    } finally {
      try {
        adapter.exec("DETACH DATABASE wt");
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    process.stderr.write(
      `gsd-db: worktree DB reconciliation failed: ${(err as Error).message}\n`,
    );
    return { ...zero, conflicts };
  }
}
