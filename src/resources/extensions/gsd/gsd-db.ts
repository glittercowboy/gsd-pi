// GSD Database Abstraction Layer
// Provides a SQLite database with provider fallback chain:
//   node:sqlite (built-in) → better-sqlite3 (npm) → null (unavailable)
//
// Exposes a unified sync API for decisions and requirements storage.
// Schema is initialized on first open with WAL mode for file-backed DBs.

import { createRequire } from "node:module";
import { existsSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Requirement, GateRow, GateId, GateScope, GateStatus, GateVerdict } from "./types.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";
import { logError, logWarning } from "./workflow-logger.js";

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
  // @ts-expect-error overriding process.emit for warning filter
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

const SCHEMA_VERSION = 14;

function initSchema(db: DbAdapter, fileBacked: boolean): void {
  if (fileBacked) db.exec("PRAGMA journal_mode=WAL");
  if (fileBacked) db.exec("PRAGMA busy_timeout = 5000");
  if (fileBacked) db.exec("PRAGMA synchronous = NORMAL");
  if (fileBacked) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (fileBacked) db.exec("PRAGMA cache_size = -8000");   // 8 MB page cache
  if (fileBacked) db.exec("PRAGMA mmap_size = 67108864");  // 64 MB mmap
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

    db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_replan_history_milestone ON replan_history(milestone_id, created_at)");

    // v13 indexes — hot-path dispatch queries
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_slices_active ON slices(milestone_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_quality_gates_pending ON quality_gates(milestone_id, slice_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_verification_evidence_task ON verification_evidence(milestone_id, slice_id, task_id)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");

    // v14 index — slice dependency lookups
    db.exec("CREATE INDEX IF NOT EXISTS idx_slice_deps_target ON slice_dependencies(milestone_id, depends_on_slice_id)");

    db.exec(`CREATE VIEW IF NOT EXISTS active_decisions AS SELECT * FROM decisions WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_requirements AS SELECT * FROM requirements WHERE superseded_by IS NULL`);
    db.exec(`CREATE VIEW IF NOT EXISTS active_memories AS SELECT * FROM memories WHERE superseded_by IS NULL`);

    const existing = db.prepare("SELECT count(*) as cnt FROM schema_version").get();
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

  migrateSchema(db);
}

function columnExists(db: DbAdapter, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row["name"] === column);
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS quality_gates (
          milestone_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          gate_id TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'slice',
          task_id TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          verdict TEXT NOT NULL DEFAULT '',
          rationale TEXT NOT NULL DEFAULT '',
          findings TEXT NOT NULL DEFAULT '',
          evaluated_at TEXT DEFAULT NULL,
          PRIMARY KEY (milestone_id, slice_id, gate_id, COALESCE(task_id, '')),
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
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_evidence_dedup ON verification_evidence(task_id, slice_id, milestone_id, command, verdict)");
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

export function getDbProvider(): ProviderName | null {
  loadProvider();
  return providerName;
}

export function isDbAvailable(): boolean {
  return currentDb !== null;
}

export function openDatabase(path: string): boolean {
  if (currentDb && currentPath !== path) closeDatabase();
  if (currentDb && currentPath === path) return true;

  const rawDb = openRawDb(path);
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
        try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
        throw retryErr;
      }
    } else {
      try { adapter.close(); } catch (e) { logWarning("db", `close after VACUUM failed: ${(e as Error).message}`); }
      throw err;
    }
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
}

/** Run a full VACUUM — call sparingly (e.g. after milestone completion). */
export function vacuumDatabase(): void {
  if (!currentDb) return;
  try {
    currentDb.exec('VACUUM');
  } catch (e) { logWarning("db", `VACUUM failed: ${(e as Error).message}`); }
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

export function insertDecision(d: Omit<Decision, "seq">): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :superseded_by)`,
  ).run({
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
    `INSERT INTO decisions (id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by)
     VALUES (:id, :when_context, :scope, :decision, :choice, :rationale, :revisable, :made_by, :superseded_by)
     ON CONFLICT(id) DO UPDATE SET
       when_context = excluded.when_context,
       scope = excluded.scope,
       decision = excluded.decision,
       choice = excluded.choice,
       rationale = excluded.rationale,
       revisable = excluded.revisable,
       made_by = excluded.made_by,
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
  planning?: Partial<SlicePlanningRecord>;
}): void {
  if (!currentDb) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  currentDb.prepare(
    `INSERT INTO slices (
      milestone_id, id, title, status, risk, depends, demo, created_at,
      goal, success_criteria, proof_level, integration_closure, observability_impact, sequence
    ) VALUES (
      :milestone_id, :id, :title, :status, :risk, :depends, :demo, :created_at,
      :goal, :success_criteria, :proof_level, :integration_closure, :observability_impact, :sequence
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
      sequence = CASE WHEN :raw_sequence IS NOT NULL THEN excluded.sequence ELSE slices.sequence END`,
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
  });
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
    description: (row["description"] as string) ?? "",
    estimate: (row["estimate"] as string) ?? "",
    files: JSON.parse((row["files"] as string) || "[]"),
    verify: (row["verify"] as string) ?? "",
    inputs: JSON.parse((row["inputs"] as string) || "[]"),
    expected_output: JSON.parse((row["expected_output"] as string) || "[]"),
    observability_impact: (row["observability_impact"] as string) ?? "",
    full_plan_md: (row["full_plan_md"] as string) ?? "",
    sequence: (row["sequence"] as number) ?? 0,
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
        merged.decisions = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO decisions (
            id, when_context, scope, decision, choice, rationale, revisable, made_by, superseded_by
          )
          SELECT id, when_context, scope, decision, choice, rationale, revisable, ${
            hasMadeBy ? "made_by" : "'agent'"
          }, superseded_by FROM wt.decisions
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

        // Merge milestones — worktree may have updated status/planning fields
        merged.milestones = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO milestones (
            id, title, status, depends_on, created_at, completed_at,
            vision, success_criteria, key_risks, proof_strategy,
            verification_contract, verification_integration, verification_operational, verification_uat,
            definition_of_done, requirement_coverage, boundary_map_markdown
          )
          SELECT id, title, status, depends_on, created_at, completed_at,
                 vision, success_criteria, key_risks, proof_strategy,
                 verification_contract, verification_integration, verification_operational, verification_uat,
                 definition_of_done, requirement_coverage, boundary_map_markdown
          FROM wt.milestones
        `).run());

        // Merge slices — preserve worktree progress but never downgrade completed status (#2558).
        // Uses INSERT OR REPLACE with a subquery that picks the best status — if the main DB
        // already has a completed slice, keep that status even if the worktree copy is stale.
        merged.slices = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO slices (
            milestone_id, id, title, status, risk, depends, demo, created_at, completed_at,
            full_summary_md, full_uat_md, goal, success_criteria, proof_level,
            integration_closure, observability_impact, sequence, replan_triggered_at
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
                 w.integration_closure, w.observability_impact, w.sequence, w.replan_triggered_at
          FROM wt.slices w
          LEFT JOIN slices m ON m.milestone_id = w.milestone_id AND m.id = w.id
        `).run());

        // Merge tasks — preserve execution results, never downgrade completed status (#2558)
        merged.tasks = countChanges(adapter.prepare(`
          INSERT OR REPLACE INTO tasks (
            milestone_id, slice_id, id, title, status, one_liner, narrative,
            verification_result, duration, completed_at, blocker_discovered,
            deviations, known_issues, key_files, key_decisions, full_summary_md,
            description, estimate, files, verify, inputs, expected_output,
            observability_impact, full_plan_md, sequence
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
                 w.observability_impact, w.full_plan_md, w.sequence
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
