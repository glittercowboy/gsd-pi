/**
 * GSD Session Lock — OS-level exclusive locking for auto-mode sessions.
 *
 * Prevents multiple GSD processes from running auto-mode concurrently on
 * the same project. Uses proper-lockfile for OS-level file locking (flock/
 * lockfile) which eliminates the TOCTOU race condition that existed with
 * the old advisory JSON lock approach.
 *
 * The lock file (.gsd/auto.lock) contains JSON metadata (PID, start time,
 * unit info) for diagnostics, but the actual exclusion is enforced by the
 * OS-level lock held via proper-lockfile.
 *
 * Lifecycle:
 *   acquireSessionLock()  — called at the START of bootstrapAutoSession
 *   validateSessionLock() — called periodically during dispatch to detect takeover
 *   releaseSessionLock()  — called on clean stop/pause
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";

const _require = createRequire(import.meta.url);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionLockData {
  pid: number;
  startedAt: string;
  unitType: string;
  unitId: string;
  unitStartedAt: string;
  completedUnits: number;
  sessionFile?: string;
}

export type SessionLockResult =
  | { acquired: true }
  | { acquired: false; reason: string; existingPid?: number };

export type SessionLockFailureReason =
  | "compromised"
  | "missing-metadata"
  | "pid-mismatch";

export interface SessionLockStatus {
  valid: boolean;
  failureReason?: SessionLockFailureReason;
  existingPid?: number;
  expectedPid?: number;
  recovered?: boolean;
}

// ─── Module State ───────────────────────────────────────────────────────────

/** Release function from proper-lockfile — calling it releases the OS lock. */
let _releaseFunction: (() => void) | null = null;

/** The path we currently hold a lock on. */
let _lockedPath: string | null = null;

/** Our PID at lock acquisition time. */
let _lockPid: number = 0;

/** Set to true when proper-lockfile fires onCompromised (mtime drift, sleep, etc.). */
let _lockCompromised: boolean = false;

/** Whether we've already registered a process.on('exit') handler. */
let _exitHandlerRegistered: boolean = false;

/** Snapshotted lock file path — captured at acquireSessionLock time to avoid
 *  gsdRoot() resolving differently in worktree vs project root contexts (#1363). */
let _snapshotLockPath: string | null = null;

/** Timestamp when the session lock was acquired — used to detect false-positive
 *  onCompromised events from event loop stalls within the stale window (#1362). */
let _lockAcquiredAt: number = 0;

const LOCK_FILE = "auto.lock";

function lockPath(basePath: string): string {
  // If we have a snapshotted path from acquisition, use it for consistency
  if (_snapshotLockPath) return _snapshotLockPath;
  return join(gsdRoot(basePath), LOCK_FILE);
}

// ─── Stray Lock Cleanup ─────────────────────────────────────────────────────

/**
 * Remove numbered lock file variants (e.g. "auto 2.lock", "auto 3.lock")
 * that accumulate from macOS file conflict resolution (iCloud/Dropbox/OneDrive)
 * or other filesystem-level copy-on-conflict behavior (#1315).
 *
 * Also removes stray proper-lockfile directories beyond the canonical `.gsd.lock/`.
 */
export function cleanupStrayLockFiles(basePath: string): void {
  const gsdDir = gsdRoot(basePath);

  // Clean numbered auto lock files inside .gsd/
  try {
    if (existsSync(gsdDir)) {
      for (const entry of readdirSync(gsdDir)) {
        // Match "auto <N>.lock" or "auto (<N>).lock" variants but NOT the canonical "auto.lock"
        if (entry !== LOCK_FILE && /^auto\s.+\.lock$/i.test(entry)) {
          try { unlinkSync(join(gsdDir, entry)); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal: directory read failure */ }

  // Clean stray proper-lockfile directories (e.g. ".gsd 2.lock/")
  // The canonical one is ".gsd.lock/" — anything else is stray.
  try {
    const parentDir = dirname(gsdDir);
    const gsdDirName = gsdDir.split("/").pop() || ".gsd";
    if (existsSync(parentDir)) {
      for (const entry of readdirSync(parentDir)) {
        // Match ".gsd <N>.lock" or ".gsd (<N>).lock" directories but NOT ".gsd.lock"
        if (entry !== `${gsdDirName}.lock` && entry.startsWith(gsdDirName) && entry.endsWith(".lock")) {
          const fullPath = join(parentDir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              rmSync(fullPath, { recursive: true, force: true });
            }
          } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Register a single process exit handler that cleans up lock state.
 * Uses module-level references so it always operates on current state.
 * Only registers once — subsequent calls are no-ops.
 */
function ensureExitHandler(gsdDir: string): void {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;

  process.once("exit", () => {
    try {
      if (_releaseFunction) { _releaseFunction(); _releaseFunction = null; }
    } catch { /* best-effort */ }
    // Remove the auto.lock metadata file so crash-recovery doesn't
    // falsely detect an interrupted session on the next startup.
    try {
      const lockFile = join(gsdDir, LOCK_FILE);
      if (existsSync(lockFile)) unlinkSync(lockFile);
    } catch { /* best-effort */ }
    try {
      const lockDir = join(gsdDir + ".lock");
      if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Attempt to acquire an exclusive session lock for the given project.
 *
 * This uses proper-lockfile for OS-level file locking. If another process
 * already holds the lock, this returns { acquired: false } with details.
 *
 * The lock file also contains JSON metadata about the session for
 * diagnostic purposes (PID, unit info, etc.).
 */
export function acquireSessionLock(basePath: string): SessionLockResult {
  const lp = lockPath(basePath);

  // Re-entrant acquire on the same path: release our current OS lock first so
  // proper-lockfile clears its update timer before we acquire a fresh lock.
  if (_releaseFunction && _lockedPath === basePath) {
    try { _releaseFunction(); } catch { /* may already be released */ }
    _releaseFunction = null;
    _lockedPath = null;
    _lockPid = 0;
    _lockCompromised = false;
  }

  // Ensure the directory exists
  mkdirSync(dirname(lp), { recursive: true });

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  // Write our lock data first (the content is informational; the OS lock is the real guard)
  const lockData: SessionLockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: new Date().toISOString(),
    completedUnits: 0,
  };

  let lockfile: typeof import("proper-lockfile");
  try {
    lockfile = _require("proper-lockfile") as typeof import("proper-lockfile");
  } catch {
    // proper-lockfile not available — fall back to PID-based check
    return acquireFallbackLock(basePath, lp, lockData);
  }

  const gsdDir = gsdRoot(basePath);

  try {
    // Try to acquire an exclusive OS-level lock on the lock file.
    // We lock the directory (gsdRoot) since proper-lockfile works best
    // on directories, and the lock file itself may not exist yet.
    mkdirSync(gsdDir, { recursive: true });

    const release = lockfile.lockSync(gsdDir, {
      realpath: false,
      stale: 1_800_000, // 30 minutes — safe for laptop sleep / long event loop stalls
      update: 10_000, // Update lock mtime every 10s to prove liveness
      onCompromised: () => {
        // proper-lockfile detected mtime drift (system sleep, event loop stall, etc.).
        // Default handler throws inside setTimeout — an uncaught exception that crashes
        // or corrupts process state.
        //
        // False-positive suppression (#1362): If we're still within the stale window
        // (30 min since acquisition), the mtime mismatch is from an event loop stall
        // during a long LLM call — not a real takeover. Log and continue.
        const elapsed = Date.now() - _lockAcquiredAt;
        if (elapsed < 1_800_000) {
          process.stderr.write(
            `[gsd] Lock heartbeat mismatch after ${Math.round(elapsed / 1000)}s — event loop stall, continuing.\n`,
          );
          return; // Suppress false positive
        }
        // Past the stale window — this is a real compromise
        _lockCompromised = true;
        _releaseFunction = null;
      },
    });

    _releaseFunction = release;
    _lockedPath = basePath;
    _lockPid = process.pid;
    _lockCompromised = false;
    _lockAcquiredAt = Date.now();
    _snapshotLockPath = lp; // Snapshot the resolved path for consistent access (#1363)

    // Safety net: clean up lock dir on process exit if _releaseFunction
    // wasn't called (e.g., normal exit after clean completion) (#1245).
    ensureExitHandler(gsdDir);

    // Write the informational lock data
    atomicWriteSync(lp, JSON.stringify(lockData, null, 2));

    return { acquired: true };
  } catch (err) {
    // Lock is held by another process — or the .gsd.lock/ directory is stranded.
    // Check: if auto.lock is gone and no process is alive, the lock dir is stale.
    const existingData = readExistingLockData(lp);
    const existingPid = existingData?.pid;

    // If no lock file or no alive process, try to clean up and re-acquire (#1245)
    if (!existingData || (existingPid && !isPidAlive(existingPid))) {
      try {
        const lockDir = join(gsdDir + ".lock");
        if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
        if (existsSync(lp)) unlinkSync(lp);

        // Retry acquisition after cleanup
        const release = lockfile.lockSync(gsdDir, {
          realpath: false,
          stale: 1_800_000, // 30 minutes — match primary lock settings
          update: 10_000,
          onCompromised: () => {
            // Same false-positive suppression as the primary lock (#1512).
            // Without this, the retry path fires _lockCompromised unconditionally
            // on benign mtime drift (laptop sleep, heavy LLM event loop stalls).
            const elapsed = Date.now() - _lockAcquiredAt;
            if (elapsed < 1_800_000) {
              process.stderr.write(
                `[gsd] Lock heartbeat mismatch after ${Math.round(elapsed / 1000)}s — event loop stall, continuing.\n`,
              );
              return;
            }
            _lockCompromised = true;
            _releaseFunction = null;
          },
        });
        _releaseFunction = release;
        _lockedPath = basePath;
        _lockPid = process.pid;
        _lockCompromised = false;
        _lockAcquiredAt = Date.now();
        _snapshotLockPath = lp; // Snapshot for retry path too (#1363)

        // Safety net — uses centralized handler to avoid double-registration
        ensureExitHandler(gsdDir);

        atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
        return { acquired: true };
      } catch {
        // Retry also failed — fall through to the error path
      }
    }

    const reason = existingPid
      ? `Another auto-mode session (PID ${existingPid}) appears to be running.\nStop it with \`kill ${existingPid}\` before starting a new session.`
      : `Another auto-mode session is already running on this project.`;

    return { acquired: false, reason, existingPid };
  }
}

/**
 * Fallback lock acquisition when proper-lockfile is not available.
 * Uses PID-based liveness checking (the old approach, but with the lock
 * written BEFORE initialization rather than after).
 */
function acquireFallbackLock(
  basePath: string,
  lp: string,
  lockData: SessionLockData,
): SessionLockResult {
  // Check if an existing lock is held by a live process
  const existing = readExistingLockData(lp);
  if (existing && existing.pid !== process.pid) {
    if (isPidAlive(existing.pid)) {
      return {
        acquired: false,
        reason: `Another auto-mode session (PID ${existing.pid}) is already running on this project.`,
        existingPid: existing.pid,
      };
    }
    // Stale lock from dead process — we can take over
  }

  // Write our lock data
  atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
  _lockedPath = basePath;
  _lockPid = process.pid;

  return { acquired: true };
}

/**
 * Update the lock file metadata (called on each unit dispatch).
 * Does NOT re-acquire the OS lock — just updates the JSON content.
 */
export function updateSessionLock(
  basePath: string,
  unitType: string,
  unitId: string,
  completedUnits: number,
  sessionFile?: string,
): void {
  if (_lockedPath !== basePath && _lockedPath !== null) return;

  const lp = lockPath(basePath);
  try {
    const data: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType,
      unitId,
      unitStartedAt: new Date().toISOString(),
      completedUnits,
      sessionFile,
    };
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch {
    // Non-fatal: lock update failure
  }
}

/**
 * Validate that we still own the session lock.
 *
 * Returns true if we still hold the lock, false if another process
 * has taken over (indicating we should gracefully stop).
 *
 * This is called periodically during the dispatch loop.
 */
export function getSessionLockStatus(basePath: string): SessionLockStatus {
  // Lock was compromised by proper-lockfile (mtime drift from sleep, stall, etc.)
  if (_lockCompromised) {
    // Recovery gate (#1512): Before declaring the lock lost, check if the lock
    // file still contains our PID. If it does, no other process took over — the
    // onCompromised fired from benign mtime drift (laptop sleep, event loop stall
    // beyond the stale window). Attempt re-acquisition instead of giving up.
    const lp = lockPath(basePath);
    const existing = readExistingLockData(lp);
    if (existing && existing.pid === process.pid) {
      // Lock file still ours — try to re-acquire the OS lock
      try {
        const result = acquireSessionLock(basePath);
        if (result.acquired) {
          process.stderr.write(
            `[gsd] Lock recovered after onCompromised — lock file PID matched, re-acquired.\n`,
          );
          return { valid: true, recovered: true };
        }
      } catch {
        // Re-acquisition failed — fall through to return false
      }
    }
    return {
      valid: false,
      failureReason: "compromised",
      existingPid: existing?.pid,
      expectedPid: process.pid,
    };
  }

  // If we have an OS-level lock, we're still the owner
  if (_releaseFunction && _lockedPath === basePath) {
    return { valid: true };
  }

  // Fallback: check the lock file PID
  const lp = lockPath(basePath);
  const existing = readExistingLockData(lp);
  if (!existing) {
    // Lock file was deleted — we lost ownership
    return {
      valid: false,
      failureReason: "missing-metadata",
      expectedPid: process.pid,
    };
  }

  if (existing.pid !== process.pid) {
    return {
      valid: false,
      failureReason: "pid-mismatch",
      existingPid: existing.pid,
      expectedPid: process.pid,
    };
  }

  return { valid: true };
}

export function validateSessionLock(basePath: string): boolean {
  return getSessionLockStatus(basePath).valid;
}

/**
 * Release the session lock. Called on clean stop/pause.
 */
export function releaseSessionLock(basePath: string): void {
  // Release the OS-level lock
  if (_releaseFunction) {
    try {
      _releaseFunction();
    } catch {
      // Lock may already be released
    }
    _releaseFunction = null;
  }

  // Remove the lock file
  const lp = lockPath(basePath);
  try {
    if (existsSync(lp)) unlinkSync(lp);
  } catch {
    // Non-fatal
  }

  // Remove the proper-lockfile directory (.gsd.lock/) if it exists.
  // proper-lockfile creates this directory as the OS-level lock mechanism.
  // If the process exits without calling _releaseFunction (SIGKILL, crash),
  // this directory is stranded and blocks the next session (#1245).
  try {
    const lockDir = join(gsdRoot(basePath) + ".lock");
    if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }

  // Clean up numbered lock file variants from cloud sync conflicts (#1315)
  cleanupStrayLockFiles(basePath);

  _lockedPath = null;
  _lockPid = 0;
  _lockCompromised = false;
  _lockAcquiredAt = 0;
  _snapshotLockPath = null;
}

/**
 * Check if a session lock exists and return its data (for crash recovery).
 * Does NOT acquire the lock.
 */
export function readSessionLockData(basePath: string): SessionLockData | null {
  return readExistingLockData(lockPath(basePath));
}

/**
 * Check if the process that wrote the lock is still alive.
 */
export function isSessionLockProcessAlive(data: SessionLockData): boolean {
  return isPidAlive(data.pid);
}

/**
 * Returns true if we currently hold a session lock for the given path.
 */
export function isSessionLockHeld(basePath: string): boolean {
  return _lockedPath === basePath && _lockPid === process.pid;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function readExistingLockData(lp: string): SessionLockData | null {
  try {
    if (!existsSync(lp)) return null;
    const raw = readFileSync(lp, "utf-8");
    return JSON.parse(raw) as SessionLockData;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}
