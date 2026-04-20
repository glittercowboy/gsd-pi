/**
 * GSD Crash Recovery
 *
 * Detects interrupted auto-mode sessions via a lock file.
 * Written on auto-start, updated on each unit dispatch, deleted on clean stop.
 * If the lock file exists on next startup, the previous session crashed.
 *
 * The lock records the pi session file path so crash recovery can read the
 * surviving JSONL (pi appends entries incrementally via appendFileSync,
 * so the file on disk reflects every tool call up to the crash point).
 */

import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import { effectiveLockFile } from "./session-lock.js";
import { emitJournalEvent, queryJournal } from "./journal.js";

export interface LockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  /** Path to the pi session JSONL file that was active when this unit started. */
  sessionFile?: string;
}

function lockPath(basePath: string): string {
  return join(gsdRoot(basePath), effectiveLockFile());
}

/** Write or update the lock file with current auto-mode state. */
export function writeLock(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
): void {
  try {
    const data: LockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      sessionFile,
    };
    const lp = lockPath(basePath);
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch (e) { /* non-fatal: lock write failure */ void e; }
}

/** Remove the lock file on clean stop. */
export function clearLock(basePath: string): void {
  try {
    const p = lockPath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch (e) { /* non-fatal: lock clear failure */ void e; }
}

/** Check if a crash lock exists and return its data. */
export function readCrashLock(basePath: string): LockData | null {
  try {
    const p = lockPath(basePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as LockData;
  } catch (e) {
    /* non-fatal: corrupt or unreadable lock file */ void e;
    return null;
  }
}

/**
 * Check whether the process that wrote the lock is still running.
 * Uses `process.kill(pid, 0)` which sends no signal but checks liveness.
 * Returns true if the PID matches our own — we are the lock holder (#2470).
 */
export function isLockProcessAlive(lock: LockData): boolean {
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Our own PID means WE hold this lock — we are alive. (#2470)
  // Callers that need to distinguish "our lock" from "someone else's lock"
  // (e.g. startAuto checking for a prior crashed session with a recycled PID)
  // already guard with `crashLock.pid !== process.pid` before calling us.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission — treat as alive.
    // ESRCH means the process does not exist — treat as dead (stale lock).
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

  // Add recovery guidance based on what was happening when it crashed
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
 *
 * Queries the journal to find the most recent unit-start for the crashed unit.
 * If a matching unit-end already exists (e.g. the hard timeout fired), this is a
 * no-op. Called during crash recovery, before clearing the stale lock.
 *
 * Addresses the gap reported in #3348 where `unit-start` was emitted but no
 * `unit-end` followed — side effects landed but the worker died before closeout.
 */
export function emitCrashRecoveredUnitEnd(basePath: string, lock: LockData): void {
  // Skip bootstrap / starting pseudo-units — they have no meaningful unit-start event.
  if (!lock.unitType || !lock.unitId || lock.unitType === "starting") return;

  try {
    const all = queryJournal(basePath);

    // Find the most recent unit-start for this unitId
    const starts = all.filter(
      (e) => e.eventType === "unit-start" && e.data?.unitId === lock.unitId,
    );
    if (starts.length === 0) return;

    const lastStart = starts[starts.length - 1];

    // Check if a unit-end was already emitted (e.g. hard timeout fired after the crash)
    const alreadyClosed = all.some(
      (e) =>
        e.eventType === "unit-end" &&
        e.data?.unitId === lock.unitId &&
        e.causedBy?.flowId === lastStart.flowId &&
        e.causedBy?.seq === lastStart.seq,
    );
    if (alreadyClosed) return;

    // Find the highest seq in this flow for monotonic ordering
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
    // Never throw from crash recovery path — journal failure must not block recovery
  }
}
