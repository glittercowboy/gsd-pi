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
  MergeConflictError,
} from "./git-service.js";
import { parseRoadmap } from "./files.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

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

  // 5. Checkout main
  execSync(`git checkout ${mainBranch}`, {
    cwd: originalBasePath_,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  // 6. Build rich commit message
  const milestoneTitle = roadmap.title.replace(/^M\d+:\s*/, "").trim() || milestoneId;
  const subject = `feat(${milestoneId}): ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices.map(s => `- ${s.id}: ${s.title}`).join("\n");
    body = `\n\nCompleted slices:\n${sliceLines}\n\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 7. Squash merge
  try {
    execSync(`git merge --squash ${milestoneBranch}`, {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch (mergeErr) {
    // Check for real conflicts
    try {
      const conflictOutput = execSync("git diff --name-only --diff-filter=U", {
        cwd: originalBasePath_,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (conflictOutput) {
        const conflictedFiles = conflictOutput.split("\n").filter(Boolean);
        throw new MergeConflictError(conflictedFiles, "squash", milestoneBranch, mainBranch);
      }
    } catch (diffErr) {
      if (diffErr instanceof MergeConflictError) throw diffErr;
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
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
