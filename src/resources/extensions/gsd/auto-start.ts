/**
 * Auto-mode bootstrap — fresh-start initialization path.
 *
 * Git/state bootstrap, crash lock detection, debug init, worktree recovery,
 * guided flow gate, session init, worktree lifecycle, DB lifecycle,
 * preflight validation.
 *
 * Extracted from startAuto() in auto.ts. The resume path (s.paused)
 * remains in auto.ts — this module handles only the fresh-start path.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { loadFile, getManifestStatus } from "./files.js";
import {
  loadEffectiveGSDPreferences,
  resolveSkillDiscoveryMode,
  getIsolationMode,
} from "./preferences.js";
import { ensureGsdSymlink, isInheritedRepo, validateProjectId } from "./repo-identity.js";
import { migrateToExternalState, recoverFailedMigration } from "./migrate-external.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import { gsdRoot, resolveMilestoneFile, milestonesDir } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { synthesizeCrashRecovery } from "./session-forensics.js";
import {
  writeLock,
  clearLock,
  readCrashLock,
  formatCrashInfo,
  isLockProcessAlive,
} from "./crash-recovery.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  updateSessionLock,
} from "./session-lock.js";
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import {
  nativeIsRepo,
  nativeInit,
  nativeAddAll,
  nativeCommit,
} from "./native-git-bridge.js";
import { GitServiceImpl } from "./git-service.js";
import {
  captureIntegrationBranch,
  detectWorktreeName,
  setActiveMilestoneId,
} from "./worktree.js";
import { getAutoWorktreePath, isInAutoWorktree } from "./auto-worktree.js";
import { readResourceVersion, cleanStaleRuntimeUnits } from "./auto-worktree.js";
import { initMetrics } from "./metrics.js";
import { initRoutingHistory } from "./routing-history.js";
import { restoreHookState, resetHookState } from "./post-unit-hooks.js";
import { resetProactiveHealing, setLevelChangeCallback } from "./doctor-proactive.js";
import { snapshotSkills } from "./skill-discovery.js";
import { isDbAvailable, getMilestone } from "./gsd-db.js";
import { hideFooter } from "./auto-dashboard.js";
import {
  debugLog,
  enableDebug,
  isDebugEnabled,
  getDebugLogPath,
} from "./debug-logger.js";
import { parseUnitId } from "./unit-id.js";
import type { AutoSession } from "./auto/session.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { sep as pathSep } from "node:path";

import type { WorktreeResolver } from "./worktree-resolver.js";

export interface BootstrapDeps {
  shouldUseWorktreeIsolation: () => boolean;
  registerSigtermHandler: (basePath: string) => void;
  lockBase: () => string;
  buildResolver: () => WorktreeResolver;
}

/**
 * Bootstrap a fresh auto-mode session. Handles everything from git init
 * through secrets collection, returning when ready for the first
 * dispatchNextUnit call.
 *
 * Returns false if the bootstrap aborted (e.g., guided flow returned,
 * concurrent session detected). Returns true when ready to dispatch.
 */

/** Guard: tracks consecutive bootstrap attempts that found phase === "complete".
 *  Prevents the recursive dialog loop described in #1348 where
 *  bootstrapAutoSession → showSmartEntry → checkAutoStartAfterDiscuss → startAuto
 *  cycles indefinitely when the discuss workflow doesn't produce a milestone. */
let _consecutiveCompleteBootstraps = 0;
const MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS = 2;
export async function bootstrapAutoSession(
  s: AutoSession,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  requestedStepMode: boolean,
  deps: BootstrapDeps,
): Promise<boolean> {
  const {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    lockBase,
    buildResolver,
  } = deps;

  const lockResult = acquireSessionLock(base);
  if (!lockResult.acquired) {
    ctx.ui.notify(lockResult.reason, "error");
    return false;
  }

  function releaseLockAndReturn(): false {
    releaseSessionLock(base);
    clearLock(base);
    return false;
  }

  try {
    // Validate GSD_PROJECT_ID early so the user gets immediate feedback
    const customProjectId = process.env.GSD_PROJECT_ID;
    if (customProjectId && !validateProjectId(customProjectId)) {
      ctx.ui.notify(
        `GSD_PROJECT_ID must contain only alphanumeric characters, hyphens, and underscores. Got: "${customProjectId}"`,
        "error",
      );
      return releaseLockAndReturn();
    }

    // Ensure git repo exists *locally* at base.
    // nativeIsRepo() uses `git rev-parse` which traverses up to parent dirs,
    // so a parent repo can make it return true even when base has no .git of
    // its own. Check for a local .git instead (defense-in-depth for the case
    // where isInheritedRepo() returns a false negative, e.g. stale .gsd at
    // the parent git root). See #2393 and related issue.
    const hasLocalGit = existsSync(join(base, ".git"));
    if (!hasLocalGit || isInheritedRepo(base)) {
      const mainBranch =
        loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
      nativeInit(base, mainBranch);
    }

    // Migrate legacy in-project .gsd/ to external state directory.
    // Migration MUST run before ensureGitignore to avoid adding ".gsd" to
    // .gitignore when .gsd/ is git-tracked (data-loss bug #1364).
    recoverFailedMigration(base);
    const migration = migrateToExternalState(base);
    if (migration.error) {
      ctx.ui.notify(`External state migration warning: ${migration.error}`, "warning");
    }
    // Ensure symlink exists (handles fresh projects and post-migration)
    ensureGsdSymlink(base);

    // Ensure .gitignore has baseline patterns.
    // ensureGitignore checks for git-tracked .gsd/ files and skips the
    // ".gsd" pattern if the project intentionally tracks .gsd/ in git.
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const manageGitignore = gitPrefs?.manage_gitignore;
    ensureGitignore(base, { manageGitignore });
    if (manageGitignore !== false) untrackRuntimeFiles(base);

    // Bootstrap .gsd/ if it doesn't exist
    const gsdDir = join(base, ".gsd");
    if (!existsSync(gsdDir)) {
      mkdirSync(join(gsdDir, "milestones"), { recursive: true });
      try {
        nativeAddAll(base);
        nativeCommit(base, "chore: init gsd");
      } catch {
        /* nothing to commit */
      }
    }

    // Initialize GitServiceImpl
    s.gitService = new GitServiceImpl(
      s.basePath,
      loadEffectiveGSDPreferences()?.preferences?.git ?? {},
    );

    // Check for crash from previous session. Skip our own fresh bootstrap lock.
    const crashLock = readCrashLock(base);
    if (crashLock && crashLock.pid !== process.pid) {
      if (isLockProcessAlive(crashLock)) {
        ctx.ui.notify(
          `Another auto-mode session (PID ${crashLock.pid}) appears to be running.\nStop it with \`kill ${crashLock.pid}\` before starting a new session.`,
          "error",
        );
        return releaseLockAndReturn();
      }
      const recoveredMid = parseUnitId(crashLock.unitId).milestone;
      const milestoneAlreadyComplete = recoveredMid
        ? !!resolveMilestoneFile(base, recoveredMid, "SUMMARY")
        : false;

      if (milestoneAlreadyComplete) {
        ctx.ui.notify(
          `Crash recovery: discarding stale context for ${crashLock.unitId} — milestone ${recoveredMid} is already complete.`,
          "info",
        );
      } else {
        const activityDir = join(gsdRoot(base), "activity");
        const recovery = synthesizeCrashRecovery(
          base,
          crashLock.unitType,
          crashLock.unitId,
          crashLock.sessionFile,
          activityDir,
        );
        if (recovery && recovery.trace.toolCallCount > 0) {
          s.pendingCrashRecovery = recovery.prompt;
          ctx.ui.notify(
            `${formatCrashInfo(crashLock)}\nRecovered ${recovery.trace.toolCallCount} tool calls from crashed session. Resuming with full context.`,
            "warning",
          );
        } else {
          ctx.ui.notify(
            `${formatCrashInfo(crashLock)}\nNo session data recovered. Resuming from disk state.`,
            "warning",
          );
        }
      }
      clearLock(base);
    }

    // ── Debug mode ──
    if (!isDebugEnabled() && process.env.GSD_DEBUG === "1") {
      enableDebug(base);
    }
    if (isDebugEnabled()) {
      const { isNativeParserAvailable } =
        await import("./native-parser-bridge.js");
      debugLog("debug-start", {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        model: ctx.model?.id ?? "unknown",
        provider: ctx.model?.provider ?? "unknown",
        nativeParser: isNativeParserAvailable(),
        cwd: base,
      });
      ctx.ui.notify(`Debug logging enabled → ${getDebugLogPath()}`, "info");
    }

    // Invalidate caches before initial state derivation
    invalidateAllCaches();

    // Clean stale runtime unit files for completed milestones (#887)
    cleanStaleRuntimeUnits(
      gsdRoot(base),
      (mid) => !!resolveMilestoneFile(base, mid, "SUMMARY"),
    );

    let state = await deriveState(base);

    // Stale worktree state recovery (#654)
    if (
      state.activeMilestone &&
      shouldUseWorktreeIsolation() &&
      !detectWorktreeName(base)
    ) {
      const wtPath = getAutoWorktreePath(base, state.activeMilestone.id);
      if (wtPath) {
        state = await deriveState(wtPath);
      }
    }

    // Milestone branch recovery (#601, #2358)
    // Detect survivor milestone branches in both pre-planning and complete phases.
    // In phase=complete, the milestone artifacts exist but finalization (merge,
    // worktree cleanup) was never run — the survivor branch must be merged.
    let hasSurvivorBranch = false;
    if (
      state.activeMilestone &&
      (state.phase === "pre-planning" || state.phase === "complete") &&
      shouldUseWorktreeIsolation() &&
      !detectWorktreeName(base) &&
      !base.includes(`${pathSep}.gsd${pathSep}worktrees${pathSep}`)
    ) {
      const milestoneBranch = `milestone/${state.activeMilestone.id}`;
      const { nativeBranchExists } = await import("./native-git-bridge.js");
      hasSurvivorBranch = nativeBranchExists(base, milestoneBranch);
      if (hasSurvivorBranch) {
        ctx.ui.notify(
          `Found prior session branch ${milestoneBranch}. Resuming.`,
          "info",
        );
      }
    }

    // Survivor branch exists but milestone still needs discussion (#1726):
    // The worktree/branch was created but the milestone only has CONTEXT-DRAFT.md.
    // Route to the interactive discussion handler instead of falling through to
    // auto-mode, which would immediately stop with "needs discussion".
    if (hasSurvivorBranch && state.phase === "needs-discussion") {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

      invalidateAllCaches();
      const postState = await deriveState(base);
      if (
        postState.activeMilestone &&
        postState.phase !== "needs-discussion"
      ) {
        state = postState;
        // Discussion succeeded — clear survivor flag so normal flow continues
        hasSurvivorBranch = false;
      } else {
        ctx.ui.notify(
          "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
          "warning",
        );
        return releaseLockAndReturn();
      }
    }

    // Survivor branch exists and milestone is complete (#2358):
    // The milestone artifacts were written but finalization (merge, worktree
    // cleanup) never ran. Run mergeAndExit to finalize, then re-derive state
    // so the normal "all milestones complete" or "next milestone" path runs.
    if (hasSurvivorBranch && state.phase === "complete") {
      const mid = state.activeMilestone!.id;
      ctx.ui.notify(
        `Milestone ${mid} is complete but branch/worktree was not finalized. Running merge now.`,
        "info",
      );
      const resolver = buildResolver();
      resolver.mergeAndExit(mid, {
        notify: ctx.ui.notify.bind(ctx.ui),
      });
      invalidateAllCaches();
      state = await deriveState(base);
      // Clear survivor flag — finalization is done
      hasSurvivorBranch = false;
    }

    if (!hasSurvivorBranch) {
      // No active work — start a new milestone via discuss flow
      if (!state.activeMilestone || state.phase === "complete") {
        // Guard against recursive dialog loop (#1348):
        // If we've entered this branch multiple times in quick succession,
        // the discuss workflow isn't producing a milestone. Break the cycle.
        _consecutiveCompleteBootstraps++;
        if (_consecutiveCompleteBootstraps > MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS) {
          _consecutiveCompleteBootstraps = 0;
          ctx.ui.notify(
            "All milestones are complete and the discussion didn't produce a new one. " +
            "Run /gsd to start a new milestone manually.",
            "warning",
          );
          return releaseLockAndReturn();
        }

        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        invalidateAllCaches();
        const postState = await deriveState(base);
        if (
          postState.activeMilestone &&
          postState.phase !== "complete" &&
          postState.phase !== "pre-planning"
        ) {
          _consecutiveCompleteBootstraps = 0; // Successfully advanced past "complete"
          state = postState;
        } else if (
          postState.activeMilestone &&
          postState.phase === "pre-planning"
        ) {
          const contextFile = resolveMilestoneFile(
            base,
            postState.activeMilestone.id,
            "CONTEXT",
          );
          const hasContext = !!(contextFile && (await loadFile(contextFile)));
          if (hasContext) {
            state = postState;
          } else {
            ctx.ui.notify(
              "Discussion completed but no milestone context was written. Run /gsd to try the discussion again, or /gsd auto after creating the milestone manually.",
              "warning",
            );
            return releaseLockAndReturn();
          }
        } else {
          return releaseLockAndReturn();
        }
      }

      // Active milestone exists but has no roadmap
      if (state.phase === "pre-planning") {
        const mid = state.activeMilestone!.id;
        const contextFile = resolveMilestoneFile(base, mid, "CONTEXT");
        const hasContext = !!(contextFile && (await loadFile(contextFile)));
        if (!hasContext) {
          const { showSmartEntry } = await import("./guided-flow.js");
          await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

          invalidateAllCaches();
          const postState = await deriveState(base);
          if (postState.activeMilestone && postState.phase !== "pre-planning") {
            state = postState;
          } else {
            ctx.ui.notify(
              "Discussion completed but milestone context is still missing. Run /gsd to try again.",
              "warning",
            );
            return releaseLockAndReturn();
          }
        }
      }

      // Active milestone has CONTEXT-DRAFT but no full context — needs discussion
      if (state.phase === "needs-discussion") {
        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        invalidateAllCaches();
        const postState = await deriveState(base);
        if (
          postState.activeMilestone &&
          postState.phase !== "needs-discussion"
        ) {
          state = postState;
        } else {
          ctx.ui.notify(
            "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
            "warning",
          );
          return releaseLockAndReturn();
        }
      }
    }

    // Unreachable safety check
    if (!state.activeMilestone) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      return releaseLockAndReturn();
    }

    // Successfully resolved an active milestone — reset the re-entry guard
    _consecutiveCompleteBootstraps = 0;

    // ── Initialize session state ──
    s.active = true;
    s.stepMode = requestedStepMode;
    s.verbose = verboseMode;
    s.cmdCtx = ctx;
    s.basePath = base;
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.lastBudgetAlertLevel = 0;
    s.unitLifetimeDispatches.clear();
    resetHookState();
    restoreHookState(base);
    resetProactiveHealing();
    // Notify user on health level transitions (green→yellow→red and back)
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level as "info" | "warning" | "error");
    });
    s.autoStartTime = Date.now();
    s.resourceVersionOnStart = readResourceVersion();
    s.pendingQuickTasks = [];
    s.currentUnit = null;
    s.currentMilestoneId = state.activeMilestone?.id ?? null;
    s.originalModelId = ctx.model?.id ?? null;
    s.originalModelProvider = ctx.model?.provider ?? null;

    // Register SIGTERM handler
    registerSigtermHandler(base);

    // Capture integration branch
    if (s.currentMilestoneId) {
      if (getIsolationMode() !== "none") {
        captureIntegrationBranch(base, s.currentMilestoneId);
      }
      setActiveMilestoneId(base, s.currentMilestoneId);
    }

    // ── Auto-worktree setup ──
    s.originalBasePath = base;

    const isUnderGsdWorktrees = (p: string): boolean => {
      // Direct layout: /.gsd/worktrees/
      const marker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
      if (p.includes(marker)) return true;
      const worktreesSuffix = `${pathSep}.gsd${pathSep}worktrees`;
      if (p.endsWith(worktreesSuffix)) return true;
      // Symlink-resolved layout: /.gsd/projects/<hash>/worktrees/
      const symlinkRe = new RegExp(
        `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees(?:\\${pathSep}|$)`,
      );
      return symlinkRe.test(p);
    };

    if (
      s.currentMilestoneId &&
      shouldUseWorktreeIsolation() &&
      !detectWorktreeName(base) &&
      !isUnderGsdWorktrees(base)
    ) {
      buildResolver().enterMilestone(s.currentMilestoneId, {
        notify: ctx.ui.notify.bind(ctx.ui),
      });
      if (s.basePath !== base) {
        // Successfully entered worktree — re-register SIGTERM handler at original base
        registerSigtermHandler(s.originalBasePath);
      }
    }

    // ── DB lifecycle ──
    const gsdDbPath = join(s.basePath, ".gsd", "gsd.db");
    const gsdDirPath = join(s.basePath, ".gsd");
    if (existsSync(gsdDirPath) && !existsSync(gsdDbPath)) {
      const hasDecisions = existsSync(join(gsdDirPath, "DECISIONS.md"));
      const hasRequirements = existsSync(join(gsdDirPath, "REQUIREMENTS.md"));
      const hasMilestones = existsSync(join(gsdDirPath, "milestones"));
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        openDb(gsdDbPath);
        if (hasDecisions || hasRequirements || hasMilestones) {
          const { migrateFromMarkdown } = await import("./md-importer.js");
          migrateFromMarkdown(s.basePath);
        }
      } catch (err) {
        process.stderr.write(
          `gsd-migrate: auto-migration failed: ${(err as Error).message}\n`,
        );
      }
    }
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        openDb(gsdDbPath);
      } catch (err) {
        process.stderr.write(
          `gsd-db: failed to open existing database: ${(err as Error).message}\n`,
        );
      }
    }

    // Gate: abort bootstrap if the DB file exists but the provider is
    // still unavailable after both open attempts above. Without this,
    // auto-mode starts but every gsd_task_complete / gsd_slice_complete
    // call returns "db_unavailable", triggering artifact-retry which
    // re-dispatches the same task — producing an infinite loop (#2419).
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      ctx.ui.notify(
        "SQLite database exists but failed to open. Auto-mode cannot proceed without a working database provider. " +
          "Check for corrupt gsd.db or missing native SQLite bindings.",
        "error",
      );
      return releaseLockAndReturn();
    }

    // Initialize metrics
    initMetrics(s.basePath);

    // Initialize routing history
    initRoutingHistory(s.basePath);

    // Capture session's model at auto-mode start (#650)
    const currentModel = ctx.model;
    if (currentModel) {
      s.autoModeStartModel = {
        provider: currentModel.provider,
        id: currentModel.id,
      };
    }

    // Snapshot installed skills
    if (resolveSkillDiscoveryMode() !== "off") {
      snapshotSkills();
    }

    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setFooter(hideFooter);
    const modeLabel = s.stepMode ? "Step-mode" : "Auto-mode";
    const pendingCount = (state.registry ?? []).filter(
      (m) => m.status !== "complete" && m.status !== "parked",
    ).length;
    const scopeMsg =
      pendingCount > 1
        ? `Will loop through ${pendingCount} milestones.`
        : "Will loop until milestone complete.";
    ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

    updateSessionLock(
      lockBase(),
      "starting",
      s.currentMilestoneId ?? "unknown",
    );
    writeLock(lockBase(), "starting", s.currentMilestoneId ?? "unknown");

    // Secrets collection gate
    const mid = state.activeMilestone!.id;
    try {
      const manifestStatus = await getManifestStatus(base, mid, s.originalBasePath || base);
      if (manifestStatus && manifestStatus.pending.length > 0) {
        const result = await collectSecretsFromManifest(base, mid, ctx);
        if (
          result &&
          result.applied &&
          result.skipped &&
          result.existingSkipped
        ) {
          ctx.ui.notify(
            `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
            "info",
          );
        } else {
          ctx.ui.notify("Secrets collection skipped.", "info");
        }
      }
    } catch (err) {
      ctx.ui.notify(
        `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
        "warning",
      );
    }

    // Self-heal: remove stale .git/index.lock
    try {
      const gitLockFile = join(base, ".git", "index.lock");
      if (existsSync(gitLockFile)) {
        const lockAge = Date.now() - statSync(gitLockFile).mtimeMs;
        if (lockAge > 60_000) {
          unlinkSync(gitLockFile);
          ctx.ui.notify(
            "Removed stale .git/index.lock from prior crash.",
            "info",
          );
        }
      }
    } catch (e) {
      debugLog("git-lock-cleanup-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Pre-flight: validate milestone queue
    try {
      const msDir = join(base, ".gsd", "milestones");
      if (existsSync(msDir)) {
        const milestoneIds = readdirSync(msDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^M\d{3}/.test(d.name))
          .map((d) => d.name.match(/^(M\d{3})/)?.[1] ?? d.name);
        if (milestoneIds.length > 1) {
          const issues: string[] = [];
          for (const id of milestoneIds) {
            // Skip completed/parked milestones — a leftover CONTEXT-DRAFT.md
            // on a finished milestone is harmless residue, not an actionable warning.
            if (isDbAvailable()) {
              const ms = getMilestone(id);
              if (ms?.status === "complete" || ms?.status === "parked") continue;
            }
            const draft = resolveMilestoneFile(base, id, "CONTEXT-DRAFT");
            if (draft)
              issues.push(
                `${id}: has CONTEXT-DRAFT.md (will pause for discussion)`,
              );
          }
          if (issues.length > 0) {
            ctx.ui.notify(
              `Pre-flight: ${milestoneIds.length} milestones queued.\n${issues.map((i) => `  ⚠ ${i}`).join("\n")}`,
              "warning",
            );
          } else {
            ctx.ui.notify(
              `Pre-flight: ${milestoneIds.length} milestones queued. All have full context.`,
              "info",
            );
          }
        }
      }
    } catch {
      /* non-fatal */
    }

    return true;
  } catch (err) {
    releaseSessionLock(base);
    clearLock(base);
    throw err;
  }
}
