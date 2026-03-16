/**
 * GSD Git Service
 *
 * Core git operations for GSD: types, constants, and pure helpers.
 * Higher-level operations (commit, staging, branching) build on these.
 *
 * This module centralizes the GitPreferences interface, runtime exclusion
 * paths, commit type inference, and the runGit shell helper.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectWorktreeName,
  SLICE_BRANCH_RE,
} from "./worktree.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists,
  nativeHasChanges,
  nativeAddAll,
  nativeResetPaths,
  nativeHasStagedChanges,
  nativeCommit,
  nativeRmCached,
  nativeUpdateRef,
  nativeAddPaths,
} from "./native-git-bridge.js";
import { GSDError, GSD_MERGE_CONFLICT } from "./errors.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GitPreferences {
  auto_push?: boolean;
  push_branches?: boolean;
  remote?: string;
  snapshots?: boolean;
  pre_merge_check?: boolean | string;
  commit_type?: string;
  main_branch?: string;
  merge_strategy?: "squash" | "merge";
  /** Controls auto-mode git isolation strategy.
   *  - "worktree": (default) creates a milestone worktree for isolated work
   *  - "branch": works directly in the project root (for submodule-heavy repos)
   */
  isolation?: "worktree" | "branch";
}

export const VALID_BRANCH_NAME = /^[a-zA-Z0-9_\-\/.]+$/;

export interface CommitOptions {
  message: string;
  allowEmpty?: boolean;
}

/**
 * Thrown when a slice merge hits code conflicts in non-.gsd files.
 * The working tree is left in a conflicted state (no reset) so the
 * caller can dispatch a fix-merge session to resolve it.
 */
export class MergeConflictError extends GSDError {
  readonly conflictedFiles: string[];
  readonly strategy: "squash" | "merge";
  readonly branch: string;
  readonly mainBranch: string;

  constructor(
    conflictedFiles: string[],
    strategy: "squash" | "merge",
    branch: string,
    mainBranch: string,
  ) {
    super(
      GSD_MERGE_CONFLICT,
      `${strategy === "merge" ? "Merge" : "Squash-merge"} of "${branch}" into "${mainBranch}" ` +
      `failed with conflicts in ${conflictedFiles.length} non-.gsd file(s): ${conflictedFiles.join(", ")}`,
    );
    this.name = "MergeConflictError";
    this.conflictedFiles = conflictedFiles;
    this.strategy = strategy;
    this.branch = branch;
    this.mainBranch = mainBranch;
  }
}

export interface PreMergeCheckResult {
  passed: boolean;
  skipped?: boolean;
  command?: string;
  error?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * GSD runtime paths that should be excluded from smart staging.
 * These are transient/generated artifacts that should never be committed.
 * Matches the union of SKIP_PATHS + SKIP_EXACT in worktree-manager.ts
 * and the first 7 entries in gitignore.ts BASELINE_PATTERNS.
 */
export const RUNTIME_EXCLUSION_PATHS: readonly string[] = [
  ".gsd/activity/",
  ".gsd/runtime/",
  ".gsd/worktrees/",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/completed-units.json",
  ".gsd/STATE.md",
  ".gsd/gsd.db",
  ".gsd/DISCUSSION-MANIFEST.json",
];

// ─── Integration Branch Metadata ───────────────────────────────────────────

/**
 * Path to the milestone metadata file that stores the integration branch.
 * Format: .gsd/milestones/<MID>/<MID>-META.json
 */
function milestoneMetaPath(basePath: string, milestoneId: string): string {
  return join(basePath, ".gsd", "milestones", milestoneId, `${milestoneId}-META.json`);
}

/**
 * Read the integration branch recorded for a milestone.
 * Returns null if no metadata file exists or the branch isn't set.
 */
export function readIntegrationBranch(basePath: string, milestoneId: string): string | null {
  try {
    const metaFile = milestoneMetaPath(basePath, milestoneId);
    if (!existsSync(metaFile)) return null;
    const data = JSON.parse(readFileSync(metaFile, "utf-8"));
    const branch = data?.integrationBranch;
    if (typeof branch === "string" && branch.trim() !== "" && VALID_BRANCH_NAME.test(branch)) {
      return branch;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the integration branch for a milestone.
 *
 * Called when auto-mode starts on a milestone. Records the branch the user
 * was on at that point, so the milestone worktree merges back to the correct
 * branch. Idempotent when the branch matches; updates the record when the
 * user starts from a different branch.
 *
 * The file is committed immediately so the metadata is persisted in git.
 */
export function writeIntegrationBranch(basePath: string, milestoneId: string, branch: string): void {
  // Don't record slice branches as the integration target
  if (SLICE_BRANCH_RE.test(branch)) return;
  // Validate
  if (!VALID_BRANCH_NAME.test(branch)) return;
  // Skip if already recorded with the same branch (idempotent across restarts).
  // If recorded with a different branch, update it — the user started auto-mode
  // from a new branch and expects slices to merge back there (#300).
  const existingBranch = readIntegrationBranch(basePath, milestoneId);
  if (existingBranch === branch) return;

  const metaFile = milestoneMetaPath(basePath, milestoneId);
  mkdirSync(join(basePath, ".gsd", "milestones", milestoneId), { recursive: true });

  // Merge with existing metadata if present
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch { /* corrupt file — overwrite */ }

  existing.integrationBranch = branch;
  writeFileSync(metaFile, JSON.stringify(existing, null, 2) + "\n", "utf-8");

  // Commit immediately so the metadata is persisted in git.
  try {
    nativeAddPaths(basePath, [metaFile]);
    nativeCommit(basePath, `chore(${milestoneId}): record integration branch`, { allowEmpty: false });
  } catch {
    // Non-fatal — file is on disk even if commit fails (e.g. nothing to commit
    // because the file was already tracked with identical content)
  }
}

// ─── Git Helper ────────────────────────────────────────────────────────────

/** Env overlay that suppresses interactive git credential prompts and git-svn noise. */
const GIT_NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SVN_ID: "",
};

/**
 * Strip git-svn noise from error messages.
 * Some systems (notably Arch Linux) have a buggy git-svn Perl module that
 * emits warnings on every git invocation, confusing users. See #404.
 */
function filterGitSvnNoise(message: string): string {
  return message
    .replace(/Duplicate specification "[^"]*" for option "[^"]*"\n?/g, "")
    .replace(/Unable to determine upstream SVN information from .*\n?/g, "")
    .replace(/Perhaps the repository is empty\. at .*git-svn.*\n?/g, "")
    .trim();
}

/**
 * Run a git command in the given directory.
 * Returns trimmed stdout. Throws on non-zero exit unless allowFailure is set.
 * When `input` is provided, it is piped to stdin.
 */
export function runGit(basePath: string, args: string[], options: { allowFailure?: boolean; input?: string } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      ...(options.input != null ? { input: options.input } : {}),
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${basePath}: ${filterGitSvnNoise(message)}`);
  }
}

// ─── Commit Type Inference ─────────────────────────────────────────────────

/**
 * Keyword-to-commit-type mapping. Order matters — first match wins.
 * Each entry: [keywords[], commitType]
 */
const COMMIT_TYPE_RULES: [string[], string][] = [
  [["fix", "bug", "patch", "hotfix"], "fix"],
  [["refactor", "restructure", "reorganize"], "refactor"],
  [["doc", "docs", "documentation"], "docs"],
  [["test", "tests", "testing"], "test"],
  [["chore", "cleanup", "clean up", "archive", "remove", "delete"], "chore"],
];

/**
 * Infer a conventional commit type from a slice title.
 * Uses case-insensitive word-boundary matching against known keywords.
 * Returns "feat" when no keywords match.
 */
// ─── GitServiceImpl ────────────────────────────────────────────────────

export class GitServiceImpl {
  readonly basePath: string;
  readonly prefs: GitPreferences;

  /** Active milestone ID — used to resolve the integration branch. */
  private _milestoneId: string | null = null;

  constructor(basePath: string, prefs: GitPreferences = {}) {
    this.basePath = basePath;
    this.prefs = prefs;
  }

  /**
   * Set the active milestone ID for integration branch resolution.
   * When set, getMainBranch() will check the milestone's metadata file
   * for a recorded integration branch before falling back to repo defaults.
   */
  setMilestoneId(milestoneId: string | null): void {
    this._milestoneId = milestoneId;
  }

  /** Convenience wrapper: run git in this repo's basePath. */
  private git(args: string[], options: { allowFailure?: boolean; input?: string } = {}): string {
    return runGit(this.basePath, args, options);
  }

  /**
   * Smart staging: `git add -A` excluding GSD runtime paths via pathspec.
   * Falls back to plain `git add -A` if the exclusion pathspec fails.
   * @param extraExclusions Additional pathspec exclusions beyond RUNTIME_EXCLUSION_PATHS.
   */
  private smartStage(extraExclusions: readonly string[] = []): void {
    const allExclusions = [...RUNTIME_EXCLUSION_PATHS, ...extraExclusions];

    // One-time cleanup: if runtime files are already tracked in the index
    // (from older versions where the fallback bug staged them), untrack them
    // in a dedicated commit. This must happen as a separate commit because
    // the git reset HEAD step below would otherwise undo the rm --cached.
    if (!this._runtimeFilesCleanedUp) {
      let cleaned = false;
      for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
        const removed = nativeRmCached(this.basePath, [exclusion]);
        if (removed.length > 0) cleaned = true;
      }
      if (cleaned) {
        nativeCommit(this.basePath, "chore: untrack .gsd/ runtime files from git index", { allowEmpty: false });
      }
      this._runtimeFilesCleanedUp = true;
    }

    // Stage everything, then unstage excluded paths.
    //
    // Previous approach used pathspec excludes (:(exclude)...) with git add -A,
    // but that fails when .gsd/ is in .gitignore — git exits non-zero before
    // evaluating the excludes. The catch fallback ran plain `git add -A`,
    // staging all tracked runtime files unconditionally and defeating the
    // exclusion list entirely.
    //
    // git reset HEAD silently succeeds when the path isn't staged, so no
    // error handling is needed per-path.
    nativeAddAll(this.basePath);

    for (const exclusion of allExclusions) {
      try { nativeResetPaths(this.basePath, [exclusion]); } catch { /* path not staged — ignore */ }
    }
  }

  /** Tracks whether runtime file cleanup has run this session. */
  private _runtimeFilesCleanedUp = false;

  /**
   * Stage files (smart staging) and commit.
   * Returns the commit message string on success, or null if nothing to commit.
   * Uses `git commit -F -` with stdin pipe for safe multi-line message handling.
   */
  commit(opts: CommitOptions): string | null {
    this.smartStage();

    // Check if anything was actually staged
    if (!nativeHasStagedChanges(this.basePath) && !opts.allowEmpty) return null;

    nativeCommit(this.basePath, opts.message, { allowEmpty: opts.allowEmpty ?? false });
    return opts.message;
  }

  /**
   * Auto-commit dirty working tree with a conventional chore message.
   * Returns the commit message on success, or null if nothing to commit.
   * @param extraExclusions Additional paths to exclude from staging (e.g. [".gsd/"] for pre-switch commits).
   */
  autoCommit(unitType: string, unitId: string, extraExclusions: readonly string[] = []): string | null {
    // Quick check: is there anything dirty at all?
    // Native path uses libgit2 (single syscall), fallback spawns git.
    if (!nativeHasChanges(this.basePath)) return null;

    this.smartStage(extraExclusions);

    // After smart staging, check if anything was actually staged
    // (all changes might have been runtime files that got excluded)
    if (!nativeHasStagedChanges(this.basePath)) return null;

    const message = `chore(${unitId}): auto-commit after ${unitType}`;
    nativeCommit(this.basePath, message, { allowEmpty: false });
    return message;
  }

  // ─── Branch Queries ────────────────────────────────────────────────────

  /**
   * Get the integration branch for this repo — the branch that slice
   * branches are created from and merged back into.
   *
   * This is often `main` or `master`, but not necessarily. When a user
   * starts GSD on a feature branch like `f-123-new-thing`, that branch
   * is recorded as the integration target, and all slice branches merge
   * back into it — not the repo's default branch. The name "main branch"
   * in variable names is historical; think of it as "integration branch".
   *
   * Resolution order:
   * 1. Explicit `main_branch` preference (user override, highest priority)
   * 2. Milestone integration branch from metadata file (recorded at milestone start)
   * 3. Worktree base branch (worktree/<name>)
   * 4. origin/HEAD symbolic-ref → main/master fallback → current branch
   */
  getMainBranch(): string {
    // Explicit preference takes priority (double-check validity as defense-in-depth)
    if (this.prefs.main_branch && VALID_BRANCH_NAME.test(this.prefs.main_branch)) {
      return this.prefs.main_branch;
    }

    // Check milestone integration branch — recorded when auto-mode starts
    if (this._milestoneId) {
      const integrationBranch = readIntegrationBranch(this.basePath, this._milestoneId);
      if (integrationBranch) {
        // Verify the branch still exists locally (could have been deleted)
        if (nativeBranchExists(this.basePath, integrationBranch)) return integrationBranch;
      }
    }

    const wtName = detectWorktreeName(this.basePath);
    if (wtName) {
      const wtBranch = `worktree/${wtName}`;
      if (nativeBranchExists(this.basePath, wtBranch)) return wtBranch;
      return nativeGetCurrentBranch(this.basePath);
    }

    // Repo-level default detection: origin/HEAD → main → master → current branch.
    // Native path uses libgit2 (single call), fallback spawns multiple git processes.
    return nativeDetectMainBranch(this.basePath);
  }

  /** Get the current branch name. Native libgit2 when available, execSync fallback. */
  getCurrentBranch(): string {
    return nativeGetCurrentBranch(this.basePath);
  }

  /** True if currently on a GSD slice branch. */
  // ─── Branch Lifecycle ──────────────────────────────────────────────────

  // ─── S05 Features ─────────────────────────────────────────────────────

  /**
   * Create a snapshot ref for the given label (typically a slice branch name).
   * Gated on prefs.snapshots === true. Ref path: refs/gsd/snapshots/<label>/<timestamp>
   * The ref points at HEAD, capturing the current commit before destructive operations.
   */
  createSnapshot(label: string): void {
    if (this.prefs.snapshots !== true) return;

    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + "-"
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0")
      + String(now.getSeconds()).padStart(2, "0");

    const refPath = `refs/gsd/snapshots/${label}/${ts}`;
    nativeUpdateRef(this.basePath, refPath, "HEAD");
  }

  /**
   * Run pre-merge verification check. Auto-detects test runner from project
   * files, or uses custom command from prefs.pre_merge_check.
   * Gated on prefs.pre_merge_check (false = skip, string = custom command).
   * Stub: to be implemented in T03.
   */
  runPreMergeCheck(): PreMergeCheckResult {
    if (this.prefs.pre_merge_check === false || this.prefs.pre_merge_check === undefined) {
      return { passed: true, skipped: true };
    }

    // Determine command: explicit string or auto-detect from package.json
    let command: string;
    if (typeof this.prefs.pre_merge_check === "string") {
      command = this.prefs.pre_merge_check;
    } else {
      // Auto-detect: look for package.json with a test script
      try {
        const pkg = readFileSync(join(this.basePath, "package.json"), "utf-8");
        const parsed = JSON.parse(pkg);
        if (parsed.scripts?.test) {
          command = "npm test";
        } else {
          return { passed: true, skipped: true };
        }
      } catch {
        return { passed: true, skipped: true };
      }
    }

    try {
      execSync(command, { cwd: this.basePath, stdio: "pipe", encoding: "utf-8" });
      return { passed: true, skipped: false, command };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, skipped: false, command, error: msg };
    }
  }

  // ─── Merge ─────────────────────────────────────────────────────────────

}

// ─── Commit Type Inference ─────────────────────────────────────────────────

export function inferCommitType(sliceTitle: string): string {
  const lower = sliceTitle.toLowerCase();

  for (const [keywords, commitType] of COMMIT_TYPE_RULES) {
    for (const keyword of keywords) {
      // "clean up" is multi-word — use indexOf for it
      if (keyword.includes(" ")) {
        if (lower.includes(keyword)) return commitType;
      } else {
        // Word boundary match: keyword must not be surrounded by word chars
        const re = new RegExp(`\\b${keyword}\\b`, "i");
        if (re.test(lower)) return commitType;
      }
    }
  }

  return "feat";
}
