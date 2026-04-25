// GSD Database Abstraction Layer
// Provides a SQLite database with provider fallback chain:
//   node:sqlite (built-in) → better-sqlite3 (npm) → null (unavailable)
//
// Exposes a unified sync API for decisions and requirements storage.
// Schema is initialized on first open with WAL mode for file-backed DBs.
//
// ─── Single-writer invariant ─────────────────────────────────────────────
// This file is the ONLY place in the codebase that issues write SQL
// (INSERT / UPDATE / DELETE / REPLACE / BEGIN-COMMIT transactions) against
// the engine database at `.gsd/gsd.db`. All other modules must call the
// typed wrappers exported here. The structural test
// `tests/single-writer-invariant.test.ts` fails CI if a new bypass appears.
//
// `_getAdapter()` is retained for read-only SELECTs in query modules
// (context-store, memory-store queries, doctor checks, projections).
// Do NOT use it for writes — add a wrapper here instead.
//
// The separate `.gsd/unit-claims.db` managed by `unit-ownership.ts` is an
// intentionally independent store for cross-worktree claim races and is
// excluded from this invariant.

import { createRequire } from "node:module";
import { existsSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Requirement, GateRow, GateId, GateScope, GateStatus, GateVerdict } from "./types.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { getGateIdsForTurn, type OwnerTurn } from "./gate-registry.js";
import { logError, logWarning } from "./workflow-logger.js";
// Type-only import to avoid a circular runtime dep. The runtime side of
// workflow-manifest.ts depends on this file, but the StateManifest type is
// pure structure with no runtime coupling.
import type { StateManifest } from "./workflow-manifest.js";

const _require = createRequire(import.meta.url);

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

function suppressSqliteWarning(): void {
  const origEmit = process.emit;
  // Override via loose cast: Node's overloaded emit signature is not directly assignable.
  (process as any).emit = function (event: string, ...args: unknown[]): boolean {
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
    return origEmit.apply(process, [event, ...args] as Parameters<typeof process.emit>) as unknown as boolean;
  };
}

function loadProvider(): void {
  if (loadAttempted) return;
  loadAttempted = true;

  try {
    suppressSqliteWarning();
    const mod = _require("node:sqlite");
    if (mod.DatabaseSync) {
      providerModule = mod;
      providerName = "node:sqlite";
      return;
    }
  } catch {
    // unavailable
  }

  try {
    const mod = _require("better-sqlite3");
    if (typeof mod === "function" || (mod && mod.default)) {
      providerModule = mod.default || mod;
      providerName = "better-sqlite3";
      return;
    }
  } catch {
    // unavailable
  }

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  const versionHint = nodeMajor < 22
    ? ` GSD requires Node >= 22.0.0 (current: v${process.versions.node}). Upgrade Node to fix this.`
    : "";
  process.stderr.write(
    `gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3).${versionHint}\n`,
  );
}

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

  const stmtCache = new Map<string, DbStatement>();

  function wrapStmt(raw: { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }): DbStatement {
    return {
      run(...params: unknown[]): unknown {
        return raw.run(...params);
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        return normalizeRow(raw.get(...params));
      },
      all(...params: unknown[]): Record<string, unknown>[] {
        return normalizeRows(raw.all(...params));
      },
    };
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): DbStatement {
      let cached = stmtCache.get(sql);
      if (cached) return cached;
      cached = wrapStmt(db.prepare(sql));
      stmtCache.set(sql, cached);
      return cached;
    },
    close(): void {
      stmtCache.clear();
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

  const Database = providerModule as new (path: string) => unknown;
  return new Database(path);
}

export const SCHEMA_VERSION = 22;

function indexExists(db: DbAdapter, name: string): boolean {
  return !!db.prepare(
    "SELECT 1 as present FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(name);
}

function dedupeVerificationEvidenceRows(db: DbAdapter): void {
  db.exec(`
    DELETE FROM verification_evidence
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM verification_evidence
      GROUP BY task_id, slice_id, milestone_id, command, verdict
    )
  `);
}

function ensureVerificationEvidenceDedupIndex(db: DbAdapter): void {
  if (indexExists(db, "idx_verification_evidence_dedup")) return;
  dedupeVerificationEvidenceRows(db);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");
}

function initSchema(db: DbAdapter, fileBacked: boolean): void {
  if (fileBacked) db.exec("PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec("PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");   // 8 MB page cache
  if (fileBacked && process.platform !== "darwin") db.exec("PRAGMA mmap_size = 67108864");  // 64 MB mmap
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");

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
        source TEXT NOT NULL DEFAULT 'discussion', -- ADR-011 P2: 'discussion' | 'planning' | 'escalation'
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
        hit_count INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT 'project',
        tags TEXT NOT NULL DEFAULT '[]',
        structured_fields TEXT DEFAULT NULL
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
      CREATE TABLE IF NOT EXISTS memory_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        uri TEXT,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        imported_at TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        tags TEXT NOT NULL DEFAULT '[]'
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_relations (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        rel TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, rel)
      )
    `);

    // FTS5 virtual table mirroring memories.content for fast keyword search.
    // Optional — if the SQLite build lacks FTS5, we fall back to LIKE scans.
    tryCreateMemoriesFts(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
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
        goal TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        proof_level TEXT NOT NULL DEFAULT '',
        integration_closure TEXT NOT NULL DEFAULT '',
        observability_impact TEXT NOT NULL DEFAULT '',
        sequence INTEGER DEFAULT 0, -- Ordering hint: tools may set this to control execution order
        replan_triggered_at TEXT DEFAULT NULL,
        is_sketch INTEGER NOT NULL DEFAULT 0, -- ADR-011: 1 = slice is a sketch awaiting refinement
        sketch_scope TEXT NOT NULL DEFAULT '', -- ADR-011: 2-3 sentence rough scope from plan-milestone
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
        blocker_source TEXT NOT NULL DEFAULT '', -- ADR-011 P2: provenance for blocker_discovered (e.g. 'reject-escalation')
        escalation_pending INTEGER NOT NULL DEFAULT 0, -- ADR-011 P2: pause-on-escalation flag
        escalation_awaiting_review INTEGER NOT NULL DEFAULT 0, -- ADR-011 P2: artifact exists but continueWithDefault=true (no pause)
        escalation_artifact_path TEXT DEFAULT NULL, -- ADR-011 P2: path to T##-ESCALATION.json
        escalation_override_applied_at TEXT DEFAULT NULL, -- ADR-011 P2: DB claim lock for idempotent override injection
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
        sequence INTEGER DEFAULT 0, -- Ordering hint: tools may set this to control execution order
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS replan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        summary TEXT NOT NULL DEFAULT '',
        previous_artifact_path TEXT DEFAULT NULL,
        replacement_artifact_path TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS assessments (
        path TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL DEFAULT '',
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        full_content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (milestone_id) REFERENCES milestones(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_gates (
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
        PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    // Slice dependency junction table (v14)
    db.exec(`
      CREATE TABLE IF NOT EXISTS slice_dependencies (
        milestone_id TEXT NOT NULL,
        slice_id TEXT NOT NULL,
        depends_on_slice_id TEXT NOT NULL,
        PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
        FOREIGN KEY (milestone_id, depends_on_slice_id) REFERENCES slices(milestone_id, id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS gate_runs (
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_git_transactions (
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        turn_id TEXT DEFAULT NULL,
        caused_by TEXT DEFAULT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_turn_index (
        trace_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (trace_id, turn_id)
      )
    `);

    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");

    db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");

    // v13 indexes — hot-path dispatch queries
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
    ensureVerificationEvidenceDedupIndex(db);

    // v14 index — slice dependency lookups
    db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_turn ON gate_runs(trace_id, turn_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_lookup ON gate_runs(milestone_id, slice_id, task_id, gate_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_turn_git_tx_turn ON turn_git_transactions(trace_id, turn_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_trace ON audit_events(trace_id, ts)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_turn ON audit_events(trace_id, turn_id, ts)");

    db.exec(`CREATE VIEW IF NOT EXISTS active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL`);

    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
    if (existing && (existing["cnt"] as number) === 0) {
      // Fresh install — all tables are created above with the full current schema,
      // so it is safe to create all migration-specific indexes here.  For existing
      // databases these indexes are created inside the individual migration guards
      // in migrateSchema() after the corresponding columns have been added.
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");

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

  migrateSchema(db);
}

function columnExists(db: DbAdapter, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row["name"] === column);
}

/**
 * Create the FTS5 virtual table for memories plus the triggers that keep it
 * in sync with the base table. FTS5 may be unavailable on stripped-down
 * SQLite builds — callers should treat failure as non-fatal and fall back
 * to LIKE-based scans in `memory-store.queryMemoriesRanked`.
 */
export function tryCreateMemoriesFts(db: DbAdapter): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, content='memories', content_rowid='seq', tokenize='porter unicode61')
    `);
    // Triggers mirror inserts / updates / deletes on the base memories table.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad
      AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au
      AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
      END
    `);
    return true;
  } catch (err) {
    logWarning("db", `FTS5 unavailable — memory queries will use LIKE fallback: ${(err as Error).message}`);
    return false;
  }
}

export function isMemoriesFtsAvailable(db: DbAdapter): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get();
    return !!row;
  } catch {
    return false;
  }
}

function ensureColumn(db: DbAdapter, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) db.exec(ddl);
}

function migrateSchema(db: DbAdapter): void {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  const currentVersion = row ? (row["v"] as number) : 0;
  if (currentVersion >= SCHEMA_VERSION) return;

  // Backup database before migration so a mid-migration crash doesn't
  // leave a partially-migrated DB with no recovery path.
  // WAL-safe: checkpoint first to flush WAL into the main DB file, then copy.
  if (currentPath && currentPath !== ":memory:" && existsSync(currentPath)) {
    try {
      const backupPath = `${currentPath}.backup-v${currentVersion}`;
      if (!existsSync(backupPath)) {
        // Flush WAL to main DB file before copying — without this, the backup
        // may be missing committed data that only exists in the -wal file.
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* checkpoint is best-effort */ }
        copyFileSync(currentPath, backupPath);
      }
    } catch (backupErr) {
      // Log but proceed — blocking migration leaves the DB stuck at an old
      // schema version permanently on read-only or full filesystems.
      logWarning("db", `Pre-migration backup failed: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
    }
  }

  db.exec("BEGIN");
  try {
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
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 2,
        ":applied_at": new Date().toISOString(),
      });
    }

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
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");
      db.exec("DROP VIEW IF EXISTS active_memories");
      db.exec("CREATE VIEW active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 3,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 4) {
      ensureColumn(db, "decisions", "made_by", `ALTER TABLE decisions ADD COLUMN made_by TEXT NOT NULL DEFAULT 'agent'`);
      db.exec("DROP VIEW IF EXISTS active_decisions");
      db.exec("CREATE VIEW active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 4,
        ":applied_at": new Date().toISOString(),
      });
    }

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
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 5,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 6) {
      ensureColumn(db, "slices", "full_summary_md", `ALTER TABLE slices ADD COLUMN full_summary_md TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "full_uat_md", `ALTER TABLE slices ADD COLUMN full_uat_md TEXT NOT NULL DEFAULT ''`);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 6,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 7) {
      ensureColumn(db, "slices", "depends", `ALTER TABLE slices ADD COLUMN depends TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "slices", "demo", `ALTER TABLE slices ADD COLUMN demo TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "depends_on", `ALTER TABLE milestones ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 7,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 8) {
      ensureColumn(db, "milestones", "vision", `ALTER TABLE milestones ADD COLUMN vision TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "success_criteria", `ALTER TABLE milestones ADD COLUMN success_criteria TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "key_risks", `ALTER TABLE milestones ADD COLUMN key_risks TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "proof_strategy", `ALTER TABLE milestones ADD COLUMN proof_strategy TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "verification_contract", `ALTER TABLE milestones ADD COLUMN verification_contract TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_integration", `ALTER TABLE milestones ADD COLUMN verification_integration TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_operational", `ALTER TABLE milestones ADD COLUMN verification_operational TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "verification_uat", `ALTER TABLE milestones ADD COLUMN verification_uat TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "definition_of_done", `ALTER TABLE milestones ADD COLUMN definition_of_done TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "milestones", "requirement_coverage", `ALTER TABLE milestones ADD COLUMN requirement_coverage TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "milestones", "boundary_map_markdown", `ALTER TABLE milestones ADD COLUMN boundary_map_markdown TEXT NOT NULL DEFAULT ''`);

      ensureColumn(db, "slices", "goal", `ALTER TABLE slices ADD COLUMN goal TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "success_criteria", `ALTER TABLE slices ADD COLUMN success_criteria TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "proof_level", `ALTER TABLE slices ADD COLUMN proof_level TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "integration_closure", `ALTER TABLE slices ADD COLUMN integration_closure TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "slices", "observability_impact", `ALTER TABLE slices ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''`);

      ensureColumn(db, "tasks", "description", `ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "estimate", `ALTER TABLE tasks ADD COLUMN estimate TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "files", `ALTER TABLE tasks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "verify", `ALTER TABLE tasks ADD COLUMN verify TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "inputs", `ALTER TABLE tasks ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "expected_output", `ALTER TABLE tasks ADD COLUMN expected_output TEXT NOT NULL DEFAULT '[]'`);
      ensureColumn(db, "tasks", "observability_impact", `ALTER TABLE tasks ADD COLUMN observability_impact TEXT NOT NULL DEFAULT ''`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS replan_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          milestone_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          summary TEXT NOT NULL DEFAULT '',
          previous_artifact_path TEXT DEFAULT NULL,
          replacement_artifact_path TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS assessments (
          path TEXT PRIMARY KEY,
          milestone_id TEXT NOT NULL DEFAULT '',
          slice_id TEXT DEFAULT NULL,
          task_id TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL DEFAULT '',
          full_content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 8,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 9) {
      ensureColumn(db, "slices", "sequence", `ALTER TABLE slices ADD COLUMN sequence INTEGER DEFAULT 0`);
      ensureColumn(db, "tasks", "sequence", `ALTER TABLE tasks ADD COLUMN sequence INTEGER DEFAULT 0`);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 9,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 10) {
      ensureColumn(db, "slices", "replan_triggered_at", `ALTER TABLE slices ADD COLUMN replan_triggered_at TEXT DEFAULT NULL`);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 10,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 11) {
      ensureColumn(db, "tasks", "full_plan_md", `ALTER TABLE tasks ADD COLUMN full_plan_md TEXT NOT NULL DEFAULT ''`);
      // Add unique constraint to replan_history for idempotency:
      // one replan record per blocker task per slice per milestone.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_replan_history_unique
        ON replan_history(milestone_id, slice_id, task_id)
        WHERE slice_id IS NOT NULL AND task_id IS NOT NULL
      `);

      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 11,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 12) {
      // NOTE: The original DDL used COALESCE(task_id, '') in the PRIMARY KEY
      // expression, which is invalid SQLite syntax and causes startup errors on
      // DBs that migrate through v12. The corrected DDL uses
      // task_id TEXT NOT NULL DEFAULT '' with a plain column list PK. DBs that
      // were created with the broken DDL are repaired by the v22 migration below.
      db.exec(`
        CREATE TABLE IF NOT EXISTS quality_gates (
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
          PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 12,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 13) {
      // Hot-path indexes for auto-loop dispatch queries
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
      ensureVerificationEvidenceDedupIndex(db);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 13,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 14) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS slice_dependencies (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          depends_on_slice_id TEXT NOT NULL,
          PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id),
          FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
          FOREIGN KEY (milestone_id, depends_on_slice_id) REFERENCES slices(milestone_id, id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 14,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 15) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gate_runs (
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
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS turn_git_transactions (
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
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          event_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          turn_id TEXT DEFAULT NULL,
          caused_by TEXT DEFAULT NULL,
          category TEXT NOT NULL,
          type TEXT NOT NULL,
          ts TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_turn_index (
          trace_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          first_ts TEXT NOT NULL,
          last_ts TEXT NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (trace_id, turn_id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_turn ON gate_runs(trace_id, turn_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_gate_runs_lookup ON gate_runs(milestone_id, slice_id, task_id, gate_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_turn_git_tx_turn ON turn_git_transactions(trace_id, turn_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_trace ON audit_events(trace_id, ts)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_turn ON audit_events(trace_id, turn_id, ts)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 15,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 16) {
      // ADR-011 Phase 1: sketch-then-refine progressive planning — sketch columns on slices.
      ensureColumn(db, "slices", "is_sketch", `ALTER TABLE slices ADD COLUMN is_sketch INTEGER NOT NULL DEFAULT 0`);
      ensureColumn(db, "slices", "sketch_scope", `ALTER TABLE slices ADD COLUMN sketch_scope TEXT NOT NULL DEFAULT ''`);
      // ADR-011 Phase 2: decisions can now be sourced from escalation resolutions.
      ensureColumn(db, "decisions", "source", `ALTER TABLE decisions ADD COLUMN source TEXT NOT NULL DEFAULT 'discussion'`);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 16,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 17) {
      // ADR-011 Phase 2: mid-execution escalation — columns on the tasks table.
      ensureColumn(db, "tasks", "blocker_source", `ALTER TABLE tasks ADD COLUMN blocker_source TEXT NOT NULL DEFAULT ''`);
      ensureColumn(db, "tasks", "escalation_pending", `ALTER TABLE tasks ADD COLUMN escalation_pending INTEGER NOT NULL DEFAULT 0`);
      ensureColumn(db, "tasks", "escalation_awaiting_review", `ALTER TABLE tasks ADD COLUMN escalation_awaiting_review INTEGER NOT NULL DEFAULT 0`);
      ensureColumn(db, "tasks", "escalation_artifact_path", `ALTER TABLE tasks ADD COLUMN escalation_artifact_path TEXT DEFAULT NULL`);
      ensureColumn(db, "tasks", "escalation_override_applied_at", `ALTER TABLE tasks ADD COLUMN escalation_override_applied_at TEXT DEFAULT NULL`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_escalation_pending ON tasks(milestone_id, slice_id, escalation_pending)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 17,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 18) {
      // Memory system Phase 2: scope + tags on memories, plus memory_sources
      // table for raw ingested content (notes, files, URLs, artifacts).
      ensureColumn(db, "memories", "scope", `ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      ensureColumn(db, "memories", "tags", `ALTER TABLE memories ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_sources (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          uri TEXT,
          title TEXT,
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          imported_at TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'project',
          tags TEXT NOT NULL DEFAULT '[]'
        )
      `);
      // If memory_sources already existed before v18 (created by an earlier
      // version of initSchema that lacked scope/tags), add the missing columns.
      ensureColumn(db, "memory_sources", "scope", `ALTER TABLE memory_sources ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      ensureColumn(db, "memory_sources", "tags", `ALTER TABLE memory_sources ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_kind ON memory_sources(kind)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_sources_scope ON memory_sources(scope)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 18,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 19) {
      // Memory system Phase 3: embeddings + FTS5 for hybrid retrieval.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vector BLOB NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      tryCreateMemoriesFts(db);
      // Backfill FTS5 with any existing memories (triggers only cover future writes).
      if (isMemoriesFtsAvailable(db)) {
        try {
          db.exec(`INSERT INTO memories_fts(rowid, content) SELECT seq, content FROM memories`);
        } catch (err) {
          logWarning("db", `FTS5 backfill failed: ${(err as Error).message}`);
        }
      }
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 19,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 20) {
      // Memory system Phase 4: knowledge-graph relations between memories.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_relations (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          rel TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.8,
          created_at TEXT NOT NULL,
          PRIMARY KEY (from_id, to_id, rel)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_id)");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 20,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 21) {
      // ADR-013 Step 2: preserve structured fields (gsd_save_decision's
      // scope/decision/choice/rationale/made_by/revisable) on memories rows so
      // the eventual decisions->memories cutover does not lose schema fidelity.
      // Nullable JSON column — existing rows stay NULL until backfilled in Step 5.
      // Use ensureColumn for race-safety (matches v15-v18 pattern; bare ALTER
      // throws "duplicate column" on the loser of a concurrent open race even
      // though the transaction wrapper protects the schema_version row).
      ensureColumn(db, "memories", "structured_fields", "ALTER TABLE memories ADD COLUMN structured_fields TEXT DEFAULT NULL");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 21,
        ":applied_at": new Date().toISOString(),
      });
    }

    if (currentVersion < 22) {
      // v22: Repair quality_gates tables that were created by the broken v12
      // migration (which used COALESCE(task_id, '') as a PK expression — invalid
      // SQLite DDL). Those DBs have task_id nullable (dflt_value NULL, notnull 0).
      // Rebuild the table with the correct schema, migrating existing rows via
      // COALESCE so no data is lost.
      const qgInfo = db.prepare("PRAGMA table_info(quality_gates)").all() as Array<Record<string, unknown>>;
      const taskIdCol = qgInfo.find((r) => r["name"] === "task_id");
      const needsRepair = taskIdCol && (taskIdCol["notnull"] === 0 || taskIdCol["notnull"] === "0");
      if (needsRepair) {
        db.exec(`
          CREATE TABLE quality_gates_new (
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
            PRIMARY KEY (milestone_id, slice_id, gate_id, task_id),
            FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id)
          )
        `);
        db.exec(`
          INSERT OR IGNORE INTO quality_gates_new
            (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
          SELECT milestone_id, slice_id, gate_id, scope, COALESCE(task_id, ''), status, verdict, rationale, findings, evaluated_at
          FROM quality_gates
        `);
        db.exec("DROP TABLE quality_gates");
        db.exec("ALTER TABLE quality_gates_new RENAME TO quality_gates");
        db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
      }
      // Ensure scope column exists on quality_gates and assessments (guard
      // against DBs that somehow lack it after a partial migration).
      ensureColumn(db, "quality_gates", "scope", "ALTER TABLE quality_gates ADD COLUMN scope TEXT NOT NULL DEFAULT 'slice'");
      ensureColumn(db, "assessments", "scope", "ALTER TABLE assessments ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (:version, :applied_at)").run({
        ":version": 22,
        ":applied_at": new Date().toISOString(),
      });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

let currentDb: DbAdapter | null = null;
let currentPath: string | null = null;
let currentPid: number = 0;
let _exitHandlerRegistered = false;
let _dbOpenAttempted = false;
let _lastDbError: Error | null = null;
let _lastDbPhase: "open" | "initSchema" | "vacuum-recovery" | null = null;

export function getDbProvider(): ProviderName | null {
  loadProvider();
  return providerName;
}

export function isDbAvailable(): boolean {
  return currentDb !== null;
}

/**
 * Returns true if openDatabase() has been called at least once this session.
 * Used to distinguish "DB not yet initialized" from "DB genuinely unavailable"
 * so that early callers (e.g. before_agent_start context injection) don't
 * trigger a false degraded-mode warning.
 */
export function wasDbOpenAttempted(): boolean {
  return _dbOpenAttempted;
}

export function getDbStatus(): {
  available: boolean;
  provider: ProviderName | null;
  attempted: boolean;
  lastError: Error | null;
  lastPhase: "open" | "initSchema" | "vacuum-recovery" | null;
} {
  loadProvider();
  return {
    available: currentDb !== null,
    provider: providerName,
    attempted: _dbOpenAttempted,
    lastError: _lastDbError,
    lastPhase: _lastDbPhase,
  };
}

export function openDatabase(path: string): boolean {
  _dbOpenAttempted = true;
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) return true;

  // Reset error state only when a new open attempt is actually going to run.
  _lastDbError = null;
  _lastDbPhase = null;

  let rawDb: unknown;
  let fallbackProvider: ProviderName | null = null;
  let fallbackModule: unknown = null;
  try {
    rawDb = openRawDb(path);
  } catch (primaryErr) {
    _lastDbPhase = "open";
    _lastDbError = primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr));
    // node:sqlite loaded but failed to open this file — try better-sqlite3 as fallback.
    if (providerName === "node:sqlite") {
      try {
        const mod = _require("better-sqlite3");
        const Db = (mod && mod.default) ? mod.default : mod;
        if (typeof Db === "function") {
          rawDb = new Db(path);
          fallbackProvider = "better-sqlite3";
          fallbackModule = Db;
          _lastDbError = null;
          _lastDbPhase = null;
        }
      } catch {
        // fallback unavailable; surface original error
      }
    }
    if (!rawDb) throw primaryErr;
  }
  if (!rawDb) return false;

  const adapter = createAdapter(rawDb);
  const fileBacked = path !== ":memory:";
  try {
    initSchema(adapter, fileBacked);
  } catch (err) {
    // Corrupt freelist: DDL fails with "malformed" but VACUUM can rebuild.
    // Attempt VACUUM recovery before giving up (see #2519).
    if (fileBacked && err instanceof Error && err.message?.includes("malformed")) {
      try {
        adapter.exec("VACUUM");
        initSchema(adapter, fileBacked);
        process.stderr.write("gsd-db: recovered corrupt database via VACUUM\n");
      } catch (retryErr) {
        _lastDbPhase = "vacuum-recovery";
        _lastDbError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
        try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
        throw retryErr;
      }
    } else {
      _lastDbPhase = "initSchema";
      _lastDbError = err instanceof Error ? err : new Error(String(err));
      try { adapter.close(); } catch (e) { logWarning("db", `close after initSchema failed: ${(e as Error).message}`); }
      throw err;
    }
  }

  // Commit fallback provider switch only after open + schema both succeeded.
  if (fallbackProvider) {
    providerName = fallbackProvider;
    providerModule = fallbackModule;
  }

  currentDb = adapter;
  currentPath = path;
  currentPid = process.pid;

  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", () => { try { closeDatabase(); } catch (e) { logWarning("db", `exit handler close failed: ${(e as Error).message}`); } });
  }

  return true;
}

export function closeDatabase(): void {
  if (currentDb) {
    try {
      currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
    try {
      // Incremental vacuum to reclaim space without blocking
      currentDb.exec('PRAGMA incremental_vacuum(64)');
    } catch (e) { logWarning("db", `incremental vacuum failed: ${(e as Error).message}`); }
    try {
      currentDb.close();
    } catch (e) { logWarning("db", `database close failed: ${(e as Error).message}`); }
    currentDb = null;
    currentPath = null;
    currentPid = 0;
  }
  // Reset session-scoped state unconditionally so stale error info from a
  // failed open doesn't persist into the next open attempt or status check.
  _dbOpenAttempted = false;
  _lastDbError = null;
  _lastDbPhase = null;
}

/** Run a full VACUUM — call sparingly (e.g. after milestone completion). */
export function vacuumDatabase(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('VACUUM');
  } catch (e) { logWarning("db", `VACUUM failed: ${(e as Error).message}`); }
}

/** Flush WAL into gsd.db so `git add .gsd/gsd.db` stages current state — safe while DB is open. */
export function checkpointDatabase(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) { logWarning("db", `WAL checkpoint failed: ${(e as Error).message}`); }
}

let _txDepth = 0;

export function transaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");

  // Re-entrant: if already inside a transaction, just run fn() without
  // starting a new one. SQLite does not support nested BEGIN/COMMIT.
  if (_txDepth > 0) {
    _txDepth++;
    try {
      return fn();
    } finally {
      _txDepth--;
    }
  }

  _txDepth++;
  currentDb.exec("BEGIN");
  try {
    const result = fn();
    currentDb.exec("COMMIT");
    return result;
  } catch (err) {
    currentDb.exec("ROLLBACK");
    throw err;
  } finally {
    _txDepth--;
  }
}

/**
 * Wrap a block of reads in a DEFERRED transaction so that all SELECTs observe
 * a consistent snapshot of the DB even if a concurrent writer commits between
 * them. Use this for multi-query read flows (e.g. tool executors that query
 * milestone + slices + counts and want one snapshot). Re-entrant — if already
 * inside a transaction, runs fn() without starting a nested one.
 */
export function readTransaction<T>(fn: () => T): T {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");

  if (_txDepth > 0) {
    _txDepth++;
    try {
      return fn();
    } finally {
      _txDepth--;
    }
  }

  _txDepth++;
  currentDb.exec("BEGIN DEFERRED");
  try {
    const result = fn();
    currentDb.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      currentDb.exec("ROLLBACK");
    } catch (rollbackErr) {
      // A failed ROLLBACK after a failed read is a split-brain signal —
      // the transaction is in an indeterminate state. Surface it via the
      // logger instead of swallowing it.
      logError("db", "snapshotState ROLLBACK failed", {
        error: (rollbackErr as Error).message,
      });
    }
    throw err;
  } finally {
    _txDepth--;
  }
}

export function insertDecision(d: Omit<Decision, "seq">): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)`,
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by,
  });
}

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
    source: (row["source"] as string) ?? "discussion",
    superseded_by: (row["superseded_by"] as string) ?? null,
  };
}

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
    source: (row["source"] as string) ?? "discussion",
    superseded_by: null,
  }));
}

export function insertRequirement(r: Requirement): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
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

export function getRequirementById(id: string): Requirement | null {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM requirements WHERE id = ?").get(id);
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

export function getDbOwnerPid(): number {
  return currentPid;
}

export function getDbPath(): string | null {
  return currentPath;
}

export function _getAdapter(): DbAdapter | null {
  return currentDb;
}

export function _resetProvider(): void {
  loadAttempted = false;
  providerModule = null;
  providerName = null;
}

export function upsertDecision(d: Omit<Decision, "seq">): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // Use ON CONFLICT DO UPDATE instead of INSERT OR REPLACE to preserve the
  // seq column. INSERT OR REPLACE deletes then reinserts, resetting seq and
  // corrupting decision ordering in DECISIONS.md after reconcile replay.
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :source, :superseded_by)
     ON CONFLICT(id) DO UPDATE SET
       when_context = excluded.when_context,
       scope = excluded.scope,
       decision = excluded.decision,
       choice = excluded.choice,
       rationale = excluded.rationale,
       revisable = excluded.revisable,
       made_by = excluded.made_by,
       source = excluded.source,
       superseded_by = excluded.superseded_by`,
  ).run({
    ":id": d.id,
    ":when_context": d.when_context,
    ":scope": d.scope,
    ":decision": d.decision,
    ":choice": d.choice,
    ":rationale": d.rationale,
    ":revisable": d.revisable,
    ":made_by": d.made_by ?? "agent",
    ":source": d.source ?? "discussion",
    ":superseded_by": d.superseded_by ?? null,
  });
}

export function upsertRequirement(r: Requirement): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
     VALUES (:id, :class, :status, :description, :why, :source, :primary_owner, :supporting_slices, :validation, :notes, :full_content, :superseded_by)`,
  ).run({
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

export function clearArtifacts(): void {
  if (!currentDb) return;
  try { currentDb.exec("DELETE FROM artifacts"); } catch (e) { logWarning("db", `clearArtifacts failed: ${(e as Error).message}`); }
}

export function insertArtifact(a: {
  path: string;
  artifact_type: string;
  milestone_id: string | null;
  slice_id: string | null;
  task_id: string | null;
  full_content: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO artifacts (path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at)
     VALUES (:path, :artifact_type, :milestone_id, :slice_id, :task_id, :full_content, :imported_at)`,
  ).run({
    ":path": a.path,
    ":artifact_type": a.artifact_type,
    ":milestone_id": a.milestone_id,
    ":slice_id": a.slice_id,
    ":task_id": a.task_id,
    ":full_content": a.full_content,
    ":imported_at": new Date().toISOString(),
  });
}

export interface MilestonePlanningRecord {
  vision: string;
  successCriteria: string[];
  keyRisks: Array<{ risk: string; whyItMatters: string }>;
  proofStrategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verificationContract: string;
  verificationIntegration: string;
  verificationOperational: string;
  verificationUat: string;
  definitionOfDone: string[];
  requirementCoverage: string;
  boundaryMapMarkdown: string;
}

export interface SlicePlanningRecord {
  goal: string;
  successCriteria: string;
  proofLevel: string;
  integrationClosure: string;
  observabilityImpact: string;
}

export interface TaskPlanningRecord {
  title?: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  observabilityImpact: string;
  fullPlanMd?: string;
}

export function insertMilestone(m: {
  id: string;
  title?: string;
  status?: string;
  depends_on?: string[];
  planning?: Partial<MilestonePlanningRecord>;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO milestones (
      id, title, status, depends_on, created_at,
      vision, success_criteria, key_risks, proof_strategy,
      verification_contract, verification_integration, verification_operational, verification_uat,
      definition_of_done, requirement_coverage, boundary_map_markdown
    ) VALUES (
      :id, :title, :status, :depends_on, :created_at,
      :vision, :success_criteria, :key_risks, :proof_strategy,
      :verification_contract, :verification_integration, :verification_operational, :verification_uat,
      :definition_of_done, :requirement_coverage, :boundary_map_markdown
    )`,
  ).run({
    ":id": m.id,
    ":title": m.title ?? "",
    // Default to "queued" — never auto-create milestones as "active" (#3380).
    // Callers that need "active" must pass it explicitly.
    ":status": m.status ?? "queued",
    ":depends_on": JSON.stringify(m.depends_on ?? []),
    ":created_at": new Date().toISOString(),
    ":vision": m.planning?.vision ?? "",
    ":success_criteria": JSON.stringify(m.planning?.successCriteria ?? []),
    ":key_risks": JSON.stringify(m.planning?.keyRisks ?? []),
    ":proof_strategy": JSON.stringify(m.planning?.proofStrategy ?? []),
    ":verification_contract": m.planning?.verificationContract ?? "",
    ":verification_integration": m.planning?.verificationIntegration ?? "",
    ":verification_operational": m.planning?.verificationOperational ?? "",
    ":verification_uat": m.planning?.verificationUat ?? "",
    ":definition_of_done": JSON.stringify(m.planning?.definitionOfDone ?? []),
    ":requirement_coverage": m.planning?.requirementCoverage ?? "",
    ":boundary_map_markdown": m.planning?.boundaryMapMarkdown ?? "",
  });
}

export function upsertMilestonePlanning(milestoneId: string, planning: Partial<MilestonePlanningRecord> & { title?: string; status?: string }): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE milestones SET
      title = COALESCE(NULLIF(:title, ''), title),
      status = COALESCE(NULLIF(:status, ''), status),
      vision = COALESCE(:vision, vision),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      key_risks = COALESCE(:key_risks, key_risks),
      proof_strategy = COALESCE(:proof_strategy, proof_strategy),
      verification_contract = COALESCE(:verification_contract, verification_contract),
      verification_integration = COALESCE(:verification_integration, verification_integration),
      verification_operational = COALESCE(:verification_operational, verification_operational),
      verification_uat = COALESCE(:verification_uat, verification_uat),
      definition_of_done = COALESCE(:definition_of_done, definition_of_done),
      requirement_coverage = COALESCE(:requirement_coverage, requirement_coverage),
      boundary_map_markdown = COALESCE(:boundary_map_markdown, boundary_map_markdown)
     WHERE id = :id`,
  ).run({
    ":id": milestoneId,
    ":title": planning.title ?? "",
    ":status": planning.status ?? "",
    ":vision": planning.vision ?? null,
    ":success_criteria": planning.successCriteria ? JSON.stringify(planning.successCriteria) : null,
    ":key_risks": planning.keyRisks ? JSON.stringify(planning.keyRisks) : null,
    ":proof_strategy": planning.proofStrategy ? JSON.stringify(planning.proofStrategy) : null,
    ":verification_contract": planning.verificationContract ?? null,
    ":verification_integration": planning.verificationIntegration ?? null,
    ":verification_operational": planning.verificationOperational ?? null,
    ":verification_uat": planning.verificationUat ?? null,
    ":definition_of_done": planning.definitionOfDone ? JSON.stringify(planning.definitionOfDone) : null,
    ":requirement_coverage": planning.requirementCoverage ?? null,
    ":boundary_map_markdown": planning.boundaryMapMarkdown ?? null,
  });
}

export function insertSlice(s: {
  id: string;
  milestoneId: string;
  title?: string;
  status?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
  sequence?: number;
  isSketch?: boolean;
  sketchScope?: string;
  planning?: Partial<SlicePlanningRecord>;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO slices (
      milestone_id, id, title, status, risk, depends, demo, created_at,
      goal, success_criteria, proof_level, integration_closure, observability_impact, sequence,
      is_sketch, sketch_scope
    ) VALUES (
      :milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at,
      :goal, :success_criteria, :proof_level, :integration_closure, :observability_impact, :sequence,
      :is_sketch, :sketch_scope
    )
    ON CONFLICT (milestone_id, id) DO UPDATE SET
      title = CASE WHEN :raw_title IS NOT NULL THEN excluded.title ELSE slices.title END,
      status = CASE WHEN slices.status IN ('complete', 'done') THEN slices.status ELSE excluded.status END,
      risk = CASE WHEN :raw_risk IS NOT NULL THEN excluded.risk ELSE slices.risk END,
      depends = excluded.depends,
      demo = CASE WHEN :raw_demo IS NOT NULL THEN excluded.demo ELSE slices.demo END,
      goal = CASE WHEN :raw_goal IS NOT NULL THEN excluded.goal ELSE slices.goal END,
      success_criteria = CASE WHEN :raw_success_criteria IS NOT NULL THEN excluded.success_criteria ELSE slices.success_criteria END,
      proof_level = CASE WHEN :raw_proof_level IS NOT NULL THEN excluded.proof_level ELSE slices.proof_level END,
      integration_closure = CASE WHEN :raw_integration_closure IS NOT NULL THEN excluded.integration_closure ELSE slices.integration_closure END,
      observability_impact = CASE WHEN :raw_observability_impact IS NOT NULL THEN excluded.observability_impact ELSE slices.observability_impact END,
      sequence = CASE WHEN :raw_sequence IS NOT NULL THEN excluded.sequence ELSE slices.sequence END,
      is_sketch = CASE WHEN :raw_is_sketch IS NOT NULL THEN excluded.is_sketch ELSE slices.is_sketch END,
      sketch_scope = CASE WHEN :raw_sketch_scope IS NOT NULL THEN excluded.sketch_scope ELSE slices.sketch_scope END`,
  ).run({
    ":milestone_id": s.milestoneId,
    ":id": s.id,
    ":title": s.title ?? "",
    ":status": s.status ?? "pending",
    ":risk": s.risk ?? "medium",
    ":depends": JSON.stringify(s.depends ?? []),
    ":demo": s.demo ?? "",
    ":created_at": new Date().toISOString(),
    ":goal": s.planning?.goal ?? "",
    ":success_criteria": s.planning?.successCriteria ?? "",
    ":proof_level": s.planning?.proofLevel ?? "",
    ":integration_closure": s.planning?.integrationClosure ?? "",
    ":observability_impact": s.planning?.observabilityImpact ?? "",
    ":sequence": s.sequence ?? 0,
    ":is_sketch": s.isSketch ? 1 : 0,
    ":sketch_scope": s.sketchScope ?? "",
    // Raw sentinel params: NULL when caller omitted the field, used in ON CONFLICT guards
    ":raw_title": s.title ?? null,
    ":raw_risk": s.risk ?? null,
    ":raw_demo": s.demo ?? null,
    ":raw_goal": s.planning?.goal ?? null,
    ":raw_success_criteria": s.planning?.successCriteria ?? null,
    ":raw_proof_level": s.planning?.proofLevel ?? null,
    ":raw_integration_closure": s.planning?.integrationClosure ?? null,
    ":raw_observability_impact": s.planning?.observabilityImpact ?? null,
    ":raw_sequence": s.sequence ?? null,
    ":raw_is_sketch": s.isSketch === undefined ? null : (s.isSketch ? 1 : 0),
    // NOTE: use !== undefined (not ??) so an explicit empty string "" is treated
    // as a present value and correctly clears the existing sketch_scope on
    // CONFLICT. ?? would incorrectly preserve the stale value.
    ":raw_sketch_scope": s.sketchScope !== undefined ? s.sketchScope : null,
  });
}

// ADR-011: sketch-then-refine helpers
export function setSliceSketchFlag(milestoneId: string, sliceId: string, isSketch: boolean): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET is_sketch = :is_sketch WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":is_sketch": isSketch ? 1 : 0, ":mid": milestoneId, ":sid": sliceId });
}

/**
 * ADR-011 auto-heal: reconcile stale is_sketch=1 rows whose PLAN already exists.
 *
 * Callers pass a predicate that resolves whether a plan file exists for a slice.
 * The predicate MUST use the canonical path resolver (`resolveSliceFile`, etc.)
 * to keep path logic in one place — do not hand-roll the path inside the callback.
 *
 * Recovers from two scenarios:
 *   1. Crash between `gsd_plan_slice` write and the sketch flag flip.
 *   2. Flag-OFF downgrade path: when `progressive_planning` is off, the dispatch
 *      rule routes sketch slices to plan-slice, which writes PLAN.md but leaves
 *      `is_sketch=1` — the next state derivation auto-heals it to 0 here.
 *
 * Not aggressive in practice: PLAN.md is only written via the DB-backed
 * `gsd_plan_slice` tool (which also inserts tasks), so a "stale PLAN.md with
 * is_sketch=1" is extremely unlikely to indicate anything other than the two
 * recovery scenarios above.
 */
export function autoHealSketchFlags(milestoneId: string, hasPlanFile: (sliceId: string) => boolean): void {
  if (!currentDb) return;
  const rows = currentDb.prepare(
    `SELECT id FROM slices WHERE milestone_id = :mid AND is_sketch = 1`,
  ).all({ ":mid": milestoneId }) as Array<{ id: string }>;
  for (const row of rows) {
    if (hasPlanFile(row.id)) {
      setSliceSketchFlag(milestoneId, row.id, false);
    }
  }
}

export function upsertSlicePlanning(milestoneId: string, sliceId: string, planning: Partial<SlicePlanningRecord>): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET
      goal = COALESCE(:goal, goal),
      success_criteria = COALESCE(:success_criteria, success_criteria),
      proof_level = COALESCE(:proof_level, proof_level),
      integration_closure = COALESCE(:integration_closure, integration_closure),
      observability_impact = COALESCE(:observability_impact, observability_impact)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":goal": planning.goal ?? null,
    ":success_criteria": planning.successCriteria ?? null,
    ":proof_level": planning.proofLevel ?? null,
    ":integration_closure": planning.integrationClosure ?? null,
    ":observability_impact": planning.observabilityImpact ?? null,
  });
}

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
  sequence?: number;
  planning?: Partial<TaskPlanningRecord>;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO tasks (
      milestone_id, slice_id, id, title, status, one_liner, narrative,
      verification_result, duration, completed_at, blocker_discovered,
      deviations, known_issues, key_files, key_decisions, full_summary_md,
      description, estimate, files, verify, inputs, expected_output, observability_impact, sequence
    ) VALUES (
      :milestone_id, :slice_id, :id, :title, :status, :one_liner, :narrative,
      :verification_result, :duration, :completed_at, :blocker_discovered,
      :deviations, :known_issues, :key_files, :key_decisions, :full_summary_md,
      :description, :estimate, :files, :verify, :inputs, :expected_output, :observability_impact, :sequence
    )
    ON CONFLICT(milestone_id, slice_id, id) DO UPDATE SET
      title = CASE WHEN NULLIF(:title, '') IS NOT NULL THEN :title ELSE tasks.title END,
      status = :status,
      one_liner = :one_liner,
      narrative = :narrative,
      verification_result = :verification_result,
      duration = :duration,
      completed_at = :completed_at,
      blocker_discovered = :blocker_discovered,
      deviations = :deviations,
      known_issues = :known_issues,
      key_files = :key_files,
      key_decisions = :key_decisions,
      full_summary_md = :full_summary_md,
      description = CASE WHEN NULLIF(:description, '') IS NOT NULL THEN :description ELSE tasks.description END,
      estimate = CASE WHEN NULLIF(:estimate, '') IS NOT NULL THEN :estimate ELSE tasks.estimate END,
      files = CASE WHEN NULLIF(:files, '[]') IS NOT NULL THEN :files ELSE tasks.files END,
      verify = CASE WHEN NULLIF(:verify, '') IS NOT NULL THEN :verify ELSE tasks.verify END,
      inputs = CASE WHEN NULLIF(:inputs, '[]') IS NOT NULL THEN :inputs ELSE tasks.inputs END,
      expected_output = CASE WHEN NULLIF(:expected_output, '[]') IS NOT NULL THEN :expected_output ELSE tasks.expected_output END,
      observability_impact = CASE WHEN NULLIF(:observability_impact, '') IS NOT NULL THEN :observability_impact ELSE tasks.observability_impact END,
      sequence = :sequence`,
  ).run({
    ":milestone_id": t.milestoneId,
    ":slice_id": t.sliceId,
    ":id": t.id,
    ":title": t.title ?? "",
    ":status": t.status ?? "pending",
    ":one_liner": t.oneLiner ?? "",
    ":narrative": t.narrative ?? "",
    ":verification_result": t.verificationResult ?? "",
    ":duration": t.duration ?? "",
    ":completed_at": t.status === "done" || t.status === "complete" ? new Date().toISOString() : null,
    ":blocker_discovered": t.blockerDiscovered ? 1 : 0,
    ":deviations": t.deviations ?? "",
    ":known_issues": t.knownIssues ?? "",
    ":key_files": JSON.stringify(t.keyFiles ?? []),
    ":key_decisions": JSON.stringify(t.keyDecisions ?? []),
    ":full_summary_md": t.fullSummaryMd ?? "",
    ":description": t.planning?.description ?? "",
    ":estimate": t.planning?.estimate ?? "",
    ":files": JSON.stringify(t.planning?.files ?? []),
    ":verify": t.planning?.verify ?? "",
    ":inputs": JSON.stringify(t.planning?.inputs ?? []),
    ":expected_output": JSON.stringify(t.planning?.expectedOutput ?? []),
    ":observability_impact": t.planning?.observabilityImpact ?? "",
    ":sequence": t.sequence ?? 0,
  });
}

export function updateTaskStatus(milestoneId: string, sliceId: string, taskId: string, status: string, completedAt?: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
  });
}

export function setTaskBlockerDiscovered(milestoneId: string, sliceId: string, taskId: string, discovered: boolean): void {
  if (!currentDb) return;
  currentDb.prepare(
    `UPDATE tasks SET blocker_discovered = :discovered WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":discovered": discovered ? 1 : 0, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

export function upsertTaskPlanning(milestoneId: string, sliceId: string, taskId: string, planning: Partial<TaskPlanningRecord>): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET
      title = COALESCE(:title, title),
      description = COALESCE(:description, description),
      estimate = COALESCE(:estimate, estimate),
      files = COALESCE(:files, files),
      verify = COALESCE(:verify, verify),
      inputs = COALESCE(:inputs, inputs),
      expected_output = COALESCE(:expected_output, expected_output),
      observability_impact = COALESCE(:observability_impact, observability_impact),
      full_plan_md = COALESCE(:full_plan_md, full_plan_md)
     WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":id": taskId,
    ":title": planning.title ?? null,
    ":description": planning.description ?? null,
    ":estimate": planning.estimate ?? null,
    ":files": planning.files ? JSON.stringify(planning.files) : null,
    ":verify": planning.verify ?? null,
    ":inputs": planning.inputs ? JSON.stringify(planning.inputs) : null,
    ":expected_output": planning.expectedOutput ? JSON.stringify(planning.expectedOutput) : null,
    ":observability_impact": planning.observabilityImpact ?? null,
    ":full_plan_md": planning.fullPlanMd ?? null,
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
  goal: string;
  success_criteria: string;
  proof_level: string;
  integration_closure: string;
  observability_impact: string;
  sequence: number;
  replan_triggered_at: string | null;
  is_sketch: number;
  sketch_scope: string;
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
    goal: (row["goal"] as string) ?? "",
    success_criteria: (row["success_criteria"] as string) ?? "",
    proof_level: (row["proof_level"] as string) ?? "",
    integration_closure: (row["integration_closure"] as string) ?? "",
    observability_impact: (row["observability_impact"] as string) ?? "",
    sequence: (row["sequence"] as number) ?? 0,
    replan_triggered_at: (row["replan_triggered_at"] as string) ?? null,
    is_sketch: (row["is_sketch"] as number) ?? 0,
    sketch_scope: (row["sketch_scope"] as string) ?? "",
  };
}

export function getSlice(milestoneId: string, sliceId: string): SliceRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM slices WHERE milestone_id = :mid AND id = :sid").get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToSlice(row);
}

export function updateSliceStatus(milestoneId: string, sliceId: string, status: string, completedAt?: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET status = :status, completed_at = :completed_at
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":status": status,
    ":completed_at": completedAt ?? null,
    ":milestone_id": milestoneId,
    ":id": sliceId,
  });
}

export function setTaskSummaryMd(milestoneId: string, sliceId: string, taskId: string, md: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks SET full_summary_md = :md WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId, ":md": md });
}

export function setSliceSummaryMd(milestoneId: string, sliceId: string, summaryMd: string, uatMd: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET full_summary_md = :summary_md, full_uat_md = :uat_md WHERE milestone_id = :mid AND id = :sid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":summary_md": summaryMd, ":uat_md": uatMd });
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
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expected_output: string[];
  observability_impact: string;
  full_plan_md: string;
  sequence: number;
  // ADR-011 Phase 2 escalation fields
  blocker_source: string;
  escalation_pending: number;
  escalation_awaiting_review: number;
  escalation_artifact_path: string | null;
  escalation_override_applied_at: string | null;
}

function parseTaskArrayColumn(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((value) => String(value));
    if (parsed === null || parsed === undefined || parsed === "") return [];
    return [String(parsed)];
  } catch {
    // Older/corrupt rows may contain comma-separated strings instead of JSON.
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

function rowToTask(row: Record<string, unknown>): TaskRow {
  const parseTaskArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    if (typeof value !== "string") return [];

    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
      if (typeof parsed === "string" && parsed.trim()) {
        return [parsed.trim()];
      }
    } catch {
      // Older/corrupt DB rows may contain raw comma-separated paths instead of JSON arrays.
    }

    return trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
  };

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
    key_files: parseTaskArrayColumn(row["key_files"]),
    key_decisions: parseTaskArrayColumn(row["key_decisions"]),
    full_summary_md: row["full_summary_md"] as string,
    description: (row["description"] as string) ?? "",
    estimate: (row["estimate"] as string) ?? "",
    files: parseTaskArray(row["files"]),
    verify: (row["verify"] as string) ?? "",
    inputs: parseTaskArray(row["inputs"]),
    expected_output: parseTaskArray(row["expected_output"]),
    observability_impact: (row["observability_impact"] as string) ?? "",
    full_plan_md: (row["full_plan_md"] as string) ?? "",
    sequence: (row["sequence"] as number) ?? 0,
    blocker_source: (row["blocker_source"] as string) ?? "",
    escalation_pending: (row["escalation_pending"] as number) ?? 0,
    escalation_awaiting_review: (row["escalation_awaiting_review"] as number) ?? 0,
    escalation_artifact_path: (row["escalation_artifact_path"] as string) ?? null,
    escalation_override_applied_at: (row["escalation_override_applied_at"] as string) ?? null,
  };
}

export function getTask(milestoneId: string, sliceId: string, taskId: string): TaskRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid",
  ).get({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  if (!row) return null;
  return rowToTask(row);
}

export function getSliceTasks(milestoneId: string, sliceId: string): TaskRow[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId, ":sid": sliceId });
  return rows.map(rowToTask);
}

// ─── ADR-011 Phase 2 escalation helpers ──────────────────────────────────

/** Set pause-on-escalation state on a completed task. Mutually exclusive with awaiting_review. */
export function setTaskEscalationPending(
  milestoneId: string, sliceId: string, taskId: string,
  artifactPath: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_pending = 1,
           escalation_awaiting_review = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

/** Set awaiting-review state (artifact exists but continueWithDefault=true, no pause). Mutually exclusive with pending. */
export function setTaskEscalationAwaitingReview(
  milestoneId: string, sliceId: string, taskId: string,
  artifactPath: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_awaiting_review = 1,
           escalation_pending = 0,
           escalation_artifact_path = :path
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":path": artifactPath, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

/** Clear escalation-pending and awaiting-review flags once the user has resolved it. */
export function clearTaskEscalationFlags(
  milestoneId: string, sliceId: string, taskId: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET escalation_pending = 0,
           escalation_awaiting_review = 0
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

/**
 * Atomically claim a resolved escalation override for injection into a downstream
 * task's prompt. Returns true if this caller claimed it (must inject), false if
 * another caller already claimed it (must skip).
 */
export function claimEscalationOverride(
  milestoneId: string, sliceId: string, sourceTaskId: string,
): boolean {
  if (!currentDb) return false;
  const now = new Date().toISOString();
  const result = currentDb.prepare(
    `UPDATE tasks
       SET escalation_override_applied_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid
       AND escalation_override_applied_at IS NULL
       AND escalation_artifact_path IS NOT NULL`,
  ).run({ ":now": now, ":mid": milestoneId, ":sid": sliceId, ":tid": sourceTaskId });
  // node:sqlite + better-sqlite3 both surface `changes` on the run result.
  const changes = (result as { changes?: number }).changes ?? 0;
  return changes > 0;
}

/** Find the most recent resolved-but-unapplied escalation override in a slice. */
export function findUnappliedEscalationOverride(
  milestoneId: string, sliceId: string,
): { taskId: string; artifactPath: string } | null {
  if (!currentDb) return null;
  // Filter BOTH flags: escalation_pending=0 AND escalation_awaiting_review=0
  // ensures we only claim overrides the user has explicitly resolved.
  // Without the awaiting_review filter, continueWithDefault=true artifacts
  // (not yet responded to) would be prematurely claimed, causing the override
  // to be lost when the user later resolves (#ADR-011 Phase 2 peer-review Bug 2).
  const row = currentDb.prepare(
    `SELECT id, escalation_artifact_path AS path
       FROM tasks
      WHERE milestone_id = :mid AND slice_id = :sid
        AND escalation_artifact_path IS NOT NULL
        AND escalation_override_applied_at IS NULL
        AND escalation_pending = 0
        AND escalation_awaiting_review = 0
      ORDER BY sequence DESC, id DESC
      LIMIT 1`,
  ).get({ ":mid": milestoneId, ":sid": sliceId }) as
    | { id: string; path: string | null }
    | undefined;
  if (!row || !row.path) return null;
  return { taskId: row.id, artifactPath: row.path };
}

/** Set the blocker_source provenance field (used when rejecting an escalation). */
export function setTaskBlockerSource(
  milestoneId: string, sliceId: string, taskId: string, source: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE tasks
       SET blocker_discovered = 1,
           blocker_source = :src
     WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
  ).run({ ":src": source, ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

/** List tasks with active escalation artifacts across a milestone (for /gsd escalate list). */
export function listEscalationArtifacts(milestoneId: string, includeResolved: boolean = false): TaskRow[] {
  if (!currentDb) return [];
  const filter = includeResolved
    ? "escalation_artifact_path IS NOT NULL"
    : "(escalation_pending = 1 OR escalation_awaiting_review = 1) AND escalation_artifact_path IS NOT NULL";
  const rows = currentDb.prepare(
    `SELECT * FROM tasks WHERE milestone_id = :mid AND ${filter} ORDER BY slice_id, sequence, id`,
  ).all({ ":mid": milestoneId });
  return rows.map(rowToTask);
}

export function insertVerificationEvidence(e: {
  taskId: string;
  sliceId: string;
  milestoneId: string;
  command: string;
  exitCode: number;
  verdict: string;
  durationMs: number;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
     VALUES (:task_id, :slice_id, :milestone_id, :command, :exit_code, :verdict, :duration_ms, :created_at)`,
  ).run({
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

export interface VerificationEvidenceRow {
  id: number;
  task_id: string;
  slice_id: string;
  milestone_id: string;
  command: string;
  exit_code: number;
  verdict: string;
  duration_ms: number;
  created_at: string;
}

export function getVerificationEvidence(milestoneId: string, sliceId: string, taskId: string): VerificationEvidenceRow[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare(
    "SELECT * FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid ORDER BY id",
  ).all({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  return rows as unknown as VerificationEvidenceRow[];
}

export interface MilestoneRow {
  id: string;
  title: string;
  status: string;
  depends_on: string[];
  created_at: string;
  completed_at: string | null;
  vision: string;
  success_criteria: string[];
  key_risks: Array<{ risk: string; whyItMatters: string }>;
  proof_strategy: Array<{ riskOrUnknown: string; retireIn: string; whatWillBeProven: string }>;
  verification_contract: string;
  verification_integration: string;
  verification_operational: string;
  verification_uat: string;
  definition_of_done: string[];
  requirement_coverage: string;
  boundary_map_markdown: string;
}

function rowToMilestone(row: Record<string, unknown>): MilestoneRow {
  return {
    id: row["id"] as string,
    title: row["title"] as string,
    status: row["status"] as string,
    depends_on: JSON.parse((row["depends_on"] as string) || "[]"),
    created_at: row["created_at"] as string,
    completed_at: (row["completed_at"] as string) ?? null,
    vision: (row["vision"] as string) ?? "",
    success_criteria: JSON.parse((row["success_criteria"] as string) || "[]"),
    key_risks: JSON.parse((row["key_risks"] as string) || "[]"),
    proof_strategy: JSON.parse((row["proof_strategy"] as string) || "[]"),
    verification_contract: (row["verification_contract"] as string) ?? "",
    verification_integration: (row["verification_integration"] as string) ?? "",
    verification_operational: (row["verification_operational"] as string) ?? "",
    verification_uat: (row["verification_uat"] as string) ?? "",
    definition_of_done: JSON.parse((row["definition_of_done"] as string) || "[]"),
    requirement_coverage: (row["requirement_coverage"] as string) ?? "",
    boundary_map_markdown: (row["boundary_map_markdown"] as string) ?? "",
  };
}

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

export function getAllMilestones(): MilestoneRow[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM milestones ORDER BY id").all();
  return rows.map(rowToMilestone);
}

export function getMilestone(id: string): MilestoneRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM milestones WHERE id = :id").get({ ":id": id });
  if (!row) return null;
  return rowToMilestone(row);
}

/**
 * Update a milestone's status in the database.
 * Used by park/unpark to keep the DB in sync with the filesystem marker.
 * See: https://github.com/gsd-build/gsd-2/issues/2694
 */
export function updateMilestoneStatus(milestoneId: string, status: string, completedAt?: string | null): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE milestones SET status = :status, completed_at = :completed_at WHERE id = :id`,
  ).run({ ":status": status, ":completed_at": completedAt ?? null, ":id": milestoneId });
}

export function getActiveMilestoneFromDb(): MilestoneRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM milestones WHERE status NOT IN ('complete', 'parked') ORDER BY id LIMIT 1",
  ).get();
  if (!row) return null;
  return rowToMilestone(row);
}

export function getActiveSliceFromDb(milestoneId: string): SliceRow | null {
  if (!currentDb) return null;

  // Single query: find the first non-complete slice whose dependencies are all satisfied.
  // Uses json_each() to expand the JSON depends array and checks each dep is complete.
  const row = currentDb.prepare(
    `SELECT s.* FROM slices s
     WHERE s.milestone_id = :mid
       AND s.status NOT IN ('complete', 'done', 'skipped')
       AND NOT EXISTS (
         SELECT 1 FROM json_each(s.depends) AS dep
         WHERE dep.value NOT IN (
           SELECT id FROM slices WHERE milestone_id = :mid AND status IN ('complete', 'done', 'skipped')
         )
       )
     ORDER BY s.sequence, s.id
     LIMIT 1`,
  ).get({ ":mid": milestoneId });
  if (!row) return null;
  return rowToSlice(row);
}

export function getActiveTaskFromDb(milestoneId: string, sliceId: string): TaskRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT * FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1",
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return rowToTask(row);
}

export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  if (!currentDb) return [];
  const rows = currentDb.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}

export function getArtifact(path: string): ArtifactRow | null {
  if (!currentDb) return null;
  const row = currentDb.prepare("SELECT * FROM artifacts WHERE path = :path").get({ ":path": path });
  if (!row) return null;
  return rowToArtifact(row);
}

// ─── Lightweight Query Variants (hot-path optimized) ─────────────────────

/** Fast milestone status check — avoids deserializing JSON planning fields. */
export function getActiveMilestoneIdFromDb(): { id: string; status: string } | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT id, status FROM milestones WHERE status NOT IN ('complete', 'parked') ORDER BY id LIMIT 1",
  ).get();
  if (!row) return null;
  return { id: row["id"] as string, status: row["status"] as string };
}

/** Fast slice status check — avoids deserializing JSON depends/planning fields. */
export function getSliceStatusSummary(milestoneId: string): Array<{ id: string; status: string }> {
  if (!currentDb) return [];
  return currentDb.prepare(
    "SELECT id, status FROM slices WHERE milestone_id = :mid ORDER BY sequence, id",
  ).all({ ":mid": milestoneId }).map((r) => ({ id: r["id"] as string, status: r["status"] as string }));
}

/** Fast task status check — avoids deserializing JSON arrays and large text fields. */
export function getActiveTaskIdFromDb(milestoneId: string, sliceId: string): { id: string; status: string; title: string } | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    "SELECT id, status, title FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND status NOT IN ('complete', 'done') ORDER BY sequence, id LIMIT 1",
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return null;
  return { id: row["id"] as string, status: row["status"] as string, title: row["title"] as string };
}

/** Count tasks by status for a slice — useful for progress reporting without full row load. */
export function getSliceTaskCounts(milestoneId: string, sliceId: string): { total: number; done: number; pending: number } {
  if (!currentDb) return { total: 0, done: 0, pending: 0 };
  const row = currentDb.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status IN ('complete', 'done') THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status NOT IN ('complete', 'done') THEN 1 ELSE 0 END) as pending
     FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  if (!row) return { total: 0, done: 0, pending: 0 };
  return { total: (row["total"] as number) ?? 0, done: (row["done"] as number) ?? 0, pending: (row["pending"] as number) ?? 0 };
}

// ─── Slice Dependencies (junction table) ─────────────────────────────────

/** Sync the slice_dependencies junction table from a slice's JSON depends array. */
export function syncSliceDependencies(milestoneId: string, sliceId: string, depends: string[]): void {
  if (!currentDb) return;
  currentDb.prepare(
    "DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid",
  ).run({ ":mid": milestoneId, ":sid": sliceId });
  for (const dep of depends) {
    currentDb.prepare(
      "INSERT OR IGNORE INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id) VALUES (:mid, :sid, :dep)",
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":dep": dep });
  }
}

/** Get all slices that depend on a given slice. */
export function getDependentSlices(milestoneId: string, sliceId: string): string[] {
  if (!currentDb) return [];
  return currentDb.prepare(
    "SELECT slice_id FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid",
  ).all({ ":mid": milestoneId, ":sid": sliceId }).map((r) => r["slice_id"] as string);
}

// ─── Worktree DB Helpers ──────────────────────────────────────────────────

export function copyWorktreeDb(srcDbPath: string, destDbPath: string): boolean {
  try {
    if (!existsSync(srcDbPath)) return false;
    const destDir = dirname(destDbPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(srcDbPath, destDbPath);
    return true;
  } catch (err) {
    logError("db", "failed to copy DB to worktree", { error: (err as Error).message });
    return false;
  }
}

export interface ReconcileResult {
  decisions: number;
  requirements: number;
  artifacts: number;
  milestones: number;
  slices: number;
  tasks: number;
  memories: number;
  verification_evidence: number;
  conflicts: string[];
}

export function reconcileWorktreeDb(
  mainDbPath: string,
  worktreeDbPath: string,
): ReconcileResult {
  const zero: ReconcileResult = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0, conflicts: [] };
  if (!existsSync(worktreeDbPath)) return zero;
  // Guard: bail when both paths resolve to the same physical file.
  // ATTACHing a WAL-mode DB to itself corrupts the WAL (#2823).
  try {
    if (realpathSync(mainDbPath) === realpathSync(worktreeDbPath)) return zero;
  } catch (e) { logWarning("db", `realpathSync failed: ${(e as Error).message}`); }
  // Sanitize path: reject any characters that could break ATTACH syntax.
  // ATTACH DATABASE doesn't support parameterized paths in all providers,
  // so we use strict allowlist validation instead.
  if (/['";\x00]/.test(worktreeDbPath)) {
    logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
    return zero;
  }
  if (!currentDb) {
    const opened = openDatabase(mainDbPath);
    if (!opened) {
      logError("db", "worktree DB reconciliation failed: cannot open main DB");
      return zero;
    }
  }
  const adapter = currentDb!;
  const conflicts: string[] = [];
  try {
    adapter.exec(`ATTACH DATABASE '${worktreeDbPath}' AS wt`);
    try {
      const wtInfo = adapter.prepare("PRAGMA wt.table_info('decisions')").all();
      const hasMadeBy = wtInfo.some((col) => col["name"] === "made_by");
      // ADR-011: worktree may predate schema v16/v17. For missing columns we
      // fall through to the main DB's existing value (not a literal default)
      // so reconcile never silently clears state the main tree has recorded.
      const hasDecisionSource = wtInfo.some((col) => col["name"] === "source");
      const wtSliceInfo = adapter.prepare("PRAGMA wt.table_info('slices')").all();
      const hasIsSketch = wtSliceInfo.some((col) => col["name"] === "is_sketch");
      const hasSketchScope = wtSliceInfo.some((col) => col["name"] === "sketch_scope");
      const wtTaskInfo = adapter.prepare("PRAGMA wt.table_info('tasks')").all();
      const hasBlockerSource = wtTaskInfo.some((col) => col["name"] === "blocker_source");
      const hasEscalationPending = wtTaskInfo.some((col) => col["name"] === "escalation_pending");
      const hasEscalationAwaiting = wtTaskInfo.some((col) => col["name"] === "escalation_awaiting_review");
      const hasEscalationArtifact = wtTaskInfo.some((col) => col["name"] === "escalation_artifact_path");
      const hasEscalationOverride = wtTaskInfo.some((col) => col["name"] === "escalation_override_applied_at");

      const decConf = adapter.prepare(
        `SELECT m.id FROM decisions m INNER JOIN wt.decisions w ON m.id = w.id WHERE m.decision != w.decision OR m.choice != w.choice OR m.rationale != w.rationale OR ${
          hasMadeBy ? "m.made_by != w.made_by" : "'agent' != 'agent'"
        } OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of decConf) conflicts.push(`decision ${(row as Record<string, unknown>)["id"]}: modified in both`);

      const reqConf = adapter.prepare(
        `SELECT m.id FROM requirements m INNER JOIN wt.requirements w ON m.id = w.id WHERE m.description != w.description OR m.status != w.status OR m.notes != w.notes OR m.superseded_by IS NOT w.superseded_by`,
      ).all();
      for (const row of reqConf) conflicts.push(`requirement ${(row as Record<string, unknown>)["id"]}: modified in both`);

      const merged: Omit<ReconcileResult, "conflicts"> = { decisions: 0, requirements: 0, artifacts: 0, milestones: 0, slices: 0, tasks: 0, memories: 0, verification_evidence: 0 };

      function countChanges(result: unknown): number {
        return typeof result === "object" && result !== null ? ((result as { changes?: number }).changes ?? 0) : 0;
      }

      adapter.exec("BEGIN");
      try {
        // Join the target decisions so we can prefer an existing main.source
        // when the worktree predates v16 — otherwise a write-through reconcile
        // would clobber 'escalation'-sourced decisions with the literal default.
        merged.decisions = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO decisions (
            id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by
          )
          SELECT w.id, w.when_context, w.scope, w.decision, w.choice, w.rationale, w.revisable, ${
            hasMadeBy ? "w.made_by" : "COALESCE(m.made_by, 'agent')"
          }, ${
            hasDecisionSource ? "w.source" : "COALESCE(m.source, 'discussion')"
          }, w.superseded_by
          FROM wt.decisions w
          LEFT JOIN decisions m ON m.id = w.id
        `).run());

        merged.requirements = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO requirements (
            id, class, status, description, why, source, primary_owner,
            supporting_slices, validation, notes, full_content, superseded_by
          )
          SELECT id, class, status, description, why, source, primary_owner,
                 supporting_slices, validation, notes, full_content, superseded_by
          FROM wt.requirements
        `).run());

        merged.artifacts = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO artifacts (
            path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          )
          SELECT path, artifact_type, milestone_id, slice_id, task_id, full_content, imported_at
          FROM wt.artifacts
        `).run());

        // Merge milestones — worktree may have updated status/planning fields.
        // Never downgrade status: complete > active > pre-planning (#4372).
        // A stale worktree may carry an older 'active' status for a milestone
        // that the main DB has already marked 'complete'; preserve the higher status.
        merged.milestones = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO milestones (
            id, title, status, depends_on, created_at, completed_at,
            vision, success_criteria, key_risks, proof_strategy,
            verification_contract, verification_integration, verification_operational, verification_uat,
            definition_of_done, requirement_coverage, boundary_map_markdown
          )
          SELECT w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.depends_on,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.created_at ELSE w.created_at
                 END,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.vision, w.success_criteria, w.key_risks, w.proof_strategy,
                 w.verification_contract, w.verification_integration, w.verification_operational, w.verification_uat,
                 w.definition_of_done, w.requirement_coverage, w.boundary_map_markdown
          FROM wt.milestones w
          LEFT JOIN milestones m ON m.id = w.id
        `).run());

        // Merge slices — preserve worktree progress but never downgrade completed status (#2558).
        // ADR-011 Phase 1: carry is_sketch + sketch_scope so reconcile doesn't
        // silently clear sketch metadata. When the worktree predates v16,
        // fall back to the main DB's existing value rather than a literal 0/''.
        merged.slices = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO slices (
            milestone_id, id, title, status, risk, depends, demo, created_at, completed_at,
            full_summary_md, full_uat_md, goal, success_criteria, proof_level,
            integration_closure, observability_impact, sequence, replan_triggered_at,
            is_sketch, sketch_scope
          )
          SELECT w.milestone_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.risk, w.depends, w.demo, w.created_at,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.full_summary_md, w.full_uat_md, w.goal, w.success_criteria, w.proof_level,
                 w.integration_closure, w.observability_impact, w.sequence, w.replan_triggered_at,
                 ${hasIsSketch ? "w.is_sketch" : "COALESCE(m.is_sketch, 0)"},
                 ${hasSketchScope ? "w.sketch_scope" : "COALESCE(m.sketch_scope, '')"}
          FROM wt.slices w
          LEFT JOIN slices m ON m.milestone_id = w.milestone_id AND m.id = w.id
        `).run());

        // Merge tasks — preserve execution results, never downgrade completed status (#2558).
        // ADR-011 P2: carry blocker_source + escalation_* columns so worktree reconcile
        // doesn't silently clear escalation state back to defaults.
        merged.tasks = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO tasks (
            milestone_id, slice_id, id, title, status, one_liner, narrative,
            verification_result, duration, completed_at, blocker_discovered,
            deviations, known_issues, key_files, key_decisions, full_summary_md,
            description, estimate, files, verify, inputs, expected_output,
            observability_impact, full_plan_md, sequence,
            blocker_source, escalation_pending, escalation_awaiting_review,
            escalation_artifact_path, escalation_override_applied_at
          )
          SELECT w.milestone_id, w.slice_id, w.id, w.title,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.status ELSE w.status
                 END,
                 w.one_liner, w.narrative,
                 w.verification_result, w.duration,
                 CASE
                   WHEN m.status IN ('complete', 'done') AND w.status NOT IN ('complete', 'done')
                   THEN m.completed_at ELSE w.completed_at
                 END,
                 w.blocker_discovered,
                 w.deviations, w.known_issues, w.key_files, w.key_decisions, w.full_summary_md,
                 w.description, w.estimate, w.files, w.verify, w.inputs, w.expected_output,
                 w.observability_impact, w.full_plan_md, w.sequence,
                 ${hasBlockerSource ? "w.blocker_source" : "COALESCE(m.blocker_source, '')"},
                 ${hasEscalationPending ? "w.escalation_pending" : "COALESCE(m.escalation_pending, 0)"},
                 ${hasEscalationAwaiting ? "w.escalation_awaiting_review" : "COALESCE(m.escalation_awaiting_review, 0)"},
                 ${hasEscalationArtifact ? "w.escalation_artifact_path" : "m.escalation_artifact_path"},
                 ${hasEscalationOverride ? "w.escalation_override_applied_at" : "m.escalation_override_applied_at"}
          FROM wt.tasks w
          LEFT JOIN tasks m ON m.milestone_id = w.milestone_id AND m.slice_id = w.slice_id AND m.id = w.id
        `).run());

        // Merge memories — keep worktree-learned insights
        merged.memories = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO memories (
            seq, id, category, content, confidence, source_unit_type, source_unit_id,
            created_at, updated_at, superseded_by, hit_count
          )
          SELECT seq, id, category, content, confidence, source_unit_type, source_unit_id,
                 created_at, updated_at, superseded_by, hit_count
          FROM wt.memories
        `).run());

        // Merge verification evidence — append-only, use INSERT OR IGNORE to avoid duplicates
        merged.verification_evidence = countChanges(adapter.prepare(`
          INSERT OR IGNORE INTO verification_evidence (
            task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          )
          SELECT task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at
          FROM wt.verification_evidence
        `).run());

        adapter.exec("COMMIT");
      } catch (txErr) {
        try { adapter.exec("ROLLBACK"); } catch (e) { logWarning("db", `rollback failed: ${(e as Error).message}`); }
        throw txErr;
      }
      return { ...merged, conflicts };
    } finally {
      try { adapter.exec("DETACH DATABASE wt"); } catch (e) { logWarning("db", `detach worktree DB failed: ${(e as Error).message}`); }
    }
  } catch (err) {
    logError("db", "worktree DB reconciliation failed", { error: (err as Error).message });
    return { ...zero, conflicts };
  }
}

// ─── Replan & Assessment Helpers ──────────────────────────────────────────

export function insertReplanHistory(entry: {
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  summary: string;
  previousArtifactPath?: string | null;
  replacementArtifactPath?: string | null;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  // INSERT OR REPLACE: idempotent on (milestone_id, slice_id, task_id) via schema v11 unique index.
  // Retrying the same replan silently updates summary instead of accumulating duplicate rows.
  currentDb.prepare(
    `INSERT OR REPLACE INTO replan_history (milestone_id, slice_id, task_id, summary, previous_artifact_path, replacement_artifact_path, created_at)
     VALUES (:milestone_id, :slice_id, :task_id, :summary, :previous_artifact_path, :replacement_artifact_path, :created_at)`,
  ).run({
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":summary": entry.summary,
    ":previous_artifact_path": entry.previousArtifactPath ?? null,
    ":replacement_artifact_path": entry.replacementArtifactPath ?? null,
    ":created_at": new Date().toISOString(),
  });
}

export function insertAssessment(entry: {
  path: string;
  milestoneId: string;
  sliceId?: string | null;
  taskId?: string | null;
  status: string;
  scope: string;
  fullContent: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO assessments (path, milestone_id, slice_id, task_id, status, scope, full_content, created_at)
     VALUES (:path, :milestone_id, :slice_id, :task_id, :status, :scope, :full_content, :created_at)`,
  ).run({
    ":path": entry.path,
    ":milestone_id": entry.milestoneId,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":status": entry.status,
    ":scope": entry.scope,
    ":full_content": entry.fullContent,
    ":created_at": new Date().toISOString(),
  });
}

export function deleteAssessmentByScope(milestoneId: string, scope: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `DELETE FROM assessments WHERE milestone_id = :mid AND scope = :scope`,
  ).run({ ":mid": milestoneId, ":scope": scope });
}

export function deleteVerificationEvidence(milestoneId: string, sliceId: string, taskId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
  ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
}

export function deleteTask(milestoneId: string, sliceId: string, taskId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    // Must delete verification_evidence first (FK constraint)
    currentDb!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid AND task_id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
    currentDb!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": taskId });
  });
}

export function deleteSlice(milestoneId: string, sliceId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    // Cascade-style manual deletion: evidence → tasks → dependencies → slice
    currentDb!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid AND depends_on_slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    currentDb!.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}

export function deleteMilestone(milestoneId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb!.prepare(
      `DELETE FROM verification_evidence WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM quality_gates WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM gate_runs WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM tasks WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM slice_dependencies WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM slices WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM replan_history WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM assessments WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM artifacts WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    currentDb!.prepare(
      `DELETE FROM milestones WHERE id = :mid`,
    ).run({ ":mid": milestoneId });
  });
}

export function updateSliceFields(milestoneId: string, sliceId: string, fields: {
  title?: string;
  risk?: string;
  depends?: string[];
  demo?: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE slices SET
      title = COALESCE(:title, title),
      risk = COALESCE(:risk, risk),
      depends = COALESCE(:depends, depends),
      demo = COALESCE(:demo, demo)
     WHERE milestone_id = :milestone_id AND id = :id`,
  ).run({
    ":milestone_id": milestoneId,
    ":id": sliceId,
    ":title": fields.title ?? null,
    ":risk": fields.risk ?? null,
    ":depends": fields.depends ? JSON.stringify(fields.depends) : null,
    ":demo": fields.demo ?? null,
  });
}

export function getReplanHistory(milestoneId: string, sliceId?: string): Array<Record<string, unknown>> {
  if (!currentDb) return [];
  if (sliceId) {
    return currentDb.prepare(
      `SELECT * FROM replan_history WHERE milestone_id = :mid AND slice_id = :sid ORDER BY created_at DESC`,
    ).all({ ":mid": milestoneId, ":sid": sliceId });
  }
  return currentDb.prepare(
    `SELECT * FROM replan_history WHERE milestone_id = :mid ORDER BY created_at DESC`,
  ).all({ ":mid": milestoneId });
}

export function getAssessment(path: string): Record<string, unknown> | null {
  if (!currentDb) return null;
  const row = currentDb.prepare(
    `SELECT * FROM assessments WHERE path = :path`,
  ).get({ ":path": path });
  return row ?? null;
}

// ─── Quality Gates ───────────────────────────────────────────────────────

function rowToGate(row: Record<string, unknown>): GateRow {
  return {
    milestone_id: row["milestone_id"] as string,
    slice_id: row["slice_id"] as string,
    gate_id: row["gate_id"] as GateId,
    scope: row["scope"] as GateScope,
    task_id: (row["task_id"] as string) ?? "",
    status: row["status"] as GateStatus,
    verdict: (row["verdict"] as GateVerdict) || "",
    rationale: (row["rationale"] as string) || "",
    findings: (row["findings"] as string) || "",
    evaluated_at: (row["evaluated_at"] as string) ?? null,
  };
}

export function insertGateRow(g: {
  milestoneId: string;
  sliceId: string;
  gateId: GateId;
  scope: GateScope;
  taskId?: string | null;
  status?: GateStatus;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status)`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId ?? "",
    ":status": g.status ?? "pending",
  });
}

export function saveGateResult(g: {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  taskId?: string | null;
  verdict: GateVerdict;
  rationale: string;
  findings: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE quality_gates
     SET status = 'complete', verdict = :verdict, rationale = :rationale,
         findings = :findings, evaluated_at = :evaluated_at
     WHERE milestone_id = :mid AND slice_id = :sid AND gate_id = :gid
       AND task_id = :tid`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":tid": g.taskId ?? "",
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": new Date().toISOString(),
  });

  const outcome =
    g.verdict === "pass"
      ? "pass"
      : g.verdict === "omitted"
        ? "manual-attention"
        : "fail";
  insertGateRun({
    traceId: `quality-gate:${g.milestoneId}:${g.sliceId}`,
    turnId: `gate:${g.gateId}:${g.taskId ?? "slice"}`,
    gateId: g.gateId,
    gateType: "quality-gate",
    milestoneId: g.milestoneId,
    sliceId: g.sliceId,
    taskId: g.taskId ?? undefined,
    outcome,
    failureClass: outcome === "fail" ? "verification" : outcome === "manual-attention" ? "manual-attention" : "none",
    rationale: g.rationale,
    findings: g.findings,
    attempt: 1,
    maxAttempts: 1,
    retryable: false,
    evaluatedAt: new Date().toISOString(),
  });
}

export function getPendingGates(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!currentDb) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope AND status = 'pending'`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return currentDb.prepare(sql).all(params).map(rowToGate);
}

export function getGateResults(milestoneId: string, sliceId: string, scope?: GateScope): GateRow[] {
  if (!currentDb) return [];
  const sql = scope
    ? `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid AND scope = :scope`
    : `SELECT * FROM quality_gates WHERE milestone_id = :mid AND slice_id = :sid`;
  const params: Record<string, unknown> = { ":mid": milestoneId, ":sid": sliceId };
  if (scope) params[":scope"] = scope;
  return currentDb.prepare(sql).all(params).map(rowToGate);
}

export function markAllGatesOmitted(milestoneId: string, sliceId: string): void {
  if (!currentDb) return;
  currentDb.prepare(
    `UPDATE quality_gates SET status = 'omitted', verdict = 'omitted', evaluated_at = :now
     WHERE milestone_id = :mid AND slice_id = :sid AND status = 'pending'`,
  ).run({
    ":mid": milestoneId,
    ":sid": sliceId,
    ":now": new Date().toISOString(),
  });
}

export function getPendingSliceGateCount(milestoneId: string, sliceId: string): number {
  if (!currentDb) return 0;
  const row = currentDb.prepare(
    `SELECT COUNT(*) as cnt FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid AND scope = 'slice' AND status = 'pending'`,
  ).get({ ":mid": milestoneId, ":sid": sliceId });
  return row ? (row["cnt"] as number) : 0;
}

/**
 * Return pending gate rows owned by a specific workflow turn.
 *
 * Unlike `getPendingGates(..., scope)`, this filters by the registry's
 * `ownerTurn` metadata so callers can distinguish Q3/Q4 (owned by
 * gate-evaluate) from Q8 (owned by complete-slice) even though both are
 * scope:"slice". Pass `taskId` to narrow task-scoped results to one task.
 */
export function getPendingGatesForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
  taskId?: string,
): GateRow[] {
  if (!currentDb) return [];
  const ids = getGateIdsForTurn(turn);
  if (ids.size === 0) return [];
  const idList = [...ids];
  const placeholders = idList.map((_, i) => `:gid${i}`).join(",");
  const params: Record<string, unknown> = {
    ":mid": milestoneId,
    ":sid": sliceId,
  };
  idList.forEach((id, i) => {
    params[`:gid${i}`] = id;
  });
  let sql =
    `SELECT * FROM quality_gates
     WHERE milestone_id = :mid AND slice_id = :sid
       AND status = 'pending'
       AND gate_id IN (${placeholders})`;
  if (taskId !== undefined) {
    sql += ` AND task_id = :tid`;
    params[":tid"] = taskId;
  }
  return currentDb.prepare(sql).all(params).map(rowToGate);
}

/**
 * Count pending gates for a turn. Convenience wrapper used by state
 * derivation to decide whether a phase transition should pause.
 */
export function getPendingGateCountForTurn(
  milestoneId: string,
  sliceId: string,
  turn: OwnerTurn,
): number {
  return getPendingGatesForTurn(milestoneId, sliceId, turn).length;
}

export function insertGateRun(entry: {
  traceId: string;
  turnId: string;
  gateId: string;
  gateType: string;
  unitType?: string;
  unitId?: string;
  milestoneId?: string;
  sliceId?: string;
  taskId?: string;
  outcome: "pass" | "fail" | "retry" | "manual-attention";
  failureClass: "none" | "policy" | "input" | "execution" | "artifact" | "verification" | "closeout" | "git" | "timeout" | "manual-attention" | "unknown";
  rationale?: string;
  findings?: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  evaluatedAt: string;
}): void {
  if (!currentDb) return;
  currentDb.prepare(
    `INSERT INTO gate_runs (
      trace_id, turn_id, gate_id, gate_type, unit_type, unit_id, milestone_id, slice_id, task_id,
      outcome, failure_class, rationale, findings, attempt, max_attempts, retryable, evaluated_at
    ) VALUES (
      :trace_id, :turn_id, :gate_id, :gate_type, :unit_type, :unit_id, :milestone_id, :slice_id, :task_id,
      :outcome, :failure_class, :rationale, :findings, :attempt, :max_attempts, :retryable, :evaluated_at
    )`,
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":gate_id": entry.gateId,
    ":gate_type": entry.gateType,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":milestone_id": entry.milestoneId ?? null,
    ":slice_id": entry.sliceId ?? null,
    ":task_id": entry.taskId ?? null,
    ":outcome": entry.outcome,
    ":failure_class": entry.failureClass,
    ":rationale": entry.rationale ?? "",
    ":findings": entry.findings ?? "",
    ":attempt": entry.attempt,
    ":max_attempts": entry.maxAttempts,
    ":retryable": entry.retryable ? 1 : 0,
    ":evaluated_at": entry.evaluatedAt,
  });
}

export function upsertTurnGitTransaction(entry: {
  traceId: string;
  turnId: string;
  unitType?: string;
  unitId?: string;
  stage: string;
  action: "commit" | "snapshot" | "status-only";
  push: boolean;
  status: "ok" | "failed";
  error?: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}): void {
  if (!currentDb) return;
  currentDb.prepare(
    `INSERT OR REPLACE INTO turn_git_transactions (
      trace_id, turn_id, unit_type, unit_id, stage, action, push, status, error, metadata_json, updated_at
    ) VALUES (
      :trace_id, :turn_id, :unit_type, :unit_id, :stage, :action, :push, :status, :error, :metadata_json, :updated_at
    )`,
  ).run({
    ":trace_id": entry.traceId,
    ":turn_id": entry.turnId,
    ":unit_type": entry.unitType ?? null,
    ":unit_id": entry.unitId ?? null,
    ":stage": entry.stage,
    ":action": entry.action,
    ":push": entry.push ? 1 : 0,
    ":status": entry.status,
    ":error": entry.error ?? null,
    ":metadata_json": JSON.stringify(entry.metadata ?? {}),
    ":updated_at": entry.updatedAt,
  });
}

export function insertAuditEvent(entry: {
  eventId: string;
  traceId: string;
  turnId?: string;
  causedBy?: string;
  category: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}): void {
  if (!currentDb) return;
  transaction(() => {
    currentDb!.prepare(
      `INSERT OR IGNORE INTO audit_events (
        event_id, trace_id, turn_id, caused_by, category, type, ts, payload_json
      ) VALUES (
        :event_id, :trace_id, :turn_id, :caused_by, :category, :type, :ts, :payload_json
      )`,
    ).run({
      ":event_id": entry.eventId,
      ":trace_id": entry.traceId,
      ":turn_id": entry.turnId ?? null,
      ":caused_by": entry.causedBy ?? null,
      ":category": entry.category,
      ":type": entry.type,
      ":ts": entry.ts,
      ":payload_json": JSON.stringify(entry.payload ?? {}),
    });

    if (entry.turnId) {
      const row = currentDb!.prepare(
        `SELECT event_count, first_ts, last_ts
         FROM audit_turn_index
         WHERE trace_id = :trace_id AND turn_id = :turn_id`,
      ).get({
        ":trace_id": entry.traceId,
        ":turn_id": entry.turnId,
      });
      if (row) {
        currentDb!.prepare(
          `UPDATE audit_turn_index
           SET first_ts = CASE WHEN :ts < first_ts THEN :ts ELSE first_ts END,
               last_ts = CASE WHEN :ts > last_ts THEN :ts ELSE last_ts END,
               event_count = event_count + 1
           WHERE trace_id = :trace_id AND turn_id = :turn_id`,
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":ts": entry.ts,
        });
      } else {
        currentDb!.prepare(
          `INSERT INTO audit_turn_index (trace_id, turn_id, first_ts, last_ts, event_count)
           VALUES (:trace_id, :turn_id, :first_ts, :last_ts, :event_count)`,
        ).run({
          ":trace_id": entry.traceId,
          ":turn_id": entry.turnId,
          ":first_ts": entry.ts,
          ":last_ts": entry.ts,
          ":event_count": 1,
        });
      }
    }
  });
}

// ─── Single-writer bypass wrappers ───────────────────────────────────────
// These wrappers exist so modules outside this file never need to call
// `_getAdapter()` for writes. Each one is a byte-equivalent replacement for
// a raw prepare/run previously issued from another module. Keep them
// minimal and direct — they exist to hold SQL text in one place, not to
// add new behavior.

/** Delete a decision row by id. Used by db-writer.ts rollback on disk-write failure. */
export function deleteDecisionById(id: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM decisions WHERE id = :id").run({ ":id": id });
}

/** Delete a requirement row by id. Used by db-writer.ts rollback on disk-write failure. */
export function deleteRequirementById(id: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM requirements WHERE id = :id").run({ ":id": id });
}

/** Delete an artifact row by path. Used by db-writer.ts rollback on disk-write failure. */
export function deleteArtifactByPath(path: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("DELETE FROM artifacts WHERE path = :path").run({ ":path": path });
}

/**
 * Drop all rows from tasks/slices/milestones in dependency order inside a
 * transaction. Used by `gsd recover` to rebuild engine state from markdown.
 */
export function clearEngineHierarchy(): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    currentDb!.exec("DELETE FROM tasks");
    currentDb!.exec("DELETE FROM slices");
    currentDb!.exec("DELETE FROM milestones");
  });
}

/**
 * INSERT OR IGNORE a slice during event replay (workflow-reconcile.ts).
 * Strict insert-or-ignore semantics are required here to avoid the
 * `insertSlice` ON CONFLICT path that could downgrade an already-completed
 * slice back to 'pending'.
 */
export function insertOrIgnoreSlice(args: {
  milestoneId: string;
  sliceId: string;
  title: string;
  createdAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO slices (milestone_id, id, title, status, created_at)
     VALUES (:mid, :sid, :title, 'pending', :ts)`,
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":title": args.title,
    ":ts": args.createdAt,
  });
}

/**
 * INSERT OR IGNORE a task during event replay (workflow-reconcile.ts).
 * Same rationale as `insertOrIgnoreSlice`.
 */
export function insertOrIgnoreTask(args: {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title: string;
  createdAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO tasks (milestone_id, slice_id, id, title, status, created_at)
     VALUES (:mid, :sid, :tid, :title, 'pending', :ts)`,
  ).run({
    ":mid": args.milestoneId,
    ":sid": args.sliceId,
    ":tid": args.taskId,
    ":title": args.title,
    ":ts": args.createdAt,
  });
}

/**
 * Stamp the `replan_triggered_at` column on a slice. Used by triage-resolution
 * when a user capture requests a replan so the dispatcher can detect the
 * trigger via DB in addition to the on-disk REPLAN-TRIGGER.md marker.
 */
export function setSliceReplanTriggeredAt(milestoneId: string, sliceId: string, ts: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE slices SET replan_triggered_at = :ts WHERE milestone_id = :mid AND id = :sid",
  ).run({ ":ts": ts, ":mid": milestoneId, ":sid": sliceId });
}

/**
 * INSERT OR REPLACE a quality_gates row. Used by milestone-validation-gates.ts
 * to persist milestone-level (MV*) gate outcomes after validate-milestone runs.
 */
export function upsertQualityGate(g: {
  milestoneId: string;
  sliceId: string;
  gateId: string;
  scope: string;
  taskId: string;
  status: string;
  verdict: string;
  rationale: string;
  findings: string;
  evaluatedAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO quality_gates
     (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
     VALUES (:mid, :sid, :gid, :scope, :tid, :status, :verdict, :rationale, :findings, :evaluated_at)`,
  ).run({
    ":mid": g.milestoneId,
    ":sid": g.sliceId,
    ":gid": g.gateId,
    ":scope": g.scope,
    ":tid": g.taskId,
    ":status": g.status,
    ":verdict": g.verdict,
    ":rationale": g.rationale,
    ":findings": g.findings,
    ":evaluated_at": g.evaluatedAt,
  });
}

/**
 * Atomically replace all workflow state from a manifest. Lifted verbatim from
 * workflow-manifest.ts so the single-writer invariant holds. Only touches
 * engine tables + decisions. Does NOT modify artifacts or memories.
 */
export function restoreManifest(manifest: StateManifest): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = currentDb;

  transaction(() => {
    // Clear engine tables (order matters for foreign-key-like consistency)
    db.exec("DELETE FROM verification_evidence");
    db.exec("DELETE FROM tasks");
    db.exec("DELETE FROM slices");
    db.exec("DELETE FROM milestones");
    db.exec("DELETE FROM decisions WHERE 1=1");

    // Restore milestones
    const msStmt = db.prepare(
      `INSERT INTO milestones (id, title, status, depends_on, created_at, completed_at,
        vision, success_criteria, key_risks, proof_strategy,
        verification_contract, verification_integration, verification_operational, verification_uat,
        definition_of_done, requirement_coverage, boundary_map_markdown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of manifest.milestones) {
      msStmt.run(
        m.id, m.title, m.status,
        JSON.stringify(m.depends_on), m.created_at, m.completed_at,
        m.vision, JSON.stringify(m.success_criteria), JSON.stringify(m.key_risks),
        JSON.stringify(m.proof_strategy),
        m.verification_contract, m.verification_integration, m.verification_operational, m.verification_uat,
        JSON.stringify(m.definition_of_done), m.requirement_coverage, m.boundary_map_markdown,
      );
    }

    // Restore slices (ADR-011 Phase 1: includes is_sketch + sketch_scope)
    const slStmt = db.prepare(
      `INSERT INTO slices (milestone_id, id, title, status, risk, depends, demo,
        created_at, completed_at, full_summary_md, full_uat_md,
        goal, success_criteria, proof_level, integration_closure, observability_impact,
        sequence, replan_triggered_at, is_sketch, sketch_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of manifest.slices) {
      slStmt.run(
        s.milestone_id, s.id, s.title, s.status, s.risk,
        JSON.stringify(s.depends), s.demo,
        s.created_at, s.completed_at, s.full_summary_md, s.full_uat_md,
        s.goal, s.success_criteria, s.proof_level, s.integration_closure, s.observability_impact,
        s.sequence, s.replan_triggered_at,
        s.is_sketch ?? 0,
        s.sketch_scope ?? "",
      );
    }

    // Restore tasks (ADR-011 P2: includes blocker_source + escalation_* columns)
    const tkStmt = db.prepare(
      `INSERT INTO tasks (milestone_id, slice_id, id, title, status,
        one_liner, narrative, verification_result, duration, completed_at,
        blocker_discovered, deviations, known_issues, key_files, key_decisions,
        full_summary_md, description, estimate, files, verify,
        inputs, expected_output, observability_impact, sequence,
        blocker_source, escalation_pending, escalation_awaiting_review,
        escalation_artifact_path, escalation_override_applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of manifest.tasks) {
      tkStmt.run(
        t.milestone_id, t.slice_id, t.id, t.title, t.status,
        t.one_liner, t.narrative, t.verification_result, t.duration, t.completed_at,
        t.blocker_discovered ? 1 : 0, t.deviations, t.known_issues,
        JSON.stringify(t.key_files), JSON.stringify(t.key_decisions),
        t.full_summary_md, t.description, t.estimate, JSON.stringify(t.files), t.verify,
        JSON.stringify(t.inputs), JSON.stringify(t.expected_output),
        t.observability_impact, t.sequence,
        t.blocker_source ?? "",
        t.escalation_pending ?? 0,
        t.escalation_awaiting_review ?? 0,
        t.escalation_artifact_path ?? null,
        t.escalation_override_applied_at ?? null,
      );
    }

    // Restore decisions (ADR-011 P2: include source so escalation decisions survive)
    const dcStmt = db.prepare(
      `INSERT INTO decisions (seq, id, when_context, scope, decision, choice, rationale, revisable, made_by, source, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of manifest.decisions) {
      dcStmt.run(d.seq, d.id, d.when_context, d.scope, d.decision, d.choice, d.rationale, d.revisable, d.made_by, d.source ?? "discussion", d.superseded_by);
    }

    // Restore verification evidence
    const evStmt = db.prepare(
      `INSERT INTO verification_evidence (task_id, slice_id, milestone_id, command, exit_code, verdict, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of manifest.verification_evidence) {
      evStmt.run(e.task_id, e.slice_id, e.milestone_id, e.command, e.exit_code, e.verdict, e.duration_ms, e.created_at);
    }
  });
}

// ─── Legacy markdown → DB bulk migration ─────────────────────────────────

export interface LegacyMilestoneInsert {
  id: string;
  title: string;
  status: string;
}

export interface LegacySliceInsert {
  id: string;
  milestoneId: string;
  title: string;
  status: string;
  risk: string;
  sequence: number;
}

export interface LegacyTaskInsert {
  id: string;
  sliceId: string;
  milestoneId: string;
  title: string;
  status: string;
  sequence: number;
}

/**
 * Bulk delete + insert a legacy milestone hierarchy for markdown → DB migration.
 * Used by workflow-migration.ts to populate engine tables from parsed ROADMAP/PLAN
 * files. All operations run inside a single transaction.
 */
export function bulkInsertLegacyHierarchy(payload: {
  milestones: LegacyMilestoneInsert[];
  slices: LegacySliceInsert[];
  tasks: LegacyTaskInsert[];
  clearMilestoneIds: string[];
  createdAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const db = currentDb;
  const { milestones, slices, tasks, clearMilestoneIds, createdAt } = payload;

  if (clearMilestoneIds.length === 0) return;
  const placeholders = clearMilestoneIds.map(() => "?").join(",");

  transaction(() => {
    db.prepare(`DELETE FROM tasks WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM slices WHERE milestone_id IN (${placeholders})`).run(...clearMilestoneIds);
    db.prepare(`DELETE FROM milestones WHERE id IN (${placeholders})`).run(...clearMilestoneIds);

    const insertMilestone = db.prepare(
      "INSERT INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const m of milestones) {
      insertMilestone.run(m.id, m.title, m.status, createdAt);
    }

    const insertSliceStmt = db.prepare(
      "INSERT INTO slices (id, milestone_id, title, status, risk, depends, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of slices) {
      insertSliceStmt.run(s.id, s.milestoneId, s.title, s.status, s.risk, "[]", s.sequence, createdAt);
    }

    const insertTaskStmt = db.prepare(
      "INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const t of tasks) {
      insertTaskStmt.run(t.id, t.sliceId, t.milestoneId, t.title, "", t.status, "", "[]", t.sequence);
    }
  });
}

// ─── Memory store writers ────────────────────────────────────────────────
// All memory writes go through gsd-db.ts so the single-writer invariant
// holds. These are direct pass-throughs to the SQL previously in
// memory-store.ts — same bindings, same behavior.

export function insertMemoryRow(args: {
  id: string;
  category: string;
  content: string;
  confidence: number;
  sourceUnitType: string | null;
  sourceUnitId: string | null;
  createdAt: string;
  updatedAt: string;
  scope?: string;
  tags?: string[];
  /**
   * ADR-013 Step 2: optional structured payload preserved alongside the flat
   * `content` field. Used to retain gsd_save_decision-style fields (scope,
   * decision, choice, rationale, made_by, revisable) on architecture-category
   * memories so the cutover in Step 6 is lossless. Schema is intentionally
   * open inside the JSON; documented per category in ADR-013.
   */
  structuredFields?: Record<string, unknown> | null;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO memories (id, category, content, confidence, source_unit_type, source_unit_id, created_at, updated_at, scope, tags, structured_fields)
     VALUES (:id, :category, :content, :confidence, :source_unit_type, :source_unit_id, :created_at, :updated_at, :scope, :tags, :structured_fields)`,
  ).run({
    ":id": args.id,
    ":category": args.category,
    ":content": args.content,
    ":confidence": args.confidence,
    ":source_unit_type": args.sourceUnitType,
    ":source_unit_id": args.sourceUnitId,
    ":created_at": args.createdAt,
    ":updated_at": args.updatedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? []),
    ":structured_fields": args.structuredFields == null ? null : JSON.stringify(args.structuredFields),
  });
}

export function insertMemorySourceRow(args: {
  id: string;
  kind: string;
  uri: string | null;
  title: string | null;
  content: string;
  contentHash: string;
  importedAt: string;
  scope?: string;
  tags?: string[];
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO memory_sources (id, kind, uri, title, content, content_hash, imported_at, scope, tags)
     VALUES (:id, :kind, :uri, :title, :content, :content_hash, :imported_at, :scope, :tags)`,
  ).run({
    ":id": args.id,
    ":kind": args.kind,
    ":uri": args.uri,
    ":title": args.title,
    ":content": args.content,
    ":content_hash": args.contentHash,
    ":imported_at": args.importedAt,
    ":scope": args.scope ?? "project",
    ":tags": JSON.stringify(args.tags ?? []),
  });
}

export function deleteMemorySourceRow(id: string): boolean {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const res = currentDb
    .prepare("DELETE FROM memory_sources WHERE id = :id")
    .run({ ":id": id }) as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

export function upsertMemoryEmbedding(args: {
  memoryId: string;
  model: string;
  dim: number;
  vector: Uint8Array;
  updatedAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO memory_embeddings (memory_id, model, dim, vector, updated_at)
     VALUES (:memory_id, :model, :dim, :vector, :updated_at)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model,
       dim = excluded.dim,
       vector = excluded.vector,
       updated_at = excluded.updated_at`,
  ).run({
    ":memory_id": args.memoryId,
    ":model": args.model,
    ":dim": args.dim,
    ":vector": args.vector,
    ":updated_at": args.updatedAt,
  });
}

export function deleteMemoryEmbedding(memoryId: string): boolean {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  const res = currentDb
    .prepare("DELETE FROM memory_embeddings WHERE memory_id = :id")
    .run({ ":id": memoryId }) as { changes?: number };
  return (res?.changes ?? 0) > 0;
}

export function insertMemoryRelationRow(args: {
  fromId: string;
  toId: string;
  rel: string;
  confidence: number;
  createdAt: string;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, confidence, created_at)
     VALUES (:from_id, :to_id, :rel, :confidence, :created_at)`,
  ).run({
    ":from_id": args.fromId,
    ":to_id": args.toId,
    ":rel": args.rel,
    ":confidence": args.confidence,
    ":created_at": args.createdAt,
  });
}

export function deleteMemoryRelationsFor(memoryId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb
    .prepare("DELETE FROM memory_relations WHERE from_id = :id OR to_id = :id")
    .run({ ":id": memoryId });
}

export function rewriteMemoryId(placeholderId: string, realId: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare("UPDATE memories SET id = :real_id WHERE id = :placeholder").run({
    ":real_id": realId,
    ":placeholder": placeholderId,
  });
}

export function updateMemoryContentRow(
  id: string,
  content: string,
  confidence: number | undefined,
  updatedAt: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  if (confidence != null) {
    currentDb.prepare(
      "UPDATE memories SET content = :content, confidence = :confidence, updated_at = :updated_at WHERE id = :id",
    ).run({ ":content": content, ":confidence": confidence, ":updated_at": updatedAt, ":id": id });
  } else {
    currentDb.prepare(
      "UPDATE memories SET content = :content, updated_at = :updated_at WHERE id = :id",
    ).run({ ":content": content, ":updated_at": updatedAt, ":id": id });
  }
}

export function incrementMemoryHitCount(id: string, updatedAt: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE memories SET hit_count = hit_count + 1, updated_at = :updated_at WHERE id = :id",
  ).run({ ":updated_at": updatedAt, ":id": id });
}

export function supersedeMemoryRow(oldId: string, newId: string, updatedAt: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    "UPDATE memories SET superseded_by = :new_id, updated_at = :updated_at WHERE id = :old_id",
  ).run({ ":new_id": newId, ":updated_at": updatedAt, ":old_id": oldId });
}

export function markMemoryUnitProcessed(
  unitKey: string,
  activityFile: string,
  processedAt: string,
): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT OR IGNORE INTO memory_processed_units (unit_key, activity_file, processed_at)
     VALUES (:key, :file, :at)`,
  ).run({ ":key": unitKey, ":file": activityFile, ":at": processedAt });
}

export function decayMemoriesBefore(cutoffTs: string, now: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE memories
     SET confidence = MAX(0.1, confidence - 0.1), updated_at = :now
     WHERE superseded_by IS NULL AND updated_at < :cutoff AND confidence > 0.1`,
  ).run({ ":now": now, ":cutoff": cutoffTs });
}

export function supersedeLowestRankedMemories(limit: number, now: string): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `UPDATE memories SET superseded_by = 'CAP_EXCEEDED', updated_at = :now
     WHERE id IN (
       SELECT id FROM memories
       WHERE superseded_by IS NULL
       ORDER BY (confidence * (1.0 + hit_count * 0.1)) ASC
       LIMIT :limit
     )`,
  ).run({ ":now": now, ":limit": limit });
}
