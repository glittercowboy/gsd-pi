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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";


import {
  detectWorktreeName,
} from "./worktree.js";
import { SLICE_BRANCH_RE, QUICK_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists,
  nativeHasChanges,
  nativeAddAllWithExclusions,
  nativeResetPaths,
  nativeHasStagedChanges,
  nativeCommit,
  nativeRmCached,
  nativeUpdateRef,
  nativeAddPaths,
  nativeResetSoft,
  nativeCommitSubject,
} from "./native-git-bridge.js";
import { GSDError, GSD_MERGE_CONFLICT, GSD_GIT_ERROR } from "./errors.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GitPreferences {
  auto_push?: boolean;
  push_branches?: boolean;
  remote?: string;
  snapshots?: boolean;
  /** Deprecated. .gsd/ is managed externally; retained for compatibility. */
  commit_docs?: boolean;
  pre_merge_check?: boolean | string;
  commit_type?: string;
  main_branch?: string;
  merge_strategy?: "squash" | "merge";
  /** Controls auto-mode git isolation strategy.
   *  - "worktree": creates a milestone worktree for isolated work
   *  - "branch": works directly in the project root (for submodule-heavy repos)
   *  - "none": (default) no git isolation — commits land on the user's current branch directly
   */
  isolation?: "worktree" | "branch" | "none";
  /** When false, GSD will not modify .gitignore at all — no baseline patterns
   *  are added and no self-healing occurs. Use this if you manage your own
   *  .gitignore and don't want GSD touching it.
   *  Default: true (GSD ensures baseline patterns are present).
   */
  manage_gitignore?: boolean;
  /** Script to run after a worktree is created (#597).
   *  Receives SOURCE_DIR and WORKTREE_DIR as environment variables.
   *  Can be an absolute path or relative to the project root.
   *  Failure is non-fatal — logged as a warning.
   */
  worktree_post_create?: string;
  /** When true, automatically create a pull request after milestone completion.
   *  The PR targets `pr_target_branch` (default: the main branch).
   *  Requires `push_branches: true` and a configured remote.
   *  Default: false.
   */
  auto_pr?: boolean;
  /** Target branch for auto-created PRs (e.g. "develop", "qa").
   *  Default: the main branch (from `main_branch` or auto-detected).
   */
  pr_target_branch?: string;
  /** Whether to squash `gsd snapshot:` commits into the next real autoCommit.
   *  Enabled by default. Set to false to keep snapshot commits in history
   *  for forensic inspection.
   */
  absorb_snapshot_commits?: boolean;
}

export const VALID_BRANCH_NAME = /^[a-zA-Z0-9_\-\/.]+$/;

export interface CommitOptions {
  message: string;
  allowEmpty?: boolean;
}

// ─── Meaningful Commit Message Generation ───────────────────────────────────

/** Context for generating a meaningful commit message from task execution results. */
export interface TaskCommitContext {
  taskId: string;
  taskTitle: string;
  /** The one-liner from the task summary (e.g. "Added retry-aware worker status logging") */
  oneLiner?: string;
  /** Files modified by this task (from task summary frontmatter) */
  keyFiles?: string[];
  /** GitHub issue number — appends "Resolves #N" trailer when set. */
  issueNumber?: number;
}

/**
 * Build a meaningful conventional commit message from task execution context.
 * Format: `{type}: {description}` (clean conventional commit — no GSD IDs in subject).
 *
 * GSD metadata is placed in a `GSD-Task:` git trailer at the end of the body,
 * following the same convention as `Signed-off-by:` or `Co-Authored-By:`.
 *
 * The description is the task summary one-liner if available (it describes
 * what was actually built), falling back to the task title (what was planned).
 */
export function buildTaskCommitMessage(ctx: TaskCommitContext): string {
  const description = ctx.oneLiner || ctx.taskTitle;
  const type = inferCommitType(ctx.taskTitle, ctx.oneLiner);

  // Truncate description to ~72 chars for subject line (full budget without scope)
  const maxDescLen = 70 - type.length;
  const truncated = description.length > maxDescLen
    ? description.slice(0, maxDescLen - 1).trimEnd() + "…"
    : description;

  const subject = `${type}: ${truncated}`;

  // Build body with key files if available
  const bodyParts: string[] = [];

  if (ctx.keyFiles && ctx.keyFiles.length > 0) {
    const fileLines = ctx.keyFiles
      .slice(0, 8) // cap at 8 files to keep commit concise
      .map(f => `- ${f}`)
      .join("\n");
    bodyParts.push(fileLines);
  }

  // Trailers: GSD-Task first, then Resolves
  bodyParts.push(`GSD-Task: ${ctx.taskId}`);

  if (ctx.issueNumber) {
    bodyParts.push(`Resolves #${ctx.issueNumber}`);
  }

  return `${subject}\n\n${bodyParts.join("\n\n")}`;
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
  ".gsd/gsd.db-shm",   // SQLite WAL sidecar — always created alongside gsd.db (#2296)
  ".gsd/gsd.db-wal",   // SQLite WAL sidecar — always created alongside gsd.db (#2296)
  ".gsd/journal/",     // daily-rotated JSONL event journal (#2296)
  ".gsd/doctor-history.jsonl", // doctor run history (#2296)
  ".gsd/DISCUSSION-MANIFEST.json",
];

// ─── Integration Branch Metadata ───────────────────────────────────────────

/**
 * Path to the milestone metadata file that stores the integration branch.
 * Format: .gsd/milestones/<MID>/<MID>-META.json
 */
function milestoneMetaPath(basePath: string, milestoneId: string): string {
  return join(gsdRoot(basePath), "milestones", milestoneId, `${milestoneId}-META.json`);
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
/** Re-export for backward compatibility — canonical definitions in branch-patterns.ts */
export { QUICK_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";

export function writeIntegrationBranch(
  basePath: string,
  milestoneId: string,
  branch: string,
): void {
  // Don't record slice branches as the integration target
  if (SLICE_BRANCH_RE.test(branch)) return;
  // Don't record quick-task branches — they are ephemeral and merge back
  // to their origin branch on completion. Recording one as the integration
  // target causes milestone merges to land on the wrong branch (#1293).
  if (QUICK_BRANCH_RE.test(branch)) return;
  // Don't record workflow-template branches (hotfix, bugfix, spike, etc.) —
  // same root cause as quick-task branches (#2498). All templates create
  // gsd/<templateId>/<slug> branches that are ephemeral.
  if (WORKFLOW_BRANCH_RE.test(branch)) return;
  // Validate
  if (!VALID_BRANCH_NAME.test(branch)) return;
  // Skip if already recorded with the same branch (idempotent across restarts).
  // If recorded with a different branch, update it — the user started auto-mode
  // from a new branch and expects slices to merge back there (#300).
  const existingBranch = readIntegrationBranch(basePath, milestoneId);
  if (existingBranch === branch) return;

  const metaFile = milestoneMetaPath(basePath, milestoneId);
  mkdirSync(join(gsdRoot(basePath), "milestones", milestoneId), { recursive: true });

  // Merge with existing metadata if present
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch { /* corrupt file — overwrite */ }

  existing.integrationBranch = branch;
  writeFileSync(metaFile, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  // .gsd/ is managed externally (symlinked) — metadata is not committed to git.
}

export type IntegrationBranchResolutionStatus = "recorded" | "fallback" | "missing";

export interface IntegrationBranchResolution {
  recordedBranch: string | null;
  effectiveBranch: string | null;
  status: IntegrationBranchResolutionStatus;
  reason: string;
}

/**
 * Resolve a milestone's recorded integration branch into an actionable status.
 *
 * This helper is intentionally scoped to milestones that already have recorded
 * metadata. If no integration branch is recorded, it returns `missing` with no
 * effective branch so callers can continue with their existing non-milestone
 * fallback logic (for example worktree/current-branch detection in getMainBranch).
 */
export function resolveMilestoneIntegrationBranch(
  basePath: string,
  milestoneId: string,
  prefs: GitPreferences = {},
): IntegrationBranchResolution {
  const recordedBranch = readIntegrationBranch(basePath, milestoneId);
  if (!recordedBranch) {
    return {
      recordedBranch: null,
      effectiveBranch: null,
      status: "missing",
      reason: `Milestone ${milestoneId} has no recorded integration branch metadata.`,
    };
  }

  if (nativeBranchExists(basePath, recordedBranch)) {
    return {
      recordedBranch,
      effectiveBranch: recordedBranch,
      status: "recorded",
      reason: `Using recorded integration branch "${recordedBranch}" for milestone ${milestoneId}.`,
    };
  }

  const configuredBranch = prefs.main_branch && VALID_BRANCH_NAME.test(prefs.main_branch)
    ? prefs.main_branch
    : null;

  if (configuredBranch) {
    if (nativeBranchExists(basePath, configuredBranch)) {
      return {
        recordedBranch,
        effectiveBranch: configuredBranch,
        status: "fallback",
        reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists; using configured git.main_branch "${configuredBranch}" instead.`,
      };
    }

    return {
      recordedBranch,
      effectiveBranch: null,
      status: "missing",
      reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists, and configured git.main_branch "${configuredBranch}" is unavailable.`,
    };
  }

  try {
    const detectedBranch = nativeDetectMainBranch(basePath);
    if (detectedBranch && VALID_BRANCH_NAME.test(detectedBranch) && nativeBranchExists(basePath, detectedBranch)) {
      return {
        recordedBranch,
        effectiveBranch: detectedBranch,
        status: "fallback",
        reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists; using detected fallback branch "${detectedBranch}" instead.`,
      };
    }
  } catch {
    // Fall through to the explicit missing result below.
  }

  return {
    recordedBranch,
    effectiveBranch: null,
    status: "missing",
    reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists, and no safe fallback branch could be determined.`,
  };
}

// ─── Git Helper ────────────────────────────────────────────────────────────


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
    const message = getErrorMessage(error);
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}: ${filterGitSvnNoise(message)}`);
  }
}

// ─── Commit Type Inference ─────────────────────────────────────────────────

/**
 * Keyword-to-commit-type mapping. Order matters — first match wins.
 * Each entry: [keywords[], commitType]
 */
const COMMIT_TYPE_RULES: [string[], string][] = [
  [["fix", "fixed", "fixes", "bug", "patch", "hotfix", "repair", "correct"], "fix"],
  [["refactor", "restructure", "reorganize"], "refactor"],
  [["doc", "docs", "documentation", "readme", "changelog"], "docs"],
  [["test", "tests", "testing", "spec", "coverage"], "test"],
  [["perf", "performance", "optimize", "speed", "cache"], "perf"],
  [["chore", "cleanup", "clean up", "dependencies", "deps", "bump", "config", "ci", "archive", "remove", "delete"], "chore"],
];

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

  /**
   * Smart staging: `git add -A` excluding GSD runtime paths via pathspec.
   * Falls back to plain `git add -A` if the exclusion pathspec fails.
   * @param extraExclusions Additional pathspec exclusions beyond RUNTIME_EXCLUSION_PATHS.
   */
  private smartStage(extraExclusions: readonly string[] = []): void {
    // One-time cleanup: if runtime files are already tracked in the index
    // (from older versions where the fallback bug staged them), untrack them
    // in a dedicated commit. This must happen as a separate commit because
    // the git reset HEAD step below would otherwise undo the rm --cached.
    //
    // SAFETY: Only untrack the specific RUNTIME paths (activity/, runtime/,
    // auto.lock, etc.) — NOT all of .gsd/. If .gsd/milestones/ files were
    // previously tracked, they stay tracked until the milestone completes
    // and the worktree is torn down. This prevents a mid-execution behavioral
    // discontinuity where the first half of a milestone has .gsd/ artifacts
    // committed but the second half doesn't (#1326).
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

    // Stage everything using pathspec exclusions so excluded paths are never
    // hashed by git. The old approach of `git add -A` followed by unstaging
    // hangs indefinitely on repos with large untracked artifact trees (#1605).
    //
    // Exclude only RUNTIME paths from staging — not the entire .gsd/ directory.
    // When .gsd/milestones/ files are already tracked in the index (projects
    // where .gsd/ is not gitignored, or Windows junctions that git sees as
    // real directories), they should continue to be committed. Excluding the
    // entire .gsd/ directory mid-milestone causes silent commit failure where
    // the second half of a milestone's artifacts are never committed (#1326).
    //
    // If .gsd/ IS in .gitignore (the default for external state projects),
    // git add -A already skips it and the exclusions are harmless no-ops.
    const allExclusions = [...RUNTIME_EXCLUSION_PATHS, ...extraExclusions];

    // ── Parallel worker milestone scope (#1991) ──
    // When GSD_MILESTONE_LOCK is set, this process is a parallel worker that
    // must only commit files belonging to its own milestone. Exclude all other
    // milestone directories from staging to prevent cross-milestone pollution
    // (e.g., an M033 worker fabricating M032 artifacts in the same commit).
    const milestoneLock = process.env.GSD_MILESTONE_LOCK;
    if (milestoneLock) {
      const msDir = join(gsdRoot(this.basePath), "milestones");
      if (existsSync(msDir)) {
        try {
          const entries = readdirSync(msDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== milestoneLock) {
              allExclusions.push(`.gsd/milestones/${entry.name}/`);
            }
          }
        } catch {
          // Best-effort — if we can't read the milestones dir, proceed without scoping
        }
      }
    }

    nativeAddAllWithExclusions(this.basePath, allExclusions);
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
   * Auto-commit dirty working tree.
   *
   * When `taskContext` is provided, generates a meaningful conventional commit
   * message from the task execution results (one-liner, title, inferred type).
   * Falls back to a generic `chore()` message when no context is available
   * (e.g. pre-switch commits, stop commits, state rebuild commits).
   *
   * Returns the commit message on success, or null if nothing to commit.
   * @param extraExclusions Additional paths to exclude from staging (e.g. [".gsd/"] for pre-switch commits).
   */
  autoCommit(
    unitType: string,
    unitId: string,
    extraExclusions: readonly string[] = [],
    taskContext?: TaskCommitContext,
  ): string | null {
    // Quick check: is there anything dirty at all?
    // Native path uses libgit2 (single syscall), fallback spawns git.
    if (!nativeHasChanges(this.basePath)) return null;

    this.smartStage(extraExclusions);

    // After smart staging, check if anything was actually staged
    // (all changes might have been runtime files that got excluded)
    if (!nativeHasStagedChanges(this.basePath)) return null;

    const message = taskContext
      ? buildTaskCommitMessage(taskContext)
      : `chore: auto-commit after ${unitType}\n\nGSD-Unit: ${unitId}`;
    nativeCommit(this.basePath, message, { allowEmpty: false });

    // Absorb any preceding gsd snapshot commits into this real commit.
    // Walk backwards from HEAD~1 counting consecutive snapshot subjects,
    // then soft-reset to before them and re-commit with the same message.
    this.absorbSnapshotCommits(message);

    return message;
  }

  /**
   * Squash consecutive `gsd snapshot:` commits that sit immediately below
   * HEAD into the current HEAD commit. This keeps the git history clean
   * after automated snapshot commits are superseded by real work.
   *
   * Guards:
   * - Opt-in via `absorb_snapshot_commits` preference (default: true).
   * - Refuses to rewrite commits that have been pushed to the remote
   *   tracking branch (checks merge-base ancestry).
   * - Saves HEAD SHA before reset; restores it if the re-commit fails.
   *
   * Does nothing if there are no snapshot commits to absorb.
   */
  private absorbSnapshotCommits(headMessage: string): void {
    try {
      // Opt-in guard — users can disable to keep snapshot commits for forensics
      if (this.prefs.absorb_snapshot_commits === false) return;

      const GSD_SNAPSHOT_PREFIX = "gsd snapshot:";
      let count = 0;

      // Walk back from HEAD~1 counting consecutive snapshot commits (cap at 10)
      for (let i = 1; i <= 10; i++) {
        const subject = nativeCommitSubject(this.basePath, `HEAD~${i}`);
        if (!subject.startsWith(GSD_SNAPSHOT_PREFIX)) break;
        count = i;
      }

      if (count === 0) return;

      // Guard: don't rewrite history that has been pushed to the remote.
      // Check whether the newest snapshot commit (HEAD~1) is already
      // reachable from the remote tracking branch. If it is, the snapshots
      // have been pushed and must not be squashed via local history rewrite.
      // (Checking resetTarget instead would false-positive when the remote
      // is at the pre-snapshot base but the snapshots themselves are local.)
      const resetTarget = `HEAD~${count + 1}`;
      try {
        const branch = nativeGetCurrentBranch(this.basePath);
        if (branch) {
          const remoteBranch = `origin/${branch}`;
          // merge-base --is-ancestor exits 0 if HEAD~1 is ancestor of remote
          execFileSync("git", ["merge-base", "--is-ancestor", "HEAD~1", remoteBranch], {
            cwd: this.basePath,
            stdio: ["ignore", "pipe", "pipe"],
          });
          // If we get here, newest snapshot IS reachable from remote — already pushed
          return;
        }
      } catch {
        // Not an ancestor or remote doesn't exist — safe to proceed
      }

      // Save HEAD SHA so we can restore if the re-commit fails
      const savedHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();

      nativeResetSoft(this.basePath, resetTarget);

      // Re-run smartStage so the same RUNTIME_EXCLUSION_PATHS apply.
      // Snapshot commits used nativeAddTracked (git add -u) which stages
      // ALL tracked modifications including .gsd/ state files. Without
      // re-staging, those .gsd/ changes leak into the absorbed commit.
      this.smartStage();

      try {
        nativeCommit(this.basePath, headMessage, { allowEmpty: false });
      } catch {
        // Re-commit failed — restore original HEAD to avoid leaving the
        // repo in a partially-reset state with no commit
        nativeResetSoft(this.basePath, savedHead);
      }
    } catch {
      // Non-fatal — if squash fails, the commits remain unsquashed
    }
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
      const resolved = resolveMilestoneIntegrationBranch(this.basePath, this._milestoneId);
      if (resolved.effectiveBranch) {
        return resolved.effectiveBranch;
      }
    }

    const wtName = detectWorktreeName(this.basePath);
    if (wtName) {
      // Auto-mode worktrees use milestone/<MID> branches (wtName = milestone ID)
      const milestoneBranch = `milestone/${wtName}`;
      const currentBranch = nativeGetCurrentBranch(this.basePath);

      // If we're on a milestone/<MID> branch, use it (auto-mode case)
      if (currentBranch.startsWith("milestone/")) {
        return currentBranch;
      }

      // Otherwise check for manual worktree branch (worktree/<name>)
      const wtBranch = `worktree/${wtName}`;
      if (nativeBranchExists(this.basePath, wtBranch)) return wtBranch;

      return currentBranch;
    }

    // Repo-level default detection: origin/HEAD → main → master → current branch.
    // Native path uses libgit2 (single call), fallback spawns multiple git processes.
    return nativeDetectMainBranch(this.basePath);
  }

  /** Get the current branch name. Native libgit2 when available, execSync fallback. */
  getCurrentBranch(): string {
    return nativeGetCurrentBranch(this.basePath);
  }

  /**
   * Create a snapshot ref for the given label (typically a slice branch name).
   * Enabled by default; opt out with prefs.snapshots === false.
   * Ref path: refs/gsd/snapshots/<label>/<timestamp>
   * The ref points at HEAD, capturing the current commit before destructive operations.
   */
  createSnapshot(label: string): void {
    if (this.prefs.snapshots === false) return;

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
    if (this.prefs.pre_merge_check === false) {
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
      const msg = getErrorMessage(err);
      return { passed: false, skipped: false, command, error: msg };
    }
  }

}

// ─── Draft PR Creation ─────────────────────────────────────────────────────

/**
 * Create a draft pull request for a completed milestone using `gh pr create`.
 * Returns the PR URL on success, or null on failure.
 * Non-fatal: callers should treat failure as best-effort.
 */
export function createDraftPR(
  basePath: string,
  milestoneId: string,
  title: string,
  body: string,
  opts?: { head?: string; base?: string },
): string | null {
  try {
    const args = [
      "pr", "create", "--draft",
      "--title", title,
      "--body", body,
    ];
    if (opts?.head) args.push("--head", opts.head);
    if (opts?.base) args.push("--base", opts.base);
    const result = execFileSync("gh", args, { cwd: basePath, encoding: "utf8", timeout: 30000, env: GIT_NO_PROMPT_ENV });
    return result.trim();
  } catch {
    return null;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

/** Create a GitServiceImpl with the current effective git preferences. */
export function createGitService(basePath: string): GitServiceImpl {
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  return new GitServiceImpl(basePath, gitPrefs);
}

// ─── Commit Type Inference ─────────────────────────────────────────────────

/**
 * Infer a conventional commit type from a title (and optional one-liner).
 * Uses case-insensitive word-boundary matching against known keywords.
 * Returns "feat" when no keywords match.
 *
 * Used for both slice squash-merge titles and task commit messages.
 */
export function inferCommitType(title: string, oneLiner?: string): string {
  const lower = `${title} ${oneLiner || ""}`.toLowerCase();

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
