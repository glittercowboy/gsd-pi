/**
 * Forensics detectStuckLoops tests — #1943
 *
 * Verifies that detectStuckLoops counts distinct dispatches (unique startedAt
 * values per type/id) instead of raw entry count, which produces false-positive
 * stuck-loop anomalies when idle-watchdog duplicate metrics entries exist.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { UnitMetrics } from "../metrics.js";
import { detectStuckLoops, type ForensicAnomaly } from "../forensics.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<UnitMetrics> = {}): UnitMetrics {
  return {
    type: "execute-task",
    id: "M001/S01/T01",
    model: "claude-sonnet-4-20250514",
    startedAt: 1000,
    finishedAt: 2000,
    tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
    cost: 0.05,
    toolCalls: 3,
    assistantMessages: 2,
    userMessages: 1,
    ...overrides,
  };
}


// ── Tests ────────────────────────────────────────────────────────────────────

test("#1943 detectStuckLoops does not flag idle-watchdog duplicates as stuck loops", () => {
  const anomalies: ForensicAnomaly[] = [];
  const startedAt = 1774011016218;

  // 20 entries with the SAME startedAt — these are idle-watchdog duplicates,
  // not real re-dispatches. They should count as 1 dispatch.
  const units: UnitMetrics[] = [];
  for (let i = 0; i < 20; i++) {
    units.push(makeUnit({
      type: "research-slice",
      id: "M009/S02",
      startedAt,
      finishedAt: startedAt + (i + 1) * 15000,
      cost: 1.50 + i * 0.05,
      toolCalls: 0,
    }));
  }

  detectStuckLoops(units, anomalies);

  // A single dispatch (same startedAt) should NOT trigger a stuck-loop anomaly
  assert.equal(
    anomalies.length, 0,
    `expected 0 anomalies for 20 watchdog snapshots of the same dispatch, got ${anomalies.length}: ${anomalies.map(a => a.summary).join(", ")}`,
  );
});

test("#1943 detectStuckLoops correctly flags real re-dispatches", () => {
  const anomalies: ForensicAnomaly[] = [];

  // 3 entries with DIFFERENT startedAt values — these are real re-dispatches
  const units: UnitMetrics[] = [
    makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 1000, finishedAt: 2000, cost: 0.05 }),
    makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 3000, finishedAt: 4000, cost: 0.06 }),
    makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 5000, finishedAt: 6000, cost: 0.07 }),
  ];

  detectStuckLoops(units, anomalies);

  assert.equal(anomalies.length, 1, "3 distinct dispatches of the same unit should flag 1 anomaly");
  assert.equal(anomalies[0].type, "stuck-loop");
  assert.ok(anomalies[0].summary.includes("3 times"), `summary should mention 3 dispatches: ${anomalies[0].summary}`);
});

test("#1943 detectStuckLoops ignores watchdog duplicates but flags real re-dispatches in mixed data", () => {
  const anomalies: ForensicAnomaly[] = [];

  const units: UnitMetrics[] = [
    // 5 watchdog duplicates for dispatch 1 (same startedAt = 1000)
    ...Array.from({ length: 5 }, (_, i) =>
      makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 1000, finishedAt: 1000 + (i + 1) * 15000, cost: 0.05 + i * 0.01 }),
    ),
    // 3 watchdog duplicates for dispatch 2 (same startedAt = 100000)
    ...Array.from({ length: 3 }, (_, i) =>
      makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 100000, finishedAt: 100000 + (i + 1) * 15000, cost: 0.08 + i * 0.01 }),
    ),
    // 1 entry for dispatch 3 (startedAt = 200000)
    makeUnit({ type: "execute-task", id: "M001/S01/T01", startedAt: 200000, finishedAt: 260000, cost: 0.10 }),
    // Different unit — only 1 dispatch, should NOT be flagged
    makeUnit({ type: "plan-slice", id: "M001/S01", startedAt: 500, finishedAt: 1500, cost: 0.02 }),
  ];

  detectStuckLoops(units, anomalies);

  // M001/S01/T01 has 3 distinct dispatches (startedAt: 1000, 100000, 200000) — should be flagged
  // M001/S01 has 1 dispatch — should NOT be flagged
  assert.equal(anomalies.length, 1, `expected 1 anomaly (for the 3x dispatched task), got ${anomalies.length}`);
  assert.ok(anomalies[0].summary.includes("3 times"));
});

test("#3760 detectStuckLoops ignores cross-session recovery re-dispatches", () => {
  const anomalies: ForensicAnomaly[] = [];

  const units: UnitMetrics[] = [
    makeUnit({
      type: "plan-slice",
      id: "M001/S02",
      startedAt: 1000,
      finishedAt: 2000,
      autoSessionKey: "session-a",
    }),
    makeUnit({
      type: "plan-slice",
      id: "M001/S02",
      startedAt: 5000,
      finishedAt: 6000,
      autoSessionKey: "session-b",
    }),
  ];

  detectStuckLoops(units, anomalies);

  assert.equal(anomalies.length, 0, "cross-session recovery should not be flagged as a stuck loop");
});

test("#3760 detectStuckLoops still flags repeated dispatches within one auto session", () => {
  const anomalies: ForensicAnomaly[] = [];

  const units: UnitMetrics[] = [
    makeUnit({
      type: "complete-slice",
      id: "M011/S02",
      startedAt: 1000,
      finishedAt: 2000,
      autoSessionKey: "session-a",
    }),
    makeUnit({
      type: "complete-slice",
      id: "M011/S02",
      startedAt: 5000,
      finishedAt: 6000,
      autoSessionKey: "session-a",
    }),
    makeUnit({
      type: "complete-slice",
      id: "M011/S02",
      startedAt: 9000,
      finishedAt: 10000,
      autoSessionKey: "session-b",
    }),
  ];

  detectStuckLoops(units, anomalies);

  assert.equal(anomalies.length, 1, "within-session retries should still be flagged");
  assert.ok(anomalies[0].summary.includes("2 times"), `summary should reflect the worst same-session loop: ${anomalies[0].summary}`);
  assert.ok(
    anomalies[0].details.includes("Cross-session recovery runs are ignored"),
    `details should explain the session-aware rule: ${anomalies[0].details}`,
  );
});
