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
  getLatestHealthIssues,
  getLatestHealthFixes,
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
  kind: "positive" | "negative" | "neutral";
  label: string;
}

function escalateLevel(level: ProgressLevel, next: ProgressLevel): ProgressLevel {
  const ranks: Record<ProgressLevel, number> = {
    green: 0,
    yellow: 1,
    red: 2,
  };
  return ranks[next] > ranks[level] ? next : level;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute the current progress score from health signals.
 */
export function computeProgressScore(): ProgressScore {
  const signals: ProgressSignal[] = [];
  let level: ProgressLevel = "green";

  // Check consecutive errors
  const consecutiveErrors = getConsecutiveErrorUnits();
  if (consecutiveErrors >= 3) {
    signals.push({ kind: "negative", label: `${consecutiveErrors} consecutive error units` });
    level = escalateLevel(level, "red");
  } else if (consecutiveErrors >= 1) {
    signals.push({ kind: "negative", label: `${consecutiveErrors} consecutive error unit(s)` });
    level = escalateLevel(level, "yellow");
  }

  // Check health trend
  const trend = getHealthTrend();
  if (trend === "degrading") {
    signals.push({ kind: "negative", label: "Health trend declining" });
    level = escalateLevel(level, "yellow");
  } else if (trend === "improving") {
    signals.push({ kind: "positive", label: "Health trend improving" });
  } else if (trend === "stable") {
    signals.push({ kind: "neutral", label: "Health trend stable" });
  }

  // Check recent history
  const history = getHealthHistory();
  if (history.length === 0) {
    signals.push({ kind: "neutral", label: "No health data yet" });
  }

  // Surface actual doctor issue details when degraded
  if (level !== "green") {
    const latestIssues = getLatestHealthIssues();
    // Show up to 5 most relevant issues (errors first, then warnings)
    const sorted = [...latestIssues].sort((a, b) => {
      const rank = { error: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity];
    });
    for (const issue of sorted.slice(0, 5)) {
      signals.push({
        kind: issue.severity === "error" ? "negative" : "neutral",
        label: issue.message,
      });
    }

    const latestFixes = getLatestHealthFixes();
    for (const fix of latestFixes.slice(0, 3)) {
      signals.push({ kind: "positive", label: `Fixed: ${fix}` });
    }
  }

  const summary = level === "green"
    ? "Progressing well"
    : level === "yellow"
      ? "Some issues detected"
      : "Stuck or erroring";

  return { level, summary, signals };
}

/**
 * Compute progress score with additional context for dashboard display.
 */
export function computeProgressScoreWithContext(context: {
  sameUnitCount?: number;
  recoveryCount?: number;
  completedCount?: number;
}): ProgressScore {
  const base = computeProgressScore();

  if (context.sameUnitCount && context.sameUnitCount >= 3) {
    base.signals.push({ kind: "negative", label: `Same unit dispatched ${context.sameUnitCount}× consecutively` });
    base.level = escalateLevel(base.level, "red");
    base.summary = "Stuck on same unit";
  } else if (context.sameUnitCount && context.sameUnitCount >= 2) {
    base.signals.push({ kind: "negative", label: `Same unit dispatched ${context.sameUnitCount}×` });
    base.level = escalateLevel(base.level, "yellow");
  }

  if (context.recoveryCount && context.recoveryCount > 0) {
    base.signals.push({ kind: "negative", label: `${context.recoveryCount} recovery attempts` });
    base.level = escalateLevel(base.level, "yellow");
  }

  if (context.completedCount && context.completedCount > 0) {
    base.signals.push({ kind: "positive", label: `${context.completedCount} units completed` });
  }

  return base;
}

/**
 * Format a one-line progress indicator for dashboard/status display.
 */
export function formatProgressLine(score: ProgressScore): string {
  const icon = score.level === "green" ? "●" : score.level === "yellow" ? "◐" : "○";
  return `${icon} ${score.summary}`;
}

/**
 * Format a multi-line progress report.
 */
export function formatProgressReport(score: ProgressScore): string {
  const lines = [formatProgressLine(score)];
  for (const signal of score.signals) {
    const prefix = signal.kind === "positive" ? "  ✓" : signal.kind === "negative" ? "  ✗" : "  ·";
    lines.push(`${prefix} ${signal.label}`);
  }
  return lines.join("\n");
}
