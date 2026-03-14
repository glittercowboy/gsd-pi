/**
 * GSD Slice Branch Management — Thin Facade
 *
 * Simple branch-per-slice workflow. No worktrees, no registry.
 * Runtime state (metrics, activity, lock, STATE.md) is gitignored
 * so branch switches are clean.
 *
 * All git-mutation functions delegate to GitServiceImpl from git-service.ts.
 * Pure utility functions (detectWorktreeName, getSliceBranchName, parseSliceBranch,
 * SLICE_BRANCH_RE) remain standalone.
 *
 * Flow:
 *   1. ensureSliceBranch() — create + checkout slice branch
 *   2. agent does work, commits
 *   3. mergeSliceToMain() — checkout integration branch, squash-merge, delete slice branch
 */

import { sep } from "node:path";

import { GitServiceImpl, writeIntegrationBranch } from "./git-service.ts";
import { loadEffectiveGSDPreferences } from "./preferences.ts";

// Re-export MergeSliceResult from the canonical source (D014 — type-only re-export)
export type { MergeSliceResult } from "./git-service.ts";
export { MergeConflictError } from "./git-service.ts";

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
 * merge back to. No-op if already recorded or if on a GSD slice branch.
 */
export function captureIntegrationBranch(basePath: string, milestoneId: string): void {
  const svc = getService(basePath);
  const current = svc.getCurrentBranch();
  writeIntegrationBranch(basePath, milestoneId, current);
}

// ─── Pure Utility Functions (unchanged) ────────────────────────────────────

/**
 * Detect the active worktree name from the current working directory.
 * Returns null if not inside a GSD worktree (.gsd/worktrees/<name>/).
 */
export function detectWorktreeName(basePath: string): string | null {
  const marker = `${sep}.gsd${sep}worktrees${sep}`;
  const idx = basePath.indexOf(marker);
  if (idx === -1) return null;
  const afterMarker = basePath.slice(idx + marker.length);
  const name = afterMarker.split(sep)[0] ?? afterMarker.split("/")[0];
  return name || null;
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
 * Ensure the slice branch exists and is checked out.
 * Creates the branch from the current branch if it's not a slice branch,
 * otherwise from main. This preserves planning artifacts (CONTEXT, ROADMAP,
 * etc.) that were committed on the working branch — which may differ from
 * the repo's default branch (e.g. `developer` vs `main`).
 * When inside a worktree, the branch is namespaced to avoid conflicts.
 * Returns true if the branch was newly created.
 */
export function ensureSliceBranch(basePath: string, milestoneId: string, sliceId: string): boolean {
  return getService(basePath).ensureSliceBranch(milestoneId, sliceId);
}

/**
 * Auto-commit any dirty files in the current working tree.
 * Returns the commit message used, or null if already clean.
 */
export function autoCommitCurrentBranch(
  basePath: string, unitType: string, unitId: string,
): string | null {
  return getService(basePath).autoCommit(unitType, unitId);
}

/**
 * Switch to the integration branch, auto-committing any dirty files on the current branch first.
 */
export function switchToMain(basePath: string): void {
  getService(basePath).switchToMain();
}

/**
 * Squash-merge a completed slice branch into the integration branch.
 * Expects to already be on the integration branch (call switchToMain first).
 * Deletes the slice branch after merge.
 */
export function mergeSliceToMain(
  basePath: string, milestoneId: string, sliceId: string, sliceTitle: string,
): import("./git-service.ts").MergeSliceResult {
  return getService(basePath).mergeSliceToMain(milestoneId, sliceId, sliceTitle);
}

// ─── Query Functions (delegate to GitServiceImpl) ──────────────────────────

/**
 * Check if we're currently on a slice branch (not main).
 * Handles both plain (gsd/M001/S01) and worktree-namespaced (gsd/wt/M001/S01) branches.
 */
export function isOnSliceBranch(basePath: string): boolean {
  const current = getCurrentBranch(basePath);
  return SLICE_BRANCH_RE.test(current);
}

/**
 * Get the active slice branch name, or null if on main.
 * Handles both plain and worktree-namespaced branch patterns.
 */
export function getActiveSliceBranch(basePath: string): string | null {
  try {
    const current = getCurrentBranch(basePath);
    return SLICE_BRANCH_RE.test(current) ? current : null;
  } catch {
    return null;
  }
}
