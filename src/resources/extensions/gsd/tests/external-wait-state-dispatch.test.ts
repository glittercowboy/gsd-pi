/**
 * external-wait-state-dispatch.test.ts — Integration tests for M006/S01:
 * external_waits DB table, awaiting-external state derivation, and probe
 * dispatch rule (sleep/skip/stop actions).
 *
 * Uses real DB and real child_process.exec probes — no mocks.
 *
 * Requirements verified: R212, R217, R218, R233
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── DB layer ──────────────────────────────────────────────────────────────
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  updateTaskStatus,
  getExternalWait,
  insertExternalWait,
  incrementProbeFailureCount,
} from "../gsd-db.ts";

// ── State derivation ──────────────────────────────────────────────────────
import { deriveStateFromDb, invalidateStateCache } from "../state.ts";

// ── Dispatch ─────────────────────────────────────────────────────────────
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";

// ── Status guards ─────────────────────────────────────────────────────────
import { isClosedStatus } from "../status-guards.ts";

// ── Cache invalidation ───────────────────────────────────────────────────
import { clearPathCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fixture Helpers
// ═══════════════════════════════════════════════════════════════════════════

let base: string;

function createFixture(): { basePath: string; cleanup: () => void } {
  base = mkdtempSync(join(tmpdir(), "gsd-ext-wait-"));
  const gsdDir = join(base, ".gsd");
  const m001Dir = join(gsdDir, "milestones", "M001");
  const s01Dir = join(m001Dir, "slices", "S01");
  const s01Tasks = join(s01Dir, "tasks");

  mkdirSync(s01Tasks, { recursive: true });

  writeFileSync(
    join(m001Dir, "M001-CONTEXT.md"),
    "# M001: External Wait Test\n\n## Purpose\nTest external wait flow.\n",
  );

  writeFileSync(
    join(m001Dir, "M001-ROADMAP.md"),
    [
      "# M001: External Wait Test",
      "",
      "## Vision",
      "Validate awaiting-external phase.",
      "",
      "## Success Criteria",
      "- External wait flow works",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Test** `risk:low` `depends:[]`",
      "  - After this: External wait tested.",
      "",
      "## Boundary Map",
      "",
      "| From | To | Produces | Consumes |",
      "|------|----|----------|----------|",
      "| S01 | terminal | result | nothing |",
    ].join("\n"),
  );

  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    [
      "# S01: Test",
      "",
      "**Goal:** test external waits",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Test** `est:30m`",
      "  - Do: test",
      "  - Verify: tests pass",
    ].join("\n"),
  );

  writeFileSync(join(s01Tasks, "T01-PLAN.md"), "# T01: Test\n\n## Steps\n1. test\n");

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "External Wait Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test", status: "pending" });

  return {
    basePath: base,
    cleanup: () => {
      try { closeDatabase(); } catch { /* may not be open */ }
      if (base) rmSync(base, { recursive: true, force: true });
    },
  };
}

function buildDispatchCtx(
  basePath: string,
  mid: string,
  stateOverrides: Partial<import("../types.ts").GSDState> = {},
): DispatchContext {
  return {
    basePath,
    mid,
    midTitle: `${mid} Test`,
    state: {
      activeMilestone: { id: mid, title: `${mid} Test` },
      activeSlice: null,
      activeTask: null,
      phase: "executing",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
      ...stateOverrides,
    },
    prefs: undefined,
  };
}

// Helper: write a minimal T##-EXTERNAL-WAIT.json probe spec so the dispatch
// rule's existence check (R228) doesn't short-circuit to manual-attention.
function writeProbeSpec(
  basePath: string,
  mid: string,
  sid: string,
  tid: string,
  pollWhileCommand: string,
): void {
  const tasksDir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${tid}-EXTERNAL-WAIT.json`),
    JSON.stringify({ pollWhileCommand, pollIntervalMs: 30000, timeoutMs: 86400000 }),
  );
}

/**
 * Insert an external_waits row using the production API, with optional
 * pre-set failure count via incrementProbeFailureCount.
 */
function insertExternalWaitRow(
  _basePath: string,
  opts: {
    milestoneId: string;
    sliceId: string;
    taskId: string;
    pollWhileCommand: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    probeFailureCount?: number;
  },
): void {
  insertExternalWait(opts.milestoneId, opts.sliceId, opts.taskId, opts.pollWhileCommand, {
    pollIntervalMs: opts.pollIntervalMs,
    timeoutMs: opts.timeoutMs,
  });
  // Pre-set failure count if needed (production API only exposes increment)
  const targetCount = opts.probeFailureCount ?? 0;
  for (let i = 0; i < targetCount; i++) {
    incrementProbeFailureCount(opts.milestoneId, opts.sliceId, opts.taskId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

afterEach(() => {
  try { closeDatabase(); } catch { /* may not be open */ }
  if (base) {
    rmSync(base, { recursive: true, force: true });
    base = "";
  }
});

beforeEach(() => {
  invalidateStateCache();
  invalidateAllCaches();
  clearPathCache();
});

// ── 1. external_waits DB table ───────────────────────────────────────────

describe("external_waits DB table", () => {
  test("table exists after migration", () => {
    createFixture();
    // Prove the table exists by calling getExternalWait — it returns null for
    // a missing row but would throw if the table didn't exist.
    const result = getExternalWait("M001", "S01", "T01");
    assert.equal(result, null, "should return null for nonexistent row");
  });

  test("insert and read round-trip via getExternalWait", () => {
    const { basePath } = createFixture();
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: "echo hello",
      pollIntervalMs: 5000,
      timeoutMs: 60000,
      probeFailureCount: 0,
    });

    const row = getExternalWait("M001", "S01", "T01");
    assert.ok(row, "should return a row");
    assert.equal(row.milestone_id, "M001");
    assert.equal(row.slice_id, "S01");
    assert.equal(row.task_id, "T01");
    assert.equal(row.poll_while_command, "echo hello");
    assert.equal(row.poll_interval_ms, 5000);
    assert.equal(row.timeout_ms, 60000);
    assert.equal(row.probe_failure_count, 0);
    assert.equal(row.status, "waiting");
  });

  test("incrementProbeFailureCount increments by 1", () => {
    const { basePath } = createFixture();
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: "echo test",
      probeFailureCount: 0,
    });

    incrementProbeFailureCount("M001", "S01", "T01");
    const row = getExternalWait("M001", "S01", "T01");
    assert.ok(row);
    assert.equal(row.probe_failure_count, 1);

    // Increment again
    incrementProbeFailureCount("M001", "S01", "T01");
    const row2 = getExternalWait("M001", "S01", "T01");
    assert.ok(row2);
    assert.equal(row2.probe_failure_count, 2);
  });

  test("isClosedStatus('awaiting-external') returns false", () => {
    assert.equal(isClosedStatus("awaiting-external"), false);
  });
});

// ── 2. State derivation with awaiting-external ──────────────────────────

describe("state derivation with awaiting-external", () => {
  test("happy path — task with awaiting-external status yields phase awaiting-external", async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    invalidateStateCache();
    invalidateAllCaches();
    clearPathCache();

    const state = await deriveStateFromDb(basePath);
    assert.equal(state.phase, "awaiting-external");
    assert.ok(state.activeTask);
    assert.equal(state.activeTask.id, "T01");
  });

  test("no external_waits row needed for state derivation", async () => {
    const { basePath } = createFixture();
    // Set status but do NOT insert external_waits row
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    invalidateStateCache();
    invalidateAllCaches();
    clearPathCache();

    const state = await deriveStateFromDb(basePath);
    // State derivation only reads task status, not external_waits table (D026)
    assert.equal(state.phase, "awaiting-external");
  });

  test("completed task does not yield awaiting-external phase", async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "complete");
    invalidateStateCache();
    invalidateAllCaches();
    clearPathCache();

    const state = await deriveStateFromDb(basePath);
    assert.notEqual(state.phase, "awaiting-external");
    // With all tasks complete, should be summarizing
    assert.equal(state.phase, "summarizing");
  });
});

// ── 3. Dispatch rule probe execution ────────────────────────────────────

describe("dispatch rule probe execution", () => {
  test("exit 0 (still running) → sleep action", async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: "exit 0",
      pollIntervalMs: 15000,
    });
    writeProbeSpec(basePath, "M001", "S01", "T01", "exit 0");
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, "M001", {
      phase: "awaiting-external",
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "sleep");
    if (result.action === "sleep") {
      assert.equal(result.durationMs, 15000);
    }
  });

  test("exit non-zero (done) → skip action", async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: "exit 1",
    });
    writeProbeSpec(basePath, "M001", "S01", "T01", "exit 1");
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, "M001", {
      phase: "awaiting-external",
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "skip");
  });

  // Slow test: uses a long-running Node process to trigger the 30s probe timeout. ~35s runtime.
  // Skip in fast CI with FAST_CI=1 env var.
  const longSleepCmd = `${process.execPath} -e "setTimeout(()=>{},35000)"`;
  const skipSlow = process.env.FAST_CI === "1";
  test("probe timeout increments failure count", { timeout: 40000, skip: skipSlow }, async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: longSleepCmd,
      pollIntervalMs: 10000,
      probeFailureCount: 0,
    });
    writeProbeSpec(basePath, "M001", "S01", "T01", longSleepCmd);
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, "M001", {
      phase: "awaiting-external",
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
    });

    const result = await resolveDispatch(ctx);
    // With count going from 0 → 1, should NOT stop (threshold is 3)
    assert.equal(result.action, "sleep");

    // Verify failure count was incremented
    const row = getExternalWait("M001", "S01", "T01");
    assert.ok(row);
    assert.equal(row.probe_failure_count, 1);
  });

  // Slow test: uses a long-running Node process to trigger the 30s probe timeout. ~35s runtime.
  test("3-strike escalation → stop action", { timeout: 40000, skip: skipSlow }, async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    insertExternalWaitRow(basePath, {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      pollWhileCommand: longSleepCmd,
      pollIntervalMs: 10000,
      probeFailureCount: 2, // Already at 2, timeout will push to 3
    });
    writeProbeSpec(basePath, "M001", "S01", "T01", longSleepCmd);
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, "M001", {
      phase: "awaiting-external",
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.match(result.reason, /3 times/);
    }
  });

  test("no external_waits row → stop action", async () => {
    const { basePath } = createFixture();
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    // Do NOT insert external_waits row
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, "M001", {
      phase: "awaiting-external",
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
    });

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.match(result.reason, /no external_waits record/);
    }
  });
});
