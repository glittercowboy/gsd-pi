// Native Git Bridge
// Provides fast READ-ONLY git operations backed by libgit2 via the Rust native module.
// Falls back to execSync git commands when the native module is unavailable.
//
// Only READ operations are native — WRITE operations (commit, merge, checkout, push)
// remain as execSync calls in git-service.ts.

import { execSync } from "node:child_process";

/** Env overlay that suppresses interactive git credential prompts and git-svn noise. */
const GIT_NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SVN_ID: "",
};

let nativeModule: {
  gitCurrentBranch: (repoPath: string) => string | null;
  gitMainBranch: (repoPath: string) => string;
  gitBranchExists: (repoPath: string, branch: string) => boolean;
  gitHasMergeConflicts: (repoPath: string) => boolean;
  gitWorkingTreeStatus: (repoPath: string) => string;
  gitHasChanges: (repoPath: string) => boolean;
  gitCommitCountBetween: (repoPath: string, fromRef: string, toRef: string) => number;
} | null = null;

let loadAttempted = false;

// Keep native main-branch detection independent from worktree.ts to avoid a circular import.
const GSD_SLICE_BRANCH_RE = /^gsd\/(?:[a-zA-Z0-9_-]+\/)?M\d+(?:-[a-z0-9]{6})?\/S\d+$/;

function loadNative(): typeof nativeModule {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;

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

/** Run a git command via execSync. Returns trimmed stdout. */
function gitExec(basePath: string, args: string[], allowFailure = false): string {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
    }).trim();
  } catch {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed in ${basePath}`);
  }
}

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
 *
 * Note: milestone integration branch and worktree detection are handled
 * by the caller (GitServiceImpl.getMainBranch) — this only covers the
 * repo-level default detection that spawned multiple git processes.
 */
export function nativeDetectMainBranch(basePath: string): string {
  const native = loadNative();
  if (native) {
    const nativeBranch = native.gitMainBranch(basePath);
    if (!GSD_SLICE_BRANCH_RE.test(nativeBranch)) {
      return nativeBranch;
    }
  }

  // Fallback: same logic as GitServiceImpl.getMainBranch() repo-level detection
  const symbolic = gitExec(basePath, ["symbolic-ref", "refs/remotes/origin/HEAD"], true);
  if (symbolic) {
    const match = symbolic.match(/refs\/remotes\/origin\/(.+)$/);
    const branch = match?.[1];
    if (branch && !GSD_SLICE_BRANCH_RE.test(branch)) return branch;
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
 * Fallback: `git show-ref --verify`.
 */
export function nativeBranchExists(basePath: string, branch: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitBranchExists(basePath, branch);
  }
  const result = gitExec(basePath, ["show-ref", "--verify", `refs/heads/${branch}`], true);
  return result !== "";
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

/**
 * Quick check: any staged or unstaged changes?
 * Native: libgit2 status check (single syscall).
 * Fallback: `git status --short`.
 */
export function nativeHasChanges(basePath: string): boolean {
  const native = loadNative();
  if (native) {
    return native.gitHasChanges(basePath);
  }
  const result = gitExec(basePath, ["status", "--short"], true);
  return result !== "";
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

/**
 * Check if the native git module is available.
 */
export function isNativeGitAvailable(): boolean {
  return loadNative() !== null;
}
