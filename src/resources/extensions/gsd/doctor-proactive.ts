/**
 * GSD Doctor — Proactive Healing Layer
 *
 * Three mechanisms for automatic health monitoring during auto-mode:
 *
 * 1. Pre-dispatch health gate: lightweight check before each unit dispatch.
 *    Returns blocking issues that should pause auto-mode rather than
 *    dispatching into a broken state.
 *
 * 2. Health score tracking: tracks issue counts over time to detect
 *    degradation trends. If health is declining, surfaces a warning.
 *
 * 3. Auto-heal escalation: if deterministic fix can't resolve issues
 *    after N units, escalates to LLM-assisted heal dispatch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot, resolveGsdRootFile } from "./paths.js";
import { readCrashLock, isLockProcessAlive, clearLock } from "./crash-recovery.js";
import { abortAndReset } from "./git-self-heal.js";
import { rebuildState } from "./doctor.js";
import { deriveState } from "./state.js";
import { resolveMilestoneIntegrationBranch } from "./git-service.js";
import { nativeIsRepo, nativeHasChanges, nativeLastCommitEpoch, nativeGetCurrentBranch, nativeAddTracked, nativeCommit } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { runEnvironmentChecks } from "./doctor-environment.js";

// ── Health Score Tracking ──────────────────────────────────────────────────

/** Compact issue detail stored per snapshot for real-time visibility. */
export interface HealthIssueDetail {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  unitId: string;
}

export interface HealthSnapshot {
  timestamp: number;
  errors: number;
  warnings: number;
  fixesApplied: number;
  unitIndex: number; // which unit dispatch triggered this snapshot
  /** Top issues from the doctor run that produced this snapshot. */
  issues: HealthIssueDetail[];
  /** Fixes that were auto-applied during this snapshot's doctor run. */
  fixes: string[];
  /** Milestone/slice scope this snapshot belongs to (e.g. "M001" or "M001/S02"). */
  scope?: string;
}

/** In-memory health history for the current auto-mode session. */
let healthHistory: HealthSnapshot[] = [];

/** Count of consecutive units with unresolved errors. */
let consecutiveErrorUnits = 0;

/** Unit index counter for health tracking. */
let healthUnitIndex = 0;

/** Previous progress level for state transition detection. */
let previousProgressLevel: "green" | "yellow" | "red" = "green";

/** Callback for state transition notifications. Set by auto-mode. */
let onLevelChange: ((from: string, to: string, summary: string) => void) | null = null;

/**
 * Register a callback for progress level transitions (green→yellow, yellow→red, etc.).
 * Called once when auto-mode starts. Pass null to unregister.
 */
export function setLevelChangeCallback(cb: ((from: string, to: string, summary: string) => void) | null): void {
  onLevelChange = cb;
  previousProgressLevel = "green";
}

/**
 * Record a health snapshot after a doctor run.
 * Called from the post-unit hook in auto-post-unit.ts.
 */
export function recordHealthSnapshot(
  errors: number,
  warnings: number,
  fixesApplied: number,
  issues?: HealthIssueDetail[],
  fixes?: string[],
  scope?: string,
): void {
  healthUnitIndex++;
  healthHistory.push({
    timestamp: Date.now(),
    errors,
    warnings,
    fixesApplied,
    unitIndex: healthUnitIndex,
    issues: issues ?? [],
    fixes: fixes ?? [],
    scope,
  });

  // Keep only the last 50 snapshots to bound memory
  if (healthHistory.length > 50) {
    healthHistory = healthHistory.slice(-50);
  }

  if (errors > 0) {
    consecutiveErrorUnits++;
  } else {
    consecutiveErrorUnits = 0;
  }

  // Detect progress level transitions and notify
  if (onLevelChange) {
    const newLevel = consecutiveErrorUnits >= 3 ? "red"
      : consecutiveErrorUnits >= 1 || getHealthTrend() === "degrading" ? "yellow"
        : "green";
    if (newLevel !== previousProgressLevel) {
      const topIssue = (issues ?? []).find(i => i.severity === "error") ?? (issues ?? [])[0];
      const detail = topIssue ? `: ${topIssue.message}` : "";
      onLevelChange(previousProgressLevel, newLevel, `Health ${previousProgressLevel} → ${newLevel}${detail}`);
      previousProgressLevel = newLevel;
    }
  }
}

/**
 * Get the current health trend.
 * Returns "improving", "stable", "degrading", or "unknown" (not enough data).
 */
export function getHealthTrend(): "improving" | "stable" | "degrading" | "unknown" {
  if (healthHistory.length < 3) return "unknown";

  const recent = healthHistory.slice(-5);
  const older = healthHistory.slice(-10, -5);

  if (older.length === 0) return "unknown";

  const recentAvg = recent.reduce((sum, s) => sum + s.errors + s.warnings, 0) / recent.length;
  const olderAvg = older.reduce((sum, s) => sum + s.errors + s.warnings, 0) / older.length;

  const delta = recentAvg - olderAvg;
  if (delta > 1) return "degrading";
  if (delta < -1) return "improving";
  return "stable";
}

/**
 * Get the number of consecutive units with unresolved errors.
 */
export function getConsecutiveErrorUnits(): number {
  return consecutiveErrorUnits;
}

/**
 * Get health history for display (e.g., dashboard overlay).
 */
export function getHealthHistory(): readonly HealthSnapshot[] {
  return healthHistory;
}

/**
 * Get the latest health issues from the most recent snapshot.
 * Returns issues from the last snapshot that had any, for real-time visibility.
 */
export function getLatestHealthIssues(): HealthIssueDetail[] {
  for (let i = healthHistory.length - 1; i >= 0; i--) {
    if (healthHistory[i]!.issues.length > 0) return healthHistory[i]!.issues;
  }
  return [];
}

/**
 * Get the latest fixes applied from the most recent snapshot.
 */
export function getLatestHealthFixes(): string[] {
  for (let i = healthHistory.length - 1; i >= 0; i--) {
    if (healthHistory[i]!.fixes.length > 0) return healthHistory[i]!.fixes;
  }
  return [];
}

/**
 * Reset health tracking state. Called on auto-mode start/stop.
 */
export function resetHealthTracking(): void {
  healthHistory = [];
  consecutiveErrorUnits = 0;
  healthUnitIndex = 0;
  previousProgressLevel = "green";
}

// ── Pre-Dispatch Health Gate ───────────────────────────────────────────────

export interface PreDispatchHealthResult {
  /** Whether the dispatch should proceed. */
  proceed: boolean;
  /** If blocked, the reason to show the user. */
  reason?: string;
  /** Issues found (for logging). */
  issues: string[];
  /** Whether fix was applied. */
  fixesApplied: string[];
}

/**
 * Lightweight pre-dispatch health check. Runs fast checks that should
 * block dispatch if they fail — avoids dispatching into a broken state.
 *
 * This is NOT a full doctor run — it only checks critical, fast-to-evaluate
 * conditions that would cause the next unit to fail or corrupt state.
 *
 * Returns { proceed: true } if dispatch should continue.
 */
export async function preDispatchHealthGate(basePath: string): Promise<PreDispatchHealthResult> {
  const issues: string[] = [];
  const fixesApplied: string[] = [];

  // ── Stale crash lock blocks dispatch ──
  // If a stale lock exists, the crash recovery path should handle it,
  // not a new dispatch. This prevents double-dispatch after crashes.
  try {
    const lock = readCrashLock(basePath);
    if (lock && !isLockProcessAlive(lock)) {
      // Auto-clear it since we're about to dispatch anyway
      clearLock(basePath);
      fixesApplied.push("cleared stale auto.lock before dispatch");
    }
  } catch {
    // Non-fatal
  }

  // ── Corrupt merge/rebase state blocks dispatch ──
  // Dispatching a unit with MERGE_HEAD present will cause git operations to fail.
  try {
    const gitDir = join(basePath, ".git");
    if (existsSync(gitDir)) {
      const blockers = ["MERGE_HEAD", "rebase-apply", "rebase-merge"].filter(
        f => existsSync(join(gitDir, f)),
      );
      if (blockers.length > 0) {
        // Try to auto-heal
        try {
          const result = abortAndReset(basePath);
          fixesApplied.push(`pre-dispatch: cleaned merge state (${result.cleaned.join(", ")})`);
        } catch {
          issues.push(`Corrupt git state: ${blockers.join(", ")}. Run /gsd doctor fix.`);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // ── STATE.md existence check ──
  // If STATE.md is missing, attempt to rebuild it for the next unit's context.
  // Non-blocking — fresh worktrees won't have it until the first unit completes (#889).
  try {
    const stateFile = resolveGsdRootFile(basePath, "STATE");
    const milestonesDir = join(gsdRoot(basePath), "milestones");
    if (existsSync(milestonesDir) && !existsSync(stateFile)) {
      try {
        await rebuildState(basePath);
        fixesApplied.push("rebuilt missing STATE.md before dispatch");
      } catch {
        // Rebuild failed — non-blocking, dispatch continues
        fixesApplied.push("STATE.md missing — will rebuild after first unit completes");
      }
    }
  } catch {
    // Non-fatal — dispatch continues without STATE.md if rebuild fails
  }

  // ── Integration branch existence check ──
  // If the active milestone's recorded integration branch no longer exists in
  // git, the merge-back at the end of the milestone will fail. Block dispatch
  // now to surface this before work is lost.
  try {
    if (nativeIsRepo(basePath)) {
      const state = await deriveState(basePath);
      if (state.activeMilestone) {
        const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
        const resolution = resolveMilestoneIntegrationBranch(basePath, state.activeMilestone.id, gitPrefs);
        if (resolution.status === "fallback" && resolution.effectiveBranch) {
          fixesApplied.push(
            `using fallback integration branch "${resolution.effectiveBranch}" for milestone ${state.activeMilestone.id}; recorded "${resolution.recordedBranch}" no longer exists`,
          );
        } else if (resolution.recordedBranch && resolution.status === "missing") {
          issues.push(
            `${resolution.reason} Restore the branch or update the integration branch before dispatching. Run /gsd doctor for details.`,
          );
        }
      }
    }
  } catch {
    // Non-fatal — dispatch continues if state/branch check fails
  }

  // ── Stale uncommitted changes — auto-snapshot before dispatch ──
  // If the working tree is dirty and no commit has happened recently,
  // create a safety snapshot so work isn't lost if the next unit crashes.
  try {
    if (nativeIsRepo(basePath)) {
      const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};
      // `git.snapshots: false` is the canonical toggle that disables WIP
      // snapshot commits — honour it before touching the threshold path (#4420).
      const snapshotsEnabled = prefs.git?.snapshots !== false;
      const thresholdMinutes = prefs.stale_commit_threshold_minutes ?? 30;

      if (snapshotsEnabled && thresholdMinutes > 0 && nativeHasChanges(basePath)) {
        const branch = nativeGetCurrentBranch(basePath);
        const lastEpoch = nativeLastCommitEpoch(basePath, branch || "HEAD");
        const nowEpoch = Math.floor(Date.now() / 1000);
        const minutesSinceCommit = lastEpoch > 0 ? (nowEpoch - lastEpoch) / 60 : Infinity;

        if (minutesSinceCommit >= thresholdMinutes) {
          const mins = Math.floor(minutesSinceCommit);
          try {
            nativeAddTracked(basePath);
            const commitMsg = `gsd snapshot: pre-dispatch, uncommitted changes after ${mins}m inactivity`;
            const result = nativeCommit(basePath, commitMsg);
            if (result) {
              fixesApplied.push(`pre-dispatch: created gsd snapshot after ${mins}m of uncommitted changes`);
            }
          } catch {
            // Non-blocking — snapshot failed but dispatch can continue
            fixesApplied.push("pre-dispatch: gsd snapshot failed");
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // ── Disk space check ──
  // Catches low-disk conditions before dispatch rather than letting the unit
  // fail mid-execution with ENOSPC (which wastes a full LLM turn).
  try {
    const envResults = runEnvironmentChecks(basePath);
    const diskError = envResults.find(r => r.name === "disk_space" && r.status === "error");
    if (diskError) {
      issues.push(`${diskError.message}${diskError.detail ? ` — ${diskError.detail}` : ""}`);
    }
  } catch {
    // Non-fatal — dispatch continues if env check fails
  }

  // If we had critical issues that couldn't be auto-healed, block dispatch
  if (issues.length > 0) {
    return {
      proceed: false,
      reason: `Pre-dispatch health check failed:\n${issues.map(i => `  - ${i}`).join("\n")}\nRun /gsd doctor fix to resolve.`,
      issues,
      fixesApplied,
    };
  }

  return { proceed: true, issues, fixesApplied };
}

// ── Auto-Heal Escalation ──────────────────────────────────────────────────

/** Threshold: escalate to LLM heal after this many consecutive error units. */
const ESCALATION_THRESHOLD = 5;

/** Whether an escalation has already been triggered this session (prevent spam). */
let escalationTriggered = false;

/**
 * Check whether auto-heal should escalate from deterministic fix to
 * LLM-assisted heal. Called after each post-unit doctor run.
 *
 * Returns the structured issue text for LLM dispatch, or null if
 * escalation is not needed.
 */
export function checkHealEscalation(
  errors: number,
  unresolvedIssues: Array<{ code: string; message: string; unitId: string }>,
): { shouldEscalate: boolean; reason: string; issues: typeof unresolvedIssues } {
  if (escalationTriggered) {
    return { shouldEscalate: false, reason: "already escalated this session", issues: [] };
  }

  if (consecutiveErrorUnits < ESCALATION_THRESHOLD) {
    return {
      shouldEscalate: false,
      reason: `${consecutiveErrorUnits}/${ESCALATION_THRESHOLD} consecutive error units`,
      issues: [],
    };
  }

  if (errors === 0) {
    return { shouldEscalate: false, reason: "no errors to escalate", issues: [] };
  }

  const trend = getHealthTrend();
  if (trend === "improving") {
    return { shouldEscalate: false, reason: "health is improving — deferring escalation", issues: [] };
  }

  escalationTriggered = true;
  return {
    shouldEscalate: true,
    reason: `${consecutiveErrorUnits} consecutive units with unresolved errors (trend: ${trend})`,
    issues: unresolvedIssues,
  };
}

/**
 * Reset escalation state. Called on auto-mode start/stop.
 */
export function resetEscalation(): void {
  escalationTriggered = false;
}

/**
 * Format a health summary for display in the auto-mode dashboard.
 * Human-readable with full words, not abbreviations.
 */
export function formatHealthSummary(): string {
  if (healthHistory.length === 0) return "No health data yet.";

  const latest = healthHistory[healthHistory.length - 1]!;
  const trend = getHealthTrend();
  const trendLabel = trend === "improving" ? "improving"
    : trend === "degrading" ? "degrading"
      : trend === "stable" ? "stable"
        : "unknown";
  const totalFixes = healthHistory.reduce((sum, s) => sum + s.fixesApplied, 0);

  const parts: string[] = [];

  // Error/warning summary
  if (latest.errors === 0 && latest.warnings === 0) {
    parts.push("No issues");
  } else {
    const counts: string[] = [];
    if (latest.errors > 0) counts.push(`${latest.errors} error${latest.errors > 1 ? "s" : ""}`);
    if (latest.warnings > 0) counts.push(`${latest.warnings} warning${latest.warnings > 1 ? "s" : ""}`);
    parts.push(counts.join(", "));
  }

  parts.push(`trend ${trendLabel}`);

  if (totalFixes > 0) {
    parts.push(`${totalFixes} fix${totalFixes > 1 ? "es" : ""} applied`);
  }

  if (consecutiveErrorUnits > 0) {
    parts.push(`${consecutiveErrorUnits} of ${ESCALATION_THRESHOLD} consecutive errors before escalation`);
  }

  // Include top issue from latest snapshot
  if (latest.issues.length > 0) {
    const topIssue = latest.issues.find(i => i.severity === "error") ?? latest.issues[0]!;
    parts.push(`latest: ${topIssue.message}`);
  }

  return parts.join(" · ");
}

/**
 * Reset all proactive healing state. Called on auto-mode start/stop.
 */
export function resetProactiveHealing(): void {
  resetHealthTracking();
  resetEscalation();
}
