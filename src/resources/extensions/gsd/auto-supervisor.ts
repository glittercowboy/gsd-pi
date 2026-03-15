/**
 * Auto-mode Supervisor — SIGTERM handling and working-tree activity detection.
 *
 * Pure functions — no module-level globals or AutoContext dependency.
 */

import { clearLock } from "./crash-recovery.js";
import { execSync } from "node:child_process";

// ─── SIGTERM Handling ─────────────────────────────────────────────────────────

/**
 * Register a SIGTERM handler that clears the lock file and exits cleanly.
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
  if (previousHandler) process.off("SIGTERM", previousHandler);
  const handler = () => {
    clearLock(currentBasePath);
    process.exit(0);
  };
  process.on("SIGTERM", handler);
  return handler;
}

/** Deregister the SIGTERM handler (called on stop/pause). */
export function deregisterSigtermHandler(handler: (() => void) | null): void {
  if (handler) {
    process.off("SIGTERM", handler);
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
    const out = execSync("git status --porcelain", {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}
