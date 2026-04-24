/**
 * external-wait-e2e.test.ts — Full-pipeline end-to-end integration tests
 * for the external-wait system (M006/S04).
 *
 * 7 distinct scenarios covering:
 *   1. Multi-cycle happy path with POSIX-portable stateful bash probe (R230, R231)
 *   2. Immediate completion (done on first probe)
 *   3. Timeout escalation
 *   4. 3-strike probe failure (optimized with pre-set failure count)
 *   5. Job failure via successCheck
 *   6. Job success via successCheck
 *   7. All-awaiting minimum pollInterval sleep
 *
 * Uses real DB and real child_process.exec probes — no mocks.
 *
 * Requirements verified: R230, R231
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
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
  getTask,
  incrementProbeFailureCount,
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
}

function createFixture(opts: FixtureOpts): {
  basePath: string;
  tasksDir: string;
  session: { pendingExternalResume: string | null };
} {
  base = mkdtempSync(join(tmpdir(), "gsd-e2e-"));
  const gsdDir = join(base, ".gsd");
  const m001Dir = join(gsdDir, "milestones", "M001");
  const s01Dir = join(m001Dir, "slices", "S01");
  const tasksDir = join(s01Dir, "tasks");

  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(
    join(m001Dir, "M001-CONTEXT.md"),
    "# M001: E2E Test\n\n## Purpose\nEnd-to-end external wait testing.\n",
  );

  writeFileSync(
    join(m001Dir, "M001-ROADMAP.md"),
    [
      "# M001: E2E Test",
      "",
      "## Vision",
      "Validate full external-wait pipeline end-to-end.",
      "",
      "## Success Criteria",
      "- All external wait paths work",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Test** `risk:low` `depends:[]`",
      "  - After this: External wait e2e tested.",
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
      "**Goal:** test external wait e2e",
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
  insertMilestone({ id: "M001", title: "E2E Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test", status: "pending" });

  updateTaskStatus("M001", "S01", "T01", "awaiting-external");
  insertExternalWait("M001", "S01", "T01", opts.pollWhileCommand, {
    successCheck: opts.successCheck,
    pollIntervalMs: opts.pollIntervalMs,
    timeoutMs: opts.timeoutMs,
    contextHint: opts.contextHint,
    onTimeout: opts.onTimeout,
  });

  writeFileSync(
    join(tasksDir, "T01-EXTERNAL-WAIT.json"),
    JSON.stringify({
      pollWhileCommand: opts.pollWhileCommand,
      pollIntervalMs: opts.pollIntervalMs ?? 30000,
      timeoutMs: opts.timeoutMs ?? 86400000,
    }),
  );

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
    midTitle: "E2E Test",
    state: {
      activeMilestone: { id: "M001", title: "E2E Test" },
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
    session: session as any,
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
// Scenario 1 — Multi-cycle happy path (R230, R231)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 1: Multi-cycle happy path (R230, R231)", () => {
  test("stateful POSIX probe: exit 0 twice (still running), exit 1 third (done) → resume with contextHint", { skip: process.platform === "win32" ? "POSIX-only test — shell probe uses /bin/sh" : undefined }, async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "gsd-e2e-multi-"));
    base = tmpBase;
    const gsdDir = join(tmpBase, ".gsd");
    const m001Dir = join(gsdDir, "milestones", "M001");
    const s01Dir = join(m001Dir, "slices", "S01");
    const tasksDir = join(s01Dir, "tasks");

    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(
      join(m001Dir, "M001-CONTEXT.md"),
      "# M001: Multi-cycle\n\n## Purpose\nMulti-cycle probe test.\n",
    );
    writeFileSync(
      join(m001Dir, "M001-ROADMAP.md"),
      [
        "# M001: Multi-cycle",
        "",
        "## Vision",
        "Multi-cycle probe.",
        "",
        "## Success Criteria",
        "- Multi-cycle works",
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
        "**Goal:** multi-cycle probe",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: Test** `est:30m`",
        "  - Do: test",
        "  - Verify: pass",
      ].join("\n"),
    );
    writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Test\n\n## Steps\n1. test\n");

    // Create POSIX-portable stateful probe script
    const counterFile = join(tmpBase, "counter.txt");
    const probeScript = join(tmpBase, "probe.sh");
    writeFileSync(
      probeScript,
      [
        '#!/bin/sh',
        'COUNT=$(cat "$1" 2>/dev/null || echo 0)',
        'COUNT=$(expr $COUNT + 1)',
        'echo $COUNT > "$1"',
        'if [ $COUNT -ge 3 ]; then exit 1; fi',
        'exit 0',
      ].join("\n"),
    );
    chmodSync(probeScript, 0o755);

    const pollWhileCommand = `${probeScript} ${counterFile}`;

    openDatabase(join(gsdDir, "gsd.db"));
    insertMilestone({ id: "M001", title: "Multi-cycle", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test", status: "pending" });

    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    insertExternalWait("M001", "S01", "T01", pollWhileCommand, {
      contextHint: "Training job XYZ",
    });

    writeFileSync(
      join(tasksDir, "T01-EXTERNAL-WAIT.json"),
      JSON.stringify({ pollWhileCommand, pollIntervalMs: 30000, timeoutMs: 86400000 }),
    );

    const session = { pendingExternalResume: null as string | null };
    const ctx = buildDispatchCtx(tmpBase, session);
    ctx.state.activeMilestone = { id: "M001", title: "Multi-cycle" };
    ctx.midTitle = "Multi-cycle";

    // ── Cycle 1: exit 0 → still running → sleep ──
    invalidateAllCaches();
    invalidateStateCache();
    clearPathCache();
    const r1 = await resolveDispatch(ctx);
    assert.equal(r1.action, "sleep", "cycle 1 should sleep (still running)");

    // ── Cycle 2: exit 0 → still running → sleep ──
    invalidateAllCaches();
    invalidateStateCache();
    clearPathCache();
    // Re-set phase since state may have been mutated
    ctx.state.phase = "awaiting-external";
    const r2 = await resolveDispatch(ctx);
    assert.equal(r2.action, "sleep", "cycle 2 should sleep (still running)");

    // ── Cycle 3: exit 1 → done → skip (resume) ──
    invalidateAllCaches();
    invalidateStateCache();
    clearPathCache();
    ctx.state.phase = "awaiting-external";
    const r3 = await resolveDispatch(ctx);
    assert.equal(r3.action, "skip", "cycle 3 should skip (done)");

    // Verify DB: task status → executing
    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    // Verify DB: external_waits status → resolved
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "resolved");

    // Verify session carry-forward contains contextHint and EXTERNAL WAIT RESOLVED
    assert.ok(session.pendingExternalResume, "pendingExternalResume should be set");
    assert.match(session.pendingExternalResume!, /EXTERNAL WAIT RESOLVED/);
    assert.match(session.pendingExternalResume!, /Training job XYZ/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Immediate completion
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 2: Immediate completion", () => {
  test("exit 1 on first probe → skip, task=executing, wait=resolved, carry-forward set", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1",
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "resolved");
    assert.ok(wait.resolved_at, "resolved_at should be set");

    assert.ok(session.pendingExternalResume, "pendingExternalResume should be set");
    assert.match(session.pendingExternalResume!, /EXTERNAL WAIT RESOLVED/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3 — Timeout escalation
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 3: Timeout escalation", () => {
  test("timeoutMs=1 (already expired) → stop warning, task=manual-attention, wait=timed-out", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 0",
      timeoutMs: 1,
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

    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "manual-attention");

    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.status, "timed-out");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4 — 3-strike probe failure (optimized)
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 4: 3-strike probe failure", () => {
  test("probe timeout with pre-set failure_count=2 → 3rd failure → stop, task=manual-attention", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "sleep 35", // will hit 30s exec timeout
    });

    // Pre-set probe_failure_count to 2 via DB wrapper API
    incrementProbeFailureCount("M001", "S01", "T01");
    incrementProbeFailureCount("M001", "S01", "T01");

    // Verify pre-condition
    const beforeWait = getExternalWait("M001", "S01", "T01");
    assert.ok(beforeWait);
    assert.equal(beforeWait.probe_failure_count, 2, "pre-condition: failure count should be 2");

    invalidateAllCaches();
    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "stop");

    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "manual-attention");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4b — Per-probe timeout is distinct from overall wait timeout
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 4b: Per-probe timeout distinct from overall wait timeout", () => {
  test("hanging probe is killed by per-probe timeout (30s) even when overall timeout is 24h", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "sleep 120", // hangs for 2 minutes — must be killed by probe timeout
      timeoutMs: 86400000,           // overall timeout is 24h — NOT what kills this
    });

    invalidateAllCaches();
    const ctx = buildDispatchCtx(basePath, session);

    const start = Date.now();
    const result = await resolveDispatch(ctx);
    const elapsed = Date.now() - start;

    // Probe should be killed after ~30s (probe timeout), not 120s or 24h
    assert.ok(elapsed < 60000, `probe should be killed by per-probe timeout (~30s), not hang for 120s (took ${elapsed}ms)`);

    // Result should be sleep (failure count incremented to 1, still below 3-strike threshold)
    assert.equal(result.action, "sleep", "first probe failure should sleep, not stop");

    // Verify failure count was incremented
    const wait = getExternalWait("M001", "S01", "T01");
    assert.ok(wait);
    assert.equal(wait.probe_failure_count, 1, "probe_failure_count should be incremented after timeout kill");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5 — Job failure via successCheck
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 5: Job failure via successCheck", () => {
  test("pollWhileCommand done + successCheck exit 42 → skip, carry-forward contains JOB FAILED and exit code", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // done
      successCheck: "exit 42", // non-zero = job failed
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    assert.ok(session.pendingExternalResume);
    assert.match(session.pendingExternalResume!, /JOB FAILED/);
    assert.match(session.pendingExternalResume!, /Exit code: 42/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6 — Job success via successCheck
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 6: Job success via successCheck", () => {
  test("pollWhileCommand done + successCheck exit 0 → skip, carry-forward contains completed successfully", async () => {
    const { basePath, session } = createFixture({
      pollWhileCommand: "exit 1", // done
      successCheck: "exit 0", // success
    });
    invalidateAllCaches();

    const ctx = buildDispatchCtx(basePath, session);
    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "skip");

    const task = getTask("M001", "S01", "T01");
    assert.ok(task);
    assert.equal(task.status, "executing");

    assert.ok(session.pendingExternalResume);
    assert.match(session.pendingExternalResume!, /completed successfully/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7 — All-awaiting minimum pollInterval sleep
// ═══════════════════════════════════════════════════════════════════════════

describe("Scenario 7: All-awaiting minimum pollInterval sleep", () => {
  test("two tasks with different pollIntervals → sleep uses minimum (10000)", async () => {
    base = mkdtempSync(join(tmpdir(), "gsd-e2e-minpoll-"));
    const gsdDir = join(base, ".gsd");
    const m001Dir = join(gsdDir, "milestones", "M001");
    const s01Dir = join(m001Dir, "slices", "S01");
    const tasksDir = join(s01Dir, "tasks");

    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(
      join(m001Dir, "M001-CONTEXT.md"),
      "# M001: MinPoll E2E\n\n## Purpose\nTest min poll interval.\n",
    );

    writeFileSync(
      join(m001Dir, "M001-ROADMAP.md"),
      [
        "# M001: MinPoll E2E",
        "",
        "## Vision",
        "Validate minimum poll interval across tasks.",
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
    insertMilestone({ id: "M001", title: "MinPoll E2E", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test", status: "in_progress" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Test 1", status: "pending" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Test 2", status: "pending" });

    updateTaskStatus("M001", "S01", "T01", "awaiting-external");
    updateTaskStatus("M001", "S01", "T02", "awaiting-external");

    insertExternalWait("M001", "S01", "T01", "exit 0", { pollIntervalMs: 60000 });
    insertExternalWait("M001", "S01", "T02", "exit 0", { pollIntervalMs: 10000 });

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

    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "MinPoll E2E",
      state: {
        activeMilestone: { id: "M001", title: "MinPoll E2E" },
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
    };

    const result = await resolveDispatch(ctx);

    assert.equal(result.action, "sleep");
    if (result.action === "sleep") {
      assert.equal(result.durationMs, 10000, "sleep should use minimum pollInterval (10000) across all waiting tasks");
    }
  });
});
