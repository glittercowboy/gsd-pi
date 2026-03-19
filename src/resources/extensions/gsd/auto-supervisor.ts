/**
 * Auto-mode Supervisor — signal handling and working-tree activity detection.
 *
 * Pure functions — no module-level globals or AutoContext dependency.
 */

import { clearLock } from "./crash-recovery.js";
import { releaseSessionLock } from "./session-lock.js";
import { nativeHasChanges } from "./native-git-bridge.js";

// ─── Signal Handling ──────────────────────────────────────────────────────────

/**
 * Register SIGTERM and SIGINT handlers that clear lock files and exit cleanly.
 * Captures the active base path at registration time so the handler
 * always references the correct path even if the module variable changes.
 * Removes any previously registered handler before installing the new one.
 *
 * Returns the new handler so the caller can store and deregister it later.
 */
export function registerSigtermHandler(
  currentBasePath: string,
  previousHandler: (() => void) | null,
): () => void {
  if (previousHandler) {
    process.off("SIGTERM", previousHandler);
    process.off("SIGINT", previousHandler);
  }
  const handler = () => {
    releaseSessionLock(currentBasePath);
    clearLock(currentBasePath);
    process.exit(0);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return handler;
}

/** Deregister signal handlers (called on stop/pause). */
export function deregisterSigtermHandler(handler: (() => void) | null): void {
  if (handler) {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  }
}

// ─── Working Tree Activity Detection ──────────────────────────────────────────

/**
 * Detect whether the agent is producing work on disk by checking git for
 * any working-tree changes (staged, unstaged, or untracked). Returns true
 * if there are uncommitted changes — meaning the agent is actively working,
 * even though it hasn't signaled progress through runtime records.
 */
export function detectWorkingTreeActivity(cwd: string): boolean {
  try {
    return nativeHasChanges(cwd);
  } catch {
    return false;
  }
}
