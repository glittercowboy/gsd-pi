/**
 * GSD Worktree Manager
 *
 * Creates and manages git worktrees under .gsd/worktrees/<name>/.
 * Each worktree gets its own branch (worktree/<name>) and a full
 * working copy of the project, enabling parallel work streams.
 *
 * The merge helper compares .gsd/ artifacts between a worktree and
 * the main branch, then dispatches an LLM-guided merge flow.
 *
 * Flow:
 *   1. create()  — git worktree add .gsd/worktrees/<name> -b worktree/<name>
 *   2. user works in the worktree (new plans, milestones, etc.)
 *   3. merge()   — LLM-guided reconciliation of .gsd/ artifacts back to main
 *   4. remove()  — git worktree remove + branch cleanup
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  nativeBranchDelete,
  nativeBranchExists,
  nativeBranchForceReset,
  nativeCommit,
  nativeDetectMainBranch,
  nativeDiffContent,
  nativeDiffNameStatus,
  nativeDiffNumstat,
  nativeGetCurrentBranch,
  nativeLogOneline,
  nativeMergeSquash,
  nativeWorktreeAdd,
  nativeWorktreeList,
  nativeWorktreePrune,
  nativeWorktreeRemove,
} from "./native-git-bridge.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  exists: boolean;
}

/** Per-file line change stats from git diff --numstat. */
export interface FileLineStat {
  file: string;
  added: number;
  removed: number;
}

export interface WorktreeDiffSummary {
  /** Files only in the worktree .gsd/ (new artifacts) */
  added: string[];
  /** Files in both but with different content */
  modified: string[];
  /** Files only in main .gsd/ (deleted in worktree) */
  removed: string[];
}

// ─── Path Helpers ──────────────────────────────────────────────────────────

function normalizePathForComparison(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function getMainBranch(basePath: string): string {
  return nativeDetectMainBranch(basePath);
}

export function worktreesDir(basePath: string): string {
  return join(basePath, ".gsd", "worktrees");
}

export function worktreePath(basePath: string, name: string): string {
  return join(worktreesDir(basePath), name);
}

export function worktreeBranchName(name: string): string {
  return `worktree/${name}`;
}

// ─── Core Operations ───────────────────────────────────────────────────────

/**
 * Create a new git worktree under .gsd/worktrees/<name>/ with branch worktree/<name>.
 * The branch is created from the current HEAD of the main branch.
 *
 * @param opts.branch — override the default `worktree/<name>` branch name
 */
export function createWorktree(basePath: string, name: string, opts: { branch?: string } = {}): WorktreeInfo {
  // Validate name: alphanumeric, hyphens, underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid worktree name "${name}". Use only letters, numbers, hyphens, and underscores.`);
  }

  const wtPath = worktreePath(basePath, name);
  const branch = opts.branch ?? worktreeBranchName(name);

  if (existsSync(wtPath)) {
    throw new Error(`Worktree "${name}" already exists at ${wtPath}`);
  }

  // Ensure the .gsd/worktrees/ directory exists
  const wtDir = worktreesDir(basePath);
  mkdirSync(wtDir, { recursive: true });

  // Prune any stale worktree entries from a previous removal
  nativeWorktreePrune(basePath);

  // Check if the branch already exists (leftover from a previous worktree)
  const branchAlreadyExists = nativeBranchExists(basePath, branch);
  const mainBranch = nativeDetectMainBranch(basePath);

  if (branchAlreadyExists) {
    // Check if the branch is actively used by an existing worktree.
    const worktreeEntries = nativeWorktreeList(basePath);
    const branchInUse = worktreeEntries.some(entry => entry.branch === branch);

    if (branchInUse) {
      throw new Error(
        `Branch "${branch}" is already in use by another worktree. ` +
        `Remove the existing worktree first with /worktree remove ${name}.`,
      );
    }

    // Reset the stale branch to current main, then attach worktree to it
    nativeBranchForceReset(basePath, branch, mainBranch);
    nativeWorktreeAdd(basePath, wtPath, branch);
  } else {
    nativeWorktreeAdd(basePath, wtPath, branch, true, mainBranch);
  }

  return {
    name,
    path: wtPath,
    branch,
    exists: true,
  };
}

/**
 * List all GSD-managed worktrees.
 * Uses native worktree list and filters to those under .gsd/worktrees/.
 */
export function listWorktrees(basePath: string): WorktreeInfo[] {
  const baseVariants = [resolve(basePath)];
  if (existsSync(basePath)) {
    baseVariants.push(realpathSync(basePath));
  }
  const seenRoots = new Set<string>();
  const worktreeRoots = baseVariants
    .map(baseVariant => {
      const path = join(baseVariant, ".gsd", "worktrees");
      return {
        normalized: normalizePathForComparison(path),
      };
    })
    .filter(root => {
      if (seenRoots.has(root.normalized)) return false;
      seenRoots.add(root.normalized);
      return true;
    });

  const entries = nativeWorktreeList(basePath);

  if (!entries.length) return [];

  const worktrees: WorktreeInfo[] = [];

  for (const entry of entries) {
    if (entry.isBare) continue;

    const entryPath = entry.path;
    const branch = entry.branch;

    if (!branch) continue;

    const branchWorktreeName = branch.startsWith("worktree/")
      ? branch.slice("worktree/".length)
      : branch.startsWith("milestone/")
        ? branch.slice("milestone/".length)
        : null;

    const entryVariants = [resolve(entryPath)];
    if (existsSync(entryPath)) {
      entryVariants.push(realpathSync(entryPath));
    }
    const normalizedEntryVariants = [...new Set(entryVariants.map(normalizePathForComparison))];
    const matchedRoot = worktreeRoots.find(root =>
      normalizedEntryVariants.some(entryVariant => entryVariant.startsWith(`${root.normalized}/`)),
    );
    const matchesBranchLeaf = branchWorktreeName
      ? normalizedEntryVariants.some(entryVariant => entryVariant.split("/").pop() === branchWorktreeName)
      : false;

    // Only include worktrees under .gsd/worktrees/
    if (!matchedRoot && !matchesBranchLeaf) continue;

    const matchedEntryPath = normalizedEntryVariants.find(entryVariant =>
      matchedRoot ? entryVariant.startsWith(`${matchedRoot.normalized}/`) : false,
    );
    let name = matchedRoot ? matchedEntryPath?.slice(matchedRoot.normalized.length + 1) ?? "" : "";

    // Git on Windows can report a path form that does not map cleanly back to the
    // repo root even when the branch naming is still authoritative.
    if ((!name || name.includes("/")) && branchWorktreeName && matchesBranchLeaf) {
      name = branchWorktreeName;
    }

    if (!name || name.includes("/")) continue;

    const resolvedEntryPath = existsSync(entryPath) ? realpathSync(entryPath) : resolve(entryPath);

    worktrees.push({
      name,
      path: resolvedEntryPath,
      branch,
      exists: existsSync(resolvedEntryPath),
    });
  }

  return worktrees;
}

/**
 * Remove a worktree and optionally delete its branch.
 * If the process is currently inside the worktree, chdir out first.
 */
export function removeWorktree(
  basePath: string,
  name: string,
  opts: { deleteBranch?: boolean; force?: boolean; branch?: string } = {},
): void {
  const wtPath = worktreePath(basePath, name);
  const resolvedWtPath = existsSync(wtPath) ? realpathSync(wtPath) : wtPath;
  const branch = opts.branch ?? worktreeBranchName(name);
  const { deleteBranch = true, force = true } = opts;

  // If we're inside the worktree, move out first — git can't remove an in-use directory
  const cwd = process.cwd();
  const resolvedCwd = existsSync(cwd) ? realpathSync(cwd) : cwd;
  if (resolvedCwd === resolvedWtPath || resolvedCwd.startsWith(resolvedWtPath + sep)) {
    process.chdir(basePath);
  }

  if (!existsSync(wtPath)) {
    nativeWorktreePrune(basePath);
    if (deleteBranch) {
      try { nativeBranchDelete(basePath, branch, true); } catch { /* branch may not exist */ }
    }
    return;
  }

  // Remove worktree (force if requested, to handle dirty worktrees)
  try { nativeWorktreeRemove(basePath, wtPath, force); } catch { /* may fail */ }

  // If the directory is still there (e.g. locked), try harder with force
  if (existsSync(wtPath)) {
    try { nativeWorktreeRemove(basePath, wtPath, true); } catch { /* may fail */ }
  }

  // Prune stale entries so git knows the worktree is gone
  nativeWorktreePrune(basePath);

  if (deleteBranch) {
    try { nativeBranchDelete(basePath, branch, true); } catch { /* branch may not exist */ }
  }
}

/** Paths to skip in all worktree diffs (internal/runtime artifacts). */
const SKIP_PATHS = [".gsd/worktrees/", ".gsd/runtime/", ".gsd/activity/"];
const SKIP_EXACT = [".gsd/STATE.md", ".gsd/auto.lock", ".gsd/metrics.json"];

function shouldSkipPath(filePath: string): boolean {
  if (SKIP_PATHS.some(p => filePath.startsWith(p))) return true;
  if (SKIP_EXACT.includes(filePath)) return true;
  return false;
}

function parseDiffNameStatus(entries: { status: string; path: string }[]): WorktreeDiffSummary {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const { status, path } of entries) {
    if (shouldSkipPath(path)) continue;

    switch (status) {
      case "A": added.push(path); break;
      case "M": modified.push(path); break;
      case "D": removed.push(path); break;
      default:
        // Renames, copies — treat as modified
        if (status?.startsWith("R") || status?.startsWith("C")) {
          modified.push(path);
        }
    }
  }

  return { added, modified, removed };
}

/**
 * Diff the .gsd/ directory between the worktree branch and main branch.
 * Returns a summary of added, modified, and removed GSD artifacts.
 */
export function diffWorktreeGSD(basePath: string, name: string): WorktreeDiffSummary {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  const entries = nativeDiffNameStatus(basePath, mainBranch, branch, ".gsd/", true);

  return parseDiffNameStatus(entries);
}

/**
 * Diff ALL files between the worktree branch and main branch.
 * Uses direct diff (no merge-base) to show what will actually change
 * on main when the merge is applied. If both branches have identical
 * content, this correctly returns an empty diff.
 */
export function diffWorktreeAll(basePath: string, name: string): WorktreeDiffSummary {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  const entries = nativeDiffNameStatus(basePath, mainBranch, branch);

  return parseDiffNameStatus(entries);
}

/**
 * Get per-file line addition/deletion stats for what will change on main.
 * Uses direct diff (not merge-base) so the preview matches the actual merge outcome.
 */
export function diffWorktreeNumstat(basePath: string, name: string): FileLineStat[] {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  const rawStats = nativeDiffNumstat(basePath, mainBranch, branch);

  const stats: FileLineStat[] = [];
  for (const entry of rawStats) {
    if (shouldSkipPath(entry.path)) continue;
    stats.push({ file: entry.path, added: entry.added, removed: entry.removed });
  }
  return stats;
}

/**
 * Get the full diff content for .gsd/ between the worktree branch and main.
 * Returns the raw unified diff for LLM consumption.
 */
export function getWorktreeGSDDiff(basePath: string, name: string): string {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  return nativeDiffContent(basePath, mainBranch, branch, ".gsd/", undefined, true);
}

/**
 * Get the full diff content for non-.gsd/ files between the worktree branch and main.
 * Returns the raw unified diff for LLM consumption.
 */
export function getWorktreeCodeDiff(basePath: string, name: string): string {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  return nativeDiffContent(basePath, mainBranch, branch, undefined, ".gsd/", true);
}

/**
 * Get commit log for the worktree branch since it diverged from main.
 */
export function getWorktreeLog(basePath: string, name: string): string {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);

  const entries = nativeLogOneline(basePath, mainBranch, branch);

  return entries.map(e => `${e.sha} ${e.message}`).join("\n");
}

/**
 * Merge the worktree branch into main using squash merge.
 * Must be called from the main working tree (not the worktree itself).
 * Returns the merge commit message.
 */
export function mergeWorktreeToMain(basePath: string, name: string, commitMessage: string): string {
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const current = nativeGetCurrentBranch(basePath);

  if (current !== mainBranch) {
    throw new Error(`Must be on ${mainBranch} to merge. Currently on ${current}.`);
  }

  const result = nativeMergeSquash(basePath, branch);
  if (!result.success) {
    throw new Error(`Merge conflicts detected in: ${result.conflicts.join(", ")}`);
  }

  nativeCommit(basePath, commitMessage);

  return commitMessage;
}
