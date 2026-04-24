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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { GSDError, GSD_PARSE_ERROR, GSD_STALE_STATE, GSD_LOCK_HELD, GSD_GIT_ERROR, GSD_MERGE_CONFLICT } from "./errors.js";
import { logWarning } from "./workflow-logger.js";
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
import { emitCanonicalRootRedirect } from "./worktree-telemetry.js";

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

// ─── resolveGitDir ─────────────────────────────────────────────────────────

/**
 * Resolve the actual git directory for a given repository path.
 *
 * In a normal repo, .git is a directory → returns `<basePath>/.git`.
 * In a worktree, .git is a file containing `gitdir: <path>` → resolves
 * and returns that path.
 *
 * This is critical for operations that reference git metadata files like
 * MERGE_HEAD, SQUASH_MSG, etc. — these live in the git directory, not
 * in the working tree root. Without this, worktree merges fail because
 * they look for MERGE_HEAD in the wrong location.
 */
export function resolveGitDir(basePath: string): string {
  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) return gitPath;
  // In a normal repo .git is a directory — skip the file read (#3597)
  if (lstatSync(gitPath).isDirectory()) return gitPath;
  try {
    const content = readFileSync(gitPath, "utf-8").trim();
    if (content.startsWith("gitdir: ")) {
      return resolve(basePath, content.slice(8));
    }
  } catch (e) {
    logWarning("worktree", `.git file read failed: ${(e as Error).message}`);
  }
  return gitPath;
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

/**
 * Validate that a path is inside the .gsd/worktrees/ directory.
 * Resolves symlinks and normalizes ".." traversals before comparison
 * so that a symlink-resolved or crafted path cannot escape containment.
 *
 * Used as a safety gate before any destructive operation (rmSync,
 * nativeWorktreeRemove --force) to prevent #2365-style data loss.
 */
export function isInsideWorktreesDir(basePath: string, targetPath: string): boolean {
  const wtDirPath = worktreesDir(basePath);
  const wtDir = existsSync(wtDirPath) ? realpathSync(wtDirPath) : resolve(wtDirPath);
  const resolved = existsSync(targetPath) ? realpathSync(targetPath) : resolve(targetPath);
  // The resolved path must start with the worktrees dir followed by a separator,
  // not merely be a prefix match (e.g. ".gsd/worktrees-extra" must not match).
  return resolved === wtDir || resolved.startsWith(wtDir + sep);
}

/**
 * Return the canonical path from which a milestone's artifacts should be read.
 *
 * If a live git worktree exists for this milestone at `.gsd/worktrees/<MID>/`
 * (directory present AND a `.git` file indicating a registered worktree),
 * returns that worktree path. Otherwise returns `basePath` unchanged.
 *
 * Readers that cross the session/worktree boundary (validators, the bootstrap
 * audit, cross-session state queries) should route through this helper so they
 * don't silently read stale project-root state while live work sits in the
 * worktree. Writers and tools whose contract is "operate on the path I was
 * given" should NOT use this helper — they preserve the legacy behavior.
 *
 * A stale worktree directory (no `.git` file) is treated as absent. The
 * createWorktree() path already cleans these up, but readers must not trust
 * them in the window before cleanup runs.
 *
 * Fixes #4761. Used by the #4762 audit for the pre-completion orphan case.
 */
export function resolveCanonicalMilestoneRoot(
  basePath: string,
  milestoneId: string,
): string {
  if (!milestoneId || /[\/\\]|\.\./.test(milestoneId)) return basePath;

  const wtPath = worktreePath(basePath, milestoneId);
  if (!existsSync(wtPath)) return basePath;

  // A registered git worktree has a .git *file* (not directory) containing
  // "gitdir: <path>". A standalone .git directory indicates a copied repo
  // or nested standalone repo — not a worktree registered with this project —
  // and must not be treated as the canonical root.
  const gitPath = join(wtPath, ".git");
  if (!existsSync(gitPath)) return basePath;
  try {
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return basePath;
  } catch {
    return basePath;
  }

  // #4764 — record the redirect so we can measure how often the #4761 fix
  // would have mattered. Best-effort; emit is silent on any failure.
  try {
    emitCanonicalRootRedirect(basePath, milestoneId, wtPath);
  } catch (err) {
    logWarning("worktree", `canonical-root-redirect telemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return wtPath;
}

// ─── Core Operations ───────────────────────────────────────────────────────

/**
 * Create a new git worktree under .gsd/worktrees/<name>/ with branch worktree/<name>.
 * The branch is created from the current HEAD of the main branch.
 *
 * @param opts.branch — override the default `worktree/<name>` branch name
 */
export function createWorktree(basePath: string, name: string, opts: { branch?: string; startPoint?: string; reuseExistingBranch?: boolean } = {}): WorktreeInfo {
  // Validate name: alphanumeric, hyphens, underscores only
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new GSDError(GSD_PARSE_ERROR, `Invalid worktree name "${name}". Use only letters, numbers, hyphens, and underscores.`);
  }

  const wtPath = worktreePath(basePath, name);
  const branch = opts.branch ?? worktreeBranchName(name);

  if (existsSync(wtPath)) {
    // A valid git worktree has a .git file (not directory) containing a
    // "gitdir:" pointer.  If the directory exists but has no .git file,
    // it is a stale leftover from a prior crash — remove it so a fresh
    // worktree can be created in its place.
    const gitFilePath = join(wtPath, ".git");
    if (!existsSync(gitFilePath)) {
      logWarning("reconcile", `Removing stale worktree directory (no .git file): ${wtPath}`, { worktree: name });
      rmSync(wtPath, { recursive: true, force: true });
    } else {
      throw new GSDError(GSD_STALE_STATE, `Worktree "${name}" already exists at ${wtPath}`);
    }
  }

  // Ensure the .gsd/worktrees/ directory exists
  const wtDir = worktreesDir(basePath);
  mkdirSync(wtDir, { recursive: true });

  // Prune any stale worktree entries from a previous removal
  nativeWorktreePrune(basePath);

  // Use the explicit start point (e.g. integration branch) if provided,
  // otherwise fall back to the repo's detected main branch.
  const startPoint = opts.startPoint ?? nativeDetectMainBranch(basePath);

  // Check if the branch already exists (leftover from a previous worktree)
  const branchAlreadyExists = nativeBranchExists(basePath, branch);

  if (branchAlreadyExists) {
    // Check if the branch is actively used by an existing worktree.
    const worktreeEntries = nativeWorktreeList(basePath);
    const branchInUse = worktreeEntries.some(entry => entry.branch === branch);

    if (branchInUse) {
      throw new GSDError(
        GSD_LOCK_HELD,
        `Branch "${branch}" is already in use by another worktree. ` +
        `Remove the existing worktree first with /worktree remove ${name}.`,
      );
    }

    if (opts.reuseExistingBranch) {
      // Attach worktree to the existing branch as-is (preserving commits).
      // Used when resuming auto-mode: the milestone branch has valid work
      // from prior sessions that must not be reset.
      nativeWorktreeAdd(basePath, wtPath, branch);
    } else {
      // Reset the stale branch to the start point, then attach worktree to it
      nativeBranchForceReset(basePath, branch, startPoint);
      nativeWorktreeAdd(basePath, wtPath, branch);
    }
  } else {
    nativeWorktreeAdd(basePath, wtPath, branch, true, startPoint);
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

// ─── Nested .git Detection (#2616) ──────────────────────────────────────
//
// Scaffolding tools (create-next-app, cargo init, etc.) create nested .git
// directories inside worktrees. Git records these as gitlinks (mode 160000)
// without a .gitmodules entry — so worktree cleanup destroys the only copy
// of their object database, causing permanent silent data loss.

/** Directories to skip when scanning for nested .git dirs. */
const NESTED_GIT_SKIP_DIRS = new Set([
  ".git", ".gsd", "node_modules", ".next", ".nuxt", "dist", "build",
  "__pycache__", ".tox", ".venv", "venv", "target", "vendor",
]);

/**
 * Recursively find nested .git directories inside a worktree root.
 * Returns paths to directories that contain their own .git (directory, not file).
 * Skips node_modules, .gsd, and other non-project directories for performance.
 *
 * A nested .git *directory* (not a .git file — which is a legitimate worktree
 * pointer) indicates a scaffolded repo that will become an orphaned gitlink.
 */
export function findNestedGitDirs(rootPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    // Cap recursion depth to avoid runaway scanning
    if (depth > 10) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      logWarning("worktree", `readdirSync failed: ${(e as Error).message}`);
      return;
    }

    for (const entry of entries) {
      if (NESTED_GIT_SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);

      // Only follow real directories, not symlinks
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (e) {
        logWarning("worktree", `lstatSync failed for ${fullPath}: ${(e as Error).message}`);
        continue;
      }
      if (!stat.isDirectory()) continue;

      // Check if this directory contains a .git *directory* (not a .git file).
      // A .git file is a worktree pointer and is legitimate.
      // A .git directory is a standalone repo created by scaffolding.
      const innerGit = join(fullPath, ".git");
      try {
        const innerStat = lstatSync(innerGit);
        if (innerStat.isDirectory()) {
          results.push(fullPath);
          // Don't recurse into the nested repo — we found what we need
          continue;
        }
      } catch (e) {
        logWarning("worktree", `existsSync/.git check failed for ${fullPath}: ${(e as Error).message}`);
      }

      walk(fullPath, depth + 1);
    }
  }

  walk(rootPath, 0);
  return results;
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
  let wtPath = worktreePath(basePath, name);
  const branch = opts.branch ?? worktreeBranchName(name);
  const { deleteBranch = true, force = true } = opts;

  // Resolve the ACTUAL worktree path from git's worktree list.
  // The computed path may differ when .gsd/ is (or was) a symlink to an
  // external state directory — git resolves symlinks at worktree creation
  // time, so its registered path points to the resolved external location.
  // If syncStateToProjectRoot later creates a real .gsd/ directory that
  // shadows the symlink, the computed path diverges from git's record.
  let gitReportedPath: string | null = null;
  try {
    const entries = nativeWorktreeList(basePath);
    const entry = entries.find(e => e.branch === branch);
    if (entry?.path) {
      gitReportedPath = entry.path;
    }
  } catch (e) { logWarning("worktree", `nativeWorktreeList parse failed: ${(e as Error).message}`); }

  // Safety gate (#2365): only use the git-reported path if it is actually
  // inside .gsd/worktrees/.  When .gsd/ was a symlink, git may have resolved
  // it to an external directory (e.g. a project data folder).  Using that
  // path for removal would destroy user data.
  if (gitReportedPath && isInsideWorktreesDir(basePath, gitReportedPath)) {
    wtPath = gitReportedPath;
  } else if (gitReportedPath) {
    console.error(
      `[GSD] WARNING: git worktree list reported path outside .gsd/worktrees/: ${gitReportedPath}\n` +
        `  Refusing to use it for removal — falling back to computed path: ${wtPath}`,
    );
    // Still tell git to unregister the worktree entry via its reported path,
    // but do NOT use force and do NOT fall back to rmSync on this path.
    try { nativeWorktreeRemove(basePath, gitReportedPath, false); } catch (e) { logWarning("worktree", `non-force worktree remove failed for ${gitReportedPath}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const resolvedWtPath = existsSync(wtPath) ? realpathSync(wtPath) : wtPath;

  // Double-check: the resolved path (after symlink resolution) must also be
  // inside .gsd/worktrees/ — a symlink inside the directory could point out.
  const resolvedPathSafe = isInsideWorktreesDir(basePath, resolvedWtPath);

  // If we're inside the worktree, move out first — git can't remove an in-use directory
  const cwd = process.cwd();
  const resolvedCwd = existsSync(cwd) ? realpathSync(cwd) : cwd;
  if (resolvedCwd === resolvedWtPath || resolvedCwd.startsWith(resolvedWtPath + sep)) {
    process.chdir(basePath);
  }

  if (!existsSync(wtPath)) {
    nativeWorktreePrune(basePath);
    if (deleteBranch) {
      try { nativeBranchDelete(basePath, branch, true); } catch (e) { logWarning("worktree", `nativeBranchDelete failed: ${(e as Error).message}`); }
    }
    return;
  }

  // Submodule safety (#2337): detect submodules with uncommitted changes
  // before force-removing the worktree. Force removal destroys all uncommitted
  // state, which is especially destructive for submodule directories.
  let hasSubmoduleChanges = false;
  const gitmodulesPath = join(resolvedWtPath, ".gitmodules");
  if (existsSync(gitmodulesPath)) {
    try {
      const submoduleStatus = execFileSync(
        "git", ["submodule", "status"], 
        { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      ).trim();
      // Lines starting with '+' indicate uncommitted submodule changes
      hasSubmoduleChanges = submoduleStatus.split("\n").some(
        (line: string) => line.startsWith("+") || line.startsWith("-"),
      );
      if (hasSubmoduleChanges) {
        // Stash submodule changes so they are not lost during force removal.
        // The stash is created in the worktree before it's torn down.
        try {
          execFileSync(
            "git", ["stash", "push", "-m", "gsd: auto-stash submodule changes before worktree teardown"],
            { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
          );
          logWarning("reconcile", `Stashed uncommitted submodule changes before worktree teardown`, { worktree: name, path: resolvedWtPath });
        } catch {
          // Stash failed — warn the user that submodule changes may be lost
          logWarning("reconcile", `Submodule changes detected — stash failed, changes may be lost during force removal`, { worktree: name, path: resolvedWtPath });
        }
      }
    } catch (e) {
      logWarning("worktree", `submodule status check failed: ${(e as Error).message}`);
    }
  }

  // Nested .git safety (#2616): detect nested .git directories created by
  // scaffolding tools (create-next-app, cargo init, etc.). These produce
  // gitlink entries (mode 160000) without .gitmodules — cleanup would destroy
  // the only copy of the nested object database, causing permanent data loss.
  // Fix: remove the nested .git dirs so git tracks the files as regular content.
  const nestedGitDirs = findNestedGitDirs(resolvedWtPath);
  if (nestedGitDirs.length > 0) {
    for (const nestedDir of nestedGitDirs) {
      const nestedGitPath = join(nestedDir, ".git");
      try {
        rmSync(nestedGitPath, { recursive: true, force: true });
        logWarning("reconcile",
          `Removed nested .git directory from scaffolded project to prevent data loss (#2616)`,
          { worktree: name, nestedRepo: nestedDir },
        );
      } catch {
        logWarning("reconcile",
          `Failed to remove nested .git directory — files may be lost as orphaned gitlink`,
          { worktree: name, nestedRepo: nestedDir },
        );
      }
    }
  }

  // Remove worktree — only use force/rmSync when the path is safely contained
  if (resolvedPathSafe) {
    // Remove worktree: try non-force first when submodules have changes,
    // falling back to force only after submodule state has been preserved.
    const useForce = hasSubmoduleChanges ? false : force;
    try { nativeWorktreeRemove(basePath, resolvedWtPath, useForce); } catch (e) { logWarning("worktree", `nativeWorktreeRemove failed: ${(e as Error).message}`); }

    // If the directory is still there (e.g. locked), try harder with force
    if (existsSync(resolvedWtPath)) {
      try { nativeWorktreeRemove(basePath, resolvedWtPath, true); } catch (e) { logWarning("worktree", `nativeWorktreeRemove (force) failed: ${(e as Error).message}`); }
    }

    // (#2821) If the worktree directory STILL exists after both native removal
    // attempts (e.g. untracked files like ASSESSMENT/UAT-RESULT prevent git
    // worktree remove), force-remove the git internal worktree metadata first,
    // then remove the filesystem directory. Without this, the .git/worktrees/<name>
    // lock prevents rmSync from cleaning up, and the orphaned worktree directory
    // causes every subsequent `/gsd auto` to re-enter the stale worktree.
    if (existsSync(resolvedWtPath)) {
      try {
        const wtInternalDir = join(basePath, ".git", "worktrees", name);
        if (existsSync(wtInternalDir)) {
          rmSync(wtInternalDir, { recursive: true, force: true });
        }
        rmSync(resolvedWtPath, { recursive: true, force: true });
        if (wtPath !== resolvedWtPath && existsSync(wtPath)) {
          rmSync(wtPath, { recursive: true, force: true });
        }
      } catch {
        logWarning(
          "reconcile",
          `Worktree directory could not be removed after git internal cleanup: ${resolvedWtPath}. ` +
            `Manual cleanup: rm -rf "${resolvedWtPath.replaceAll("\\", "/")}"`,
          { worktree: name },
        );
      }
    }
  } else {
    // Path is outside containment — only do a non-force git worktree remove
    // (which refuses to delete dirty worktrees) and never fall back to rmSync.
    console.error(
      `[GSD] WARNING: Resolved worktree path is outside .gsd/worktrees/: ${resolvedWtPath}\n` +
        `  Skipping forced removal to prevent data loss.`,
    );
    try { nativeWorktreeRemove(basePath, resolvedWtPath, false); } catch (e) { logWarning("worktree", `non-force worktree remove failed for ${resolvedWtPath}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Prune stale entries so git knows the worktree is gone
  nativeWorktreePrune(basePath);

  if (deleteBranch) {
    try { nativeBranchDelete(basePath, branch, true); } catch (e) { logWarning("worktree", `final branch delete failed: ${(e as Error).message}`); }
  }
}

/**
 * Paths to skip in all worktree diffs (internal/runtime artifacts).
 *
 * NOTE: These arrays must stay synchronized with GSD_RUNTIME_PATTERNS in gitignore.ts.
 * That file is the canonical source of truth for runtime ignore patterns.
 * This module uses a split representation (paths/exact/prefixes) for efficient matching.
 */
const SKIP_PATHS = [
  ".gsd/worktrees/",
  ".gsd/runtime/",
  ".gsd/activity/",
  ".gsd/audit/",
  ".gsd/forensics/",
  ".gsd/parallel/",
  ".gsd/journal/",
];
const SKIP_EXACT = [
  ".gsd/STATE.md",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/state-manifest.json",
  ".gsd/doctor-history.jsonl",
  ".gsd/event-log.jsonl",
];
/** File prefixes to skip (for wildcard patterns like completed-units*.json, gsd.db*). */
const SKIP_PREFIXES = [
  ".gsd/completed-units",
  ".gsd/gsd.db",
];

function shouldSkipPath(filePath: string): boolean {
  if (SKIP_PATHS.some(p => filePath.startsWith(p))) return true;
  if (SKIP_EXACT.includes(filePath)) return true;
  if (SKIP_PREFIXES.some(p => filePath.startsWith(p))) return true;
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
    throw new GSDError(GSD_GIT_ERROR, `Must be on ${mainBranch} to merge. Currently on ${current}.`);
  }

  const result = nativeMergeSquash(basePath, branch);
  if (!result.success) {
    throw new GSDError(GSD_MERGE_CONFLICT, `Merge conflicts detected in: ${result.conflicts.join(", ")}`);
  }

  nativeCommit(basePath, commitMessage);

  return commitMessage;
}
