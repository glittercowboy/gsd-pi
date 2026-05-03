// gsd-2 + Auto-mode worker process registry (DB-backed coordination, Phase B)
//
// IMPORTANT — naming clarification (codex review LOW N1):
// This module is the AUTO-MODE PROCESS REGISTRY. It tracks long-running
// `gsd auto` worker processes for cross-process coordination via the shared
// SQLite WAL. It is NOT the in-process subagent registry, which lives at
// `src/resources/extensions/subagent/worker-registry.ts` and tracks dispatched
// subagent threads within a single process.
//
// Both modules use the word "worker" but they are unrelated:
//   - subagent/worker-registry.ts → ephemeral in-process subagent threads
//   - db/auto-workers.ts          → durable cross-process auto-mode sessions
//
// Single-host invariant: SQLite WAL coordination only works on local disk.
// NFS / network filesystems break heartbeat semantics. Multi-host execution
// needs a real coordinator (etcd, Postgres) — out of scope for Phase B.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  _getAdapter,
  isDbAvailable,
  transaction,
  insertAuditEvent,
} from "../gsd-db.js";

const HEARTBEAT_TTL_SECONDS = 60;
// Version label is for diagnostics only — embedded in audit_events and
// workers.version. Bumping this manually on protocol changes is fine; we
// don't pull it from package.json to avoid module-load filesystem I/O.
const WORKER_REGISTRY_VERSION = "1";

export type WorkerStatus = "active" | "stopping" | "crashed";

export interface AutoWorkerRow {
  worker_id: string;
  host: string;
  pid: number;
  started_at: string;
  version: string;
  last_heartbeat_at: string;
  status: WorkerStatus;
  project_root_realpath: string;
}

/**
 * Register a new auto-mode worker process. Returns the generated worker_id
 * for the session to store on its AutoSession.
 *
 * The worker is created with `status='active'` and an initial heartbeat
 * stamp; callers must invoke heartbeatAutoWorker() periodically (e.g. once
 * per loop iteration) to refresh the TTL.
 */
export function registerAutoWorker(opts: {
  projectRootRealpath: string;
}): string {
  if (!isDbAvailable()) {
    throw new Error("registerAutoWorker: DB unavailable");
  }
  const workerId = `auto-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  transaction(() => {
    const db = _getAdapter()!;
    db.prepare(
      `INSERT INTO workers (
        worker_id, host, pid, started_at, version,
        last_heartbeat_at, status, project_root_realpath
      ) VALUES (
        :worker_id, :host, :pid, :started_at, :version,
        :last_heartbeat_at, 'active', :project_root_realpath
      )`,
    ).run({
      ":worker_id": workerId,
      ":host": hostname(),
      ":pid": process.pid,
      ":started_at": now,
      ":version": WORKER_REGISTRY_VERSION,
      ":last_heartbeat_at": now,
      ":project_root_realpath": opts.projectRootRealpath,
    });
  });

  insertAuditEvent({
    eventId: randomUUID(),
    traceId: workerId,
    category: "orchestration",
    type: "worker-registered",
    ts: now,
    payload: {
      workerId,
      host: hostname(),
      pid: process.pid,
      version: WORKER_REGISTRY_VERSION,
      projectRootRealpath: opts.projectRootRealpath,
    },
  });

  return workerId;
}

/**
 * Refresh the worker's heartbeat. Call once per auto-loop iteration.
 * Idempotent — silently no-ops if the worker no longer exists (e.g. row was
 * cleaned up by a janitor).
 */
export function heartbeatAutoWorker(workerId: string): void {
  if (!isDbAvailable()) return;
  const now = new Date().toISOString();
  const db = _getAdapter()!;
  db.prepare(
    `UPDATE workers SET last_heartbeat_at = :now WHERE worker_id = :worker_id AND status = 'active'`,
  ).run({ ":now": now, ":worker_id": workerId });
}

/**
 * Mark the worker as crashed. Used by janitors / doctor commands when a
 * worker's heartbeat has expired beyond the TTL window.
 */
export function markWorkerCrashed(workerId: string): void {
  if (!isDbAvailable()) return;
  const db = _getAdapter()!;
  transaction(() => {
    db.prepare(
      `UPDATE workers SET status = 'crashed' WHERE worker_id = :worker_id AND status = 'active'`,
    ).run({ ":worker_id": workerId });
  });
  insertAuditEvent({
    eventId: randomUUID(),
    traceId: workerId,
    category: "orchestration",
    type: "worker-crashed",
    ts: new Date().toISOString(),
    payload: { workerId },
  });
}

/**
 * Mark the worker as stopping. Called from the stopAuto path when the user
 * cleanly shuts down auto-mode.
 */
export function markWorkerStopping(workerId: string): void {
  if (!isDbAvailable()) return;
  const db = _getAdapter()!;
  transaction(() => {
    db.prepare(
      `UPDATE workers SET status = 'stopping' WHERE worker_id = :worker_id`,
    ).run({ ":worker_id": workerId });
  });
}

/**
 * Return all workers whose status is 'active' AND whose heartbeat is within
 * the TTL window. Workers older than the TTL are NOT auto-marked crashed
 * here — that's a separate janitor responsibility — but they are filtered
 * out of the active set so callers see a fresh view.
 */
export function getActiveAutoWorkers(): readonly AutoWorkerRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  const cutoffMs = Date.now() - HEARTBEAT_TTL_SECONDS * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const rows = db.prepare(
    `SELECT worker_id, host, pid, started_at, version,
            last_heartbeat_at, status, project_root_realpath
     FROM workers
     WHERE status = 'active' AND last_heartbeat_at >= :cutoff
     ORDER BY started_at`,
  ).all({ ":cutoff": cutoffIso }) as unknown as AutoWorkerRow[];
  return rows;
}

/** Return all worker rows regardless of status or TTL. */
export function getAllAutoWorkers(): readonly AutoWorkerRow[] {
  if (!isDbAvailable()) return [];
  const db = _getAdapter()!;
  const rows = db.prepare(
    `SELECT worker_id, host, pid, started_at, version,
            last_heartbeat_at, status, project_root_realpath
     FROM workers
     ORDER BY started_at`,
  ).all() as unknown as AutoWorkerRow[];
  return rows;
}

/**
 * Look up a single worker row. Returns null if no row exists.
 */
export function getAutoWorker(workerId: string): AutoWorkerRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT worker_id, host, pid, started_at, version,
            last_heartbeat_at, status, project_root_realpath
     FROM workers WHERE worker_id = :worker_id`,
  ).get({ ":worker_id": workerId }) as AutoWorkerRow | undefined;
  return row ?? null;
}

/** Test/janitor helper: TTL constant exported for callers to compute expirations. */
export function autoWorkerHeartbeatTtlSeconds(): number {
  return HEARTBEAT_TTL_SECONDS;
}

/**
 * Phase C pt 2 — find the most recently active worker for a project root
 * whose heartbeat has lapsed (the "previous crashed session" indicator).
 *
 * Used by crash-recovery.ts:readCrashLock to detect when a prior auto-mode
 * session ended without cleanup. Callers should additionally PID-check the
 * returned row via isLockProcessAlive() to distinguish "really dead" from
 * "still alive but heartbeat behind" (rare, but possible under load).
 *
 * Returns null if no stale worker exists for this project root.
 */
export function findStaleWorkerForProject(
  projectRootRealpath: string,
): AutoWorkerRow | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const cutoffMs = Date.now() - HEARTBEAT_TTL_SECONDS * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const row = db.prepare(
    `SELECT worker_id, host, pid, started_at, version,
            last_heartbeat_at, status, project_root_realpath
     FROM workers
     WHERE project_root_realpath = :project_root
       AND status = 'active'
       AND last_heartbeat_at < :cutoff
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get({ ":project_root": projectRootRealpath, ":cutoff": cutoffIso }) as AutoWorkerRow | undefined;
  return row ?? null;
}
