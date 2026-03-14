/**
 * GSD Git Service
 *
 * Core git operations for GSD: types, constants, and pure helpers.
 * Higher-level operations (commit, staging, branching) build on these.
 *
 * This module centralizes the GitPreferences interface, runtime exclusion
 * paths, commit type inference, and the runGit shell helper.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import {
  detectWorktreeName,
  getSliceBranchName,
  SLICE_BRANCH_RE,
} from "./worktree.ts";

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
}

export const VALID_BRANCH_NAME = /^[a-zA-Z0-9_\-\/.]+$/;

export interface CommitOptions {
  message: string;
  allowEmpty?: boolean;
}

export interface MergeSliceResult {
  branch: string;
  mergedCommitMessage: string;
  deletedBranch: boolean;
}

/**
 * Thrown when a slice merge hits code conflicts in non-.gsd files.
 * The working tree is left in a conflicted state (no reset) so the
 * caller can dispatch a fix-merge session to resolve it.
 */
export class MergeConflictError extends Error {
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
 * was on at that point, so that slice branches merge back to it instead of
 * the repo's default branch. Idempotent when the branch matches; updates
 * the record when the user starts from a different branch.
 *
 * The file is committed immediately so it survives branch switches — the
 * pre-switch auto-commit excludes `.gsd/` to avoid merge conflicts, and
 * uncommitted `.gsd/` files are discarded during checkout.
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

  // Commit immediately — .gsd/ files are discarded during branch switches
  // (ensureSliceBranch excludes .gsd/ from pre-switch auto-commit and runs
  // git checkout -- .gsd/ to prevent checkout conflicts). Without this
  // commit, the metadata would be lost on the first branch switch.
  try {
    runGit(basePath, ["add", "--force", metaFile]);
    runGit(basePath, ["commit", "-F", "-"], {
      input: `chore(${milestoneId}): record integration branch`,
    });
  } catch {
    // Non-fatal — file is on disk even if commit fails (e.g. nothing to commit
    // because the file was already tracked with identical content)
  }
}

// ─── Git Helper ────────────────────────────────────────────────────────────

/** Env overlay that suppresses all interactive git credential prompts. */
const GIT_NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
};

/**
 * Run a git command in the given directory.
 * Returns trimmed stdout. Throws on non-zero exit unless allowFailure is set.
 * When `input` is provided, it is piped to stdin.
 */
export function runGit(basePath: string, args: string[], options: { allowFailure?: boolean; input?: string } = {}): string {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: basePath,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      ...(options.input != null ? { input: options.input } : {}),
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${basePath}: ${message}`);
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
        const result = this.git(["rm", "--cached", "-r", "--ignore-unmatch", exclusion], { allowFailure: true });
        if (result && result.includes("rm '")) cleaned = true;
      }
      if (cleaned) {
        this.git(["commit", "-F", "-"], { input: "chore: untrack .gsd/ runtime files from git index" });
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
    this.git(["add", "-A"]);
    for (const exclusion of allExclusions) {
      this.git(["reset", "HEAD", "--", exclusion], { allowFailure: true });
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
    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (!staged && !opts.allowEmpty) return null;

    this.git(
      ["commit", "-F", "-", ...(opts.allowEmpty ? ["--allow-empty"] : [])],
      { input: opts.message },
    );
    return opts.message;
  }

  /**
   * Auto-commit dirty working tree with a conventional chore message.
   * Returns the commit message on success, or null if nothing to commit.
   * @param extraExclusions Additional paths to exclude from staging (e.g. [".gsd/"] for pre-switch commits).
   */
  autoCommit(unitType: string, unitId: string, extraExclusions: readonly string[] = []): string | null {
    // Quick check: is there anything dirty at all?
    const status = this.git(["status", "--short"], { allowFailure: true });
    if (!status) return null;

    this.smartStage(extraExclusions);

    // After smart staging, check if anything was actually staged
    // (all changes might have been runtime files that got excluded)
    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (!staged) return null;

    const message = `chore(${unitId}): auto-commit after ${unitType}`;
    this.git(["commit", "-F", "-"], { input: message });
    return message;
  }

  // ─── Branch Queries ────────────────────────────────────────────────────

  /**
   * Get the "main" (integration) branch for this repo.
   *
   * Resolution order:
   * 1. Explicit `main_branch` preference (user override, highest priority)
   * 2. Milestone integration branch from metadata file (recorded at milestone start)
   * 3. Worktree base branch (worktree/<name>)
   * 4. origin/HEAD symbolic-ref → main/master fallback → current branch
   *
   * The integration branch (step 2) is what makes feature-branch workflows
   * work correctly: when a user starts GSD on `f-123-new-thing`, that branch
   * is recorded as the integration target, and all slice branches merge back
   * to it instead of the repo's default branch.
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
        const exists = this.git(["show-ref", "--verify", `refs/heads/${integrationBranch}`], { allowFailure: true });
        if (exists) return integrationBranch;
      }
    }

    const wtName = detectWorktreeName(this.basePath);
    if (wtName) {
      const wtBranch = `worktree/${wtName}`;
      const exists = this.git(["show-ref", "--verify", `refs/heads/${wtBranch}`], { allowFailure: true });
      if (exists) return wtBranch;
      return this.git(["branch", "--show-current"]);
    }

    const symbolic = this.git(["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFailure: true });
    if (symbolic) {
      const match = symbolic.match(/refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1]!;
    }

    const mainExists = this.git(["show-ref", "--verify", "refs/heads/main"], { allowFailure: true });
    if (mainExists) return "main";

    const masterExists = this.git(["show-ref", "--verify", "refs/heads/master"], { allowFailure: true });
    if (masterExists) return "master";

    return this.git(["branch", "--show-current"]);
  }

  /** Get the current branch name. */
  getCurrentBranch(): string {
    return this.git(["branch", "--show-current"]);
  }

  /** True if currently on a GSD slice branch. */
  isOnSliceBranch(): boolean {
    const current = this.getCurrentBranch();
    return SLICE_BRANCH_RE.test(current);
  }

  /** Returns the slice branch name if on one, null otherwise. */
  getActiveSliceBranch(): string | null {
    try {
      const current = this.getCurrentBranch();
      return SLICE_BRANCH_RE.test(current) ? current : null;
    } catch {
      return null;
    }
  }

  // ─── Branch Lifecycle ──────────────────────────────────────────────────

  /**
   * Check if a local branch exists.
   */
  private branchExists(branch: string): boolean {
    try {
      this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the slice branch exists and is checked out.
   *
   * Creates the branch from the current working branch if it's not a slice
   * branch (preserves planning artifacts). Falls back to main when on another
   * slice branch (avoids chaining slice branches).
   *
   * Auto-commits dirty state via smart staging before checkout so runtime
   * files are never accidentally committed during branch switches.
   *
   * Returns true if the branch was newly created.
   */
  ensureSliceBranch(milestoneId: string, sliceId: string): boolean {
    const wtName = detectWorktreeName(this.basePath);
    const branch = getSliceBranchName(milestoneId, sliceId, wtName);
    const current = this.getCurrentBranch();

    if (current === branch) return false;

    let created = false;

    if (!this.branchExists(branch)) {
      // Fetch from remote before creating a new branch (best-effort).
      const remotes = this.git(["remote"], { allowFailure: true });
      if (remotes) {
        const remote = this.prefs.remote ?? "origin";
        const fetchResult = this.git(["fetch", "--prune", remote], { allowFailure: true });
        if (fetchResult === "" && remotes.split("\n").includes(remote)) {
          // Check if local is behind upstream (informational only)
          const behind = this.git(
            ["rev-list", "--count", "HEAD..@{upstream}"],
            { allowFailure: true },
          );
          if (behind && parseInt(behind, 10) > 0) {
            console.error(`GitService: local branch is ${behind} commit(s) behind upstream`);
          }
        }
      }

      // Branch from current when it's a normal working branch (not a slice).
      // If already on a slice branch, fall back to main to avoid chaining.
      const mainBranch = this.getMainBranch();
      const base = SLICE_BRANCH_RE.test(current) ? mainBranch : current;
      this.git(["branch", branch, base]);
      created = true;
    } else {
      // Branch exists — check it's not checked out in another worktree
      const worktreeList = this.git(["worktree", "list", "--porcelain"]);
      if (worktreeList.includes(`branch refs/heads/${branch}`)) {
        throw new Error(
          `Branch "${branch}" is already in use by another worktree. ` +
          `Remove that worktree first, or switch it to a different branch.`,
        );
      }
    }

    // Auto-commit dirty state via smart staging before checkout.
    // Exclude .gsd/ to prevent merge conflicts when both branches modify planning artifacts.
    this.autoCommit("pre-switch", current, [".gsd/"]);

    // Discard uncommitted .gsd/ changes so checkout doesn't fail.
    // These are runtime files (metrics, completed-units, STATE) that were
    // intentionally excluded from the commit above. If they remain dirty,
    // git checkout refuses when the target branch has different versions.
    this.git(["checkout", "--", ".gsd/"], { allowFailure: true });

    this.git(["checkout", branch]);
    return created;
  }

  /**
   * Switch to main, auto-committing dirty state via smart staging first.
   */
  switchToMain(): void {
    const mainBranch = this.getMainBranch();
    const current = this.getCurrentBranch();
    if (current === mainBranch) return;

    // Exclude .gsd/ to prevent merge conflicts when both branches modify planning artifacts.
    this.autoCommit("pre-switch", current, [".gsd/"]);

    // Discard uncommitted .gsd/ changes so checkout doesn't fail.
    this.git(["checkout", "--", ".gsd/"], { allowFailure: true });

    this.git(["checkout", mainBranch]);
  }

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
    this.git(["update-ref", refPath, "HEAD"]);
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
        const pkg = execSync("cat package.json", { cwd: this.basePath, encoding: "utf-8" });
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

  /**
   * Build a rich squash-commit message with a task list from branch commits.
   *
   * Format:
   *   type(scope): title
   *
   *   Tasks:
   *   - commit subject 1
   *   - commit subject 2
   *
   *   Branch: gsd/M001/S01
   */
  private buildRichCommitMessage(
    commitType: string,
    milestoneId: string,
    sliceId: string,
    sliceTitle: string,
    mainBranch: string,
    branch: string,
  ): string {
    const subject = `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`;

    // Collect branch commit subjects
    const logOutput = this.git(
      ["log", "--oneline", "--format=%s", `${mainBranch}..${branch}`],
      { allowFailure: true },
    );

    if (!logOutput) return subject;

    const subjects = logOutput.split("\n").filter(Boolean);
    const MAX_ENTRIES = 20;
    const truncated = subjects.length > MAX_ENTRIES;
    const displayed = truncated ? subjects.slice(0, MAX_ENTRIES) : subjects;

    const taskLines = displayed.map(s => `- ${s}`).join("\n");
    const truncationLine = truncated ? `\n- ... and ${subjects.length - MAX_ENTRIES} more` : "";

    return `${subject}\n\nTasks:\n${taskLines}${truncationLine}\n\nBranch: ${branch}`;
  }

  /**
   * Squash-merge a slice branch into main and delete it.
   *
   * Flow: snapshot branch HEAD → squash merge → rich commit via stdin →
   * auto-push (if enabled) → delete branch.
   *
   * Must be called from the main branch. Uses `inferCommitType(sliceTitle)`
   * for the conventional commit type instead of hardcoding `feat`.
   *
   * Throws when:
   * - Not currently on the main branch
   * - The slice branch does not exist
   * - The slice branch has no commits ahead of main
   */
  mergeSliceToMain(milestoneId: string, sliceId: string, sliceTitle: string): MergeSliceResult {
    const mainBranch = this.getMainBranch();
    const current = this.getCurrentBranch();

    if (current !== mainBranch) {
      throw new Error(
        `mergeSliceToMain must be called from the main branch ("${mainBranch}"), ` +
        `but currently on "${current}"`,
      );
    }

    const wtName = detectWorktreeName(this.basePath);
    const branch = getSliceBranchName(milestoneId, sliceId, wtName);

    if (!this.branchExists(branch)) {
      throw new Error(
        `Slice branch "${branch}" does not exist. Nothing to merge.`,
      );
    }

    // Check commits ahead
    const aheadCount = this.git(["rev-list", "--count", `${mainBranch}..${branch}`]);
    if (aheadCount === "0") {
      throw new Error(
        `Slice branch "${branch}" has no commits ahead of "${mainBranch}". Nothing to merge.`,
      );
    }

    // Snapshot the branch HEAD before merge (gated on prefs)
    // We need to save the ref while the branch still exists
    this.createSnapshot(branch);

    // Build rich commit message before squash (needs branch history)
    const commitType = inferCommitType(sliceTitle);
    const message = this.buildRichCommitMessage(
      commitType, milestoneId, sliceId, sliceTitle, mainBranch, branch,
    );

    // Pull latest main before merging to avoid conflicts from remote changes
    this.git(["pull", "--rebase", "origin", mainBranch], { allowFailure: true });

    // Untrack runtime files that may have been manually committed (e.g. via `gsd queue`)
    // to prevent merge conflicts on files that belong in .gitignore (#189)
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      this.git(["rm", "--cached", "-r", "--ignore-unmatch", exclusion], { allowFailure: true });
    }
    const untrackDiff = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (untrackDiff && untrackDiff.trim()) {
      this.git(["commit", "-m", "chore: untrack .gsd/ runtime files before merge"], { allowFailure: true });
    }

    // Merge slice branch — strategy is configurable via git.merge_strategy
    // preference. Default: "squash" (preserves existing behavior).
    // "merge" uses --no-ff which is more resilient to conflicts from
    // long-lived branches or frequently-changing .gsd/* artifacts.
    const strategy = this.prefs.merge_strategy ?? "squash";
    const mergeArgs = strategy === "merge"
      ? ["merge", "--no-ff", "-m", message, branch]
      : ["merge", "--squash", branch];

    try {
      this.git(mergeArgs);
    } catch (mergeError) {
      // Check if conflicts can be auto-resolved (#189, #218)
      const conflicted = this.git(["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
      if (conflicted) {
        const conflictedFiles = conflicted.split("\n").filter(Boolean);
        const isRuntimeConflict = (f: string) =>
          RUNTIME_EXCLUSION_PATHS.some(excl => f.startsWith(excl.replace(/\/$/, "")));

        const runtimeConflicts = conflictedFiles.filter(isRuntimeConflict);
        const gsdConflicts = conflictedFiles.filter(f => f.startsWith(".gsd/") && !isRuntimeConflict(f));
        const otherConflicts = conflictedFiles.filter(
          f => !isRuntimeConflict(f) && !f.startsWith(".gsd/"),
        );

        let resolvedAny = false;

        if (runtimeConflicts.length > 0) {
          // Runtime conflicts: take theirs and remove from index
          for (const f of runtimeConflicts) {
            this.git(["checkout", "--theirs", "--", f], { allowFailure: true });
            this.git(["rm", "--cached", "--ignore-unmatch", f], { allowFailure: true });
          }
          resolvedAny = true;
        }

        if (gsdConflicts.length > 0) {
          // Non-runtime .gsd/ conflicts (DECISIONS.md, REQUIREMENTS.md, ROADMAP.md, etc.):
          // The slice branch has the authoritative .gsd/ state since the LLM just finished
          // updating these artifacts during complete-slice. Take theirs (the slice branch).
          for (const f of gsdConflicts) {
            this.git(["checkout", "--theirs", "--", f], { allowFailure: true });
          }
          resolvedAny = true;
        }

        if (resolvedAny) {
          this.git(["add", "-A"], { allowFailure: true });

          // Re-check remaining conflicts after auto-resolving runtime and .gsd/ files
          const remaining = this.git(["diff", "--name-only", "--diff-filter=U"], {
            allowFailure: true,
          });
          if (remaining) {
            const remainingFiles = remaining
              .split("\n")
              .filter(Boolean)
              .filter(f => !isRuntimeConflict(f) && !f.startsWith(".gsd/"));

            if (remainingFiles.length > 0) {
              // Non-runtime, non-.gsd/ conflicts: leave working tree in conflicted state and throw
              // MergeConflictError so the caller can dispatch a fix-merge session.
              throw new MergeConflictError(remainingFiles, strategy, branch, mainBranch);
            }
          }
          // No remaining non-runtime, non-.gsd/ conflicts — let the merge proceed
        } else {
          // No runtime or .gsd/ conflicts to auto-resolve; throw with original conflicted files
          // so the caller can dispatch a fix-merge session.
          throw new MergeConflictError(otherConflicts.length ? otherConflicts : conflictedFiles, strategy, branch, mainBranch);
        }
      } else {
        // No conflicted files detected but merge still failed — reset and throw
        this.git(["reset", "--hard", "HEAD"], { allowFailure: true });
        const msg = mergeError instanceof Error ? mergeError.message : String(mergeError);
        throw new Error(
          `${strategy === "merge" ? "Merge" : "Squash-merge"} of "${branch}" into "${mainBranch}" failed. ` +
          `Working tree has been reset to a clean state. ` +
          `Resolve manually: git checkout ${mainBranch} && git merge ${strategy === "merge" ? "--no-ff" : "--squash"} ${branch}\n` +
          `Original error: ${msg}`,
        );
      }
    }

    // Strip runtime files from the merge result before committing (#302).
    // This replaces the old approach of checking out the slice branch to
    // untrack runtime files pre-merge, which failed when the working tree
    // had uncommitted .gsd/ changes that blocked the checkout.
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      this.git(["rm", "--cached", "-r", "--ignore-unmatch", exclusion], { allowFailure: true });
    }

    if (strategy === "squash") {
      this.git(["commit", "-F", "-"], { input: message });
    } else {
      // --no-ff already committed; amend to include runtime file removal
      const runtimeDiff = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
      if (runtimeDiff?.trim()) {
        this.git(["commit", "--amend", "--no-edit"]);
      }
    }

    // Delete the merged branch
    this.git(["branch", "-D", branch]);

    // Auto-push to remote if enabled
    if (this.prefs.auto_push === true) {
      const remote = this.prefs.remote ?? "origin";
      const pushResult = this.git(["push", remote, mainBranch], { allowFailure: true });
      if (pushResult === "") {
        // push succeeded (empty stdout is normal) or failed silently
        // Verify by checking if remote is reachable — the allowFailure handles errors
      }
    }

    return {
      branch,
      mergedCommitMessage: `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`,
      deletedBranch: true,
    };
  }
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
