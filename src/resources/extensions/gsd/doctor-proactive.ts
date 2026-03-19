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
import { readIntegrationBranch } from "./git-service.js";
import { nativeBranchExists, nativeIsRepo } from "./native-git-bridge.js";

// ── Health Score Tracking ──────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: number;
  errors: number;
  warnings: number;
  fixesApplied: number;
  unitIndex: number; // which unit dispatch triggered this snapshot
}

/** In-memory health history for the current auto-mode session. */
let healthHistory: HealthSnapshot[] = [];

/** Count of consecutive units with unresolved errors. */
let consecutiveErrorUnits = 0;

/** Unit index counter for health tracking. */
let healthUnitIndex = 0;

/**
 * Record a health snapshot after a doctor run.
 * Called from the post-unit hook in auto.ts.
 */
export function recordHealthSnapshot(errors: number, warnings: number, fixesApplied: number): void {
  healthUnitIndex++;
  healthHistory.push({
    timestamp: Date.now(),
    errors,
    warnings,
    fixesApplied,
    unitIndex: healthUnitIndex,
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
 * Reset health tracking state. Called on auto-mode start/stop.
 */
export function resetHealthTracking(): void {
  healthHistory = [];
  consecutiveErrorUnits = 0;
  healthUnitIndex = 0;
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
        const integrationBranch = readIntegrationBranch(basePath, state.activeMilestone.id);
        if (integrationBranch && !nativeBranchExists(basePath, integrationBranch)) {
          issues.push(
            `Integration branch "${integrationBranch}" for milestone ${state.activeMilestone.id} no longer exists in git. ` +
            `Restore the branch or update the integration branch before dispatching. Run /gsd doctor for details.`,
          );
        }
      }
    }
  } catch {
    // Non-fatal — dispatch continues if state/branch check fails
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
 */
export function formatHealthSummary(): string {
  if (healthHistory.length === 0) return "No health data yet.";

  const latest = healthHistory[healthHistory.length - 1]!;
  const trend = getHealthTrend();
  const trendIcon = trend === "improving" ? "+" : trend === "degrading" ? "-" : "=";
  const totalFixes = healthHistory.reduce((sum, s) => sum + s.fixesApplied, 0);

  const parts = [
    `Health: ${latest.errors}E/${latest.warnings}W`,
    `trend:${trendIcon}`,
    `fixes:${totalFixes}`,
  ];

  if (consecutiveErrorUnits > 0) {
    parts.push(`streak:${consecutiveErrorUnits}/${ESCALATION_THRESHOLD}`);
  }

  return parts.join(" | ");
}

/**
 * Reset all proactive healing state. Called on auto-mode start/stop.
 */
export function resetProactiveHealing(): void {
  resetHealthTracking();
  resetEscalation();
}
