/**
 * WorktreeResolver — encapsulates worktree path state and merge/exit lifecycle.
 *
 * Replaces scattered `s.basePath`/`s.originalBasePath` mutation and 3 duplicated
 * merge-or-teardown blocks in auto-loop.ts with single method calls. All
 * `s.basePath` mutations (except session.reset() and initial setup) happen
 * through this class.
 *
 * Design: Option A — mutates AutoSession fields directly so existing `s.basePath`
 * reads continue to work everywhere without wiring changes.
 *
 * Key invariant: `createAutoWorktree()` and `enterAutoWorktree()` call
 * `process.chdir()` internally — this class MUST NOT double-chdir.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AutoSession } from "./auto/session.js";
import { debugLog } from "./debug-logger.js";
import { MergeConflictError } from "./git-service.js";
import { emitJournalEvent } from "./journal.js";
import { emitWorktreeCreated, emitWorktreeMerged } from "./worktree-telemetry.js";
import { getCollapseCadence, getMilestoneResquash, resquashMilestoneOnMain } from "./slice-cadence.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";

// ─── Dependency Interface ──────────────────────────────────────────────────

export interface WorktreeResolverDeps {
  isInAutoWorktree: (basePath: string) => boolean;
  shouldUseWorktreeIsolation: () => boolean;
  getIsolationMode: () => "worktree" | "branch" | "none";
  mergeMilestoneToMain: (
    basePath: string,
    milestoneId: string,
    roadmapContent: string,
  ) => { pushed: boolean; codeFilesChanged: boolean };
  syncWorktreeStateBack: (
    mainBasePath: string,
    worktreePath: string,
    milestoneId: string,
  ) => { synced: string[] };
  teardownAutoWorktree: (
    basePath: string,
    milestoneId: string,
    opts?: { preserveBranch?: boolean },
  ) => void;
  createAutoWorktree: (basePath: string, milestoneId: string) => string;
  enterAutoWorktree: (basePath: string, milestoneId: string) => string;
  enterBranchModeForMilestone: (basePath: string, milestoneId: string) => void;
  getAutoWorktreePath: (basePath: string, milestoneId: string) => string | null;
  autoCommitCurrentBranch: (
    basePath: string,
    reason: string,
    milestoneId: string,
  ) => void;
  getCurrentBranch: (basePath: string) => string;
  autoWorktreeBranch: (milestoneId: string) => string;
  resolveMilestoneFile: (
    basePath: string,
    milestoneId: string,
    fileType: string,
  ) => string | null;
  readFileSync: (path: string, encoding: string) => string;
  GitServiceImpl: new (basePath: string, gitConfig: unknown) => unknown;
  loadEffectiveGSDPreferences: () =>
    | { preferences?: { git?: Record<string, unknown> } }
    | undefined;
  invalidateAllCaches: () => void;
  captureIntegrationBranch: (
    basePath: string,
    mid: string,
  ) => void;
}

// ─── Notify Context ────────────────────────────────────────────────────────

export interface NotifyCtx {
  notify: (
    msg: string,
    level?: "info" | "warning" | "error" | "success",
  ) => void;
}

// ─── Path Helpers ──────────────────────────────────────────────────────────

/**
 * Worktree marker segment — present in any path produced by worktreePath().
 * Used to strip the worktree suffix and recover the project root (#3729).
 */
const WORKTREE_MARKER = "/.gsd/worktrees/";

/**
 * Resolve the project root from session path state.
 *
 * Prefers `originalBasePath` (always the project root when set), but falls
 * back to `basePath` when `originalBasePath` is falsy (e.g. fresh AutoSession
 * with default empty string). If `basePath` itself is inside a worktree
 * directory (contains `/.gsd/worktrees/`), strip that suffix to recover the
 * actual project root — preventing double-nested worktree paths (#3729).
 */
export function resolveProjectRoot(
  originalBasePath: string,
  basePath: string,
): string {
  let resolved = originalBasePath || basePath;
  const markerIdx = resolved.indexOf(WORKTREE_MARKER);
  if (markerIdx !== -1) {
    resolved = resolved.slice(0, markerIdx);
  }
  return resolved;
}

// ─── WorktreeResolver ──────────────────────────────────────────────────────

export class WorktreeResolver {
  private readonly s: AutoSession;
  private readonly deps: WorktreeResolverDeps;

  constructor(session: AutoSession, deps: WorktreeResolverDeps) {
    this.s = session;
    this.deps = deps;
  }

  // ── Getters ────────────────────────────────────────────────────────────

  /** Current working path — may be worktree or project root. */
  get workPath(): string {
    return this.s.basePath;
  }

  /** Original project root — always the non-worktree path. */
  get projectRoot(): string {
    return resolveProjectRoot(this.s.originalBasePath, this.s.basePath);
  }

  /** Path for auto.lock file — same as the old lockBase(). */
  get lockPath(): string {
    return resolveProjectRoot(this.s.originalBasePath, this.s.basePath);
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private rebuildGitService(): void {
    const gitConfig =
      this.deps.loadEffectiveGSDPreferences()?.preferences?.git ?? {};
    this.s.gitService = new this.deps.GitServiceImpl(
      this.s.basePath,
      gitConfig,
    ) as AutoSession["gitService"];
  }

  /** Restore basePath to originalBasePath and rebuild GitService. */
  private restoreToProjectRoot(): void {
    if (!this.s.originalBasePath) return;
    this.s.basePath = this.s.originalBasePath;
    this.rebuildGitService();
    this.deps.invalidateAllCaches();
  }

  // ── Validation ──────────────────────────────────────────────────────────

  /** Validate milestoneId to prevent path traversal. */
  private validateMilestoneId(milestoneId: string): void {
    if (/[\/\\]|\.\./.test(milestoneId)) {
      throw new Error(
        `Invalid milestoneId: ${milestoneId} — contains path separators or traversal`,
      );
    }
  }

  // ── Enter Milestone ────────────────────────────────────────────────────

  /**
   * Enter or create a worktree for the given milestone.
   *
   * Only acts if `shouldUseWorktreeIsolation()` returns true.
   * Delegates to `enterAutoWorktree` (existing) or `createAutoWorktree` (new).
   * Those functions call `process.chdir()` internally — we do NOT double-chdir.
   *
   * Updates `s.basePath` and rebuilds GitService on success.
   * On failure: notifies a warning and does NOT update `s.basePath`.
   */
  enterMilestone(milestoneId: string, ctx: NotifyCtx): void {
    this.validateMilestoneId(milestoneId);

    // If worktree creation failed earlier this session, skip all future attempts
    if (this.s.isolationDegraded) {
      debugLog("WorktreeResolver", {
        action: "enterMilestone",
        milestoneId,
        skipped: true,
        reason: "isolation-degraded",
      });
      return;
    }

    const mode = this.deps.getIsolationMode();

    if (mode === "none") {
      debugLog("WorktreeResolver", {
        action: "enterMilestone",
        milestoneId,
        skipped: true,
        reason: "isolation-disabled",
      });
      emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-skip",
        data: { milestoneId, reason: "isolation-disabled" },
      });
      return;
    }

    // Resolve the project root for worktree operations via shared helper.
    // Handles the case where originalBasePath is falsy and basePath is itself
    // a worktree path — prevents double-nested worktree paths (#3729).
    const basePath = resolveProjectRoot(this.s.originalBasePath, this.s.basePath);
    debugLog("WorktreeResolver", {
      action: "enterMilestone",
      milestoneId,
      mode,
      basePath,
    });

    // ── Branch mode: create/checkout milestone branch, stay in project root ──
    if (mode === "branch") {
      try {
        this.deps.enterBranchModeForMilestone(basePath, milestoneId);
        // basePath does not change — no worktree, no chdir.
        // Rebuild GitService so the new HEAD is reflected, then flush any
        // path-keyed caches that may have been populated before the checkout.
        this.rebuildGitService();
        this.deps.invalidateAllCaches();
        debugLog("WorktreeResolver", {
          action: "enterMilestone",
          milestoneId,
          mode: "branch",
          result: "success",
        });
        emitJournalEvent(basePath, {
          ts: new Date().toISOString(),
          flowId: randomUUID(),
          seq: 0,
          eventType: "worktree-skip",
          data: { milestoneId, reason: "branch-mode-no-worktree" },
        });
        ctx.notify(`Switched to branch milestone/${milestoneId}.`, "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog("WorktreeResolver", {
          action: "enterMilestone",
          milestoneId,
          mode: "branch",
          result: "error",
          error: msg,
        });
        ctx.notify(
          `Branch isolation setup for ${milestoneId} failed: ${msg}. Continuing on current branch.`,
          "warning",
        );
        this.s.isolationDegraded = true;
      }
      return;
    }

    // ── Worktree mode ─────────────────────────────────────────────────────────
    try {
      const existingPath = this.deps.getAutoWorktreePath(basePath, milestoneId);
      let wtPath: string;

      if (existingPath) {
        wtPath = this.deps.enterAutoWorktree(basePath, milestoneId);
      } else {
        wtPath = this.deps.createAutoWorktree(basePath, milestoneId);
      }

      this.s.basePath = wtPath;
      this.rebuildGitService();

      debugLog("WorktreeResolver", {
        action: "enterMilestone",
        milestoneId,
        result: "success",
        wtPath,
      });
      emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-enter",
        data: { milestoneId, wtPath, created: !existingPath },
      });
      // #4764 — record creation/enter as a lifecycle event so the telemetry
      // aggregator can pair it with the eventual worktree-merged event.
      try {
        emitWorktreeCreated(this.s.originalBasePath || this.s.basePath, milestoneId, {
          reason: existingPath ? "enter-milestone" : "create-milestone",
        });
      } catch (telemetryErr) {
        debugLog("WorktreeResolver", {
          action: "enterMilestone",
          phase: "telemetry-emit",
          error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
        });
      }
      ctx.notify(`Entered worktree for ${milestoneId} at ${wtPath}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeResolver", {
        action: "enterMilestone",
        milestoneId,
        result: "error",
        error: msg,
      });
      emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-create-failed",
        data: { milestoneId, error: msg, fallback: "project-root" },
      });
      ctx.notify(
        `Auto-worktree creation for ${milestoneId} failed: ${msg}. Continuing in project root.`,
        "warning",
      );
      // Degrade isolation for the rest of this session so mergeAndExit
      // doesn't try to merge a nonexistent worktree branch (#2483)
      this.s.isolationDegraded = true;
      // Do NOT update s.basePath — stay in project root
    }
  }

  // ── Exit Milestone ─────────────────────────────────────────────────────

  /**
   * Exit the current worktree: auto-commit, teardown, reset basePath.
   *
   * Only acts if currently in an auto-worktree (checked via `isInAutoWorktree`).
   * Resets `s.basePath` to `s.originalBasePath` and rebuilds GitService.
   */
  exitMilestone(
    milestoneId: string,
    ctx: NotifyCtx,
    opts?: { preserveBranch?: boolean },
  ): void {
    this.validateMilestoneId(milestoneId);
    if (!this.deps.isInAutoWorktree(this.s.basePath)) {
      debugLog("WorktreeResolver", {
        action: "exitMilestone",
        milestoneId,
        skipped: true,
        reason: "not-in-worktree",
      });
      return;
    }

    debugLog("WorktreeResolver", {
      action: "exitMilestone",
      milestoneId,
      basePath: this.s.basePath,
    });

    try {
      this.deps.autoCommitCurrentBranch(this.s.basePath, "stop", milestoneId);
    } catch (err) {
      debugLog("WorktreeResolver", {
        action: "exitMilestone",
        milestoneId,
        phase: "auto-commit-failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      this.deps.teardownAutoWorktree(this.s.originalBasePath, milestoneId, {
        preserveBranch: opts?.preserveBranch ?? false,
      });
    } catch (err) {
      debugLog("WorktreeResolver", {
        action: "exitMilestone",
        milestoneId,
        phase: "teardown-failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.restoreToProjectRoot();
    debugLog("WorktreeResolver", {
      action: "exitMilestone",
      milestoneId,
      result: "done",
      basePath: this.s.basePath,
    });
    ctx.notify(`Exited worktree for ${milestoneId}`, "info");
  }

  // ── Merge and Exit ─────────────────────────────────────────────────────

  /**
   * Merge the completed milestone branch back to main and exit the worktree.
   *
   * Handles all three isolation modes:
   * - **worktree**: Read roadmap, merge, teardown worktree, reset paths.
   *   Falls back to bare teardown if no roadmap exists.
   * - **branch**: Check if on milestone branch, merge if so (no chdir/teardown).
   * - **none**: No-op.
   *
   * Error recovery: on merge failure, always restore `s.basePath` to
   * `s.originalBasePath` and `process.chdir(s.originalBasePath)`.
   */
  mergeAndExit(milestoneId: string, ctx: NotifyCtx): void {
    this.validateMilestoneId(milestoneId);

    // #4764 — telemetry: record start timestamp so we can emit merge duration.
    const mergeStartedAt = new Date().toISOString();
    const mergeStartMs = Date.now();

    // If worktree creation failed earlier, skip merge — work is on current branch (#2483)
    if (this.s.isolationDegraded) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        skipped: true,
        reason: "isolation-degraded",
      });
      ctx.notify(
        `Skipping worktree merge for ${milestoneId} — isolation was degraded (worktree creation failed earlier). Work is on the current branch.`,
        "info",
      );
      return;
    }

    const mode = this.deps.getIsolationMode();
    debugLog("WorktreeResolver", {
      action: "mergeAndExit",
      milestoneId,
      mode,
      basePath: this.s.basePath,
    });
    emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
      ts: new Date().toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-merge-start",
      data: { milestoneId, mode },
    });

    // #2625: If we are physically inside an auto-worktree, we MUST merge
    // regardless of the current isolation config. This prevents data loss when
    // the default isolation mode changes between versions (e.g., "worktree" ->
    // "none"): the worktree branch still holds real commits that need merging.
    const inWorktree = this.deps.isInAutoWorktree(this.s.basePath) && this.s.originalBasePath;

    if (mode === "none" && !inWorktree) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        skipped: true,
        reason: "mode-none",
      });
      return;
    }

    let actuallyMerged = false;
    if (
      mode === "worktree" || inWorktree
    ) {
      actuallyMerged = this._mergeWorktreeMode(milestoneId, ctx);
    } else if (mode === "branch") {
      actuallyMerged = this._mergeBranchMode(milestoneId, ctx);
    }

    // The remainder of this function emits telemetry and runs re-squash.
    // Both are gated on actuallyMerged — if the _merge* helper took a
    // no-merge path (missing originalBase, no roadmap, wrong branch) the
    // milestone branch was intentionally left unmerged and we must not
    // emit a worktree-merged event or collapse commits on main.
    if (!actuallyMerged) {
      // Always clear the start-SHA tracker to avoid leaking across sessions.
      this.s.milestoneStartShas.delete(milestoneId);
      return;
    }

    // #4765 — when collapse_cadence=slice AND milestone_resquash=true, the
    // N per-slice commits on main should be collapsed into one milestone
    // commit. Done AFTER the primary merge-and-teardown so the branch and
    // worktree are already cleaned up; we operate on main directly.
    try {
      const startSha = this.s.milestoneStartShas.get(milestoneId);
      if (startSha) {
        const prefs = loadEffectiveGSDPreferences(this.s.originalBasePath || this.s.basePath)?.preferences;
        if (getCollapseCadence(prefs) === "slice" && getMilestoneResquash(prefs)) {
          const result = resquashMilestoneOnMain(
            this.s.originalBasePath || this.s.basePath,
            milestoneId,
            startSha,
          );
          if (result.resquashed) {
            ctx.notify(
              `slice-cadence: re-squashed slice commits for ${milestoneId} into a single milestone commit.`,
              "info",
            );
          }
        }
        this.s.milestoneStartShas.delete(milestoneId);
      }
    } catch (err) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        phase: "resquash",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // #4764 — record merge completion. Only reaches here when an actual
    // merge ran; failure paths throw out of _merge* before this point and
    // no-merge paths returned above.
    try {
      emitWorktreeMerged(this.s.originalBasePath || this.s.basePath, milestoneId, {
        reason: "milestone-complete",
        startedAt: mergeStartedAt,
        durationMs: Date.now() - mergeStartMs,
      });
    } catch (telemetryErr) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        phase: "telemetry-emit",
        error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
      });
    }
  }

  /** Worktree-mode merge: read roadmap, merge, teardown, reset paths.
   *  Returns true when a squash-merge actually ran (false on skip paths). */
  private _mergeWorktreeMode(milestoneId: string, ctx: NotifyCtx): boolean {
    const originalBase = this.s.originalBasePath;
    if (!originalBase) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        mode: "worktree",
        skipped: true,
        reason: "missing-original-base",
      });
      return false;
    }

    let merged = false;
    try {
      const { synced } = this.deps.syncWorktreeStateBack(
        originalBase,
        this.s.basePath,
        milestoneId,
      );
      if (synced.length > 0) {
        debugLog("WorktreeResolver", {
          action: "mergeAndExit",
          milestoneId,
          phase: "reverse-sync",
          synced: synced.length,
        });
      }

      // Resolve roadmap — try project root first, then worktree path as fallback.
      // The worktree may hold the only copy when syncWorktreeStateBack fails
      // silently or .gsd/ is not symlinked. Without the fallback, a missing
      // roadmap triggers bare teardown which deletes the branch and orphans all
      // milestone commits (#1573).
      let roadmapPath = this.deps.resolveMilestoneFile(
        originalBase,
        milestoneId,
        "ROADMAP",
      );
      if (!roadmapPath && this.s.basePath !== originalBase) {
        roadmapPath = this.deps.resolveMilestoneFile(
          this.s.basePath,
          milestoneId,
          "ROADMAP",
        );
        if (roadmapPath) {
          debugLog("WorktreeResolver", {
            action: "mergeAndExit",
            milestoneId,
            phase: "roadmap-fallback",
            note: "resolved from worktree path",
          });
        }
      }

      if (roadmapPath) {
        const roadmapContent = this.deps.readFileSync(roadmapPath, "utf-8");
        const mergeResult = this.deps.mergeMilestoneToMain(
          originalBase,
          milestoneId,
          roadmapContent,
        );
        merged = true;

        // #2945 Bug 3: mergeMilestoneToMain performs best-effort worktree
        // cleanup internally (step 12), but it can silently fail on Windows
        // or when the worktree directory is locked. Perform a secondary
        // teardown here to ensure the worktree is properly cleaned up.
        // This is idempotent — if the worktree was already removed,
        // teardownAutoWorktree handles the no-op case gracefully.
        try {
          this.deps.teardownAutoWorktree(originalBase, milestoneId);
        } catch {
          // Best-effort — the primary cleanup in mergeMilestoneToMain may
          // have already removed the worktree.
        }

        if (mergeResult.codeFilesChanged) {
          ctx.notify(
            `Milestone ${milestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
            "info",
          );
        } else {
          // (#1906) Milestone produced only .gsd/ metadata — no actual code was
          // merged. This typically means the LLM wrote planning artifacts
          // (summaries, roadmaps) but never implemented the code. Surface this
          // clearly so the user knows the milestone is not truly complete.
          ctx.notify(
            `WARNING: Milestone ${milestoneId} merged to main but contained NO code changes — only .gsd/ metadata files. ` +
              `The milestone summary may describe planned work that was never implemented. ` +
              `Review the milestone output and re-run if code is missing.`,
            "warning",
          );
        }
      } else {
        // No roadmap at either location — teardown but PRESERVE the branch so
        // commits are not orphaned. The user can merge manually later (#1573).
        this.deps.teardownAutoWorktree(originalBase, milestoneId, {
          preserveBranch: true,
        });
        ctx.notify(
          `Exited worktree for ${milestoneId} (no roadmap found — branch preserved for manual merge).`,
          "warning",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        result: "error",
        error: msg,
        fallback: "chdir-to-project-root",
      });
      emitJournalEvent(this.s.originalBasePath || this.s.basePath, {
        ts: new Date().toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-merge-failed",
        data: { milestoneId, error: msg },
      });
      // Surface a clear, actionable error. The worktree and milestone branch are
      // intentionally preserved — nothing has been deleted. The user can retry
      // /gsd dispatch complete-milestone or merge manually once the underlying
      // issue is fixed (e.g. checkout to wrong branch, unresolved conflicts).
      // (#1668, #1891)
      ctx.notify(
        `Milestone merge failed: ${msg}. Your worktree and milestone branch are preserved — retry with \`/gsd dispatch complete-milestone\` or merge manually.`,
        "warning",
      );

      // Clean up stale merge state left by failed squash-merge (#1389)
      try {
        const gitDir = join(originalBase || this.s.basePath, ".git");
        for (const f of ["SQUASH_MSG", "MERGE_HEAD", "MERGE_MSG"]) {
          const p = join(gitDir, f);
          if (existsSync(p)) unlinkSync(p);
        }
      } catch { /* best-effort */ }

      // Error recovery: always restore to project root
      if (originalBase) {
        try {
          process.chdir(originalBase);
        } catch {
          /* best-effort */
        }
      }

      // Restore state before re-throwing so callers always get a consistent
      // session (#4380).
      this.restoreToProjectRoot();
      // Re-throw: MergeConflictError stops the auto loop (#2330); non-conflict
      // errors (permission denied, filesystem failures) must also propagate so
      // broken states are diagnosable (#4380).
      throw err;
    }

    // Always restore basePath and rebuild — whether merge succeeded or failed
    this.restoreToProjectRoot();
    debugLog("WorktreeResolver", {
      action: "mergeAndExit",
      milestoneId,
      result: "done",
      basePath: this.s.basePath,
    });
    return merged;
  }

  /** Branch-mode merge: check current branch, merge if on milestone branch.
   *  Returns true when a merge actually ran (false on skip paths). */
  private _mergeBranchMode(milestoneId: string, ctx: NotifyCtx): boolean {
    try {
      const currentBranch = this.deps.getCurrentBranch(this.s.basePath);
      const milestoneBranch = this.deps.autoWorktreeBranch(milestoneId);

      if (currentBranch !== milestoneBranch) {
        debugLog("WorktreeResolver", {
          action: "mergeAndExit",
          milestoneId,
          mode: "branch",
          skipped: true,
          reason: "not-on-milestone-branch",
          currentBranch,
          milestoneBranch,
        });
        return false;
      }

      const roadmapPath = this.deps.resolveMilestoneFile(
        this.s.basePath,
        milestoneId,
        "ROADMAP",
      );
      if (!roadmapPath) {
        debugLog("WorktreeResolver", {
          action: "mergeAndExit",
          milestoneId,
          mode: "branch",
          skipped: true,
          reason: "no-roadmap",
        });
        return false;
      }

      const roadmapContent = this.deps.readFileSync(roadmapPath, "utf-8");
      const mergeResult = this.deps.mergeMilestoneToMain(
        this.s.basePath,
        milestoneId,
        roadmapContent,
      );

      // Rebuild GitService after merge (branch HEAD changed)
      this.rebuildGitService();

      if (mergeResult.codeFilesChanged) {
        ctx.notify(
          `Milestone ${milestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
          "info",
        );
      } else {
        ctx.notify(
          `WARNING: Milestone ${milestoneId} merged (branch mode) but contained NO code changes — only .gsd/ metadata. ` +
            `Review the milestone output and re-run if code is missing.`,
          "warning",
        );
      }
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        result: "success",
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        result: "error",
        error: msg,
      });
      ctx.notify(`Milestone merge failed (branch mode): ${msg}`, "warning");
      // Re-throw all errors so callers can apply their own recovery logic (#4380).
      throw err;
    }
  }

  // ── Merge and Enter Next ───────────────────────────────────────────────

  /**
   * Milestone transition: merge the current milestone, then enter the next one.
   *
   * This is the pattern used when the loop detects that the active milestone
   * has changed (e.g., current completed, next one is now active). The caller
   * is responsible for re-deriving state between the merge and the enter.
   */
  mergeAndEnterNext(
    currentMilestoneId: string,
    nextMilestoneId: string,
    ctx: NotifyCtx,
  ): void {
    debugLog("WorktreeResolver", {
      action: "mergeAndEnterNext",
      currentMilestoneId,
      nextMilestoneId,
    });
    try {
      this.mergeAndExit(currentMilestoneId, ctx);
    } catch (err) {
      // mergeAndExit emits a warning and restores state when it fails during
      // merge/cleanup. But if it throws before recovery runs (e.g., in
      // validateMilestoneId or emitJournalEvent), basePath won't be restored
      // to projectRoot — re-throw so we don't enter the next milestone with
      // the current one unmerged.
      if (this.s.basePath !== this.projectRoot) throw err;
    }
    this.enterMilestone(nextMilestoneId, ctx);
  }
}
