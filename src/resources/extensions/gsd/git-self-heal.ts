/**
 * git-self-heal.ts — Automated git state recovery utilities.
 *
 * Four synchronous functions for recovering from broken git state
 * during auto-mode operations. Uses only `git reset --hard HEAD` —
 * never `git clean` (which would delete untracked .gsd/ dirs).
 *
 * Observability: Each function returns structured results describing
 * what actions were taken. `formatGitError` maps raw git errors to
 * user-friendly messages suggesting `/gsd doctor`.
 */

import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MergeConflictError } from "./git-service.js";

// Re-export for consumers
export { MergeConflictError };

/** Result from abortAndReset describing what was cleaned up. */
export interface AbortAndResetResult {
  /** List of actions taken, e.g. ["aborted merge", "removed SQUASH_MSG", "reset to HEAD"] */
  cleaned: string[];
}

/**
 * Detect and clean up leftover merge/rebase state, then hard-reset.
 *
 * Checks for: .git/MERGE_HEAD, .git/SQUASH_MSG, .git/rebase-apply.
 * Aborts in-progress merge or rebase if detected. Always finishes
 * with `git reset --hard HEAD`.
 *
 * @returns Structured result listing what was cleaned. Empty `cleaned`
 *          array means repo was already in a clean state.
 */
export function abortAndReset(cwd: string): AbortAndResetResult {
  const gitDir = join(cwd, ".git");
  const cleaned: string[] = [];

  // Abort in-progress merge
  if (existsSync(join(gitDir, "MERGE_HEAD"))) {
    try {
      execSync("git merge --abort", { cwd, stdio: "pipe" });
      cleaned.push("aborted merge");
    } catch {
      // merge --abort can fail if state is really broken; continue to reset
      cleaned.push("merge abort attempted (may have failed)");
    }
  }

  // Remove leftover SQUASH_MSG (squash-merge leaves this without MERGE_HEAD)
  const squashMsgPath = join(gitDir, "SQUASH_MSG");
  if (existsSync(squashMsgPath)) {
    try {
      unlinkSync(squashMsgPath);
      cleaned.push("removed SQUASH_MSG");
    } catch {
      // Not critical
    }
  }

  // Abort in-progress rebase
  if (existsSync(join(gitDir, "rebase-apply")) || existsSync(join(gitDir, "rebase-merge"))) {
    try {
      execSync("git rebase --abort", { cwd, stdio: "pipe" });
      cleaned.push("aborted rebase");
    } catch {
      cleaned.push("rebase abort attempted (may have failed)");
    }
  }

  // Always hard-reset to HEAD
  try {
    execSync("git reset --hard HEAD", { cwd, stdio: "pipe" });
    if (cleaned.length > 0) {
      cleaned.push("reset to HEAD");
    }
  } catch {
    cleaned.push("reset to HEAD failed");
  }

  return { cleaned };
}

/** Known git error patterns mapped to user-friendly messages. */
const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /conflict|CONFLICT|merge conflict/i,
    message: "A merge conflict occurred. Code changes on different branches touched the same files. Run `/gsd doctor` to diagnose.",
  },
  {
    pattern: /cannot checkout|did not match any|pathspec .* did not match/i,
    message: "Git could not switch branches — the target branch may not exist or the working tree is dirty. Run `/gsd doctor` to diagnose.",
  },
  {
    pattern: /HEAD detached|detached HEAD/i,
    message: "Git is in a detached HEAD state — not on any branch. Run `/gsd doctor` to diagnose and reattach.",
  },
  {
    pattern: /\.lock|Unable to create .* lock|lock file/i,
    message: "A git lock file is blocking operations. Another git process may be running, or a previous one crashed. Run `/gsd doctor` to diagnose.",
  },
  {
    pattern: /fatal: not a git repository/i,
    message: "This directory is not a git repository. Run `/gsd doctor` to check your project setup.",
  },
];

/**
 * Translate raw git error strings into user-friendly messages.
 *
 * Pattern-matches against common git error strings and returns
 * a non-technical message suggesting `/gsd doctor`. Returns the
 * original message if no pattern matches.
 */
export function formatGitError(error: string | Error): string {
  const errorStr = error instanceof Error ? error.message : error;

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(errorStr)) {
      return message;
    }
  }

  return `A git error occurred: ${errorStr.slice(0, 200)}. Run \`/gsd doctor\` for help.`;
}
