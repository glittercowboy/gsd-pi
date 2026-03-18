/**
 * GSD Progress Score — Traffic Light Status Indicator (#1221)
 *
 * Combines existing health signals into a single at-a-glance status:
 *   - Green: progressing well
 *   - Yellow: struggling (retries, warnings)
 *   - Red: stuck (loops, persistent errors, no activity)
 *
 * Purely derived — no stored state. Reads from doctor-proactive health
 * tracking, stuck detection counters, and working-tree activity.
 */

import {
  getHealthTrend,
  getConsecutiveErrorUnits,
  getHealthHistory,
  type HealthSnapshot,
} from "./doctor-proactive.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ProgressLevel = "green" | "yellow" | "red";

export interface ProgressScore {
  level: ProgressLevel;
  summary: string;
  signals: ProgressSignal[];
}

export interface ProgressSignal {
  name: string;
  level: ProgressLevel;
  detail: string;
}

// ── Signal Evaluators ──────────────────────────────────────────────────────

function evaluateHealthTrend(): ProgressSignal {
  const trend = getHealthTrend();

  switch (trend) {
    case "improving":
      return { name: "health_trend", level: "green", detail: "Health improving" };
    case "stable":
      return { name: "health_trend", level: "green", detail: "Health stable" };
    case "degrading":
      return { name: "health_trend", level: "red", detail: "Health degrading" };
    case "unknown":
      return { name: "health_trend", level: "green", detail: "Insufficient data" };
  }
}

function evaluateErrorStreak(): ProgressSignal {
  const streak = getConsecutiveErrorUnits();

  if (streak === 0) {
    return { name: "error_streak", level: "green", detail: "No consecutive errors" };
  }
  if (streak <= 2) {
    return { name: "error_streak", level: "yellow", detail: `${streak} consecutive error unit(s)` };
  }
  return { name: "error_streak", level: "red", detail: `${streak} consecutive error units` };
}

function evaluateRecentErrors(): ProgressSignal {
  const history = getHealthHistory();
  if (history.length === 0) {
    return { name: "recent_errors", level: "green", detail: "No health data yet" };
  }

  const latest = history[history.length - 1]!;

  if (latest.errors === 0 && latest.warnings <= 1) {
    return { name: "recent_errors", level: "green", detail: `${latest.errors}E/${latest.warnings}W` };
  }
  if (latest.errors === 0) {
    return { name: "recent_errors", level: "yellow", detail: `${latest.warnings} warning(s)` };
  }
  if (latest.errors <= 2) {
    return { name: "recent_errors", level: "yellow", detail: `${latest.errors} error(s), ${latest.warnings} warning(s)` };
  }
  return { name: "recent_errors", level: "red", detail: `${latest.errors} error(s), ${latest.warnings} warning(s)` };
}

function evaluateArtifactProduction(): ProgressSignal {
  const history = getHealthHistory();
  if (history.length < 2) {
    return { name: "artifact_production", level: "green", detail: "Insufficient data" };
  }

  const totalFixes = history.reduce((sum, s) => sum + s.fixesApplied, 0);
  const recent = history.slice(-3);
  const recentFixes = recent.reduce((sum, s) => sum + s.fixesApplied, 0);

  // If recent units are all producing fixes but errors aren't decreasing,
  // doctor is fighting fires but not making headway
  if (recentFixes > 3 && recent.every(s => s.errors > 0)) {
    return { name: "artifact_production", level: "yellow", detail: "Doctor applying fixes but errors persist" };
  }

  return { name: "artifact_production", level: "green", detail: `${totalFixes} total fixes applied` };
}

function evaluateDispatchVelocity(): ProgressSignal {
  const history = getHealthHistory();
  if (history.length < 3) {
    return { name: "dispatch_velocity", level: "green", detail: "Insufficient data" };
  }

  // Check time between recent snapshots — are units completing at a reasonable rate?
  const recent = history.slice(-5);
  if (recent.length < 2) {
    return { name: "dispatch_velocity", level: "green", detail: "Insufficient data" };
  }

  const timeDiffs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    timeDiffs.push(recent[i]!.timestamp - recent[i - 1]!.timestamp);
  }

  const avgTimeMs = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
  const avgTimeMins = Math.round(avgTimeMs / 60_000);

  // If average unit time is > 15 minutes, something might be wrong
  if (avgTimeMins > 15) {
    return { name: "dispatch_velocity", level: "yellow", detail: `Units averaging ${avgTimeMins}min each` };
  }

  return { name: "dispatch_velocity", level: "green", detail: `Units averaging ${avgTimeMins || "<1"}min each` };
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Compute the current progress score by evaluating all available signals.
 * Returns a composite score with individual signal details.
 */
export function computeProgressScore(): ProgressScore {
  const signals: ProgressSignal[] = [
    evaluateHealthTrend(),
    evaluateErrorStreak(),
    evaluateRecentErrors(),
    evaluateArtifactProduction(),
    evaluateDispatchVelocity(),
  ];

  // Overall level: worst of all signals
  const level = signals.some(s => s.level === "red")
    ? "red"
    : signals.some(s => s.level === "yellow")
      ? "yellow"
      : "green";

  // Build summary from the most important signals
  const summary = buildSummary(level, signals);

  return { level, summary, signals };
}

/**
 * Compute progress score with additional context from the current unit.
 */
export function computeProgressScoreWithContext(context: {
  currentUnitType?: string;
  currentUnitId?: string;
  completedUnits?: number;
  totalUnits?: number;
  retryCount?: number;
  maxRetries?: number;
}): ProgressScore {
  const base = computeProgressScore();

  // Add retry signal if available
  if (context.retryCount !== undefined && context.maxRetries !== undefined) {
    const retrySignal: ProgressSignal = context.retryCount === 0
      ? { name: "retry_count", level: "green", detail: "No retries" }
      : context.retryCount <= 2
        ? { name: "retry_count", level: "yellow", detail: `Retry ${context.retryCount}/${context.maxRetries}` }
        : { name: "retry_count", level: "red", detail: `Retry ${context.retryCount}/${context.maxRetries} — looping` };

    base.signals.push(retrySignal);

    // Re-evaluate level
    if (retrySignal.level === "red") base.level = "red";
    else if (retrySignal.level === "yellow" && base.level === "green") base.level = "yellow";
  }

  // Build richer summary with context
  base.summary = buildSummaryWithContext(base.level, base.signals, context);

  return base;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function buildSummary(level: ProgressLevel, signals: ProgressSignal[]): string {
  switch (level) {
    case "green":
      return "Progressing well";
    case "yellow": {
      const issues = signals.filter(s => s.level === "yellow").map(s => s.detail);
      return `Struggling — ${issues[0] ?? "minor issues detected"}`;
    }
    case "red": {
      const issues = signals.filter(s => s.level === "red").map(s => s.detail);
      return `Stuck — ${issues[0] ?? "critical issues detected"}`;
    }
  }
}

function buildSummaryWithContext(
  level: ProgressLevel,
  signals: ProgressSignal[],
  context: {
    currentUnitType?: string;
    currentUnitId?: string;
    completedUnits?: number;
    totalUnits?: number;
    retryCount?: number;
    maxRetries?: number;
  },
): string {
  const unitLabel = context.currentUnitId
    ? ` ${context.currentUnitId}`
    : "";
  const progressLabel = context.completedUnits !== undefined && context.totalUnits !== undefined
    ? ` (${context.completedUnits} of ${context.totalUnits} done)`
    : "";

  switch (level) {
    case "green":
      return `Progressing well —${unitLabel}${progressLabel}`;
    case "yellow": {
      const issues = signals.filter(s => s.level === "yellow").map(s => s.detail);
      const retryInfo = context.retryCount ? `, attempt ${context.retryCount}/${context.maxRetries}` : "";
      return `Struggling —${unitLabel}${retryInfo}${progressLabel ? ` ${progressLabel}` : ""}, ${issues[0] ?? "issues detected"}`;
    }
    case "red": {
      const issues = signals.filter(s => s.level === "red").map(s => s.detail);
      return `Stuck —${unitLabel}${progressLabel ? ` ${progressLabel}` : ""}, ${issues[0] ?? "critical issues"}`;
    }
  }
}

/**
 * Format progress score as a single-line traffic light for TUI display.
 */
export function formatProgressLine(score: ProgressScore): string {
  const icon = score.level === "green" ? "\uD83D\uDFE2"
    : score.level === "yellow" ? "\uD83D\uDFE1"
      : "\uD83D\uDD34";
  return `${icon} ${score.summary}`;
}

/**
 * Format a detailed progress report showing all signals.
 */
export function formatProgressReport(score: ProgressScore): string {
  const lines: string[] = [];

  lines.push(formatProgressLine(score));
  lines.push("");
  lines.push("Signals:");

  for (const signal of score.signals) {
    const icon = signal.level === "green" ? "\u2705"
      : signal.level === "yellow" ? "\u26A0\uFE0F"
        : "\uD83D\uDED1";
    lines.push(`  ${icon} ${signal.name}: ${signal.detail}`);
  }

  return lines.join("\n");
}
