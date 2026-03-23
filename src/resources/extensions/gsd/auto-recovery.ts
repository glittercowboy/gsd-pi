/**
 * Auto-mode Recovery — merge state reconciliation and loop remediation steps.
 *
 * Pure functions that receive all needed state as parameters — no module-level
 * globals or AutoContext dependency.
 *
 * Note: Phase 4 (D-05) removed writeBlockerPlaceholder, skipExecuteTask, and
 * the runtime record self-heal function. Recovery blockers use engine.reportBlocker().
 * Phase 5 moved artifact path/verification helpers to auto-artifact-paths.ts.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import {
  nativeConflictFiles,
  nativeCommit,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeMergeAbort,
  nativeResetHard,
} from "./native-git-bridge.js";
import {
  relMilestoneFile,
  relSliceFile,
  relSlicePath,
  relTaskFile,
} from "./paths.js";
import {
  existsSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Check whether a milestone produced implementation artifacts (non-`.gsd/` files)
 * in the git history. Uses `git log --name-only` to inspect all commits on the
 * current branch that touch files outside `.gsd/`.
 *
 * Returns true if at least one non-`.gsd/` file was committed, false otherwise.
 * Non-fatal: returns true on git errors to avoid blocking the pipeline when
 * running outside a git repo (e.g., tests).
 */
export function hasImplementationArtifacts(basePath: string): boolean {
  try {
    // Verify we're in a git repo — fail open if not
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch {
      return true;
    }

    // Strategy: check `git diff --name-only` against the merge-base with the
    // main branch. This captures ALL files changed during the milestone's
    // lifetime. If no merge-base exists (e.g., single-branch workflow), fall
    // back to checking the last N commits.
    const mainBranch = detectMainBranch(basePath);
    const changedFiles = getChangedFilesSinceBranch(basePath, mainBranch);

    // No files changed at all — fail open (could be detached HEAD, single-
    // commit repo, or other edge case where git diff returns nothing).
    if (changedFiles.length === 0) return true;

    // Filter out .gsd/ files — only implementation files count.
    // If every changed file is under .gsd/, the milestone produced no
    // implementation code (#1703).
    const implFiles = changedFiles.filter(f => !f.startsWith(".gsd/") && !f.startsWith(".gsd\\"));
    return implFiles.length > 0;
  } catch {
    // Non-fatal — if git operations fail, don't block the pipeline
    return true;
  }
}

/**
 * Detect the main/master branch name.
 */
function detectMainBranch(basePath: string): string {
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "main";
  } catch {
    // main doesn't exist
  }
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "master"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (result.trim()) return "master";
  } catch {
    // master doesn't exist either
  }
  return "main"; // default fallback
}

/**
 * Get files changed since the branch diverged from the target branch.
 * Falls back to checking HEAD~20 if merge-base detection fails.
 */
function getChangedFilesSinceBranch(basePath: string, targetBranch: string): string[] {
  try {
    // Try merge-base approach first
    const mergeBase = execFileSync(
      "git", ["merge-base", targetBranch, "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();

    if (mergeBase) {
      const result = execFileSync(
        "git", ["diff", "--name-only", mergeBase, "HEAD"],
        { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      ).trim();
      return result ? result.split("\n").filter(Boolean) : [];
    }
  } catch {
    // merge-base failed — fall back
  }

  // Fallback: check last 20 commits
  try {
    const result = execFileSync(
      "git", ["log", "--name-only", "--pretty=format:", "-20", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();
    return result ? [...new Set(result.split("\n").filter(Boolean))] : [];
  } catch {
    return [];
  }
}

// writeBlockerPlaceholder removed (D-05) — replaced by engine.reportBlocker()
// skipExecuteTask removed (D-05) — replaced by engine.reportBlocker()
// Runtime record self-heal removed (D-05) — engine is authoritative, no stale record cleanup needed
// Artifact verification/path functions moved to auto-artifact-paths.ts (Phase 5)

// ─── Merge State Reconciliation ───────────────────────────────────────────────

/**
 * Detect leftover merge state from a prior session and reconcile it.
 * If MERGE_HEAD or SQUASH_MSG exists, check whether conflicts are resolved.
 * If resolved: finalize the commit. If still conflicted: abort and reset.
 *
 * Returns true if state was dirty and re-derivation is needed.
 */
export function reconcileMergeState(
  basePath: string,
  ctx: ExtensionContext,
): boolean {
  const mergeHeadPath = join(basePath, ".git", "MERGE_HEAD");
  const squashMsgPath = join(basePath, ".git", "SQUASH_MSG");
  const hasMergeHead = existsSync(mergeHeadPath);
  const hasSquashMsg = existsSync(squashMsgPath);
  if (!hasMergeHead && !hasSquashMsg) return false;

  const conflictedFiles = nativeConflictFiles(basePath);
  if (conflictedFiles.length === 0) {
    // All conflicts resolved — finalize the merge/squash commit
    try {
      nativeCommit(basePath, ""); // --no-edit equivalent: use empty message placeholder
      const mode = hasMergeHead ? "merge" : "squash commit";
      ctx.ui.notify(`Finalized leftover ${mode} from prior session.`, "info");
    } catch {
      // Commit may already exist; non-fatal
    }
  } else {
    // Still conflicted — try auto-resolving .gsd/ state file conflicts (#530)
    const gsdConflicts = conflictedFiles.filter((f) => f.startsWith(".gsd/"));
    const codeConflicts = conflictedFiles.filter((f) => !f.startsWith(".gsd/"));

    if (gsdConflicts.length > 0 && codeConflicts.length === 0) {
      // All conflicts are in .gsd/ state files — auto-resolve by accepting theirs
      let resolved = true;
      try {
        nativeCheckoutTheirs(basePath, gsdConflicts);
        nativeAddPaths(basePath, gsdConflicts);
      } catch {
        resolved = false;
      }
      if (resolved) {
        try {
          nativeCommit(
            basePath,
            "chore: auto-resolve .gsd/ state file conflicts",
          );
          ctx.ui.notify(
            `Auto-resolved ${gsdConflicts.length} .gsd/ state file conflict(s) from prior merge.`,
            "info",
          );
        } catch {
          resolved = false;
        }
      }
      if (!resolved) {
        if (hasMergeHead) {
          try {
            nativeMergeAbort(basePath);
          } catch {
            /* best-effort */
          }
        } else if (hasSquashMsg) {
          try {
            unlinkSync(squashMsgPath);
          } catch {
            /* best-effort */
          }
        }
        try {
          nativeResetHard(basePath);
        } catch {
          /* best-effort */
        }
        ctx.ui.notify(
          "Detected leftover merge state — auto-resolve failed, cleaned up. Re-deriving state.",
          "warning",
        );
      }
    } else {
      // Code conflicts present — abort and reset
      if (hasMergeHead) {
        try {
          nativeMergeAbort(basePath);
        } catch {
          /* best-effort */
        }
      } else if (hasSquashMsg) {
        try {
          unlinkSync(squashMsgPath);
        } catch {
          /* best-effort */
        }
      }
      try {
        nativeResetHard(basePath);
      } catch {
        /* best-effort */
      }
      ctx.ui.notify(
        "Detected leftover merge state with unresolved conflicts — cleaned up. Re-deriving state.",
        "warning",
      );
    }
  }
  return true;
}

// ─── Loop Remediation ─────────────────────────────────────────────────────────

/**
 * Build concrete, manual remediation steps for a loop-detected unit failure.
 * These are shown when automatic reconciliation is not possible.
 */
export function buildLoopRemediationSteps(
  unitType: string,
  unitId: string,
  base: string,
): string | null {
  const parts = unitId.split("/");
  const mid = parts[0];
  const sid = parts[1];
  const tid = parts[2];
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      const planRel = relSliceFile(base, mid, sid, "PLAN");
      const summaryRel = relTaskFile(base, mid, sid, tid, "SUMMARY");
      return [
        `   1. Write ${summaryRel} (even a partial summary is sufficient to unblock the pipeline)`,
        `   2. Mark ${tid} [x] in ${planRel}: change "- [ ] **${tid}:" → "- [x] **${tid}:"`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode — it will pick up from the next task`,
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel =
        unitType === "plan-slice"
          ? relSliceFile(base, mid, sid, "PLAN")
          : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Write the slice summary and UAT file for ${sid} in ${relSlicePath(base, mid, sid)}`,
        `   2. Mark ${sid} [x] in ${relMilestoneFile(base, mid, "ROADMAP")}`,
        `   3. Run \`gsd doctor\` to reconcile .gsd/ state`,
        `   4. Resume auto-mode`,
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd doctor\``,
        `   3. Resume auto-mode`,
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
