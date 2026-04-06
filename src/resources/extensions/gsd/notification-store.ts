// GSD Extension — Persistent Notification Store
// Captures all ctx.ui.notify() calls and workflow-logger warnings to
// .gsd/notifications.jsonl so they survive context resets and session restarts.
// Rotates at MAX_ENTRIES to prevent unbounded growth.

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export type NotifySeverity = "info" | "success" | "warning" | "error";
export type NotificationSource = "notify" | "workflow-logger";

export interface NotificationEntry {
  id: string;
  ts: string;
  severity: NotifySeverity;
  message: string;
  source: NotificationSource;
  read: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const FILENAME = "notifications.jsonl";
const LOCKFILE = "notifications.lock";

// ─── Module State ───────────────────────────────────────────────────────

let _basePath: string | null = null;
let _lineCount = 0;  // Hint for rotation — not authoritative for public API
let _suppressCount = 0;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the notification store. Call once at session start with the
 * project root. Seeds in-memory counters from the existing file on disk.
 */
export function initNotificationStore(basePath: string): void {
  _basePath = basePath;
  // Seed line count hint for rotation — public counters read from disk
  _lineCount = _readEntriesFromDisk(basePath).length;
}

/**
 * Append a notification entry to the store. Synchronous — safe to call
 * from the notify() shim which is declared void (not async).
 */
export function appendNotification(
  message: string,
  severity: NotifySeverity,
  source: NotificationSource = "notify",
): void {
  if (!_basePath) return;
  if (_suppressCount > 0) return;

  const entry: NotificationEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    severity,
    message: message.length > 500 ? message.slice(0, 500) + "…" : message,
    source,
    read: false,
  };

  try {
    const dir = join(_basePath, ".gsd");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, FILENAME), JSON.stringify(entry) + "\n", "utf-8");
    _lineCount++;

    // Rotate if hint suggests we're over limit
    if (_lineCount > MAX_ENTRIES) {
      _rotate();
    }
  } catch {
    // Non-fatal — never let persistence break the caller
  }
}

/**
 * Read all notification entries from disk. Returns newest-first.
 */
export function readNotifications(basePath?: string): NotificationEntry[] {
  const bp = basePath ?? _basePath;
  if (!bp) return [];
  return _readEntriesFromDisk(bp).reverse();
}

/**
 * Mark all notifications as read. Atomic rewrite via temp-file + rename.
 * Resyncs in-memory counters from disk after mutation.
 */
export function markAllRead(basePath?: string): void {
  const bp = basePath ?? _basePath;
  if (!bp) return;

  const entries = _readEntriesFromDisk(bp);
  if (entries.length === 0) return;

  const hasUnread = entries.some((e) => !e.read);
  if (!hasUnread) return;

  try {
    _withLock(bp, () => {
      // Re-read inside lock to get freshest state
      const fresh = _readEntriesFromDisk(bp);
      if (fresh.length === 0 || !fresh.some((e) => !e.read)) return;
      const lines = fresh.map((e) => JSON.stringify({ ...e, read: true }));
      _atomicWrite(bp, lines.join("\n") + "\n");
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Clear all notifications. Atomic write of empty content under lock.
 */
export function clearNotifications(basePath?: string): void {
  const bp = basePath ?? _basePath;
  if (!bp) return;

  try {
    _withLock(bp, () => {
      _atomicWrite(bp, "");
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Get the current unread count. Reads from disk to stay accurate across
 * processes (web subprocess can clear/modify the file independently).
 */
export function getUnreadCount(): number {
  if (!_basePath) return 0;
  try {
    const entries = _readEntriesFromDisk(_basePath);
    return entries.filter((e) => !e.read).length;
  } catch {
    return 0;
  }
}

/**
 * Get the total notification count. Reads from disk for cross-process accuracy.
 */
export function getLineCount(): number {
  if (!_basePath) return 0;
  try {
    return _readEntriesFromDisk(_basePath).length;
  } catch {
    return 0;
  }
}

/**
 * Temporarily suppress persistence. Use around ctx.ui.notify calls that
 * should NOT be persisted (e.g., confirmation toasts after clear).
 * Calls are ref-counted — nest safely.
 */
export function suppressPersistence(): void {
  _suppressCount++;
}

export function unsuppressPersistence(): void {
  _suppressCount = Math.max(0, _suppressCount - 1);
}

// ─── Test Helpers ───────────────────────────────────────────────────────

/**
 * Reset module state. Only for use in tests.
 */
export function _resetNotificationStore(): void {
  _basePath = null;
  _lineCount = 0;
  _suppressCount = 0;
}

// ─── Internal ───────────────────────────────────────────────────────────

function _readEntriesFromDisk(basePath: string): NotificationEntry[] {
  const filePath = join(basePath, ".gsd", FILENAME);
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as NotificationEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is NotificationEntry => e !== null);
  } catch {
    return [];
  }
}

function _rotate(): void {
  if (!_basePath) return;
  try {
    _withLock(_basePath, () => {
      // Re-read inside lock to get freshest state
      const entries = _readEntriesFromDisk(_basePath!);
      if (entries.length <= MAX_ENTRIES) return;
      const trimmed = entries.slice(entries.length - MAX_ENTRIES);
      const lines = trimmed.map((e) => JSON.stringify(e));
      _atomicWrite(_basePath!, lines.join("\n") + "\n");
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Atomic file rewrite via temp-file + rename. Prevents partial reads
 * by other processes (web API subprocess, parallel workers).
 * Must be called inside _withLock for cross-process safety.
 */
function _atomicWrite(basePath: string, content: string): void {
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, FILENAME);
  const tmp = target + ".tmp." + process.pid;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, target);
}

/**
 * Acquire an exclusive lockfile for rewrite operations.
 * Uses O_CREAT|O_EXCL for atomic creation — if the file exists, another
 * process holds the lock. Retries briefly, then proceeds anyway (best-effort)
 * to avoid deadlocking the UI on a stale lock.
 */
function _withLock<T>(basePath: string, fn: () => T): T {
  const lockPath = join(basePath, ".gsd", LOCKFILE);
  let fd: number | null = null;
  const maxAttempts = 5;
  const retryMs = 20;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      mkdirSync(join(basePath, ".gsd"), { recursive: true });
      fd = openSync(lockPath, "wx");
      break;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        // Check if lock is stale (older than 5s)
        try {
          const stat = readFileSync(lockPath, "utf-8");
          const lockTime = parseInt(stat, 10);
          if (Date.now() - lockTime > 5000) {
            try { unlinkSync(lockPath); } catch { /* race ok */ }
            continue;
          }
        } catch { /* can't read lock, retry */ }

        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < retryMs) { /* spin */ }
        continue;
      }
      // Other error — proceed without lock
      break;
    }
  }

  try {
    // Write our PID timestamp into the lock for stale detection
    if (fd !== null) {
      writeFileSync(lockPath, String(Date.now()), "utf-8");
      closeSync(fd);
    }
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
  }
}
