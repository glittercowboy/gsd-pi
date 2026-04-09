import { describe, test } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression tests for dashboard metric fallback chain.
 *
 * The dashboard reads metrics from two sources:
 *   1. projectTotals (polled from /api/visualizer — always available)
 *   2. auto (live auto-mode data — null when auto is not active)
 *
 * Fallback chain: projectTotals?.X ?? auto?.X ?? 0
 *
 * See: https://github.com/gsd-build/gsd-2/issues/2709
 */

interface ProjectTotals {
  duration: number;
  cost: number;
  tokens: { total: number };
}

interface AutoDashboard {
  elapsed: number;
  totalCost: number;
  totalTokens: number;
}

/** Mirrors the fallback logic in dashboard.tsx */
function deriveMetrics(
  projectTotals: ProjectTotals | null,
  auto: AutoDashboard | null,
) {
  return {
    elapsed: projectTotals?.duration ?? auto?.elapsed ?? 0,
    totalCost: projectTotals?.cost ?? auto?.totalCost ?? 0,
    totalTokens: projectTotals?.tokens.total ?? auto?.totalTokens ?? 0,
  };
}

describe("dashboard metric fallback (#2709 regression)", () => {
  test("returns zero when both sources are null", () => {
    const result = deriveMetrics(null, null);
    assert.equal(result.elapsed, 0);
    assert.equal(result.totalCost, 0);
    assert.equal(result.totalTokens, 0);
  });

  test("uses auto data when projectTotals is null", () => {
    const auto: AutoDashboard = { elapsed: 5000, totalCost: 1.5, totalTokens: 10000 };
    const result = deriveMetrics(null, auto);
    assert.equal(result.elapsed, 5000);
    assert.equal(result.totalCost, 1.5);
    assert.equal(result.totalTokens, 10000);
  });

  test("uses projectTotals when auto is null (manual mode)", () => {
    const totals: ProjectTotals = { duration: 60000, cost: 3.2, tokens: { total: 50000 } };
    const result = deriveMetrics(totals, null);
    assert.equal(result.elapsed, 60000);
    assert.equal(result.totalCost, 3.2);
    assert.equal(result.totalTokens, 50000);
  });

  test("projectTotals takes precedence over auto when both present", () => {
    const totals: ProjectTotals = { duration: 120000, cost: 5.0, tokens: { total: 80000 } };
    const auto: AutoDashboard = { elapsed: 10000, totalCost: 0.5, totalTokens: 5000 };
    const result = deriveMetrics(totals, auto);
    assert.equal(result.elapsed, 120000, "projectTotals duration should take precedence");
    assert.equal(result.totalCost, 5.0, "projectTotals cost should take precedence");
    assert.equal(result.totalTokens, 80000, "projectTotals tokens should take precedence");
  });
});
