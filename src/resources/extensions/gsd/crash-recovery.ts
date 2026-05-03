/**
 * GSD Crash Recovery (Phase C pt 2 — DB-backed)
 *
 * Detects interrupted auto-mode sessions via the DB-backed workers +
 * unit_dispatches + runtime_kv tables. The auto.lock file is gone; the
 * `LockData` shape is preserved for backward compatibility with callers
 * (auto.ts, doctor checks, interrupted-session.ts), but the contents are
 * now synthesized from:
 *
 *   - workers.pid / .started_at / .last_heartbeat_at  → liveness + age
 *   - unit_dispatches.unit_type / .unit_id / .started_at  → what was running
 *   - runtime_kv("worker", workerId, "session_file")  → pi session JSONL path
 *
 * "Crashed" is detected via workers.status='active' + heartbeat past TTL,
 * cross-checked with the OS PID via isLockProcessAlive(). When the DB is
 * unavailable (fresh project before init), all readers return null and
 * writers no-op — preserving the historical "no lock means no prior
 * crash" semantics.
 *
 * The journal-based emitCrashRecoveredUnitEnd is unchanged from the file
 * era — it queries the journal independently of the lock mechanism.
 */

import {
  emitJournalEvent,
  queryJournal,
} from "./journal.js";
import {
  findStaleWorkerForProject,
  getAllAutoWorkers,
  type AutoWorkerRow,
} from "./db/auto-workers.js";
import { getLatestForUnit, type DispatchStatus } from "./db/unit-dispatches.js";
import { getRuntimeKv, setRuntimeKv, deleteRuntimeKv } from "./db/runtime-kv.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { normalizeRealPath } from "./paths.js";

export interface LockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  /** Path to the pi session JSONL file that was active when this unit started. */
  sessionFile?: string;
}

const SESSION_FILE_KV_KEY = "session_file";

function findActiveWorkerForCurrentProcess(
  projectRootRealpath: string,
): AutoWorkerRow | null {
  if (!isDbAvailable()) return null;
  const workers = getAllAutoWorkers();
  for (const worker of workers) {
    if (
      worker.pid === process.pid
      && worker.project_root_realpath === projectRootRealpath
    ) {
      return worker;
    }
  }
  return null;
}

/**
 * Look up the most recent dispatch row for a worker, regardless of status.
 * Returns null if the worker has no dispatch history yet (e.g. crashed
 * during bootstrap before claiming the first unit).
 */
function getLatestDispatchForWorker(workerId: string):
  | { unit_type: string; unit_id: string; started_at: string; status: DispatchStatus }
  | null {
  if (!isDbAvailable()) return null;
  const db = _getAdapter()!;
  const row = db.prepare(
    `SELECT unit_type, unit_id, started_at, status
     FROM unit_dispatches
     WHERE worker_id = :worker_id
     ORDER BY id DESC
     LIMIT 1`,
  ).get({ ":worker_id": workerId }) as
    | { unit_type: string; unit_id: string; started_at: string; status: DispatchStatus }
    | undefined;
  return row ?? null;
}

function workerToLockData(worker: AutoWorkerRow): LockData {
  const dispatch = getLatestDispatchForWorker(worker.worker_id);
  const sessionFile =
    getRuntimeKv<string>("worker", worker.worker_id, SESSION_FILE_KV_KEY) ?? undefined;
  return {
    pid: worker.pid,
    startedAt: worker.started_at,
    // Pre-Phase-C-pt-2 default: when no dispatch row exists yet (bootstrap
    // crash), report unitType="starting", unitId="bootstrap" — same shape
    // the file-based writer used to produce.
    unitType: dispatch?.unit_type ?? "starting",
    unitId: dispatch?.unit_id ?? "bootstrap",
    unitStartedAt: dispatch?.started_at ?? worker.started_at,
    sessionFile,
  };
}

/**
 * Write or update the lock state for the current auto-mode session.
 *
 * Phase C pt 2: the only persistent state this function adds beyond what
 * the workers + unit_dispatches tables already track is the pi session
 * JSONL path, which lands in runtime_kv (worker scope, key
 * "session_file"). The pid/startedAt/unitType/unitId/unitStartedAt are
 * recorded by registerAutoWorker / heartbeatAutoWorker / recordDispatchClaim
 * already.
 *
 * basePath is unused by the new implementation (kept as a parameter for
 * back-compat with the 15+ call sites) — the worker is identified by
 * pid + project_root_realpath in the workers table.
 */
export function writeLock(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  void basePath;
  void unitType;
  void unitId;
  if (!isDbAvailable()) return;
  if (!sessionFile) return;
  // Find our own worker row to scope the runtime_kv key.
  try {
    const projectRoot = normalizeRealPath(basePath);
    const worker = findActiveWorkerForCurrentProcess(projectRoot);
    if (!worker) return;
    setRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY, sessionFile);
  } catch {
    // Best-effort — never throw from the lock writer.
  }
}

/**
 * Phase C pt 2: clearLock no longer deletes a file. The cleanup path
 * (markWorkerStopping in stopAuto) flips the workers row to 'stopping'.
 * This function additionally drops the session_file runtime_kv row for
 * the current worker so a follow-up crash detection doesn't pick up a
 * stale session-file pointer.
 */
export function clearLock(basePath: string): void {
  if (!isDbAvailable()) return;
  try {
    const projectRoot = normalizeRealPath(basePath);
    const worker = findActiveWorkerForCurrentProcess(projectRoot);
    if (!worker) return;
    deleteRuntimeKv("worker", worker.worker_id, SESSION_FILE_KV_KEY);
  } catch {
    // Best-effort.
  }
}

/**
 * Detect a previous crashed auto-mode session.
 *
 * Phase C pt 2: synthesized from workers (status='active' + lapsed
 * heartbeat) + unit_dispatches (most recent for that worker) +
 * runtime_kv (session_file). Returns null when no stale worker exists
 * or the DB is unavailable.
 */
export function readCrashLock(basePath: string): LockData | null {
  if (!isDbAvailable()) return null;
  try {
    const projectRoot = normalizeRealPath(basePath);
    const stale = findStaleWorkerForProject(projectRoot);
    if (!stale) return null;
    return workerToLockData(stale);
  } catch {
    return null;
  }
}

/**
 * Check whether the process that wrote the lock is still running.
 * Uses `process.kill(pid, 0)` which sends no signal but checks liveness.
 * Returns true if the PID matches our own — we are the lock holder (#2470).
 *
 * Unchanged from the file-based era — pure stateless OS check.
 */
export function isLockProcessAlive(lock: LockData): boolean {
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/** Format crash info for display or injection into a prompt. */
export function formatCrashInfo(lock: LockData): string {
  const lines = [
    `Previous auto-mode session was interrupted.`,
    `  Was executing: ${lock.unitType} (${lock.unitId})`,
    `  Started at: ${lock.unitStartedAt}`,
    `  PID: ${lock.pid}`,
  ];

  if (lock.unitType === "starting" && lock.unitId === "bootstrap") {
    lines.push(`No work was lost. Run /gsd auto to restart.`);
  } else if (lock.unitType.includes("research") || lock.unitType.includes("plan")) {
    lines.push(`The ${lock.unitType} unit may be incomplete. Run /gsd auto to re-run it.`);
  } else if (lock.unitType.includes("execute")) {
    lines.push(`Task execution was interrupted. Run /gsd auto to resume — completed work is preserved.`);
  } else if (lock.unitType.includes("complete")) {
    lines.push(`Slice/milestone completion was interrupted. Run /gsd auto to finish.`);
  }

  return lines.join("\n");
}

/**
 * Emit a synthetic unit-end event for a unit that crashed without emitting its own.
 * Unchanged from the file era — operates on the journal, not the lock.
 */
export function emitCrashRecoveredUnitEnd(basePath: string, lock: LockData): void {
  if (!lock.unitType || !lock.unitId || lock.unitType === "starting") return;

  try {
    const all = queryJournal(basePath);

    const starts = all.filter(
      (e) => e.eventType === "unit-start" && e.data?.unitId === lock.unitId,
    );
    if (starts.length === 0) return;

    const lastStart = starts[starts.length - 1];

    const alreadyClosed = all.some(
      (e) =>
        e.eventType === "unit-end" &&
        e.data?.unitId === lock.unitId &&
        e.causedBy?.flowId === lastStart.flowId &&
        e.causedBy?.seq === lastStart.seq,
    );
    if (alreadyClosed) return;

    const maxSeq = all
      .filter((e) => e.flowId === lastStart.flowId)
      .reduce((max, e) => Math.max(max, e.seq), lastStart.seq);

    emitJournalEvent(basePath, {
      ts: new Date().toISOString(),
      flowId: lastStart.flowId,
      seq: maxSeq + 1,
      eventType: "unit-end",
      data: {
        unitType: lock.unitType,
        unitId: lock.unitId,
        status: "crash-recovered",
        artifactVerified: false,
      },
      causedBy: { flowId: lastStart.flowId, seq: lastStart.seq },
    });
  } catch {
    // Never throw from crash recovery path.
  }
}

/**
 * Used by the doctor checks (doctor-runtime-checks.ts, doctor-proactive.ts)
 * to enumerate stale workers across all projects this DB knows about.
 * Phase C pt 2 export — surface for the same diagnostics that previously
 * iterated `auto.lock` files.
 */
export function findStaleAutoWorker(basePath: string): LockData | null {
  return readCrashLock(basePath);
}
