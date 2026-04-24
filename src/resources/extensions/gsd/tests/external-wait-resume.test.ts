/**
 * external-wait-resume.test.ts — Integration tests for M006/S03:
 * Full external-wait lifecycle: resume transitions, timeout detection,
 * successCheck, probe logging, carry-forward context, failure count reset,
 * DB/JSON inconsistency self-healing, and minimum pollInterval sleep.
 *
 * Uses real DB and real child_process.exec probes — no mocks.
 *
 * Requirements verified: R219, R220, R221, R222, R224, R227, R228
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
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
  updateExternalWaitStatus,
  resetProbeFailureCount,
  incrementProbeFailureCount,
  getAllWaitingExternalWaits,
  getTask,
} from "../gsd-db.ts";

// ── State derivation ──────────────────────────────────────────────────────
import { invalidateStateCache } from "../state.ts";

// ── Dispatch ─────────────────────────────────────────────────────────────
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";

// ── Cache invalidation ───────────────────────────────────────────────────
import { clearPathCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fixture Helpers
// ═══════════════════════════════════════════════════════════════════════════

let base: string;

interface FixtureOpts {
  pollWhileCommand: string;
  successCheck?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  contextHint?: string;
  onTimeout?: string;
  /** If true, skip writing T01-EXTERNAL-WAIT.json (for R228 inconsistency test) */
  skipJsonSpec?: boolean;
}

function createFixture(opts: FixtureOpts): {
  basePath: string;
  tasksDir: string;
  session: { pendingExternalResume: string | null };
} {
  base = mkdtempSync(join(tmpdir(), "gsd-resume-"));
  const gsdDir = join(base, ".gsd");
  const m001Dir = join(gsdDir, "milestones", "M001");
  const s01Dir = join(m001Dir, "slices", "S01");
  const tasksDir = join(s01Dir, "tasks");

  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(m001Dir, "M001-CONTEXT.md"),
    "# M001: Resume Test\n\n## Purpose\nTest external wait resume flow.\n",
  );

  writeFileSync(
    join(m001Dir, "M001-ROADMAP.md"),
    [
      "# M001: Resume Test",
      "",
      "## Vision",
      "Validate awaiting-external resume lifecycle.",
      "",
      "## Success Criteria",
      "- External wait lifecycle works",
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
      "**Goal:** test external wait resume",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Test** `est:30m`",
      "  - Do: test",
      "  - Verify: tests pass",
    ].join("\n"),
  );

  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Test\n\n## Steps\n1. test\n");

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Resume Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test", status: "pending" });

  // Set task to awaiting-external and insert external_waits row
  updateTaskStatus("M001", "S01", "T01", "awaiting-external");
  insertExternalWait("M001", "S01", "T01", opts.pollWhileCommand, {
    successCheck: opts.successCheck,
    pollIntervalMs: opts.pollIntervalMs,
    timeoutMs: opts.timeoutMs,
    contextHint: opts.contextHint,
    onTimeout: opts.onTimeout,
  });

  // Write JSON probe spec unless explicitly skipped (R228 test)
  if (!opts.skipJsonSpec) {
    writeFileSync(
      join(tasksDir, "T01-EXTERNAL-WAIT.json"),
      JSON.stringify({
        pollWhileCommand: opts.pollWhileCommand,
        pollIntervalMs: opts.pollIntervalMs ?? 30000,
        timeoutMs: opts.timeoutMs ?? 86400000,
      }),
    );
  }

  const session = { pendingExternalResume: null as string | null };

  return { basePath: base, tasksDir, session };
}

function buildDispatchCtx(
  basePath: string,
  session: { pendingExternalResume: string | null },
): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Resume Test",
    state: {
      activeMilestone: { id: "M001", title: "Resume Test" },
      activeSlice: { id: "S01", title: "Test" },
      activeTask: { id: "T01", title: "Test" },
      phase: "awaiting-external",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: undefined,
    // Test partial: only pendingExternalResume is needed for external-wait dispatch
    session: session as unknown as import("../auto/session.js").AutoSession,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup
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

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Timeout detection (R221) ─────────────────────────────────────────

describe("Timeout detection (R221)", () => {
  test("times out → manual-attention + stop when registered_at + timeout_ms exceeded", async () => {
    const { basePath, tasksDir, session } = createFixture({
      pollWhileCommand: "exit 0",
      timeoutMs: 1, // 1ms — already expired by the time we dispatch
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);

    // Small delay to ensure the 1ms timeout has passed
    await new Promise(r => setTimeout(r, 10));

    const result = await resolveDispatch(ctx);
    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.equal(result.level, "warning");
      assert.match(result.reason, /timed out/i);
    }

    // Verify DB: task status → manual-attention
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "manual-attention");

    // Verify DB: external_waits status → timed-out, resolved_at set
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "timed-out");
    assert.ok(wait.resolved_at, "resolved_at should be set after timeout");

    // Verify log file exists with timeout entry
    const logPath = join(tasksDir, "T01-EXTERNAL-WAIT.log");
    assert.ok(existsSync(logPath), "log file should exist after timeout");
    const logContent = readFileSync(logPath, "utf-8").trim();
    const logEntry = JSON.parse(logContent.split("\n")[0]);
    assert.equal(logEntry.event, "timeout");
    assert.ok(logEntry.ts, "log entry should have timestamp");
  });

  test("times out → resume-with-failure + skip when onTimeout is resume-with-failure", async () => {
    const { basePath, tasksDir, session } = createFixture({
      pollWhileCommand: "exit 0",
      timeoutMs: 1, // 1ms — already expired
      onTimeout: "resume-with-failure",
      contextHint: "SLURM job 99999",
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);

    // Small delay to ensure the 1ms timeout has passed
    await new Promise(r => setTimeout(r, 10));

    const result = await resolveDispatch(ctx);

    // resume-with-failure returns skip (not stop) to resume execution
    assert.equal(result.action, "skip");

    // Verify DB: task status → executing (resumed, not manual-attention)
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing", "task should resume to executing on resume-with-failure timeout");

    // Verify DB: external_waits status → timed-out, resolved_at set
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "timed-out");
    assert.ok(wait.resolved_at, "resolved_at should be set after timeout");

    // Verify session carry-forward has failure context
    assert.ok(session.pendingExternalResume, "pendingExternalResume should be set");
    assert.match(session.pendingExternalResume!, /TIMED OUT/);
    assert.match(session.pendingExternalResume!, /resume-with-failure/);
    assert.match(session.pendingExternalResume!, /SLURM job 99999/);

    // Verify log file exists with timeout entry including onTimeout mode
    const logPath = join(tasksDir, "T01-EXTERNAL-WAIT.log");
    assert.ok(existsSync(logPath), "log file should exist after timeout");
    const logContent = readFileSync(logPath, "utf-8").trim();
    const logEntry = JSON.parse(logContent.split("\n")[0]);
    assert.equal(logEntry.event, "timeout");
    assert.ok(logEntry.ts, "log entry should have timestamp");
  });
});

// ── 2. Probe success → resume (R222, R224) ──────────────────────────────

describe("Probe success → resume (R222, R224)", () => {
  test("probe done (exit non-zero) + no successCheck → task resumes to executing", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // non-zero = done
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    // Verify DB: task status → executing
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    // Verify DB: external_waits status → resolved
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "resolved");
    assert.ok(wait.resolved_at, "resolved_at should be set after resolution");

    // Verify session carry-forward
    assert.ok(session.pendingExternalResume, "pendingExternalResume should be set");
    assert.match(session.pendingExternalResume!, /EXTERNAL WAIT RESOLVED/);
  });

  test("probe done + successCheck passes → task resumes with success context", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // done
      successCheck: "exit 0", // success check passes (exit 0 = success in normal shell)
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    // Verify DB transitions
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "resolved");

    // Verify carry-forward mentions successful completion
    assert.ok(session.pendingExternalResume);
    assert.match(session.pendingExternalResume!, /completed successfully/);
  });

  test("contextHint appears in carry-forward", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // done
      contextHint: "SLURM job 12345 training run",
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    // Verify carry-forward contains the hint text
    assert.ok(session.pendingExternalResume);
    assert.match(session.pendingExternalResume!, /SLURM job 12345 training run/);
  });
});

// ── 3. Job failure → resume with failure context (R222) ─────────────────

describe("Job failure → resume with failure context (R222)", () => {
  test("successCheck fails → task resumes with failure context", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // done
      successCheck: "exit 42", // non-zero = job failed
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    // Verify DB: task still transitions to executing (to let agent handle failure)
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    // Verify DB: external_waits status → resolved
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "resolved");

    // Verify session carry-forward mentions failure
    assert.ok(session.pendingExternalResume);
    assert.match(session.pendingExternalResume!, /JOB FAILED/);
    assert.match(session.pendingExternalResume!, /Exit code: 42/);
  });
});

// ── 4. Probe logging (R220) ────────────────────────────────────────────

describe("Probe logging (R220)", () => {
  test("probe log file created with entry after probe execution", async () => {
    const { basePath, tasksDir, session } = createFixture({
      pollWhileCommand: "echo hello && exit 0", // exit 0 = still running
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    // exit 0 = still running → sleep
    assert.equal(result.action, "sleep");

    // Read log file
    const logPath = join(tasksDir, "T01-EXTERNAL-WAIT.log");
    assert.ok(existsSync(logPath), "log file should exist after probe");
    const logContent = readFileSync(logPath, "utf-8").trim();
    const logEntry = JSON.parse(logContent.split("\n")[0]);

    assert.ok(logEntry.ts, "log entry should have ts (timestamp)");
    assert.equal(logEntry.exitCode, 0, "exit code should be 0 (still running)");
    assert.match(logEntry.stdout, /hello/, "stdout should contain 'hello'");
  });
});

// ── 5. Probe failure count reset (R227) ─────────────────────────────────

describe("Probe failure count reset (R227)", () => {
  test("successful probe (exit 0) resets failure count to 0", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 0", // still running
    });

    // Pre-set probe_failure_count to 2 via production API (increment twice)
    incrementProbeFailureCount("M001", "S01", "T01");
    incrementProbeFailureCount("M001", "S01", "T01");

    // Verify pre-condition
    const beforeWait = getExternalWait("M001", "S01", "T01");
    assert.ok(beforeWait);
    assert.equal(beforeWait.probe_failure_count, 2, "pre-condition: failure count should be 2");

    invalidateAllCaches();
    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    // exit 0 = still running → sleep, but failure count should be reset
    assert.equal(result.action, "sleep");

    const afterWait = getExternalWait("M001", "S01", "T01");
    assert.ok(afterWait);
    assert.equal(afterWait.probe_failure_count, 0, "failure count should be reset to 0 after successful probe");
  });
});

// ── 6. DB/JSON inconsistency (R228) ─────────────────────────────────────

describe("DB/JSON inconsistency (R228)", () => {
  test("missing JSON probe spec → manual-attention + stop", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 0",
      skipJsonSpec: true, // Do NOT write T01-EXTERNAL-WAIT.json
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "stop");
    if (result.action === "stop") {
      assert.equal(result.level, "warning");
      assert.match(result.reason, /EXTERNAL-WAIT\.json/);
    }

    // Verify DB: task status → manual-attention
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "manual-attention");
  });
});

// ── 7. Minimum pollInterval sleep (R219) ────────────────────────────────

describe("Minimum pollInterval sleep (R219)", () => {
  test("sleep duration uses minimum pollInterval across all waiting tasks", async () => {
    // Create fixture with T01 at pollInterval=60000
    base = mkdtempSync(join(tmpdir(), "gsd-minpoll-"));
    const gsdDir = join(base, ".gsd");
    const m001Dir = join(gsdDir, "milestones", "M001");
    const s01Dir = join(m001Dir, "slices", "S01");
    const tasksDir = join(s01Dir, "tasks");

    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(
      join(m001Dir, "M001-CONTEXT.md"),
      "# M001: MinPoll Test\n\n## Purpose\nTest min poll interval.\n",
    );

    writeFileSync(
      join(m001Dir, "M001-ROADMAP.md"),
      [
        "# M001: MinPoll Test",
        "",
        "## Vision",
        "Validate minimum poll interval.",
        "",
        "## Success Criteria",
        "- Min poll works",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Test** `risk:low` `depends:[]`",
        "  - After this: done.",
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
        "**Goal:** test min poll",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Test 1** `est:30m`",
        "  - Do: test",
        "  - Verify: pass",
        "- [ ] **T02: Test 2** `est:30m`",
        "  - Do: test",
        "  - Verify: pass",
      ].join("\n"),
    );

    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Test 1\n\n## Steps\n1. test\n");
    writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02: Test 2\n\n## Steps\n1. test\n");

    openDatabase(join(gsdDir, "gsd.db"));
    insertMilestone({ id: "M001", title: "MinPoll Test", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test 1", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Test 2", status: "pending" });

    // Both tasks awaiting-external with different poll intervals
    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    updateTaskStatus("M001", "S01", "T02", "awaiting-external");

    insertExternalWait("M001", "S01", "T01", "exit 0", { pollIntervalMs: 60000 });
    insertExternalWait("M001", "S01", "T02", "exit 0", { pollIntervalMs: 10000 });

    // Write JSON probe specs for both tasks
    writeFileSync(
      join(tasksDir, "T01-EXTERNAL-WAIT.json"),
      JSON.stringify({ pollWhileCommand: "exit 0", pollIntervalMs: 60000, timeoutMs: 86400000 }),
    );
    writeFileSync(
      join(tasksDir, "T02-EXTERNAL-WAIT.json"),
      JSON.stringify({ pollWhileCommand: "exit 0", pollIntervalMs: 10000, timeoutMs: 86400000 }),
    );

    invalidateAllCaches();
    invalidateStateCache();
    clearPathCache();

    // Dispatch for T01 (first in order, active task)
    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "MinPoll Test",
      state: {
        activeMilestone: { id: "M001", title: "MinPoll Test" },
        activeSlice: { id: "S01", title: "Test" },
        activeTask: { id: "T01", title: "Test 1" },
        phase: "awaiting-external",
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        registry: [],
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
        progress: { milestones: { done: 0, total: 1 } },
      },
      prefs: undefined,
      session: { pendingExternalResume: null } as unknown as import("../auto/session.js").AutoSession,
    };

    const result = await resolveDispatch(ctx);

    // exit 0 = still running → sleep with min poll interval
    assert.equal(result.action, "sleep");
    if (result.action === "sleep") {
      assert.equal(result.durationMs, 10000, "sleep should use minimum pollInterval (10000) across all waiting tasks");
    }
  });
});
