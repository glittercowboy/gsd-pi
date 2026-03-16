/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import { existsSync, cpSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./worktree-manager.js";
import {
  MergeConflictError,
} from "./git-service.js";
import { parseRoadmap } from "./files.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  nativeGetCurrentBranch,
  nativeWorkingTreeStatus,
  nativeAddAll,
  nativeCommit,
  nativeCheckoutBranch,
  nativeMergeSquash,
  nativeConflictFiles,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeRmForce,
  nativeBranchDelete,
} from "./native-git-bridge.js";

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

// ─── Git Helpers (local, mirrors worktree-command.ts pattern) ──────────────

function resolveGitHeadPath(dir: string): string | null {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (content.startsWith("gitdir: ")) {
      const gitDir = resolve(dir, content.slice(8));
      const headPath = join(gitDir, "HEAD");
      return existsSync(headPath) ? headPath : null;
    }
    const headPath = join(dir, ".git", "HEAD");
    return existsSync(headPath) ? headPath : null;
  } catch {
    return null;
  }
}

/**
 * Nudge pi's FooterDataProvider to re-read the git branch after chdir.
 * Touches HEAD in both old and new cwd to fire the fs watcher.
 */
function nudgeGitBranchCache(previousCwd: string): void {
  const now = new Date();
  for (const dir of [previousCwd, process.cwd()]) {
    try {
      const headPath = resolveGitHeadPath(dir);
      if (headPath) utimesSync(headPath, now, now);
    } catch {
      // Best-effort
    }
  }
}

// ─── Auto-Worktree Branch Naming ───────────────────────────────────────────

export function autoWorktreeBranch(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new auto-worktree for a milestone, chdir into it, and store
 * the original base path for later teardown.
 *
 * Atomic: chdir + originalBase update happen in the same try block
 * to prevent split-brain.
 */
export function createAutoWorktree(basePath: string, milestoneId: string): string {
  const branch = autoWorktreeBranch(milestoneId);
  const info = createWorktree(basePath, milestoneId, { branch });

  // Copy .gsd/ planning artifacts from the source repo into the new worktree.
  // Worktrees are fresh git checkouts — untracked files don't carry over.
  // Planning artifacts may be untracked if the project's .gitignore had a
  // blanket .gsd/ rule (pre-v2.14.0). Without this copy, auto-mode loops
  // on plan-slice because the plan file doesn't exist in the worktree.
  copyPlanningArtifacts(basePath, info.path);

  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    originalBase = basePath;
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't store originalBase -- caller can retry or clean up.
    throw new Error(
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return info.path;
}

/**
 * Copy .gsd/ planning artifacts from source repo to a new worktree.
 * Copies milestones/, DECISIONS.md, REQUIREMENTS.md, PROJECT.md, QUEUE.md.
 * Skips runtime files (auto.lock, metrics.json, etc.) and the worktrees/ dir.
 * Best-effort — failures are non-fatal since auto-mode can recreate artifacts.
 */
function copyPlanningArtifacts(srcBase: string, wtPath: string): void {
  const srcGsd = join(srcBase, ".gsd");
  const dstGsd = join(wtPath, ".gsd");
  if (!existsSync(srcGsd)) return;

  // Copy milestones/ directory (planning files, roadmaps, plans, research)
  const srcMilestones = join(srcGsd, "milestones");
  if (existsSync(srcMilestones)) {
    try {
      cpSync(srcMilestones, join(dstGsd, "milestones"), { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }

  // Copy top-level planning files
  for (const file of ["DECISIONS.md", "REQUIREMENTS.md", "PROJECT.md", "QUEUE.md"]) {
    const src = join(srcGsd, file);
    if (existsSync(src)) {
      try {
        cpSync(src, join(dstGsd, file), { force: true });
      } catch { /* non-fatal */ }
    }
  }
}

/**
 * Teardown an auto-worktree: chdir back to original base, then remove
 * the worktree and its branch.
 */
export function teardownAutoWorktree(originalBasePath: string, milestoneId: string): void {
  const branch = autoWorktreeBranch(milestoneId);
  const previousCwd = process.cwd();

  try {
    process.chdir(originalBasePath);
    originalBase = null;
  } catch (err) {
    throw new Error(
      `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  removeWorktree(originalBasePath, milestoneId, { branch });
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Checks both module state and git branch prefix.
 */
export function isInAutoWorktree(basePath: string): boolean {
  if (!originalBase) return false;
  const cwd = process.cwd();
  const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : basePath;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return false;
  const branch = nativeGetCurrentBranch(cwd);
  return branch.startsWith("milestone/");
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist.
 */
export function getAutoWorktreePath(basePath: string, milestoneId: string): string | null {
  const p = worktreePath(basePath, milestoneId);
  return existsSync(p) ? p : null;
}

/**
 * Enter an existing auto-worktree (chdir into it, store originalBase).
 * Use for resume -- the worktree already exists from a prior create.
 *
 * Atomic: chdir + originalBase update in same try block.
 */
export function enterAutoWorktree(basePath: string, milestoneId: string): string {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new Error(`Auto-worktree for ${milestoneId} does not exist at ${p}`);
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    originalBase = basePath;
  } catch (err) {
    throw new Error(
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return p;
}

/**
 * Get the original project root stored when entering an auto-worktree.
 * Returns null if not currently in an auto-worktree.
 */
export function getAutoWorktreeOriginalBase(): string | null {
  return originalBase;
}

// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAll(cwd);
    const result = nativeCommit(cwd, "chore: auto-commit before milestone merge");
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Squash-merge the milestone branch into main with a rich commit message
 * listing all completed slices, then tear down the worktree.
 *
 * Sequence:
 *  1. Auto-commit dirty worktree state
 *  2. chdir to originalBasePath
 *  3. git checkout main
 *  4. git merge --squash milestone/<MID>
 *  5. git commit with rich message
 *  6. Auto-push if enabled
 *  7. Delete milestone branch
 *  8. Remove worktree directory
 *  9. Clear originalBase
 *
 * On merge conflict: throws MergeConflictError.
 * On "nothing to commit" after squash: handles gracefully (no error).
 */
export function mergeMilestoneToMain(
  originalBasePath_: string,
  milestoneId: string,
  roadmapContent: string,
): { commitMessage: string; pushed: boolean } {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);

  // 1. Auto-commit dirty state in worktree before leaving
  autoCommitDirtyState(worktreeCwd);

  // 2. Parse roadmap for slice listing
  const roadmap = parseRoadmap(roadmapContent);
  const completedSlices = roadmap.slices.filter(s => s.done);

  // 3. chdir to original base
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);

  // 4. Resolve main branch from preferences
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const mainBranch = prefs.main_branch || "main";

  // 5. Checkout main
  nativeCheckoutBranch(originalBasePath_, mainBranch);

  // 6. Build rich commit message
  const milestoneTitle = roadmap.title.replace(/^M\d+:\s*/, "").trim() || milestoneId;
  const subject = `feat(${milestoneId}): ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices.map(s => `- ${s.id}: ${s.title}`).join("\n");
    body = `\n\nCompleted slices:\n${sliceLines}\n\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 7. Squash merge — auto-resolve .gsd/ state file conflicts (#530)
  const mergeResult = nativeMergeSquash(originalBasePath_, milestoneBranch);

  if (!mergeResult.success) {
    // Check for conflicts — use merge result first, fall back to nativeConflictFiles
    const conflictedFiles = mergeResult.conflicts.length > 0
      ? mergeResult.conflicts
      : nativeConflictFiles(originalBasePath_);

    if (conflictedFiles.length > 0) {
      // Separate .gsd/ state file conflicts from real code conflicts.
      // GSD state files (STATE.md, completed-units.json, auto.lock, etc.)
      // diverge between branches during normal operation — always prefer the
      // milestone branch version since it has the latest execution state.
      const gsdConflicts = conflictedFiles.filter(f => f.startsWith(".gsd/"));
      const codeConflicts = conflictedFiles.filter(f => !f.startsWith(".gsd/"));

      // Auto-resolve .gsd/ conflicts by accepting the milestone branch version
      if (gsdConflicts.length > 0) {
        for (const gsdFile of gsdConflicts) {
          try {
            nativeCheckoutTheirs(originalBasePath_, [gsdFile]);
            nativeAddPaths(originalBasePath_, [gsdFile]);
          } catch {
            // If checkout --theirs fails, try removing the file from the merge
            // (it's a runtime file that shouldn't be committed anyway)
            nativeRmForce(originalBasePath_, [gsdFile]);
          }
        }
      }

      // If there are still non-.gsd conflicts, escalate
      if (codeConflicts.length > 0) {
        throw new MergeConflictError(codeConflicts, "squash", milestoneBranch, mainBranch);
      }
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
  }

  // 8. Commit (handle nothing-to-commit gracefully)
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;

  // 9. Auto-push if enabled
  let pushed = false;
  if (prefs.auto_push === true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    try {
      execSync(`git push ${remote} ${mainBranch}`, {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      pushed = true;
    } catch {
      // Push failure is non-fatal
    }
  }

  // 10. Remove worktree directory first (must happen before branch deletion)
  try {
    removeWorktree(originalBasePath_, milestoneId, { branch: null as unknown as string, deleteBranch: false });
  } catch {
    // Best-effort -- worktree dir may already be gone
  }

  // 11. Delete milestone branch (after worktree removal so ref is unlocked)
  try {
    nativeBranchDelete(originalBasePath_, milestoneBranch);
  } catch {
    // Best-effort
  }

  // 12. Clear module state
  originalBase = null;
  nudgeGitBranchCache(previousCwd);

  return { commitMessage, pushed };
}
