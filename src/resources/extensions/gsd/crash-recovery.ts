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
