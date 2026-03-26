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
    return this.s.originalBasePath || this.s.basePath;
  }

  /** Path for auto.lock file — same as the old lockBase(). */
  get lockPath(): string {
    return this.s.originalBasePath || this.s.basePath;
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

    if (!this.deps.shouldUseWorktreeIsolation()) {
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

    const basePath = this.s.originalBasePath || this.s.basePath;
    debugLog("WorktreeResolver", {
      action: "enterMilestone",
      milestoneId,
      basePath,
    });

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

    if (mode === "none") {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        skipped: true,
        reason: "mode-none",
      });
      return;
    }

    if (
      mode === "worktree" ||
      (this.deps.isInAutoWorktree(this.s.basePath) && this.s.originalBasePath)
    ) {
      this._mergeWorktreeMode(milestoneId, ctx);
    } else if (mode === "branch") {
      this._mergeBranchMode(milestoneId, ctx);
    }
  }

  /** Worktree-mode merge: read roadmap, merge, teardown, reset paths. */
  private _mergeWorktreeMode(milestoneId: string, ctx: NotifyCtx): void {
    const originalBase = this.s.originalBasePath;
    if (!originalBase) {
      debugLog("WorktreeResolver", {
        action: "mergeAndExit",
        milestoneId,
        mode: "worktree",
        skipped: true,
        reason: "missing-original-base",
      });
      return;
    }

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
      // /gsd dispatch complete-milestone or merge manually once the underlying issue is fixed
      // (e.g. checkout to wrong branch, unresolved conflicts). (#1668)
      ctx.notify(
        `Milestone merge failed: ${msg}. Your worktree and milestone branch are preserved — retry /gsd dispatch complete-milestone or merge manually.`,
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

      // Re-throw MergeConflictError so the auto loop can detect real code
      // conflicts and stop instead of retrying forever (#2330).
      if (err instanceof MergeConflictError) {
        throw err;
      }
    }

    // Always restore basePath and rebuild — whether merge succeeded or failed
    this.restoreToProjectRoot();
    debugLog("WorktreeResolver", {
      action: "mergeAndExit",
      milestoneId,
      result: "done",
      basePath: this.s.basePath,
    });
  }

  /** Branch-mode merge: check current branch, merge if on milestone branch. */
  private _mergeBranchMode(milestoneId: string, ctx: NotifyCtx): void {
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
        return;
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
        return;
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
    this.mergeAndExit(currentMilestoneId, ctx);
    this.enterMilestone(nextMilestoneId, ctx);
  }
}
