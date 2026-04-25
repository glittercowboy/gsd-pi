/**
 * Slice-cadence collapse — #4765.
 *
 * When `git.collapse_cadence: "slice"` is set, each slice's commits are
 * squash-merged from the milestone branch to main as soon as the slice
 * passes validation. Shrinks the orphan window (#4761) from milestone-size
 * to slice-size and surfaces merge conflicts per-slice rather than all at
 * once at milestone end.
 *
 * This module is deliberately focused and narrower than mergeMilestoneToMain:
 *   - No worktree teardown (worktree is reused for the next slice)
 *   - No DB reconciliation (modern worktrees share the main DB via path resolver)
 *   - No roadmap/summary/gate handling (that's still the milestone's job)
 *   - Fails loudly on dirty main — caller is responsible for cleanliness
 *
 * Kernighan: the v1 surface handles the happy path + conflict. Edge cases
 * that mergeMilestoneToMain covers (concurrent merges, shared DB paths,
 * submodules) are explicit non-goals; users opt in via preference and early-
 * adopter scenarios are scoped narrow.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { MergeConflictError } from "./git-service.js";
import {
  nativeBranchForceReset,
  nativeCheckoutBranch,
  nativeCommit,
  nativeCommitCountBetween,
  nativeConflictFiles,
  nativeDetectMainBranch,
  nativeMergeSquash,
} from "./native-git-bridge.js";
import { resolveGitDir } from "./worktree-manager.js";
import { logWarning } from "./workflow-logger.js";
import { emitSliceMerged, emitMilestoneResquash } from "./worktree-telemetry.js";

/**
 * Auto-worktree milestone branch name. Must match autoWorktreeBranch() in
 * auto-worktree.ts; duplicated here to avoid a cyclic import.
 */
function milestoneBranchName(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

function cleanupMergeArtifacts(projectRoot: string): void {
  try {
    const gitDir = resolveGitDir(projectRoot);
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      const p = join(gitDir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  } catch (err) {
    logWarning("worktree", `merge artifact cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface SliceMergeResult {
  commitSha: string | null;
  mainBranch: string;
  milestoneBranch: string;
  durationMs: number;
  skipped: boolean;
  skippedReason?: string;
}

/**
 * Squash-merge one slice's commits from the milestone branch to main.
 *
 * Preconditions:
 *   - Caller is on the milestone branch inside the worktree
 *   - `projectRoot` points at the real project root (not the worktree)
 *
 * Post-conditions on success:
 *   - Slice's commits are a single squash commit on main
 *   - `milestone/<MID>` is fast-forwarded to main (so next slice's work
 *     starts from a clean base)
 *   - caller's process.cwd is restored
 *
 * Throws MergeConflictError on conflicts; caller should surface and stop.
 * Throws GSDError on dirty main / detection failures.
 */
export function mergeSliceToMain(
  projectRoot: string,
  milestoneId: string,
  sliceId: string,
): SliceMergeResult {
  const started = Date.now();
  const worktreeCwd = process.cwd();
  const milestoneBranch = milestoneBranchName(milestoneId);
  const mainBranch = nativeDetectMainBranch(projectRoot);

  // Fast path: if the milestone branch has no commits ahead of main, there
  // is nothing to merge. Return a skip result instead of no-op'ing silently
  // so the caller's telemetry shows the decision.
  let commitsAhead = 0;
  try {
    commitsAhead = nativeCommitCountBetween(projectRoot, mainBranch, milestoneBranch);
  } catch {
    // If we can't count, assume there's work and let the merge proceed —
    // a failing merge is more informative than a silent skip.
    commitsAhead = 1;
  }
  if (commitsAhead === 0) {
    // Do NOT emit slice-merged here — this is a no-op, not a merge. Emitting
    // would inflate slicesMerged in telemetry/forensics and distort the
    // conflict rate denominator.
    return {
      commitSha: null,
      mainBranch,
      milestoneBranch,
      durationMs: Date.now() - started,
      skipped: true,
      skippedReason: "no-commits-ahead",
    };
  }

  process.chdir(projectRoot);
  try {
    // Dirty-main check — v1 fails loudly rather than auto-stashing. Users
    // running slice-cadence opt in knowing main stays clean between merges.
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (status) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `slice-cadence merge requires a clean project root; uncommitted changes detected. ` +
        `Commit or stash at ${projectRoot} before retrying. Status:\n${status}`,
      );
    }

    nativeCheckoutBranch(projectRoot, mainBranch);

    // Clean any stale merge artifacts before attempting the squash (#2912 pattern)
    cleanupMergeArtifacts(projectRoot);

    const mergeResult = nativeMergeSquash(projectRoot, milestoneBranch);
    if (!mergeResult.success) {
      const conflictedFiles = mergeResult.conflicts.length > 0
        ? mergeResult.conflicts
        : nativeConflictFiles(projectRoot);
      cleanupMergeArtifacts(projectRoot);
      try {
        emitSliceMerged(projectRoot, milestoneId, sliceId, {
          durationMs: Date.now() - started,
          conflict: true,
        });
      } catch { /* silent */ }
      throw new MergeConflictError(
        conflictedFiles,
        "squash",
        milestoneBranch,
        mainBranch,
      );
    }

    // Commit the squash with a slice-scoped message
    const commitSha = nativeCommit(
      projectRoot,
      `gsd: merge ${sliceId} of ${milestoneId} (slice-cadence)`,
    );

    // Advance the milestone branch to main so the next slice's commits start
    // from a clean base. Force-reset is safe because we just merged this
    // branch's entire delta.
    nativeBranchForceReset(projectRoot, milestoneBranch, mainBranch);

    const durationMs = Date.now() - started;
    try {
      emitSliceMerged(projectRoot, milestoneId, sliceId, {
        durationMs,
        conflict: false,
        commitSha: commitSha ?? undefined,
      });
    } catch { /* silent */ }

    return {
      commitSha,
      mainBranch,
      milestoneBranch,
      durationMs,
      skipped: false,
    };
  } finally {
    // Always restore cwd even if anything above threw.
    try { process.chdir(worktreeCwd); } catch { /* best-effort */ }
  }
}

/**
 * Re-squash per-slice commits on main into a single milestone commit.
 *
 * Runs at milestone completion when `collapse_cadence: "slice"` AND
 * `milestone_resquash: true`. The `startSha` is the SHA of main immediately
 * before the milestone's first slice merge — the caller is responsible for
 * recording this (AutoSession field, git ref, or DB row).
 *
 * Strategy: soft-reset main to startSha, then commit the net diff. The
 * N slice commits between startSha and HEAD are collapsed into one.
 *
 * No-op (returns false) if startSha equals HEAD (nothing to re-squash).
 */
export function resquashMilestoneOnMain(
  projectRoot: string,
  milestoneId: string,
  startSha: string,
): { resquashed: boolean; newSha: string | null } {
  const mainBranch = nativeDetectMainBranch(projectRoot);
  const worktreeCwd = process.cwd();

  process.chdir(projectRoot);
  try {
    nativeCheckoutBranch(projectRoot, mainBranch);

    // Verify the startSha..HEAD range contains ONLY this milestone's slice-
    // cadence commits. If any unrelated commits landed on main since the
    // milestone started (e.g. concurrent work, cherry-picks, hotfixes), a
    // blind `git reset --soft` would fold them into the re-squash and rewrite
    // their attribution. Fail closed — the user can resolve manually.
    const expectedSuffix = `(slice-cadence)`;
    const expectedMilestoneToken = ` of ${milestoneId} `;
    let subjectsRaw = "";
    try {
      subjectsRaw = execFileSync(
        "git",
        ["log", "--format=%s", `${startSha}..HEAD`],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      );
    } catch {
      return { resquashed: false, newSha: null };
    }
    const subjects = subjectsRaw.split("\n").filter((s) => s.length > 0);
    const sliceCount = subjects.length;
    if (sliceCount === 0) {
      return { resquashed: false, newSha: null };
    }
    const foreign = subjects.filter(
      (s) => !(s.endsWith(expectedSuffix) && s.includes(expectedMilestoneToken)),
    );
    if (foreign.length > 0) {
      logWarning(
        "worktree",
        `slice-cadence: skipping milestone resquash for ${milestoneId} — ` +
        `${foreign.length} non-slice-cadence commit(s) in ${startSha}..HEAD ` +
        `would be folded in. First: "${foreign[0]}". Resolve history manually.`,
      );
      return { resquashed: false, newSha: null };
    }

    // Safe to collapse: all commits in the range are this milestone's slices.
    execFileSync("git", ["reset", "--soft", startSha], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });

    const newSha = nativeCommit(
      projectRoot,
      `gsd: complete milestone ${milestoneId} (${sliceCount} slices re-squashed)`,
      { allowEmpty: true },
    );

    try {
      emitMilestoneResquash(projectRoot, milestoneId, {
        sliceCount,
        startSha,
        endSha: newSha ?? undefined,
      });
    } catch { /* silent */ }

    return { resquashed: true, newSha };
  } finally {
    try { process.chdir(worktreeCwd); } catch { /* best-effort */ }
  }
}

/**
 * Read the effective collapse cadence from validated preferences. Accepts
 * a raw preferences object (the shape loadEffectiveGSDPreferences returns).
 */
export function getCollapseCadence(
  prefs: { git?: { collapse_cadence?: "milestone" | "slice" } } | undefined | null,
): "milestone" | "slice" {
  return prefs?.git?.collapse_cadence ?? "milestone";
}

export function getMilestoneResquash(
  prefs: { git?: { milestone_resquash?: boolean } } | undefined | null,
): boolean {
  // Default true when cadence is slice — resquash preserves the milestone-
  // level history shape users expect.
  return prefs?.git?.milestone_resquash !== false;
}
