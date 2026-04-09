/**
 * Contract tests for `formatCostProjection`.
 * Tests the pure function — no file I/O, no extension context.
 *
 * This test intentionally fails at import time (or on first assertion)
 * because `formatCostProjection` does not yet exist in metrics.ts.
 * That failure confirms the test runs against real code. (T01 state)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  type SliceAggregate,
  formatCostProjection,
} from "../metrics.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSliceAggregate(sliceId: string, cost: number): SliceAggregate {
  return {
    sliceId,
    units: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost,
    duration: 1000,
  };
}

// ─── formatCostProjection ─────────────────────────────────────────────────────

describe("formatCostProjection", () => {

  test("zero completed slices → empty result", () => {
    const result = formatCostProjection([], 3);
    assert.strictEqual(result.length, 0, "zero slices → empty array");
  });

  test("one slice → suppressed (need ≥2 to project reliably)", () => {
    const result = formatCostProjection([makeSliceAggregate("M001/S01", 0.10)], 3);
    assert.strictEqual(result.length, 0, "one slice → suppressed (no projection shown)");
  });

  test("two slices → projection shown", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5);
    assert.ok(result.length > 0, "two slices → projection shown");
  });

  test("two-slice result contains $ (cost is formatted)", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5);
    assert.ok(result.length > 0 && result[0].includes("$"), "projection line contains \"$\"");
  });

  test("budget ceiling hit: total >= ceiling → line contains ceiling", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5, 0.05);
    const hasCeilingLine = result.some(
      line => line.toLowerCase().includes("ceiling")
    );
    assert.ok(hasCeilingLine, "ceiling warning appears when total ($0.20) >= ceiling ($0.05)");
  });

  test("budget ceiling not hit: total < ceiling → no ceiling line", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5, 100.00);
    const hasCeilingLine = result.some(
      line => line.toLowerCase().includes("ceiling")
    );
    assert.ok(!hasCeilingLine, "no ceiling warning when total ($0.20) < ceiling ($100.00)");
  });

  test("no ceiling arg → no ceiling line", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5);
    const hasCeilingLine = result.some(
      line => line.toLowerCase().includes("ceiling")
    );
    assert.ok(!hasCeilingLine, "no ceiling warning when no ceiling is set");
  });

  test("rounding: avg $0.10 × 5 remaining = $0.50", () => {
    const slices = [
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 5);
    const hasRoundedCost = result.some(line => line.includes("$0.50"));
    assert.ok(hasRoundedCost, "projected cost $0.50 (avg $0.10 × 5 remaining) appears in output");
  });

  test("bare milestone entries excluded from average", () => {
    const slices = [
      makeSliceAggregate("M001", 5.00),        // bare milestone — must be excluded
      makeSliceAggregate("M001/S01", 0.10),
      makeSliceAggregate("M001/S02", 0.10),
    ];
    const result = formatCostProjection(slices, 3);
    const hasCorrectProjection = result.some(line => line.includes("$0.30"));
    assert.ok(
      hasCorrectProjection,
      "bare milestone entry excluded from avg: projection shows $0.30 (avg $0.10 × 3), not $1.83 (including $5.00 entry)"
    );
  });
});
