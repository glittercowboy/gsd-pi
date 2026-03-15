/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import { existsSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  getSliceBranchName,
} from "./worktree.js";
import {
  MergeConflictError,
  inferCommitType,
} from "./git-service.js";
import type { MergeSliceResult } from "./git-service.js";
import { recoverCheckout, withMergeHeal } from "./git-self-heal.js";
import {
  nativeBranchExists,
  nativeCommitCountBetween,
} from "./native-git-bridge.js";
import { parseRoadmap } from "./files.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

// ─── Isolation Resolver ────────────────────────────────────────────────────

/**
 * Determine whether auto-mode should use worktree isolation.
 *
 * Resolution order:
 *  1. Explicit git.isolation preference -> return (isolation === "worktree")
 *  2. Legacy detection: if gsd branches exist -> return false (branch mode)
 *  3. Default: return true (worktree mode for new projects)
 */
export function shouldUseWorktreeIsolation(basePath: string, overridePrefs?: { isolation?: string }): boolean {
  const prefs = overridePrefs ?? loadEffectiveGSDPreferences()?.preferences?.git;
  if (prefs?.isolation) {
    return prefs.isolation === "worktree";
  }

  // Legacy detection: check for existing gsd/*/* branches (branch-per-slice pattern)
  try {
    // Use unquoted glob pattern — single quotes are not interpreted by cmd.exe on Windows,
    // causing the pattern to match literally instead of as a glob.
    const output = execSync("git branch --list gsd/*/*", {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (output) return false; // Legacy branch-per-slice project
  } catch {
    // If git command fails, default to worktree
  }

  return true; // New project default
}

/**
 * Resolve the merge_to_main preference value.
 * Returns "milestone" (default) or "slice".
 */
export function getMergeToMainMode(): "milestone" | "slice" {
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
  return prefs?.merge_to_main ?? "milestone";
}

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

function getCurrentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
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
  const branch = getCurrentBranch(cwd);
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

// ─── Merge Slice -> Milestone ───────────────────────────────────────────────

/**
 * Merge a completed slice branch into the milestone branch via `--no-ff`.
 *
 * Worktree-mode merge: `.gsd/` is local to the worktree (not tracked in
 * git), so there are zero `.gsd/` conflict resolution concerns. No runtime
 * exclusion untracking, no `--theirs` checkout, no snapshot creation.
 *
 * On conflict: throws MergeConflictError with conflicted file list.
 * On success: deletes the slice branch and returns MergeSliceResult.
 */
export function mergeSliceToMilestone(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
): MergeSliceResult {
  if (!isInAutoWorktree(basePath)) {
    throw new Error("mergeSliceToMilestone called outside auto-worktree");
  }

  const cwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);
  const worktreeName = detectWorktreeName(cwd);
  const sliceBranch = getSliceBranchName(milestoneId, sliceId, worktreeName);

  // Verify slice branch exists
  if (!nativeBranchExists(cwd, sliceBranch)) {
    throw new Error(`Slice branch "${sliceBranch}" does not exist`);
  }

  // Verify slice has commits ahead of milestone branch
  const commitCount = nativeCommitCountBetween(cwd, milestoneBranch, sliceBranch);
  if (commitCount === 0) {
    throw new Error(
      `Slice branch "${sliceBranch}" has no commits ahead of "${milestoneBranch}"`,
    );
  }

  // Checkout milestone branch (with self-healing reset)
  recoverCheckout(cwd, milestoneBranch);

  // Build rich commit message (replicates GitServiceImpl.buildRichCommitMessage format)
  const commitType = inferCommitType(sliceTitle);
  const subject = `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`;

  let message = subject;
  try {
    const logOutput = execSync(
      `git log --oneline --format=%s ${milestoneBranch}..${sliceBranch}`,
      { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();

    if (logOutput) {
      const subjects = logOutput.split("\n").filter(Boolean);
      const MAX_ENTRIES = 20;
      const truncated = subjects.length > MAX_ENTRIES;
      const displayed = truncated ? subjects.slice(0, MAX_ENTRIES) : subjects;
      const taskLines = displayed.map(s => `- ${s}`).join("\n");
      const truncationLine = truncated
        ? `\n- ... and ${subjects.length - MAX_ENTRIES} more`
        : "";
      message = `${subject}\n\nTasks:\n${taskLines}${truncationLine}\n\nBranch: ${sliceBranch}`;
    }
  } catch {
    // Fall back to subject-only message
  }

  // Merge --no-ff (with self-healing retry for transient failures)
  try {
    withMergeHeal(cwd, () => {
      execFileSync("git", ["merge", "--no-ff", "-m", message, sliceBranch], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      // Re-throw with correct branch context
      throw new MergeConflictError(
        err.conflictedFiles,
        err.strategy,
        sliceBranch,
        milestoneBranch,
      );
    }
    throw err;
  }

  // Delete slice branch
  let deletedBranch = false;
  try {
    execSync(`git branch -d ${sliceBranch}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    deletedBranch = true;
  } catch {
    // Branch deletion is best-effort
  }

  return {
    branch: sliceBranch,
    mergedCommitMessage: message,
    deletedBranch,
  };
}

// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (!status) return false;
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "chore: auto-commit before milestone merge"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return true;
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

  // 5. Checkout main (with self-healing reset)
  recoverCheckout(originalBasePath_, mainBranch);

  // 6. Build rich commit message
  const milestoneTitle = roadmap.title.replace(/^M\d+:\s*/, "").trim() || milestoneId;
  const subject = `feat(${milestoneId}): ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices.map(s => `- ${s.id}: ${s.title}`).join("\n");
    body = `\n\nCompleted slices:\n${sliceLines}\n\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 7. Squash merge (with self-healing retry for transient failures)
  try {
    withMergeHeal(originalBasePath_, () => {
      execSync(`git merge --squash ${milestoneBranch}`, {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      // Re-throw with correct branch context
      throw new MergeConflictError(
        err.conflictedFiles,
        err.strategy,
        milestoneBranch,
        mainBranch,
      );
    }
    // Possibly "already up to date" -- fall through to commit which will handle nothing-to-commit
  }

  // 8. Commit (handle nothing-to-commit gracefully)
  let nothingToCommit = false;
  try {
    execFileSync("git", ["commit", "-m", commitMessage], {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    // execSync errors have stdout/stderr as properties -- check those for git's message
    const errObj = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [errObj.stdout, errObj.stderr, errObj.message].filter(Boolean).join(" ");
    if (combined.includes("nothing to commit") || combined.includes("nothing added to commit") || combined.includes("no changes added")) {
      nothingToCommit = true;
    } else {
      throw err;
    }
  }

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
    execSync(`git branch -D ${milestoneBranch}`, {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch {
    // Best-effort
  }

  // 12. Clear module state
  originalBase = null;
  nudgeGitBranchCache(previousCwd);

  return { commitMessage, pushed };
}
