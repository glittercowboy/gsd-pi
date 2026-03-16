import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initRoutingHistory,
  resetRoutingHistory,
  recordOutcome,
  recordFeedback,
  getAdaptiveTierAdjustment,
  clearRoutingHistory,
  getRoutingHistory,
} from "../routing-history.js";

// ─── Test Setup ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gsd-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  resetRoutingHistory();
}

// ─── recordOutcome ───────────────────────────────────────────────────────────

test("recordOutcome tracks success and failure counts", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordOutcome("execute-task", "standard", true);
    recordOutcome("execute-task", "standard", true);
    recordOutcome("execute-task", "standard", false);

    const history = getRoutingHistory();
    assert.ok(history);
    const pattern = history.patterns["execute-task"];
    assert.ok(pattern);
    assert.equal(pattern.standard.success, 2);
    assert.equal(pattern.standard.fail, 1);
  } finally {
    cleanup(dir);
  }
});

test("recordOutcome tracks tag-specific patterns", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordOutcome("execute-task", "light", true, ["docs"]);

    const history = getRoutingHistory();
    assert.ok(history);
    assert.ok(history.patterns["execute-task:docs"]);
    assert.equal(history.patterns["execute-task:docs"].light.success, 1);
  } finally {
    cleanup(dir);
  }
});

test("recordOutcome applies rolling window", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    // Record 60 successes — should be capped to 50
    for (let i = 0; i < 60; i++) {
      recordOutcome("execute-task", "standard", true);
    }

    const history = getRoutingHistory();
    assert.ok(history);
    const total = history.patterns["execute-task"].standard.success +
                  history.patterns["execute-task"].standard.fail;
    assert.ok(total <= 50, `total ${total} should be <= 50`);
  } finally {
    cleanup(dir);
  }
});

// ─── getAdaptiveTierAdjustment ───────────────────────────────────────────────

test("no adjustment when insufficient data", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordOutcome("execute-task", "light", false);
    // Only 1 data point — not enough
    const adj = getAdaptiveTierAdjustment("execute-task", "light");
    assert.equal(adj, null);
  } finally {
    cleanup(dir);
  }
});

test("bumps tier when failure rate exceeds threshold", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    // Record high failure rate at light tier
    recordOutcome("execute-task", "light", false);
    recordOutcome("execute-task", "light", false);
    recordOutcome("execute-task", "light", true);
    // 2/3 = 66% failure rate > 20% threshold

    const adj = getAdaptiveTierAdjustment("execute-task", "light");
    assert.equal(adj, "standard");
  } finally {
    cleanup(dir);
  }
});

test("no adjustment when success rate is high", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    for (let i = 0; i < 10; i++) {
      recordOutcome("execute-task", "light", true);
    }
    const adj = getAdaptiveTierAdjustment("execute-task", "light");
    assert.equal(adj, null);
  } finally {
    cleanup(dir);
  }
});

test("tag-specific patterns take precedence", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    // Base pattern has high success rate (tagged calls also count toward base)
    for (let i = 0; i < 15; i++) {
      recordOutcome("execute-task", "light", true);
    }
    // But docs-tagged tasks fail at light
    recordOutcome("execute-task", "light", false, ["docs"]);
    recordOutcome("execute-task", "light", false, ["docs"]);
    recordOutcome("execute-task", "light", true, ["docs"]);

    // With tags, should bump (docs pattern: 1/3 success = 66% failure)
    const adj = getAdaptiveTierAdjustment("execute-task", "light", ["docs"]);
    assert.equal(adj, "standard");

    // Without tags, should not bump (base: 16/18 success = 11% failure)
    const adjBase = getAdaptiveTierAdjustment("execute-task", "light");
    assert.equal(adjBase, null);
  } finally {
    cleanup(dir);
  }
});

// ─── recordFeedback ──────────────────────────────────────────────────────────

test("recordFeedback stores feedback entries", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordFeedback("execute-task", "M001/S01/T01", "standard", "over");

    const history = getRoutingHistory();
    assert.ok(history);
    assert.equal(history.feedback.length, 1);
    assert.equal(history.feedback[0].rating, "over");
    assert.equal(history.feedback[0].tier, "standard");
  } finally {
    cleanup(dir);
  }
});

test("recordFeedback 'under' increases failure count at tier", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordFeedback("execute-task", "M001/S01/T01", "light", "under");

    const history = getRoutingHistory();
    assert.ok(history);
    // "under" adds 2 (FEEDBACK_WEIGHT) failures
    assert.equal(history.patterns["execute-task"].light.fail, 2);
  } finally {
    cleanup(dir);
  }
});

test("recordFeedback 'over' increases success count at lower tier", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordFeedback("execute-task", "M001/S01/T01", "standard", "over");

    const history = getRoutingHistory();
    assert.ok(history);
    // "over" at standard → adds 2 successes at light
    assert.equal(history.patterns["execute-task"].light.success, 2);
  } finally {
    cleanup(dir);
  }
});

// ─── clearRoutingHistory ─────────────────────────────────────────────────────

test("clearRoutingHistory resets all data", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordOutcome("execute-task", "light", true);
    clearRoutingHistory(dir);

    const history = getRoutingHistory();
    assert.ok(history);
    assert.deepEqual(history.patterns, {});
    assert.deepEqual(history.feedback, []);
  } finally {
    cleanup(dir);
  }
});

// ─── Persistence ─────────────────────────────────────────────────────────────

test("routing history persists to disk and reloads", () => {
  const dir = makeTmpDir();
  try {
    initRoutingHistory(dir);
    recordOutcome("execute-task", "standard", true);
    recordOutcome("execute-task", "standard", true);
    resetRoutingHistory();

    // Reload from disk
    initRoutingHistory(dir);
    const history = getRoutingHistory();
    assert.ok(history);
    assert.equal(history.patterns["execute-task"].standard.success, 2);
  } finally {
    cleanup(dir);
  }
});
