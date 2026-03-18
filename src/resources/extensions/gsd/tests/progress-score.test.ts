/**
 * progress-score.test.ts — Tests for progress score / traffic light (#1221).
 *
 * Tests:
 *   - Score computation from health signals
 *   - Signal evaluation (trend, error streak, recent errors)
 *   - Context-aware scoring (retry counts, unit progress)
 *   - Formatting (single-line, detailed report)
 */

import {
  recordHealthSnapshot,
  resetProactiveHealing,
} from "../doctor-proactive.ts";

import {
  computeProgressScore,
  computeProgressScoreWithContext,
  formatProgressLine,
  formatProgressReport,
} from "../progress-score.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

async function main(): Promise<void> {
  try {
    // ── Base Score: No Data ─────────────────────────────────────────────
    console.log("\n=== progress: green with no data ===");
    {
      resetProactiveHealing();
      const score = computeProgressScore();
      assertEq(score.level, "green", "green when no data available");
      assertTrue(score.summary.includes("Progressing well"), "summary says progressing");
      assertTrue(score.signals.length > 0, "has signals");
    }

    // ── Green: Clean Health Data ────────────────────────────────────────
    console.log("\n=== progress: green with clean health ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      const score = computeProgressScore();
      assertEq(score.level, "green", "green with all clean snapshots");
    }

    // ── Yellow: Some Warnings ──────────────────────────────────────────
    console.log("\n=== progress: yellow with error streak ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(1, 2, 0);
      recordHealthSnapshot(1, 1, 0);
      const score = computeProgressScore();
      assertEq(score.level, "yellow", "yellow with consecutive errors");
      assertTrue(score.summary.includes("Struggling"), "summary says struggling");
    }

    // ── Red: Degrading Health ──────────────────────────────────────────
    console.log("\n=== progress: red with degrading trend ===");
    {
      resetProactiveHealing();
      // 5 older clean snapshots
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      // 5 recent error snapshots — triggers degrading trend
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(3, 5, 0);
      }
      const score = computeProgressScore();
      assertEq(score.level, "red", "red with degrading trend and persistent errors");
      assertTrue(score.summary.includes("Stuck"), "summary says stuck");
    }

    // ── Red: High Error Streak ─────────────────────────────────────────
    console.log("\n=== progress: red with high error streak ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 4; i++) {
        recordHealthSnapshot(2, 0, 0);
      }
      const score = computeProgressScore();
      assertEq(score.level, "red", "red with 4 consecutive error units");
    }

    // ── Context-Aware Scoring ──────────────────────────────────────────
    console.log("\n=== progress: context with retries ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 3; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      const score = computeProgressScoreWithContext({
        currentUnitId: "M001/S01/T03",
        completedUnits: 2,
        totalUnits: 5,
        retryCount: 0,
        maxRetries: 5,
      });
      assertEq(score.level, "green", "green with no retries");
      assertTrue(score.summary.includes("M001/S01/T03"), "summary includes unit ID");
      assertTrue(score.summary.includes("2 of 5"), "summary includes progress");
    }

    console.log("\n=== progress: context with high retry count ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 3; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      const score = computeProgressScoreWithContext({
        currentUnitId: "M001/S01/T03",
        retryCount: 4,
        maxRetries: 5,
      });
      assertEq(score.level, "red", "red with high retry count");
      assertTrue(score.summary.includes("looping"), "summary mentions looping");
    }

    console.log("\n=== progress: context with moderate retries ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 3; i++) {
        recordHealthSnapshot(0, 0, 0);
      }
      const score = computeProgressScoreWithContext({
        currentUnitId: "M001/S01/T03",
        retryCount: 1,
        maxRetries: 5,
      });
      assertEq(score.level, "yellow", "yellow with 1 retry");
    }

    // ── Formatting ─────────────────────────────────────────────────────
    console.log("\n=== progress: formatProgressLine ===");
    {
      resetProactiveHealing();
      const score = computeProgressScore();
      const line = formatProgressLine(score);
      assertTrue(line.includes("Progressing well"), "line includes summary");
      // Should start with green circle emoji
      assertTrue(line.startsWith("\uD83D\uDFE2"), "starts with green circle");
    }

    console.log("\n=== progress: formatProgressLine yellow ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(1, 0, 0);
      recordHealthSnapshot(1, 0, 0);
      const score = computeProgressScore();
      const line = formatProgressLine(score);
      assertTrue(line.startsWith("\uD83D\uDFE1"), "starts with yellow circle");
    }

    console.log("\n=== progress: formatProgressReport ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(0, 1, 0);
      const score = computeProgressScore();
      const detailed = formatProgressReport(score);
      assertTrue(detailed.includes("Signals:"), "report has signals section");
      assertTrue(detailed.includes("health_trend"), "report includes trend signal");
      assertTrue(detailed.includes("error_streak"), "report includes streak signal");
    }

    // ── Signal Details ─────────────────────────────────────────────────
    console.log("\n=== progress: signal names are consistent ===");
    {
      resetProactiveHealing();
      recordHealthSnapshot(0, 0, 0);
      const score = computeProgressScore();
      const names = score.signals.map(s => s.name);
      assertTrue(names.includes("health_trend"), "has health_trend signal");
      assertTrue(names.includes("error_streak"), "has error_streak signal");
      assertTrue(names.includes("recent_errors"), "has recent_errors signal");
      assertTrue(names.includes("artifact_production"), "has artifact_production signal");
      assertTrue(names.includes("dispatch_velocity"), "has dispatch_velocity signal");
    }

    console.log("\n=== progress: all signals have valid levels ===");
    {
      resetProactiveHealing();
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot(1, 1, 1);
      }
      const score = computeProgressScore();
      for (const signal of score.signals) {
        assertTrue(
          signal.level === "green" || signal.level === "yellow" || signal.level === "red",
          `signal ${signal.name} has valid level: ${signal.level}`,
        );
        assertTrue(signal.detail.length > 0, `signal ${signal.name} has non-empty detail`);
      }
    }

  } finally {
    resetProactiveHealing();
  }

  report();
}

main();
