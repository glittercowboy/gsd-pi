/**
 * Pre-unit git checkpoint and rollback for auto-mode safety harness.
 * Uses the existing refs/gsd/ namespace (already pruned by doctor).
 *
 * Creates a lightweight ref at HEAD before unit execution. On failure,
 * the ref can be used to rollback the branch to the pre-unit state.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { execFileSync } from "node:child_process";
import { logWarning } from "../workflow-logger.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CHECKPOINT_PREFIX = "refs/gsd/checkpoints/";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a checkpoint ref at the current HEAD for the given unit.
 * Returns the SHA of HEAD, or null if the operation fails.
 */
export function createCheckpoint(basePath: string, unitId: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

    if (!sha || sha.length < 7) return null;

    // Sanitize unitId for use in ref path (replace / with -)
    const safeUnitId = unitId.replace(/\//g, "-");

    execFileSync("git", ["update-ref", `${CHECKPOINT_PREFIX}${safeUnitId}`, sha], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return sha;
  } catch (e) {
    logWarning("safety", `checkpoint creation failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Rollback the current branch to a checkpoint SHA.
 * Returns true on success, false on failure.
 *
 * WARNING: This is a destructive operation — it discards all changes
 * since the checkpoint. Only call when the user has opted in via
 * safety_harness.auto_rollback or an explicit manual trigger.
 */
export function rollbackToCheckpoint(
  basePath: string,
  unitId: string,
  sha: string,
): boolean {
  try {
    // Get current branch name
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();

    if (!branch || branch === "HEAD") {
      logWarning("safety", "rollback: detached HEAD state, cannot rollback");
      return false;
    }

    // Reset branch pointer and working tree to checkpoint SHA in one step.
    // Using `git reset --hard <sha>` works on the currently checked-out branch
    // (unlike `git branch -f` which is rejected for checked-out branches).
    execFileSync("git", ["reset", "--hard", sha], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Cleanup checkpoint ref
    cleanupCheckpoint(basePath, unitId);

    return true;
  } catch (e) {
    logWarning("safety", `rollback failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Remove a checkpoint ref after successful unit completion.
 */
export function cleanupCheckpoint(basePath: string, unitId: string): void {
  try {
    const safeUnitId = unitId.replace(/\//g, "-");
    execFileSync("git", ["update-ref", "-d", `${CHECKPOINT_PREFIX}${safeUnitId}`], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Non-fatal — ref may already have been cleaned up
  }
}
