// GSD Extension — Advisory Sync Lock
// Prevents concurrent worktree syncs from colliding via a simple file lock.
// Stale locks (mtime > 60s) are auto-overridden. Lock acquisition waits up
// to 5 seconds then skips non-fatally.

import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write.js";

const STALE_THRESHOLD_MS = 60_000; // 60 seconds
const DEFAULT_TIMEOUT_MS = 5_000;  // 5 seconds
const SPIN_INTERVAL_MS = 100;      // 100ms polling interval

// SharedArrayBuffer for synchronous sleep via Atomics.wait
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

function lockFilePath(basePath: string): string {
  return join(basePath, ".gsd", "sync.lock");
}

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

/**
 * Acquire an advisory sync lock for the given basePath.
 * Returns { acquired: true } on success, { acquired: false } after timeout.
 *
 * - Creates lock file at {basePath}/.gsd/sync.lock with JSON { pid, acquired_at }
 * - If lock exists and mtime > 60s (stale), overrides it
 * - If lock exists and not stale, spins up to timeoutMs before giving up
 */
export function acquireSyncLock(
  basePath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): { acquired: boolean } {
  const lp = lockFilePath(basePath);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Check if lock file exists
    if (existsSync(lp)) {
      // Check staleness
      try {
        const stat = statSync(lp);
        const age = Date.now() - stat.mtimeMs;
        if (age > STALE_THRESHOLD_MS) {
          // Stale lock — override it
          try { unlinkSync(lp); } catch { /* race: already removed */ }
        } else {
          // Lock is held and not stale — wait or give up
          if (Date.now() >= deadline) {
            return { acquired: false };
          }
          sleepSync(SPIN_INTERVAL_MS);
          continue;
        }
      } catch {
        // stat failed (file removed between exists check and stat) — try to acquire
      }
    }

    // Lock file does not exist (or was just removed) — try to write it
    try {
      const lockData = {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      };
      atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
      return { acquired: true };
    } catch {
      // Write failed (race condition with another process) — retry or give up
      if (Date.now() >= deadline) {
        return { acquired: false };
      }
      sleepSync(SPIN_INTERVAL_MS);
    }
  }
}

/**
 * Release the advisory sync lock. No-op if lock file does not exist.
 */
export function releaseSyncLock(basePath: string): void {
  const lp = lockFilePath(basePath);
  try {
    if (existsSync(lp)) {
      unlinkSync(lp);
    }
  } catch {
    // Non-fatal — lock may have been released by another process
  }
}
