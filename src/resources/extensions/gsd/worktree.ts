/**
 * GSD Worktree Utilities
 *
 * Pure utility functions for worktree name detection, legacy branch name
 * parsing, and integration branch capture.
 *
 * Pure utility functions (detectWorktreeName, getSliceBranchName, parseSliceBranch,
 * SLICE_BRANCH_RE) remain standalone for backwards compatibility.
 *
 * Branchless architecture: all work commits sequentially on the milestone branch.
 * Pure utility functions (detectWorktreeName, getSliceBranchName, parseSliceBranch,
 * SLICE_BRANCH_RE) remain for backwards compatibility with legacy branches.
 */

import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { GitServiceImpl, writeIntegrationBranch, type TaskCommitContext } from "./git-service.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

export { MergeConflictError } from "./git-service.js";
export type { TaskCommitContext } from "./git-service.js";

// ─── Lazy GitServiceImpl Cache ─────────────────────────────────────────────

let cachedService: GitServiceImpl | null = null;
let cachedBasePath: string | null = null;

/**
 * Get or create a GitServiceImpl for the given basePath.
 * Resets the cache if basePath changes between calls.
 * Lazy construction: only instantiated at call-time, never at module-evaluation.
 */
function getService(basePath: string): GitServiceImpl {
  if (cachedService === null || cachedBasePath !== basePath) {
    const loaded = loadEffectiveGSDPreferences();
    const gitPrefs = loaded?.preferences?.git ?? {};
    cachedService = new GitServiceImpl(basePath, gitPrefs);
    cachedBasePath = basePath;
  }
  return cachedService;
}

/**
 * Set the active milestone ID on the cached GitServiceImpl.
 * This enables integration branch resolution in getMainBranch().
 */
export function setActiveMilestoneId(basePath: string, milestoneId: string | null): void {
  getService(basePath).setMilestoneId(milestoneId);
}

/**
 * Record the current branch as the integration branch for a milestone.
 * Called once when auto-mode starts — captures where slice branches should
 * merge back to. No-op if the same branch is already recorded. Updates the
 * record when the user starts from a different branch (#300). Always a no-op
 * if on a GSD slice branch.
 */
export function captureIntegrationBranch(basePath: string, milestoneId: string, options?: { commitDocs?: boolean }): void {
  // In a worktree, the base branch is implicit (worktree/<name>).
  // Writing it to META.json would leave stale metadata after merge back to main.
  if (detectWorktreeName(basePath)) return;
  const svc = getService(basePath);
  const current = svc.getCurrentBranch();
  writeIntegrationBranch(basePath, milestoneId, current, options);
}

// ─── Pure Utility Functions (unchanged) ────────────────────────────────────

/**
 * Find the worktrees segment in a path, supporting both direct
 * (`/.gsd/worktrees/`) and symlink-resolved (`/.gsd/projects/<hash>/worktrees/`)
 * layouts.  When `.gsd` is a symlink to `~/.gsd/projects/<hash>`, resolved
 * paths contain the intermediate `projects/<hash>/` segment that the old
 * single-marker check missed.
 */
function findWorktreeSegment(normalizedPath: string): { gsdIdx: number; afterWorktrees: number } | null {
  // Direct layout: /.gsd/worktrees/<name>
  const directMarker = "/.gsd/worktrees/";
  const idx = normalizedPath.indexOf(directMarker);
  if (idx !== -1) {
    return { gsdIdx: idx, afterWorktrees: idx + directMarker.length };
  }
  // Symlink-resolved layout: /.gsd/projects/<hash>/worktrees/<name>
  const symlinkRe = /\/\.gsd\/projects\/[a-f0-9]+\/worktrees\//;
  const match = normalizedPath.match(symlinkRe);
  if (match && match.index !== undefined) {
    return { gsdIdx: match.index, afterWorktrees: match.index + match[0].length };
  }
  return null;
}

/**
 * Detect the active worktree name from the current working directory.
 * Returns null if not inside a GSD worktree (.gsd/worktrees/<name>/).
 */
export function detectWorktreeName(basePath: string): string | null {
  const normalizedPath = basePath.replaceAll("\\", "/");
  const seg = findWorktreeSegment(normalizedPath);
  if (!seg) return null;
  const afterMarker = normalizedPath.slice(seg.afterWorktrees);
  const name = afterMarker.split("/")[0];
  return name || null;
}

/**
 * Resolve the project root from a path that may be inside a worktree.
 * If the path contains a worktrees segment, returns the portion before
 * `/.gsd/`. Otherwise returns the input unchanged.
 *
 * Use this in commands that call `process.cwd()` to ensure they always
 * operate against the real project root, not a worktree subdirectory.
 */
export function resolveProjectRoot(basePath: string): string {
  const normalizedPath = basePath.replaceAll("\\", "/");
  const seg = findWorktreeSegment(normalizedPath);
  if (!seg) return basePath;
  // Return the original path up to the /.gsd/ boundary
  const sep = basePath.includes("\\") ? "\\" : "/";
  const gsdMarker = `${sep}.gsd${sep}`;
  const gsdIdx = basePath.indexOf(gsdMarker);
  if (gsdIdx !== -1) return basePath.slice(0, gsdIdx);
  return basePath.slice(0, seg.gsdIdx);
}

/**
 * Get the slice branch name, namespaced by worktree when inside one.
 *
 * In the main tree:     gsd/<milestoneId>/<sliceId>
 * In a worktree:        gsd/<worktreeName>/<milestoneId>/<sliceId>
 *
 * This prevents branch conflicts when multiple worktrees work on the
 * same milestone/slice IDs — git doesn't allow a branch to be checked
 * out in more than one worktree simultaneously.
 */
export function getSliceBranchName(milestoneId: string, sliceId: string, worktreeName?: string | null): string {
  if (worktreeName) {
    return `gsd/${worktreeName}/${milestoneId}/${sliceId}`;
  }
  return `gsd/${milestoneId}/${sliceId}`;
}

/** Regex that matches both plain and worktree-namespaced slice branches. */
export const SLICE_BRANCH_RE = /^gsd\/(?:([a-zA-Z0-9_-]+)\/)?(M\d+(?:-[a-z0-9]{6})?)\/(S\d+)$/;

/**
 * Parse a slice branch name into its components.
 * Handles both `gsd/M001/S01` and `gsd/myworktree/M001/S01`.
 */
export function parseSliceBranch(branchName: string): {
  worktreeName: string | null;
  milestoneId: string;
  sliceId: string;
} | null {
  const match = branchName.match(SLICE_BRANCH_RE);
  if (!match) return null;
  return {
    worktreeName: match[1] ?? null,
    milestoneId: match[2]!,
    sliceId: match[3]!,
  };
}

// ─── Git-Mutation Functions (delegate to GitServiceImpl) ───────────────────

/**
 * Get the "main" branch for GSD slice operations.
 *
 * In the main working tree: returns main/master (the repo's default branch).
 * In a worktree: returns worktree/<name> — the worktree's own base branch.
 *
 * This is critical because git doesn't allow a branch to be checked out
 * in more than one worktree. Slice branches merge into the worktree's base
 * branch, and the worktree branch later merges into the real main via
 * /worktree merge.
 */
export function getMainBranch(basePath: string): string {
  return getService(basePath).getMainBranch();
}

export function getCurrentBranch(basePath: string): string {
  return getService(basePath).getCurrentBranch();
}

/**
 * Auto-commit any dirty files in the current working tree.
 *
 * When `taskContext` is provided, generates a meaningful conventional commit
 * message from the task summary (one-liner, inferred type, key files).
 * Falls back to a generic `chore()` message for non-task commits.
 *
 * Returns the commit message used, or null if already clean.
 */
export function autoCommitCurrentBranch(
  basePath: string, unitType: string, unitId: string,
  taskContext?: TaskCommitContext,
): string | null {
  return getService(basePath).autoCommit(unitType, unitId, [], taskContext);
}

// ─── Git HEAD Resolution ────────────────────────────────────────────────────

/**
 * Resolve the git HEAD file path for a given directory.
 * Handles both normal repos (.git is a directory) and worktrees (.git is a file
 * containing a `gitdir:` pointer to the real gitdir).
 */
export function resolveGitHeadPath(dir: string): string | null {
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
export function nudgeGitBranchCache(previousCwd: string): void {
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
