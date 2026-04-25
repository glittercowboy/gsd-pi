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
import type { InterruptedSessionAssessment } from "./interrupted-session.js";
import {
  loadEffectiveGSDPreferences,
  resolveSkillDiscoveryMode,
  getIsolationMode,
} from "./preferences.js";
import { ensureGsdSymlink, isInheritedRepo, validateProjectId } from "./repo-identity.js";
import { migrateToExternalState, recoverFailedMigration } from "./migrate-external.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import { gsdRoot, resolveMilestoneFile } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { writeLock, clearLock } from "./crash-recovery.js";
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
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeCheckoutBranch,
  nativeBranchList,
  nativeBranchListMerged,
  nativeBranchDelete,
  nativeWorktreeRemove,
  nativeCommitCountBetween,
} from "./native-git-bridge.js";
import { GitServiceImpl } from "./git-service.js";
import {
  captureIntegrationBranch,
  detectWorktreeName,
  setActiveMilestoneId,
} from "./worktree.js";
import { getAutoWorktreePath, isInAutoWorktree } from "./auto-worktree.js";
import { readResourceVersion, cleanStaleRuntimeUnits } from "./auto-worktree.js";
import { worktreePath as getWorktreeDir, isInsideWorktreesDir } from "./worktree-manager.js";
import { emitWorktreeOrphaned } from "./worktree-telemetry.js";
import { initMetrics } from "./metrics.js";
import { initRoutingHistory } from "./routing-history.js";
import { restoreHookState, resetHookState } from "./post-unit-hooks.js";
import { resetProactiveHealing, setLevelChangeCallback } from "./doctor-proactive.js";
import { snapshotSkills } from "./skill-discovery.js";
import { isDbAvailable, getMilestone, openDatabase, getDbStatus } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";

import {
  debugLog,
  enableDebug,
  isDebugEnabled,
  getDebugLogPath,
} from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import { parseUnitId } from "./unit-id.js";
import type { AutoSession } from "./auto/session.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { sep as pathSep } from "node:path";

import { resolveProjectRootDbPath } from "./bootstrap/dynamic-tools.js";
import {
  isCustomProvider,
  resolveDefaultSessionModel,
  resolveDynamicRoutingConfig,
} from "./preferences-models.js";
import type { WorktreeResolver } from "./worktree-resolver.js";
import { getSessionModelOverride } from "./session-model-override.js";

export interface BootstrapDeps {
  shouldUseWorktreeIsolation: (basePath?: string) => boolean;
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

// Guard constant for consecutive bootstrap attempts that found phase === "complete".
// Counter moved to AutoSession.consecutiveCompleteBootstraps so s.reset() clears it.
const MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS = 2;

export async function openProjectDbIfPresent(basePath: string): Promise<void> {
  const gsdDbPath = resolveProjectRootDbPath(basePath);
  if (!existsSync(gsdDbPath) || isDbAvailable()) return;

  try {
    openDatabase(gsdDbPath);
  } catch (err) {
    logWarning("engine", `gsd-db: failed to open existing database: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Audit for orphaned milestone branches at bootstrap.
 *
 * After a milestone completes, the teardown step (merge branch → main,
 * delete branch, remove worktree) runs as a post-completion engine step.
 * If the session ends between completion and teardown, the branch and
 * worktree are orphaned — the DB says "complete" so auto-mode won't
 * re-enter the milestone, and the teardown is never retried.
 *
 * This audit runs on every fresh bootstrap to catch that gap:
 * 1. Lists all local `milestone/*` branches.
 * 2. For each, checks if the milestone's DB status is "complete".
 * 3. If the branch is already merged into main → deletes the branch
 *    and cleans up any orphaned worktree directory (safe, no data loss).
 * 4. If the branch is NOT merged → preserves it and warns the user
 *    so they can merge manually (data safety first).
 *
 * Returns a summary of actions taken for the caller to surface via notify.
 */
/**
 * Decide which survivor-branch recovery action bootstrapAutoSession must
 * run for the current (hasSurvivorBranch, phase) combination. Extracted
 * from the inline chain at `bootstrapAutoSession` (around line 604) so
 * the decision table is testable without constructing a full session.
 *
 * - `none`     — no survivor, or phase doesn't call for recovery. Fall
 *                through to normal bootstrap flow.
 * - `discuss`  — survivor + phase=needs-discussion (#1726). Route to
 *                showSmartEntry.
 * - `finalize` — survivor + phase=complete (#2358). Run mergeAndExit to
 *                merge the milestone branch and clear the worktree.
 *
 * Any other phase with a survivor (pre-planning, planning, executing…)
 * returns `none` — the caller continues its normal flow and the
 * survivor branch participates in whatever auto-mode happens next.
 */
export type SurvivorAction = "none" | "discuss" | "finalize";

export function decideSurvivorAction(
  hasSurvivorBranch: boolean,
  phase: string | null | undefined,
): SurvivorAction {
  if (!hasSurvivorBranch) return "none";
  if (phase === "needs-discussion") return "discuss";
  if (phase === "complete") return "finalize";
  return "none";
}

export function auditOrphanedMilestoneBranches(
  basePath: string,
  isolationMode: "worktree" | "branch" | "none",
): { recovered: string[]; warnings: string[] } {
  const recovered: string[] = [];
  const warnings: string[] = [];

  // Skip in none mode — no milestone branches are created
  if (isolationMode === "none") return { recovered, warnings };

  // Skip if DB not available — can't determine completion status
  if (!isDbAvailable()) return { recovered, warnings };

  let milestoneBranches: string[];
  try {
    milestoneBranches = nativeBranchList(basePath, "milestone/*");
  } catch {
    // git branch list failed — skip audit
    return { recovered, warnings };
  }

  if (milestoneBranches.length === 0) return { recovered, warnings };

  // Detect main branch for merge-check
  let mainBranch: string;
  try {
    mainBranch = nativeDetectMainBranch(basePath);
  } catch {
    mainBranch = "main";
  }

  // Get branches already merged into main
  let mergedBranches: Set<string>;
  try {
    mergedBranches = new Set(nativeBranchListMerged(basePath, mainBranch, "milestone/*"));
  } catch {
    mergedBranches = new Set();
  }

  for (const branch of milestoneBranches) {
    const milestoneId = branch.replace(/^milestone\//, "");
    const milestone = getMilestone(milestoneId);

    if (!milestone) continue;

    const isMerged = mergedBranches.has(branch);

    // #4762 — in-progress milestone branch with unmerged commits ahead of
    // main. This is the pre-completion orphan case: auto-mode exited without
    // completing the milestone (pause, stop, crash, merge error, blocker) and
    // work is stranded on the branch or in the worktree. Data safety first:
    // we never delete or touch; we just surface a warning so the user knows
    // where to look.
    //
    // Gate on isClosedStatus so we only warn about genuinely open milestones.
    // Parked/other closed statuses go through the legacy complete/unmerged
    // path below where appropriate.
    if (!isClosedStatus(milestone.status)) {
      if (isMerged) continue; // nothing to recover
      let commitsAhead = 0;
      try {
        commitsAhead = nativeCommitCountBetween(basePath, mainBranch, branch);
      } catch {
        // Rev-walk failure — skip rather than noise
        continue;
      }
      if (commitsAhead === 0) continue;

      const wtDir = getWorktreeDir(basePath, milestoneId);
      const wtDirExists = existsSync(wtDir);
      const wtSuffix = wtDirExists
        ? ` Worktree directory at .gsd/worktrees/${milestoneId}/ holds the live work.`
        : "";
      warnings.push(
        `Branch ${branch} has ${commitsAhead} commit(s) ahead of ${mainBranch} for in-progress milestone ${milestoneId}.` +
        wtSuffix +
        ` Run \`/gsd auto\` to resume, or merge manually if abandoning.`,
      );

      // #4764 telemetry
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "in-progress-unmerged",
          commitsAhead,
          worktreeDirExists: wtDirExists,
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      continue;
    }

    // Only the "complete" status participates in the merged/unmerged cleanup
    // paths below — other closed statuses (parked, etc.) are intentionally
    // left alone.
    if (milestone.status !== "complete") continue;

    if (isMerged) {
      // Branch is merged — safe to delete branch and clean up worktree dir
      try {
        nativeBranchDelete(basePath, branch, true);
        recovered.push(`Deleted merged branch ${branch} for completed milestone ${milestoneId}.`);
      } catch (err) {
        warnings.push(`Failed to delete merged branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Clean up orphaned worktree directory if it exists
      const wtDir = getWorktreeDir(basePath, milestoneId);
      if (existsSync(wtDir)) {
        // Try git worktree remove first (handles registered worktrees)
        try {
          nativeWorktreeRemove(basePath, wtDir, true);
        } catch (e) {
          // Not a registered worktree — expected for orphaned dirs
          logWarning("engine", `worktree remove failed (expected for orphaned dirs): ${e instanceof Error ? e.message : String(e)}`);
        }

        // If the directory still exists after git worktree remove (either it
        // wasn't registered or the remove was a noop), fall back to direct
        // filesystem removal — but only inside .gsd/worktrees/ for safety (#2365).
        if (existsSync(wtDir)) {
          if (isInsideWorktreesDir(basePath, wtDir)) {
            try {
              rmSync(wtDir, { recursive: true, force: true });
              recovered.push(`Removed orphaned worktree directory for ${milestoneId}.`);
            } catch (err2) {
              warnings.push(`Failed to remove worktree directory for ${milestoneId}: ${err2 instanceof Error ? err2.message : String(err2)}`);
            }
          } else {
            warnings.push(`Orphaned worktree directory for ${milestoneId} is outside .gsd/worktrees/ — skipping removal for safety.`);
          }
        } else {
          recovered.push(`Removed orphaned worktree directory for ${milestoneId}.`);
        }
      }
    } else {
      // Branch is NOT merged — preserve for safety, warn the user
      warnings.push(
        `Branch ${branch} exists for completed milestone ${milestoneId} but is NOT merged into ${mainBranch}. ` +
        `This may contain unmerged work. Merge manually or run \`/gsd health --fix\` to resolve.`,
      );

      // #4764 telemetry
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "complete-unmerged",
          worktreeDirExists: existsSync(getWorktreeDir(basePath, milestoneId)),
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { recovered, warnings };
}

export async function bootstrapAutoSession(
  s: AutoSession,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  base: string,
  verboseMode: boolean,
  requestedStepMode: boolean,
  deps: BootstrapDeps,
  interrupted: InterruptedSessionAssessment,
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

  // Capture the user's session model before guided-flow dispatch can apply a
  // phase-specific planning model for a discuss turn (#2829).
  //
  // Precedence:
  // 1) Explicit session override via /gsd model (this session)
  // 2) Current session model from settings/session restore (if provider ready)
  // 3) GSD model preferences from PREFERENCES.md (validated against live auth)
  //
  // This preserves #3517 defaults while honoring explicit runtime model
  // selection for subsequent /gsd runs in the same session.
  //
  // Exception (#4122): when the session provider is a custom provider declared
  // in ~/.gsd/agent/models.json (Ollama, vLLM, OpenAI-compatible proxy, etc.),
  // PREFERENCES.md is skipped entirely. PREFERENCES.md cannot reference custom
  // providers, so honoring it would silently reroute auto-mode to a built-in
  // provider the user is not logged into and surface as "Not logged in · Please
  // run /login" before pausing and resetting to claude-code/claude-sonnet-4-6.
  const manualSessionOverride = getSessionModelOverride(ctx.sessionManager.getSessionId());
  const sessionProviderIsCustom = isCustomProvider(ctx.model?.provider);
  const preferredModel = sessionProviderIsCustom
    ? null
    : resolveDefaultSessionModel(ctx.model?.provider);
  // Validate the preferred model against the live registry + provider auth so
  // an unconfigured PREFERENCES.md entry (no API key / OAuth) can't become the
  // start-model snapshot. Without this, every subsequent unit would try to
  // fall back to an unusable model.
  let validatedPreferredModel: { provider: string; id: string } | undefined;
  if (preferredModel) {
    const { resolveModelId } = await import("./auto-model-selection.js");
    const available = ctx.modelRegistry.getAvailable();
    const match = resolveModelId(
      `${preferredModel.provider}/${preferredModel.id}`,
      available,
      ctx.model?.provider,
    );
    if (match) {
      validatedPreferredModel = { provider: match.provider, id: match.id };
    } else {
      ctx.ui.notify(
        `Preferred model ${preferredModel.provider}/${preferredModel.id} from PREFERENCES.md is not configured; falling back to session default.`,
        "warning",
      );
    }
  }
  const sessionModelReady =
    ctx.model && ctx.modelRegistry.isProviderRequestReady(ctx.model.provider);
  const currentSessionModel = (sessionModelReady && ctx.model)
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : null;
  const startThinkingSnapshot = pi.getThinkingLevel();
  const startModelSnapshot = manualSessionOverride
    ?? currentSessionModel
    ?? validatedPreferredModel
    ?? null;

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
        loadEffectiveGSDPreferences(base)?.preferences?.git?.main_branch || "main";
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
    const gitPrefs = loadEffectiveGSDPreferences(base)?.preferences?.git;
    const manageGitignore = gitPrefs?.manage_gitignore;
    ensureGitignore(base, { manageGitignore });
    if (manageGitignore !== false) untrackRuntimeFiles(base);

    // Bootstrap milestones/ if it doesn't exist.
    // Check milestones/ directly — ensureGsdSymlink above already created .gsd/,
    // so checking .gsd/ existence would be dead code (#2942).
    const gsdDir = join(base, ".gsd");
    const milestonesPath = join(gsdDir, "milestones");
    if (!existsSync(milestonesPath)) {
      mkdirSync(milestonesPath, { recursive: true });
      try {
        nativeAddAll(base);
        nativeCommit(base, "chore: init gsd");
      } catch (err) {
        /* nothing to commit */
        logWarning("engine", `mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    {
      const { prepareWorkflowMcpForProject } = await import("./workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, base);
    }

    // Initialize GitServiceImpl
    s.gitService = new GitServiceImpl(
      s.basePath,
      loadEffectiveGSDPreferences(base)?.preferences?.git ?? {},
    );

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

    if (interrupted.classification !== "recoverable") {
      s.pendingCrashRecovery = null;
    }

    // Invalidate caches before initial state derivation
    invalidateAllCaches();

    // Open the project-root DB before deriveState so DB-backed state
    // derivation (queue-order, task status) works on a cold start (#2841).
    // Must happen before cleanStaleRuntimeUnits so the cleanup predicate can
    // consult DB status and avoid clearing runtime units for milestones that
    // only have a failure-path SUMMARY on disk (#4663).
    await openProjectDbIfPresent(base);

    // Clean stale runtime unit files for completed milestones (#887).
    // DB-authoritative: when DB is available, require DB status to be closed
    // before clearing runtime units. A SUMMARY file alone is no longer
    // trusted as proof of completion (#4663). Fall back to SUMMARY-file
    // presence only when DB is unavailable (legacy/pre-migration).
    cleanStaleRuntimeUnits(
      gsdRoot(base),
      (mid) => {
        if (isDbAvailable()) {
          const row = getMilestone(mid);
          return !!row && isClosedStatus(row.status);
        }
        const summaryFile = resolveMilestoneFile(base, mid, "SUMMARY");
        if (!summaryFile) return false;
        try {
          return classifyMilestoneSummaryContent(readFileSync(summaryFile, "utf-8")) !== "failure";
        } catch {
          return false;
        }
      },
    );

    // ── Orphaned milestone branch audit ──
    // Catches completed milestones whose teardown (merge + branch delete)
    // was lost due to session ending between completion and teardown.
    // Must run after DB open and before worktree entry.
    try {
      const auditResult = auditOrphanedMilestoneBranches(base, getIsolationMode(base));
      for (const msg of auditResult.recovered) {
        ctx.ui.notify(`Orphan audit: ${msg}`, "info");
      }
      for (const msg of auditResult.warnings) {
        ctx.ui.notify(`Orphan audit: ${msg}`, "warning");
      }
      if (auditResult.recovered.length > 0) {
        debugLog("orphan-audit", { recovered: auditResult.recovered, warnings: auditResult.warnings });
      }
    } catch (err) {
      // Non-fatal — the audit is defensive, never block bootstrap
      logWarning("bootstrap", `orphaned milestone branch audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let state = await deriveState(base);

    // Stale worktree state recovery (#654)
    if (
      state.activeMilestone &&
      shouldUseWorktreeIsolation(base) &&
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
    // Applies to both worktree and branch isolation modes.
    let hasSurvivorBranch = false;
    if (
      state.activeMilestone &&
      (state.phase === "pre-planning" || state.phase === "complete") &&
      getIsolationMode(base) !== "none" &&
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
    if (decideSurvivorAction(hasSurvivorBranch, state.phase) === "discuss") {
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
    // Re-evaluate via the helper — the discuss branch above may have cleared
    // hasSurvivorBranch after a successful promotion.
    if (decideSurvivorAction(hasSurvivorBranch, state.phase) === "finalize") {
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
        s.consecutiveCompleteBootstraps++;
        if (s.consecutiveCompleteBootstraps > MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS) {
          s.consecutiveCompleteBootstraps = 0;
          ctx.ui.notify(
            "All milestones are complete and the discussion didn't produce a new one. " +
            "Run /gsd to start a new milestone manually.",
            "warning",
          );
          return releaseLockAndReturn();
        }

        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

        // showSmartEntry dispatches via pi.sendMessage() which is fire-and-forget:
        // it queues the message and returns immediately, before the LLM turn runs.
        // Checking postState here would always see the pre-dispatch state, causing
        // the premature "Discussion completed but..." warning (#3420).
        //
        // checkAutoStartAfterDiscuss (in guided-flow.ts) already handles re-entering
        // auto-mode by calling startAutoDetached after the discussion completes.
        // Release the lock and let the async dispatch proceed.
        return releaseLockAndReturn();
      }

      // Active milestone exists but has no roadmap
      if (state.phase === "pre-planning") {
        const mid = state.activeMilestone!.id;
        const contextFile = resolveMilestoneFile(base, mid, "CONTEXT");
        const hasContext = !!(contextFile && (await loadFile(contextFile)));
        if (!hasContext) {
          const { showSmartEntry } = await import("./guided-flow.js");
          await showSmartEntry(ctx, pi, base, { step: requestedStepMode });

          // showSmartEntry dispatches via pi.sendMessage() which is fire-and-forget:
          // it queues the message and returns immediately, before the LLM turn runs.
          // Checking postState here fires before the LLM has had a turn, so the
          // pre-planning phase would still appear unchanged and a premature warning
          // would be emitted (#3420).
          //
          // checkAutoStartAfterDiscuss (in guided-flow.ts) already handles re-entering
          // auto-mode by calling startAutoDetached after the discussion completes.
          // Release the lock and let the async dispatch proceed.
          return releaseLockAndReturn();
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
    s.consecutiveCompleteBootstraps = 0;

    // ── Initialize session state ──
    // Notify shared phase state so subagent conflict checks can fire
    const { activateGSD: activateGSDPhaseState } = await import("../shared/gsd-phase-state.js");
    activateGSDPhaseState();
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
    s.originalModelId = startModelSnapshot?.id ?? ctx.model?.id ?? null;
    s.originalModelProvider = startModelSnapshot?.provider ?? ctx.model?.provider ?? null;
    s.originalThinkingLevel = startThinkingSnapshot ?? null;

    // Register SIGTERM handler
    registerSigtermHandler(base);

    // Capture integration branch
    if (s.currentMilestoneId) {
      if (getIsolationMode(base) !== "none") {
        captureIntegrationBranch(base, s.currentMilestoneId);
      }
      setActiveMilestoneId(base, s.currentMilestoneId);
    }

    // Guard against stale milestone branch when isolation:none (#3613).
    // A prior session with isolation:branch/worktree may have left HEAD on
    // milestone/<MID>. Auto-checkout back to the integration branch.
    if (getIsolationMode(base) === "none" && nativeIsRepo(base)) {
      try {
        const currentBranch = nativeGetCurrentBranch(base);
        if (currentBranch.startsWith("milestone/")) {
          const integrationBranch = nativeDetectMainBranch(base);
          nativeCheckoutBranch(base, integrationBranch);
          logWarning("bootstrap", `Returned to "${integrationBranch}" — HEAD was on stale milestone branch "${currentBranch}" (isolation: none does not use milestone branches).`);
        }
      } catch (err) {
        logWarning("bootstrap", `Could not auto-checkout from stale milestone branch: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      getIsolationMode(base) !== "none" &&
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
    const gsdDbPath = resolveProjectRootDbPath(s.basePath);
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
        logError("engine", `auto-migration failed: ${(err as Error).message}`);
      }
    }
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        openDb(gsdDbPath);
      } catch (err) {
        logError("engine", `failed to open existing database: ${(err as Error).message}`);
      }
    }

    // Gate: abort bootstrap if the DB file exists but the provider is
    // still unavailable after both open attempts above. Without this,
    // auto-mode starts but every gsd_task_complete / gsd_slice_complete
    // call returns "db_unavailable", triggering artifact-retry which
    // re-dispatches the same task — producing an infinite loop (#2419).
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      const dbStatus = getDbStatus();
      const phaseHint = dbStatus.lastPhase === "open"
        ? "The database file could not be opened"
        : dbStatus.lastPhase === "initSchema"
          ? "The database schema could not be initialized"
          : dbStatus.lastPhase === "vacuum-recovery"
            ? "Corruption recovery (VACUUM) failed"
            : dbStatus.attempted
              ? "The database could not be opened (phase unknown)"
              : "The database provider could not be loaded";
      const errorDetail = dbStatus.lastError ? ` (${dbStatus.lastError.message})` : "";
      const providerHint = dbStatus.provider
        ? ` Provider: ${dbStatus.provider}.`
        : " No SQLite provider available — check Node >= 22 or install better-sqlite3.";
      ctx.ui.notify(
        `SQLite database exists but failed to open: ${gsdDbPath}. ${phaseHint}${errorDetail}.${providerHint}`,
        "error",
      );
      return releaseLockAndReturn();
    }

    // Initialize metrics
    initMetrics(s.basePath);

    // Initialize routing history
    initRoutingHistory(s.basePath);

    // Restore the model that was active when auto bootstrap began (#650, #2829).
    if (startModelSnapshot) {
      s.autoModeStartModel = {
        provider: startModelSnapshot.provider,
        id: startModelSnapshot.id,
      };
    }
    s.autoModeStartThinkingLevel = startThinkingSnapshot ?? null;
    s.manualSessionModelOverride = manualSessionOverride ?? null;

    // Apply worker model override from parallel orchestrator (#worker-model).
    // GSD_WORKER_MODEL is injected by the coordinator when parallel.worker_model
    // is configured, so parallel milestone workers use a cheaper model than the
    // coordinator session (e.g. Haiku for execution, Sonnet for planning).
    const workerModelOverride = process.env.GSD_WORKER_MODEL;
    if (workerModelOverride && process.env.GSD_PARALLEL_WORKER === "1") {
      const availableModels = ctx.modelRegistry.getAvailable();
      const { resolveModelId } = await import("./auto-model-selection.js");
      const overrideModel = resolveModelId(workerModelOverride, availableModels, ctx.model?.provider);
      if (overrideModel) {
        const ok = await pi.setModel(overrideModel, { persist: false });
        if (ok) {
          // Update start model so all subsequent units use this as the baseline
          s.autoModeStartModel = { provider: overrideModel.provider, id: overrideModel.id };
          ctx.ui.notify(`Worker model override: ${overrideModel.provider}/${overrideModel.id}`, "info");
        }
      }
    }

    // Snapshot installed skills
    if (resolveSkillDiscoveryMode(base) !== "off") {
      snapshotSkills();
    }

    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setWidget("gsd-health", undefined);
    const modeLabel = s.stepMode ? "Step-mode" : "Auto-mode";
    const pendingCount = (state.registry ?? []).filter(
      (m) => m.status !== "complete" && m.status !== "parked",
    ).length;
    const scopeMsg =
      pendingCount > 1
        ? `Will loop through ${pendingCount} milestones.`
        : "Will loop until milestone complete.";
    ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");

    // Show dynamic routing status so users know upfront if models will be
    // downgraded for simple tasks (#3962).
    // Use the same effective logic as selectAndApplyModel: check flat-rate
    // provider suppression and resolve the actual ceiling model.
    const routingConfig = resolveDynamicRoutingConfig();
    const startModelLabel = s.autoModeStartModel
      ? `${s.autoModeStartModel.provider}/${s.autoModeStartModel.id}`
      : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default";

    // Flat-rate providers (e.g. GitHub Copilot, claude-code, user-declared
    // subscription proxies, externalCli CLIs) suppress routing at dispatch
    // time (#3453) — reflect that in the banner.  Thread the same
    // FlatRateContext used by selectAndApplyModel so user-declared
    // flat-rate providers and externalCli auto-detection are respected.
    const { isFlatRateProvider, buildFlatRateContext } = await import("./auto-model-selection.js");
    const bannerPrefs = loadEffectiveGSDPreferences(base)?.preferences;
    const effectiveProvider = s.autoModeStartModel?.provider ?? ctx.model?.provider;
    const effectivelyEnabled = routingConfig.enabled
      && (routingConfig.allow_flat_rate_providers
        || !(effectiveProvider && isFlatRateProvider(
          effectiveProvider,
          buildFlatRateContext(effectiveProvider, ctx, bannerPrefs),
        )));

    // The actual ceiling may come from tier_models.heavy, not the start model.
    const effectiveCeiling = (routingConfig.enabled && routingConfig.tier_models?.heavy)
      ? routingConfig.tier_models.heavy
      : startModelLabel;

    if (effectivelyEnabled) {
      ctx.ui.notify(
        `Dynamic routing: enabled — simple tasks may use cheaper models (ceiling: ${effectiveCeiling})`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `Dynamic routing: disabled — all tasks will use ${startModelLabel}`,
        "info",
      );
    }

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
    } catch (err) {
      /* non-fatal */
      logWarning("engine", `preflight validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return true;
  } catch (err) {
    releaseSessionLock(base);
    clearLock(base);
    throw err;
  }
}
