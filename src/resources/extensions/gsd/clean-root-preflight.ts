/**
 * clean-root-preflight.ts — Preflight gate for dirty working trees before milestone merges.
 *
 * #2909: Adds a fast-path git status check before milestone completion merges.
 * When the working tree is dirty the user is warned and changes are auto-stashed
 * so the merge can proceed cleanly.  After the merge completes, postflightPopStash
 * restores the stashed changes.
 *
 * Design constraints (from Trek-e approval):
 *  - Warn the user before stashing (no silent surprises)
 *  - git stash push / git stash pop only — no custom stash management layer
 *  - Stash/pop errors are logged but MUST NOT block the merge
 *  - Fast-path status check — clean trees pay no extra cost
 */

import { execFileSync } from "node:child_process";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { logWarning } from "./workflow-logger.js";
import { nativeHasChanges } from "./native-git-bridge.js";

export interface PreflightResult {
  /** true when a stash was pushed and postflightPopStash should be called */
  stashPushed: boolean;
  /** human-readable summary of what happened (empty string for clean trees) */
  summary: string;
}

/**
 * Check the working tree for dirty files before a milestone merge.
 *
 * Clean tree path: O(1) — returns immediately with stashPushed=false.
 *
 * Dirty tree path:
 *  1. Emits a warning notification via the provided `notify` callback.
 *  2. Runs `git stash push --include-untracked -m "gsd-preflight-stash"`.
 *  3. Returns stashPushed=true so the caller knows to call postflightPopStash.
 *
 * Any stash error is logged but does NOT throw — the merge proceeds regardless.
 */
export function preflightCleanRoot(
  basePath: string,
  milestoneId: string,
  notify: (message: string, level: "info" | "warning" | "error") => void,
): PreflightResult {
  // Fast-path: clean tree — nothing to do
  let isDirty = false;
  try {
    isDirty = nativeHasChanges(basePath);
  } catch (err) {
    // If the status check itself fails, treat as clean and let the merge decide
    logWarning("preflight", `clean-root status check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { stashPushed: false, summary: "" };
  }

  if (!isDirty) {
    return { stashPushed: false, summary: "" };
  }

  // Warn the user before stashing
  const warnMsg = `Working tree has uncommitted changes before milestone ${milestoneId} merge. Auto-stashing to allow clean merge (stash will be restored after merge).`;
  notify(warnMsg, "warning");

  // Push the stash
  try {
    execFileSync("git", ["stash", "push", "--include-untracked", "-m", "gsd-preflight-stash"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
    return {
      stashPushed: true,
      summary: `Stashed uncommitted changes before merge (milestone ${milestoneId}).`,
    };
  } catch (err) {
    // Stash failure is non-fatal — log and let the merge attempt proceed
    const msg = `git stash push failed before merge of milestone ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`;
    logWarning("preflight", msg);
    notify(`Auto-stash failed before milestone ${milestoneId} merge — proceeding anyway. ${msg}`, "warning");
    return { stashPushed: false, summary: `stash-push-failed: ${msg}` };
  }
}

/**
 * Restore stashed changes after a milestone merge completes.
 *
 * Only called when preflightCleanRoot returned stashPushed=true.
 * Any pop error (e.g. conflict) is logged and notified but does NOT throw —
 * the merge already completed successfully.
 */
export function postflightPopStash(
  basePath: string,
  milestoneId: string,
  notify: (message: string, level: "info" | "warning" | "error") => void,
): void {
  try {
    execFileSync("git", ["stash", "pop"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
    notify(`Restored stashed changes after milestone ${milestoneId} merge.`, "info");
  } catch (err) {
    // Pop conflicts mean the merged code collides with the stashed changes.
    // Log a warning — the user needs to resolve manually, but the merge succeeded.
    const msg = `git stash pop failed after merge of milestone ${milestoneId}: ${err instanceof Error ? err.message : String(err)}. Run "git stash pop" manually to restore your changes.`;
    logWarning("preflight", msg);
    notify(msg, "warning");
  }
}
