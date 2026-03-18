/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import { existsSync, readFileSync, realpathSync, unlinkSync, statSync, rmSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { GSDError, GSD_IO_ERROR, GSD_GIT_ERROR } from "./errors.js";
import { execSync, execFileSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./worktree-manager.js";
import { detectWorktreeName, resolveGitHeadPath, nudgeGitBranchCache } from "./worktree.js";
import { ensureGsdSymlink } from "./repo-identity.js";
import {
  MergeConflictError,
  readIntegrationBranch,
} from "./git-service.js";
import { parseRoadmap } from "./files.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { gsdRoot } from "./paths.js";
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
  nativeBranchExists,
} from "./native-git-bridge.js";

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

// ─── Worktree Post-Create Hook (#597) ────────────────────────────────────────

/**
 * Run the user-configured post-create hook script after worktree creation.
 * The script receives SOURCE_DIR and WORKTREE_DIR as environment variables.
 * Failure is non-fatal — returns the error message or null on success.
 *
 * Reads the hook path from git.worktree_post_create in preferences.
 * Pass hookPath directly to bypass preference loading (useful for testing).
 */
export function runWorktreePostCreateHook(sourceDir: string, worktreeDir: string, hookPath?: string): string | null {
  if (hookPath === undefined) {
    const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
    hookPath = prefs?.worktree_post_create;
  }
  if (!hookPath) return null;

  // Resolve relative paths against the source project root
  const resolved = isAbsolute(hookPath) ? hookPath : join(sourceDir, hookPath);
  if (!existsSync(resolved)) {
    return `Worktree post-create hook not found: ${resolved}`;
  }

  try {
    execSync(resolved, {
      cwd: worktreeDir,
      env: {
        ...process.env,
        SOURCE_DIR: sourceDir,
        WORKTREE_DIR: worktreeDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 30_000, // 30 second timeout
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Worktree post-create hook failed: ${msg}`;
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

  // Check if the milestone branch already exists — it survives auto-mode
  // stop/pause and contains committed work from prior sessions. If it exists,
  // re-attach the worktree to it WITHOUT resetting. Only create a fresh branch
  // from the integration branch when no prior work exists.
  const branchExists = nativeBranchExists(basePath, branch);

  let info: { name: string; path: string; branch: string; exists: boolean };
  if (branchExists) {
    // Re-attach worktree to the existing milestone branch (preserving commits)
    info = createWorktree(basePath, milestoneId, { branch, reuseExistingBranch: true });
  } else {
    // Fresh start — create branch from integration branch
    const integrationBranch = readIntegrationBranch(basePath, milestoneId) ?? undefined;
    info = createWorktree(basePath, milestoneId, { branch, startPoint: integrationBranch });
  }

  // Ensure worktree shares external state via symlink
  ensureGsdSymlink(info.path);

  // Run user-configured post-create hook (#597) — e.g. copy .env, symlink assets
  const hookError = runWorktreePostCreateHook(basePath, info.path);
  if (hookError) {
    // Non-fatal — log but don't prevent worktree usage
    console.error(`[GSD] ${hookError}`);
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    originalBase = basePath;
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't store originalBase -- caller can retry or clean up.
    throw new GSDError(
      GSD_IO_ERROR,
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
export function teardownAutoWorktree(
  originalBasePath: string,
  milestoneId: string,
  opts: { preserveBranch?: boolean } = {},
): void {
  const branch = autoWorktreeBranch(milestoneId);
  const { preserveBranch = false } = opts;
  const previousCwd = process.cwd();

  try {
    process.chdir(originalBasePath);
    originalBase = null;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  removeWorktree(originalBasePath, milestoneId, { branch, deleteBranch: !preserveBranch });
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Checks both module state and git branch prefix.
 */
export function isInAutoWorktree(basePath: string): boolean {
  const cwd = process.cwd();

  // Primary check: use originalBase if available (fast path)
  if (originalBase) {
    const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : basePath;
    const wtDir = join(gsdRoot(resolvedBase), "worktrees");
    if (!cwd.startsWith(wtDir)) return false;
    const branch = nativeGetCurrentBranch(cwd);
    return branch.startsWith("milestone/");
  }

  // Fallback: infer worktree status structurally when originalBase is null
  // (happens after session restart where module-level state is lost, #1120).
  // Check if cwd is inside a .gsd/worktrees/ directory and has a .git file
  // (worktree marker) pointing to the main repo.
  const worktreeMarker = join(cwd, ".git");
  if (!existsSync(worktreeMarker)) return false;
  try {
    const stat = statSync(worktreeMarker);
    if (stat.isDirectory()) return false; // Main repo has .git dir, not file
    // Worktrees have a .git file with "gitdir: ..." pointing to the main repo
    const gitContent = readFileSync(worktreeMarker, "utf-8").trim();
    if (!gitContent.startsWith("gitdir:")) return false;
    // Verify we're inside a GSD-managed worktree
    if (!detectWorktreeName(cwd)) return false;
    const branch = nativeGetCurrentBranch(cwd);
    return branch.startsWith("milestone/");
  } catch {
    return false;
  }
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist
 * or is not a valid git worktree.
 *
 * Validates that the path is a real git worktree (has a .git file with a
 * gitdir: pointer) rather than just a stray directory. This prevents
 * mis-detection of leftover directories as active worktrees (#695).
 */
export function getAutoWorktreePath(basePath: string, milestoneId: string): string | null {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) return null;

  // Validate this is a real git worktree, not a stray directory.
  // A git worktree has a .git *file* (not directory) containing "gitdir: <path>".
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) return null;
  } catch {
    return null;
  }

  return p;
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
    throw new GSDError(GSD_IO_ERROR, `Auto-worktree for ${milestoneId} does not exist at ${p}`);
  }

  // Validate this is a real git worktree, not a stray directory (#695)
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) {
    throw new GSDError(GSD_GIT_ERROR, `Auto-worktree path ${p} exists but is not a git worktree (no .git)`);
  }
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) {
      throw new GSDError(GSD_GIT_ERROR, `Auto-worktree path ${p} has a .git but it is not a worktree gitdir pointer`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("worktree")) throw err;
    throw new GSDError(GSD_IO_ERROR, `Auto-worktree path ${p} exists but .git is unreadable`);
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    originalBase = basePath;
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
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

export function getActiveAutoWorktreeContext(): {
  originalBase: string;
  worktreeName: string;
  branch: string;
} | null {
  if (!originalBase) return null;
  const cwd = process.cwd();
  const resolvedBase = existsSync(originalBase) ? realpathSync(originalBase) : originalBase;
  const wtDir = join(gsdRoot(resolvedBase), "worktrees");
  if (!cwd.startsWith(wtDir)) return null;
  const worktreeName = detectWorktreeName(cwd);
  if (!worktreeName) return null;
  const branch = nativeGetCurrentBranch(cwd);
  if (!branch.startsWith("milestone/")) return null;
  return {
    originalBase,
    worktreeName,
    branch,
  };
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
): { commitMessage: string; pushed: boolean; prCreated: boolean } {
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

  // 3a. Auto-commit any dirty state in the project root. Without this, the
  // squash merge can fail with "Your local changes would be overwritten" (#1127).
  autoCommitDirtyState(originalBasePath_);

  // 3b. Remove untracked .gsd/ runtime files that syncStateToProjectRoot copied.
  // Only clean specific runtime files — NEVER touch milestones/, decisions, or
  // other planning artifacts that represent user work (#1250).
  const runtimeFilesToClean = ["STATE.md", "completed-units.json", "auto.lock", "gsd.db"];
  for (const f of runtimeFilesToClean) {
    const p = join(originalBasePath_, ".gsd", f);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* non-fatal */ }
  }
  try {
    const runtimeDir = join(originalBasePath_, ".gsd", "runtime");
    if (existsSync(runtimeDir)) rmSync(runtimeDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }

  // 4. Resolve integration branch — prefer milestone metadata, fall back to preferences / "main"
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const integrationBranch = readIntegrationBranch(originalBasePath_, milestoneId);
  const mainBranch = integrationBranch ?? prefs.main_branch ?? "main";

  // 5. Checkout integration branch (skip if already current — avoids git error
  //    when main is already checked out in the project-root worktree, #757)
  const currentBranchAtBase = nativeGetCurrentBranch(originalBasePath_);
  if (currentBranchAtBase !== mainBranch) {
    // Remove untracked .gsd/ state files that may conflict with the branch
    // being checked out. These are regenerated by doctor/rebuildState and
    // are not meaningful in the main working tree — the worktree had the
    // real state. Without this, `git checkout main` fails with
    // "Your local changes would be overwritten" (#827).
    const gsdStateFiles = ["STATE.md", "completed-units.json", "auto.lock"];
    for (const f of gsdStateFiles) {
      const p = join(gsdRoot(originalBasePath_), f);
      try { unlinkSync(p); } catch { /* non-fatal — file may not exist */ }
    }
    nativeCheckoutBranch(originalBasePath_, mainBranch);
  }

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

  // 9b. Auto-create PR if enabled (requires push_branches + push succeeded)
  let prCreated = false;
  if (prefs.auto_pr === true && pushed) {
    const remote = prefs.remote ?? "origin";
    const prTarget = prefs.pr_target_branch ?? mainBranch;
    try {
      // Push the milestone branch to remote first
      execSync(`git push ${remote} ${milestoneBranch}`, {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      // Create PR via gh CLI
      execSync(
        `gh pr create --base "${prTarget}" --head "${milestoneBranch}" --title "Milestone ${milestoneId} complete" --body "Auto-created by GSD on milestone completion."`,
        {
          cwd: originalBasePath_,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8",
        },
      );
      prCreated = true;
    } catch {
      // PR creation failure is non-fatal — gh may not be installed or authenticated
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

  return { commitMessage, pushed, prCreated };
}
