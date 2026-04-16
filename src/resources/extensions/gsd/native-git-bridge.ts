// Native Git Bridge
// Provides high-performance git operations backed by libgit2 via the Rust native module.
// Falls back to execSync/execFileSync git commands when the native module is unavailable.
//
// Both READ and WRITE operations are native — push operations remain as
// execSync calls because git2 credential handling is too complex.

import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { getErrorMessage } from "./error-utils.js";

// Issue #453: keep auto-mode bookkeeping on the stable git CLI path unless a
// caller explicitly opts into the native helper.
const NATIVE_GSD_GIT_ENABLED = process.env.GSD_ENABLE_NATIVE_GSD_GIT === "1";

// ─── Native Module Types ──────────────────────────────────────────────────

interface GitDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

interface GitNameStatus {
  status: string;
  path: string;
}

interface GitNumstat {
  added: number;
  removed: number;
  path: string;
}

interface GitLogEntry {
  sha: string;
  message: string;
}

interface GitWorktreeEntry {
  path: string;
  branch: string;
  isBare: boolean;
}

interface GitBatchInfo {
  branch: string;
  hasChanges: boolean;
  status: string;
  stagedCount: number;
  unstagedCount: number;
}

interface GitMergeResult {
  success: boolean;
  conflicts: string[];
  /** Filenames extracted from git stderr when a dirty working tree blocks the merge (#2151). */
  dirtyFiles?: string[];
}

// ─── Native Module Loading ──────────────────────────────────────────────────

let nativeModule: {
  // Existing read functions
  gitCurrentBranch: (repoPath: string) => string | null;
  gitMainBranch: (repoPath: string) => string;
  gitBranchExists: (repoPath: string, branch: string) => boolean;
  gitHasMergeConflicts: (repoPath: string) => boolean;
  gitWorkingTreeStatus: (repoPath: string) => string;
  gitHasChanges: (repoPath: string) => boolean;
  gitCommitCountBetween: (repoPath: string, fromRef: string, toRef: string) => number;
  // New read functions
  gitIsRepo: (path: string) => boolean;
  gitHasStagedChanges: (repoPath: string) => boolean;
  gitDiffStat: (repoPath: string, fromRef: string, toRef: string) => GitDiffStat;
  gitDiffNameStatus: (repoPath: string, fromRef: string, toRef: string, pathspec?: string, useMergeBase?: boolean) => GitNameStatus[];
  gitDiffNumstat: (repoPath: string, fromRef: string, toRef: string) => GitNumstat[];
  gitDiffContent: (repoPath: string, fromRef: string, toRef: string, pathspec?: string, exclude?: string, useMergeBase?: boolean) => string;
  gitLogOneline: (repoPath: string, fromRef: string, toRef: string) => GitLogEntry[];
  gitWorktreeList: (repoPath: string) => GitWorktreeEntry[];
  gitBranchList: (repoPath: string, pattern?: string) => string[];
  gitBranchListMerged: (repoPath: string, target: string, pattern?: string) => string[];
  gitLsFiles: (repoPath: string, pathspec: string) => string[];
  gitForEachRef: (repoPath: string, prefix: string) => string[];
  gitConflictFiles: (repoPath: string) => string[];
  gitBatchInfo: (repoPath: string) => GitBatchInfo;
  // Write functions
  gitInit: (path: string, initialBranch?: string) => void;
  gitAddAll: (repoPath: string) => void;
  gitAddPaths: (repoPath: string, paths: string[]) => void;
  gitResetPaths: (repoPath: string, paths: string[]) => void;
  gitCommit: (repoPath: string, message: string, allowEmpty?: boolean) => string;
  gitCheckoutBranch: (repoPath: string, branch: string) => void;
  gitCheckoutTheirs: (repoPath: string, paths: string[]) => void;
  gitMergeSquash: (repoPath: string, branch: string) => GitMergeResult;
  gitMergeAbort: (repoPath: string) => void;
  gitRebaseAbort: (repoPath: string) => void;
  gitResetHard: (repoPath: string) => void;
  gitBranchDelete: (repoPath: string, branch: string, force?: boolean) => void;
  gitBranchForceReset: (repoPath: string, branch: string, target: string) => void;
  gitRmCached: (repoPath: string, paths: string[], recursive?: boolean) => string[];
  gitRmForce: (repoPath: string, paths: string[]) => void;
  gitWorktreeAdd: (repoPath: string, wtPath: string, branch: string, createBranch?: boolean, startPoint?: string) => void;
  gitWorktreeRemove: (repoPath: string, wtPath: string, force?: boolean) => void;
  gitWorktreePrune: (repoPath: string) => void;
  gitRevertCommit: (repoPath: string, sha: string) => void;
  gitRevertAbort: (repoPath: string) => void;
  gitUpdateRef: (repoPath: string, refname: string, target?: string) => void;
} | null = null;

let loadAttempted = false;

function loadNative(): typeof nativeModule {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;
  if (!NATIVE_GSD_GIT_ENABLED) return nativeModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@gsd/native");
    if (mod.gitCurrentBranch && mod.gitHasChanges) {
      nativeModule = mod;
    }
  } catch {
    // Native module not available — all functions fall back to git CLI
  }

  return nativeModule;
}

// ─── Fallback Helpers ──────────────────────────────────────────────────────

/** Run a git command via execFileSync. Returns trimmed stdout. */
function gitExec(basePath: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
  } catch {
    if (allowFailure) return "";
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}`);
  }
}

/** Run a git command via execFileSync. Returns trimmed stdout. */
function gitFileExec(basePath: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
  } catch {
    if (allowFailure) return "";
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}`);
  }
}

// ─── Existing Read Functions ──────────────────────────────────────────────

/**
 * Get the current branch name.
 * Native: reads HEAD symbolic ref via libgit2.
 * Fallback: `git branch --show-current`.
 */
export function nativeGetCurrentBranch(basePath: string): string {
  const native = loadNative();
  if (native) {
    const branch = native.gitCurrentBranch(basePath);
    return branch ?? "";
  }
  return gitExec(basePath, ["branch", "--show-current"]);
}

/**
 * Detect the repo-level main branch (origin/HEAD → main → master → current).
 * Native: checks refs via libgit2.
 * Fallback: `git symbolic-ref` + `git show-ref` chain.
 */
export function nativeDetectMainBranch(basePath: string): string {
  const native = loadNative();
  if (native) {
    return native.gitMainBranch(basePath);
  }

  const symbolic = gitExec(basePath, ["symbolic-ref", "refs/remotes/origin/HEAD"], true);
  if (symbolic) {
    const match = symbolic.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1]!;
  }

  const mainExists = gitExec(basePath, ["show-ref", "--verify", "refs/heads/main"], true);
  if (mainExists) return "main";

  const masterExists = gitExec(basePath, ["show-ref", "--verify", "refs/heads/master"], true);
  if (masterExists) return "master";

  return gitExec(basePath, ["branch", "--show-current"]);
}

/**
 * Check if a local branch exists.
 * Native: checks refs/heads/<name> via libgit2.
 * Fallback: `git show-ref --verify`, with unborn-branch detection
 * so that the current branch in a zero-commit repo is treated as
 * existing (fixes #1771).
 */
export function nativeBranchExists(basePath: string, branch: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitBranchExists(basePath, branch);
  }
  const result = gitExec(basePath, ["show-ref", "--verify", `refs/heads/${branch}`], true);
  if (result !== "") return true;

  // show-ref fails for unborn branches (zero commits). Fall back to checking
  // whether the requested branch is the current (unborn) branch.
  const current = gitExec(basePath, ["branch", "--show-current"], true);
  return current === branch;
}

/**
 * Check if the index has unmerged entries (merge conflicts).
 * Native: reads index conflict state via libgit2.
 * Fallback: `git diff --name-only --diff-filter=U`.
 */
export function nativeHasMergeConflicts(basePath: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitHasMergeConflicts(basePath);
  }
  const result = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
  return result !== "";
}

/**
 * Get working tree status (porcelain format).
 * Native: reads status via libgit2.
 * Fallback: `git status --porcelain`.
 */
export function nativeWorkingTreeStatus(basePath: string): string {
  const native = loadNative();
  if (native) {
    return native.gitWorkingTreeStatus(basePath);
  }
  return gitExec(basePath, ["status", "--porcelain"], true);
}

// ─── nativeHasChanges fallback cache (10s TTL) ─────────────────────────
let _hasChangesCachedResult: boolean = false;
let _hasChangesCachedAt: number = 0;
let _hasChangesCachedPath: string = "";
const HAS_CHANGES_CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * Quick check: any staged or unstaged changes?
 * Native: libgit2 status check (single syscall).
 * Fallback: `git status --short` (cached for 10s per basePath).
 */
export function nativeHasChanges(basePath: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitHasChanges(basePath);
  }

  const now = Date.now();
  if (
    basePath === _hasChangesCachedPath &&
    now - _hasChangesCachedAt < HAS_CHANGES_CACHE_TTL_MS
  ) {
    return _hasChangesCachedResult;
  }

  const result = gitExec(basePath, ["status", "--short"], true);
  const hasChanges = result !== "";

  _hasChangesCachedResult = hasChanges;
  _hasChangesCachedAt = now;
  _hasChangesCachedPath = basePath;

  return hasChanges;
}

/** Reset the nativeHasChanges fallback cache (exported for testing). */
export function _resetHasChangesCache(): void {
  _hasChangesCachedResult = false;
  _hasChangesCachedAt = 0;
  _hasChangesCachedPath = "";
}

/**
 * Count commits between two refs (from..to).
 * Native: libgit2 revwalk.
 * Fallback: `git rev-list --count from..to`.
 */
export function nativeCommitCountBetween(basePath: string, fromRef: string, toRef: string): number {
  const native = loadNative();
  if (native) {
    return native.gitCommitCountBetween(basePath, fromRef, toRef);
  }
  const result = gitExec(basePath, ["rev-list", "--count", `${fromRef}..${toRef}`], true);
  return parseInt(result, 10) || 0;
}

// ─── New Read Functions ──────────────────────────────────────────────────

/**
 * Check if a path is inside a git repository.
 * Native: Repository::open() check.
 * Fallback: `git rev-parse --git-dir`.
 */
export function nativeIsRepo(basePath: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitIsRepo(basePath);
  }
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: basePath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if there are staged changes (index differs from HEAD).
 * Native: libgit2 tree-to-index diff.
 * Fallback: `git diff --cached --stat`.
 */
export function nativeHasStagedChanges(basePath: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitHasStagedChanges(basePath);
  }
  const result = gitExec(basePath, ["diff", "--cached", "--stat"], true);
  return result !== "";
}

/**
 * Get diff statistics.
 * Use fromRef="HEAD", toRef="WORKDIR" for working tree diff.
 * Use fromRef="HEAD", toRef="INDEX" for staged diff.
 * Native: libgit2 diff stats.
 * Fallback: `git diff --stat`.
 */
export function nativeDiffStat(basePath: string, fromRef: string, toRef: string): GitDiffStat {
  const native = loadNative();
  if (native) {
    return native.gitDiffStat(basePath, fromRef, toRef);
  }

  // Fallback
  let args: string[];
  if (fromRef === "HEAD" && toRef === "WORKDIR") {
    args = ["diff", "--stat", "HEAD"];
  } else if (fromRef === "HEAD" && toRef === "INDEX") {
    args = ["diff", "--stat", "--cached", "HEAD"];
  } else {
    args = ["diff", "--stat", fromRef, toRef];
  }

  const result = gitExec(basePath, args, true);
  // Parse numeric stats from the summary line (e.g. "3 files changed, 10 insertions(+), 2 deletions(-)")
  let filesChanged = 0, insertions = 0, deletions = 0;
  const statsMatch = result.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (statsMatch) {
    filesChanged = parseInt(statsMatch[1] ?? "0", 10);
    insertions = parseInt(statsMatch[2] ?? "0", 10);
    deletions = parseInt(statsMatch[3] ?? "0", 10);
  }
  return { filesChanged, insertions, deletions, summary: result };
}

/**
 * Get name-status diff between two refs with optional pathspec filter.
 * useMergeBase: if true, uses three-dot semantics (main...branch).
 * Native: libgit2 tree-to-tree diff.
 * Fallback: `git diff --name-status`.
 */
export function nativeDiffNameStatus(
  basePath: string,
  fromRef: string,
  toRef: string,
  pathspec?: string,
  useMergeBase?: boolean,
): GitNameStatus[] {
  const native = loadNative();
  if (native) {
    return native.gitDiffNameStatus(basePath, fromRef, toRef, pathspec, useMergeBase);
  }

  // Fallback
  const separator = useMergeBase ? "..." : " ";
  const args = ["diff", "--name-status", `${fromRef}${separator}${toRef}`];
  if (pathspec) args.push("--", pathspec);

  const result = gitExec(basePath, args, true);
  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const [status, ...pathParts] = line.split("\t");
    return { status: status ?? "", path: pathParts.join("\t") };
  });
}

/**
 * Get numstat diff between two refs.
 * Native: libgit2 patch line stats.
 * Fallback: `git diff --numstat`.
 */
export function nativeDiffNumstat(basePath: string, fromRef: string, toRef: string): GitNumstat[] {
  const native = loadNative();
  if (native) {
    return native.gitDiffNumstat(basePath, fromRef, toRef);
  }

  const result = gitExec(basePath, ["diff", "--numstat", fromRef, toRef], true);
  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const [a, r, ...pathParts] = line.split("\t");
    return {
      added: a === "-" ? 0 : parseInt(a ?? "0", 10),
      removed: r === "-" ? 0 : parseInt(r ?? "0", 10),
      path: pathParts.join("\t"),
    };
  });
}

/**
 * Get unified diff content between two refs.
 * useMergeBase: if true, uses three-dot semantics.
 * Native: libgit2 diff print.
 * Fallback: `git diff`.
 */
export function nativeDiffContent(
  basePath: string,
  fromRef: string,
  toRef: string,
  pathspec?: string,
  exclude?: string,
  useMergeBase?: boolean,
): string {
  const native = loadNative();
  if (native) {
    return native.gitDiffContent(basePath, fromRef, toRef, pathspec, exclude, useMergeBase);
  }

  const separator = useMergeBase ? "..." : " ";
  const args = ["diff", `${fromRef}${separator}${toRef}`];
  if (pathspec) {
    args.push("--", pathspec);
  } else if (exclude) {
    args.push("--", ".", `:(exclude)${exclude}`);
  }

  return gitExec(basePath, args, true);
}

/**
 * Get commit log between two refs (from..to).
 * Native: libgit2 revwalk.
 * Fallback: `git log --oneline from..to`.
 */
export function nativeLogOneline(basePath: string, fromRef: string, toRef: string): GitLogEntry[] {
  const native = loadNative();
  if (native) {
    return native.gitLogOneline(basePath, fromRef, toRef);
  }

  const result = gitExec(basePath, ["log", "--oneline", `${fromRef}..${toRef}`], true);
  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const sha = line.substring(0, 7);
    const message = line.substring(8);
    return { sha, message };
  });
}

/**
 * List git worktrees.
 * Native: libgit2 worktree API.
 * Fallback: `git worktree list --porcelain`.
 */
export function nativeWorktreeList(basePath: string): GitWorktreeEntry[] {
  const native = loadNative();
  if (native) {
    return native.gitWorktreeList(basePath);
  }

  const result = gitExec(basePath, ["worktree", "list", "--porcelain"], true);
  if (!result) return [];

  const entries: GitWorktreeEntry[] = [];
  const blocks = result.replaceAll("\r\n", "\n").split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const wtLine = lines.find(l => l.startsWith("worktree "));
    const branchLine = lines.find(l => l.startsWith("branch "));
    const isBare = lines.some(l => l === "bare");

    if (wtLine) {
      entries.push({
        path: wtLine.replace("worktree ", ""),
        branch: branchLine ? branchLine.replace("branch refs/heads/", "") : "",
        isBare,
      });
    }
  }

  return entries;
}

/**
 * List branches matching an optional pattern.
 * Native: libgit2 branch iterator.
 * Fallback: `git branch --list <pattern>`.
 */
export function nativeBranchList(basePath: string, pattern?: string): string[] {
  const native = loadNative();
  if (native) {
    return native.gitBranchList(basePath, pattern);
  }

  const args = ["branch", "--list"];
  if (pattern) args.push(pattern);

  const result = gitFileExec(basePath, args, true);
  if (!result) return [];

  return result.split("\n").map(b => b.trim().replace(/^\* /, "")).filter(Boolean);
}

/**
 * List branches merged into target.
 * Native: libgit2 merge-base check.
 * Fallback: `git branch --merged <target> --list <pattern>`.
 */
export function nativeBranchListMerged(basePath: string, target: string, pattern?: string): string[] {
  const native = loadNative();
  if (native) {
    return native.gitBranchListMerged(basePath, target, pattern);
  }

  const args = ["branch", "--merged", target];
  if (pattern) args.push("--list", pattern);

  const result = gitFileExec(basePath, args, true);
  if (!result) return [];

  return result.split("\n").map(b => b.trim()).filter(Boolean);
}

/**
 * List tracked files matching a pathspec.
 * Native: libgit2 index iteration.
 * Fallback: `git ls-files <pathspec>`.
 */
export function nativeLsFiles(basePath: string, pathspec: string): string[] {
  const native = loadNative();
  if (native) {
    return native.gitLsFiles(basePath, pathspec);
  }

  const result = gitFileExec(basePath, ["ls-files", pathspec], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}

/**
 * List references matching a prefix.
 * Native: libgit2 references_glob.
 * Fallback: `git for-each-ref <prefix> --format=%(refname)`.
 */
export function nativeForEachRef(basePath: string, prefix: string): string[] {
  const native = loadNative();
  if (native) {
    return native.gitForEachRef(basePath, prefix);
  }

  const result = gitFileExec(basePath, ["for-each-ref", prefix, "--format=%(refname)"], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}

/**
 * Get list of files with unmerged (conflict) entries.
 * Native: libgit2 index conflicts.
 * Fallback: `git diff --name-only --diff-filter=U`.
 */
export function nativeConflictFiles(basePath: string): string[] {
  const native = loadNative();
  if (native) {
    return native.gitConflictFiles(basePath);
  }

  const result = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}

/**
 * Get batch info: branch + status + change counts in ONE call.
 * Native: single libgit2 call replaces 3-4 sequential execSync calls.
 * Fallback: multiple git commands.
 */
export function nativeBatchInfo(basePath: string): GitBatchInfo {
  const native = loadNative();
  if (native) {
    return native.gitBatchInfo(basePath);
  }

  const branch = gitExec(basePath, ["branch", "--show-current"], true);
  const status = gitExec(basePath, ["status", "--porcelain"], true);
  const hasChanges = status !== "";

  // Parse porcelain status to count staged vs unstaged changes
  let stagedCount = 0;
  let unstagedCount = 0;
  if (status) {
    for (const line of status.split("\n")) {
      if (!line || line.length < 2) continue;
      const x = line[0]; // index (staged) status
      const y = line[1]; // worktree (unstaged) status
      if (x !== " " && x !== "?") stagedCount++;
      if (y !== " " && y !== "?") unstagedCount++;
      if (x === "?" && y === "?") unstagedCount++; // untracked files
    }
  }

  return {
    branch,
    hasChanges,
    status,
    stagedCount,
    unstagedCount,
  };
}

// ─── Write Functions ──────────────────────────────────────────────────────

/**
 * Initialize a new git repository.
 * Native: libgit2 Repository::init.
 * Fallback: `git init -b <branch>`.
 */
export function nativeInit(basePath: string, initialBranch?: string): void {
  const native = loadNative();
  if (native) {
    native.gitInit(basePath, initialBranch);
    return;
  }

  const args = ["init"];
  if (initialBranch) args.push("-b", initialBranch);
  gitFileExec(basePath, args);
}

/**
 * Stage all files (git add -A).
 * Native: libgit2 index add_all + update_all.
 * Fallback: `git add -A`.
 */
export function nativeAddAll(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitAddAll(basePath);
    return;
  }
  gitFileExec(basePath, ["add", "-A"]);
}

/**
 * Stage only already-tracked files (git add -u).
 * Does NOT add new untracked files — only updates modifications and deletions
 * for files git already knows about. Safe for automated snapshots where
 * pulling in unknown untracked files (secrets, binaries) would be dangerous.
 */
export function nativeAddTracked(basePath: string): void {
  gitFileExec(basePath, ["add", "-u"]);
}

function isDotGsdIgnored(basePath: string): boolean {
  for (const path of [".gsd", ".gsd/"]) {
    try {
      execFileSync("git", ["check-ignore", "-q", path], {
        cwd: basePath,
        stdio: "pipe",
        env: GIT_NO_PROMPT_ENV,
      });
      return true;
    } catch {
      // exit 1 means this form is not ignored; try the next variant
    }
  }
  return false;
}

/**
 * Stage all files with pathspec exclusions (git add -A -- ':!pattern' ...).
 * Excluded paths are never hashed by git, preventing hangs on large
 * untracked artifact trees (57GB+, 11K+ files). See #1605.
 *
 * Falls back to plain `git add -A` when no exclusions are provided.
 * Always uses the CLI path (not libgit2) because libgit2's add_all
 * does not support pathspec exclusion syntax.
 *
 * When excluded paths are already covered by .gitignore, git may exit
 * with code 1 and an "ignored by .gitignore" warning. This is harmless
 * (the staging succeeds for all non-ignored files) and is suppressed.
 */
export function nativeAddAllWithExclusions(basePath: string, exclusions: readonly string[]): void {
  if (exclusions.length === 0) {
    nativeAddAll(basePath);
    return;
  }
  const pathspecs = exclusions.map(e => `:!${e}`);
  try {
    execFileSync("git", ["add", "-A", "--", ...pathspecs], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    // git exits 1 when pathspec exclusions reference paths already covered
    // by .gitignore. The staging itself succeeds — only suppress that case.
    if (stderr.includes("ignored by one of your .gitignore files")) {
      return;
    }
    // When .gsd is a symlink, git rejects `:!.gsd/...` pathspecs with
    // "beyond a symbolic link". If `.gsd` is already covered by .gitignore
    // (the default external-state layout), a plain `git add -A` safely stages
    // new files while still leaving `.gsd` excluded. Otherwise keep the
    // tracked-only fallback to avoid staging unexpected external-state files.
    if (stderr.includes("beyond a symbolic link")) {
      gitFileExec(basePath, isDotGsdIgnored(basePath) ? ["add", "-A"] : ["add", "-u"]);
      return;
    }
    throw new GSDError(GSD_GIT_ERROR, `git add -A with exclusions failed in ${basePath}: ${getErrorMessage(err)}`);
  }
}

/**
 * Stage specific files.
 * Native: libgit2 index add.
 * Fallback: `git add -- <paths>`.
 */
export function nativeAddPaths(basePath: string, paths: string[]): void {
  const native = loadNative();
  if (native) {
    native.gitAddPaths(basePath, paths);
    return;
  }
  gitFileExec(basePath, ["add", "--", ...paths]);
}

/**
 * Unstage files (reset index entries to HEAD).
 * Native: libgit2 reset_default.
 * Fallback: `git reset HEAD -- <paths>`.
 */
export function nativeResetPaths(basePath: string, paths: string[]): void {
  const native = loadNative();
  if (native) {
    native.gitResetPaths(basePath, paths);
    return;
  }
  for (const p of paths) {
    gitExec(basePath, ["reset", "HEAD", "--", p], true);
  }
}

/**
 * Create a commit from the current index.
 * Returns the commit SHA on success, or null if nothing to commit.
 * Native: libgit2 commit create.
 * Fallback: `git commit --no-verify -F -`.
 */
export function nativeCommit(
  basePath: string,
  message: string,
  options?: { allowEmpty?: boolean; input?: string },
): string | null {
  const native = loadNative();
  if (native) {
    try {
      return native.gitCommit(basePath, message, options?.allowEmpty);
    } catch (e) {
      const msg = getErrorMessage(e);
      if (msg.includes("nothing to commit")) return null;
      throw e;
    }
  }

  // Fallback: use git commit with stdin pipe for safe multi-line messages
  try {
    const args = ["commit", "--no-verify", "-F", "-"];
    if (options?.allowEmpty) args.push("--allow-empty");
    const result = execFileSync("git", args, {
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      input: message,
    }).trim();
    return result;
  } catch (err: unknown) {
    const errObj = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [errObj.stdout, errObj.stderr, errObj.message].filter(Boolean).join(" ");
    if (combined.includes("nothing to commit") || combined.includes("nothing added to commit") || combined.includes("no changes added")) {
      return null;
    }
    throw err;
  }
}

/**
 * Checkout a branch (switch HEAD and update working tree).
 * Native: libgit2 checkout + set_head.
 * Fallback: `git checkout <branch>`.
 */
export function nativeCheckoutBranch(basePath: string, branch: string): void {
  const native = loadNative();
  if (native) {
    native.gitCheckoutBranch(basePath, branch);
    return;
  }
  execFileSync("git", ["checkout", branch], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

/**
 * Resolve index conflicts by accepting "theirs" version.
 * Native: libgit2 index conflict resolution.
 * Fallback: `git checkout --theirs -- <file>`.
 */
export function nativeCheckoutTheirs(basePath: string, paths: string[]): void {
  const native = loadNative();
  if (native) {
    native.gitCheckoutTheirs(basePath, paths);
    return;
  }
  for (const path of paths) {
    gitFileExec(basePath, ["checkout", "--theirs", "--", path]);
  }
}

/**
 * Squash-merge a branch (stages changes, does NOT commit).
 * Native: libgit2 merge with squash semantics.
 * Fallback: `git merge --squash <branch>`.
 */
export function nativeMergeSquash(basePath: string, branch: string): GitMergeResult {
  const native = loadNative();
  if (native) {
    return native.gitMergeSquash(basePath, branch);
  }

  try {
    execFileSync("git", ["merge", "--squash", branch], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    });
    return { success: true, conflicts: [] };
  } catch (err: unknown) {
    // Distinguish pre-merge rejections (dirty working tree) from actual
    // content conflicts.  When git rejects the merge before staging
    // ("local changes would be overwritten"), there are no conflict markers
    // to detect, so the old --diff-filter=U check would return an empty
    // list and incorrectly report success (#1672, #1738).
    const stderr =
      err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
    if (
      stderr.includes("local changes would be overwritten") ||
      stderr.includes("not possible because you have unmerged files") ||
      stderr.includes("overwritten by merge")
    ) {
      // Extract filenames from git stderr so callers can report which files
      // are dirty instead of generically blaming .gsd/ (#2151).
      // Git lists them as tab-indented lines between the "would be overwritten"
      // header and the "Please commit" footer.
      const dirtyFiles = stderr
        .split("\n")
        .filter((line) => line.startsWith("\t"))
        .map((line) => line.trim())
        .filter(Boolean);
      return { success: false, conflicts: ["__dirty_working_tree__"], dirtyFiles };
    }

    // Check for real content conflicts
    const conflictOutput = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
    const conflicts = conflictOutput ? conflictOutput.split("\n").filter(Boolean) : [];
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    // No conflicts detected — this is a non-conflict failure; re-throw
    // so the caller knows the merge did not succeed.
    throw err;
  }
}

/**
 * Abort an in-progress merge.
 * Native: libgit2 reset + cleanup.
 * Fallback: `git merge --abort`.
 */
export function nativeMergeAbort(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitMergeAbort(basePath);
    return;
  }
  gitExec(basePath, ["merge", "--abort"], true);
}

/**
 * Abort an in-progress rebase.
 * Native: libgit2 reset + cleanup.
 * Fallback: `git rebase --abort`.
 */
export function nativeRebaseAbort(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitRebaseAbort(basePath);
    return;
  }
  gitExec(basePath, ["rebase", "--abort"], true);
}

/**
 * Hard reset to HEAD.
 * Native: libgit2 reset(Hard).
 * Fallback: `git reset --hard HEAD`.
 */
export function nativeResetHard(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitResetHard(basePath);
    return;
  }
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: basePath, stdio: "pipe" });
}

/**
 * Soft reset to a target ref (git reset --soft <ref>).
 * Moves HEAD to `target` while keeping all changes staged in the index.
 * Used to squash snapshot commits back into a single real commit.
 */
export function nativeResetSoft(basePath: string, target: string): void {
  execFileSync("git", ["reset", "--soft", target], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: GIT_NO_PROMPT_ENV,
  });
}

/**
 * Get the subject line of a commit (git log -1 --format=%s <ref>).
 * Returns empty string if the ref doesn't exist.
 */
export function nativeCommitSubject(basePath: string, ref: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%s", ref], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Delete a branch.
 * Native: libgit2 branch delete.
 * Fallback: `git branch -D/-d <branch>`.
 */
export function nativeBranchDelete(basePath: string, branch: string, force = true): void {
  const native = loadNative();
  if (native) {
    native.gitBranchDelete(basePath, branch, force);
    return;
  }
  gitFileExec(basePath, ["branch", force ? "-D" : "-d", branch], true);
}

/**
 * Force-reset a branch to point at a target ref.
 * Native: libgit2 branch create with force.
 * Fallback: `git branch -f <branch> <target>`.
 */
export function nativeBranchForceReset(basePath: string, branch: string, target: string): void {
  const native = loadNative();
  if (native) {
    native.gitBranchForceReset(basePath, branch, target);
    return;
  }
  gitExec(basePath, ["branch", "-f", branch, target]);
}

/**
 * Remove files from the index (cache) without touching the working tree.
 * Returns list of removed files.
 * Native: libgit2 index remove.
 * Fallback: `git rm --cached -r --ignore-unmatch <path>`.
 */
export function nativeRmCached(basePath: string, paths: string[], recursive = true): string[] {
  const native = loadNative();
  if (native) {
    return native.gitRmCached(basePath, paths, recursive);
  }

  const removed: string[] = [];
  for (const path of paths) {
    const result = gitExec(
      basePath,
      ["rm", "--cached", ...(recursive ? ["-r"] : []), "--ignore-unmatch", path],
      true,
    );
    if (result) removed.push(result);
  }
  return removed;
}

/**
 * Force-remove files from both index and working tree.
 * Native: libgit2 index remove + fs delete.
 * Fallback: `git rm --force -- <file>`.
 */
export function nativeRmForce(basePath: string, paths: string[]): void {
  const native = loadNative();
  if (native) {
    native.gitRmForce(basePath, paths);
    return;
  }
  for (const path of paths) {
    gitFileExec(basePath, ["rm", "--force", "--", path], true);
  }
}

/**
 * Add a new git worktree.
 * Native: libgit2 worktree API.
 * Fallback: `git worktree add`.
 */
export function nativeWorktreeAdd(
  basePath: string,
  wtPath: string,
  branch: string,
  createBranch?: boolean,
  startPoint?: string,
): void {
  const native = loadNative();
  if (native) {
    native.gitWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint);
    return;
  }

  if (createBranch) {
    gitExec(basePath, ["worktree", "add", "-b", branch, wtPath, startPoint ?? "HEAD"]);
  } else {
    gitExec(basePath, ["worktree", "add", wtPath, branch]);
  }
}

/**
 * Remove a git worktree.
 * Native: libgit2 worktree prune + fs cleanup.
 * Fallback: `git worktree remove [--force] <path>`.
 */
export function nativeWorktreeRemove(basePath: string, wtPath: string, force = false): void {
  const native = loadNative();
  if (native) {
    native.gitWorktreeRemove(basePath, wtPath, force);
    return;
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(wtPath);
  gitExec(basePath, args, true);
}

/**
 * Prune stale worktree entries.
 * Native: libgit2 worktree validation + prune.
 * Fallback: `git worktree prune`.
 */
export function nativeWorktreePrune(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitWorktreePrune(basePath);
    return;
  }
  gitExec(basePath, ["worktree", "prune"], true);
}

/**
 * Revert a commit without auto-committing.
 * Native: libgit2 revert.
 * Fallback: `git revert --no-commit <sha>`.
 */
export function nativeRevertCommit(basePath: string, sha: string): void {
  const native = loadNative();
  if (native) {
    native.gitRevertCommit(basePath, sha);
    return;
  }
  gitFileExec(basePath, ["revert", "--no-commit", sha]);
}

/**
 * Abort an in-progress revert.
 * Native: libgit2 reset + cleanup.
 * Fallback: `git revert --abort`.
 */
export function nativeRevertAbort(basePath: string): void {
  const native = loadNative();
  if (native) {
    native.gitRevertAbort(basePath);
    return;
  }
  gitFileExec(basePath, ["revert", "--abort"], true);
}

/**
 * Create or delete a ref.
 * When target is provided, creates/updates the ref. When undefined, deletes it.
 * Native: libgit2 reference create/delete.
 * Fallback: `git update-ref`.
 */
export function nativeUpdateRef(basePath: string, refname: string, target?: string): void {
  const native = loadNative();
  if (native) {
    native.gitUpdateRef(basePath, refname, target);
    return;
  }

  if (target !== undefined) {
    gitExec(basePath, ["update-ref", refname, target]);
  } else {
    gitExec(basePath, ["update-ref", "-d", refname], true);
  }
}

/**
 * Check if the native git module is available.
 */
export function isNativeGitAvailable(): boolean {
  return loadNative() !== null;
}

/**
 * Check if a commit/branch is an ancestor of another.
 * Returns true if `ancestor` is reachable from `descendant`.
 * Fallback: `git merge-base --is-ancestor`.
 */
export function nativeIsAncestor(basePath: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_NO_PROMPT_ENV,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the Unix epoch (seconds) of the latest commit on a ref.
 * Returns 0 if the ref doesn't exist or has no commits.
 * Fallback: `git log -1 --format=%ct <ref>`.
 */
export function nativeLastCommitEpoch(basePath: string, ref: string): number {
  try {
    const result = execFileSync("git", ["log", "-1", "--format=%ct", ref], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Count commits on `branch` that are not on any remote tracking branch.
 * Returns the count of unpushed commits, or -1 if the branch has no upstream.
 * Fallback: `git rev-list <branch> --not --remotes`.
 */
export function nativeUnpushedCount(basePath: string, branch: string): number {
  try {
    const result = execFileSync("git", ["rev-list", branch, "--not", "--remotes", "--count"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return -1;
  }
}

// ─── Re-exports for type consumers ──────────────────────────────────────

export type {
  GitDiffStat,
  GitNameStatus,
  GitNumstat,
  GitLogEntry,
  GitWorktreeEntry,
  GitBatchInfo,
  GitMergeResult,
};
