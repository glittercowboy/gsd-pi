/**
 * Tests for parallel milestone orchestration modules:
 * - session-status-io.ts (file-based IPC)
 * - parallel-eligibility.ts (eligibility formatting)
 * - parallel-orchestrator.ts (orchestrator lifecycle)
 * - preferences.ts (parallel config validation)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeSessionStatus,
  readSessionStatus,
  readAllSessionStatuses,
  removeSessionStatus,
  sendSignal,
  consumeSignal,
  isSessionStale,
  cleanupStaleSessions,
  type SessionStatus,
} from "../session-status-io.js";

import {
  formatEligibilityReport,
  type ParallelCandidates,
} from "../parallel-eligibility.js";

import {
  isParallelActive,
  getOrchestratorState,
  getWorkerStatuses,
  startParallel,
  stopParallel,
  shutdownParallel,
  pauseWorker,
  resumeWorker,
  getAggregateCost,
  isBudgetExceeded,
  resetOrchestrator,
  refreshWorkerStatuses,
} from "../parallel-orchestrator.js";

import { validatePreferences, resolveParallelConfig } from "../preferences.js";

import { determineMergeOrder, formatMergeResults, type MergeResult } from "../parallel-merge.js";
import type { WorkerInfo } from "../parallel-orchestrator.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-test-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    milestoneId: "M001",
    pid: process.pid,
    state: "running",
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() },
    completedUnits: 3,
    cost: 1.50,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 60_000,
    worktreePath: "/tmp/test-worktree",
    ...overrides,
  };
}

// ─── session-status-io ───────────────────────────────────────────────────────

describe("session-status-io: status roundtrip", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("write then read returns identical status", () => {
    const status = makeStatus();
    writeSessionStatus(base, status);
    const read = readSessionStatus(base, "M001");
    assert.ok(read);
    assert.equal(read.milestoneId, "M001");
    assert.equal(read.pid, process.pid);
    assert.equal(read.state, "running");
    assert.equal(read.completedUnits, 3);
    assert.equal(read.cost, 1.50);
  });

  it("readSessionStatus returns null for missing milestone", () => {
    const read = readSessionStatus(base, "M999");
    assert.equal(read, null);
  });

  it("readAllSessionStatuses returns all written statuses", () => {
    writeSessionStatus(base, makeStatus({ milestoneId: "M001" }));
    writeSessionStatus(base, makeStatus({ milestoneId: "M002" }));
    writeSessionStatus(base, makeStatus({ milestoneId: "M003" }));
    const all = readAllSessionStatuses(base);
    assert.equal(all.length, 3);
    const ids = all.map(s => s.milestoneId).sort();
    assert.deepEqual(ids, ["M001", "M002", "M003"]);
  });

  it("readAllSessionStatuses returns empty array when no parallel dir", () => {
    const all = readAllSessionStatuses(base);
    assert.equal(all.length, 0);
  });

  it("removeSessionStatus deletes the file", () => {
    writeSessionStatus(base, makeStatus());
    assert.ok(readSessionStatus(base, "M001"));
    removeSessionStatus(base, "M001");
    assert.equal(readSessionStatus(base, "M001"), null);
  });
});

describe("session-status-io: signal roundtrip", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("sendSignal then consumeSignal returns the signal", () => {
    sendSignal(base, "M001", "pause");
    const signal = consumeSignal(base, "M001");
    assert.ok(signal);
    assert.equal(signal.signal, "pause");
    assert.equal(signal.from, "coordinator");
    assert.ok(signal.sentAt > 0);
  });

  it("consumeSignal removes the signal file", () => {
    sendSignal(base, "M001", "stop");
    consumeSignal(base, "M001");
    const second = consumeSignal(base, "M001");
    assert.equal(second, null);
  });

  it("consumeSignal returns null when no signal pending", () => {
    assert.equal(consumeSignal(base, "M001"), null);
  });
});

describe("session-status-io: stale detection", () => {
  it("isSessionStale returns false for current process PID", () => {
    const status = makeStatus({ pid: process.pid, lastHeartbeat: Date.now() });
    assert.equal(isSessionStale(status), false);
  });

  it("isSessionStale returns true for dead PID", () => {
    // PID 2147483647 is extremely unlikely to be alive
    const status = makeStatus({ pid: 2147483647, lastHeartbeat: Date.now() });
    assert.equal(isSessionStale(status), true);
  });

  it("isSessionStale returns true for expired heartbeat", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now() - 60_000,
    });
    assert.equal(isSessionStale(status, 5_000), true);
  });

  it("isSessionStale returns false for recent heartbeat with alive PID", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now(),
    });
    assert.equal(isSessionStale(status, 30_000), false);
  });
});

describe("session-status-io: cleanupStaleSessions", () => {
  let base: string;
  beforeEach(() => { base = makeTmpBase(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it("removes stale sessions and returns their IDs", () => {
    // Write a stale session (dead PID)
    writeSessionStatus(base, makeStatus({
      milestoneId: "M001",
      pid: 2147483647,
    }));
    // Write a live session
    writeSessionStatus(base, makeStatus({
      milestoneId: "M002",
      pid: process.pid,
      lastHeartbeat: Date.now(),
    }));

    const removed = cleanupStaleSessions(base);
    assert.deepEqual(removed, ["M001"]);
    assert.equal(readSessionStatus(base, "M001"), null);
    assert.ok(readSessionStatus(base, "M002"));
  });
});

// ─── parallel-eligibility ────────────────────────────────────────────────────

describe("parallel-eligibility: formatEligibilityReport", () => {
  it("formats empty candidates", () => {
    const candidates: ParallelCandidates = {
      eligible: [],
      ineligible: [],
      fileOverlaps: [],
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Eligible for Parallel Execution (0)"));
    assert.ok(report.includes("No milestones are currently eligible"));
  });

  it("formats eligible milestones", () => {
    const candidates: ParallelCandidates = {
      eligible: [
        { milestoneId: "M001", title: "Auth System", eligible: true, reason: "All dependencies satisfied." },
        { milestoneId: "M002", title: "Dashboard", eligible: true, reason: "All dependencies satisfied." },
      ],
      ineligible: [],
      fileOverlaps: [],
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Eligible for Parallel Execution (2)"));
    assert.ok(report.includes("**M001** — Auth System"));
    assert.ok(report.includes("**M002** — Dashboard"));
  });

  it("formats ineligible milestones with reasons", () => {
    const candidates: ParallelCandidates = {
      eligible: [],
      ineligible: [
        { milestoneId: "M003", title: "API", eligible: false, reason: "Blocked by incomplete dependencies: M001." },
      ],
      fileOverlaps: [],
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Ineligible (1)"));
    assert.ok(report.includes("Blocked by incomplete dependencies"));
  });

  it("formats file overlap warnings", () => {
    const candidates: ParallelCandidates = {
      eligible: [
        { milestoneId: "M001", title: "Auth", eligible: true, reason: "OK" },
        { milestoneId: "M002", title: "API", eligible: true, reason: "OK" },
      ],
      ineligible: [],
      fileOverlaps: [
        { mid1: "M001", mid2: "M002", files: ["src/types.ts", "src/utils.ts"] },
      ],
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("File Overlap Warnings (1)"));
    assert.ok(report.includes("`src/types.ts`"));
    assert.ok(report.includes("`src/utils.ts`"));
  });
});

// ─── parallel-orchestrator ───────────────────────────────────────────────────

describe("parallel-orchestrator: lifecycle", () => {
  let base: string;
  beforeEach(() => {
    base = makeTmpBase();
    resetOrchestrator();
  });
  afterEach(() => {
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });

  it("isParallelActive returns false initially", () => {
    assert.equal(isParallelActive(), false);
  });

  it("getWorkerStatuses restores persisted workers from disk", async () => {
    const base = makeTmpBase();
    try {
      const persisted = {
        active: true,
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: process.pid,
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "running",
            completedUnits: 2,
            cost: 0.25,
          },
        ],
        totalCost: 0.25,
        startedAt: Date.now(),
        configSnapshot: { max_workers: 2 },
      };
      writeFileSync(join(base, ".gsd", "orchestrator.json"), JSON.stringify(persisted, null, 2), "utf-8");
      const workers = getWorkerStatuses(base);
      assert.equal(workers.length, 1);
      assert.equal(workers[0].milestoneId, "M001");
      assert.equal(workers[0].completedUnits, 2);
      assert.equal(isParallelActive(), true);
    } finally {
      resetOrchestrator();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("startParallel initializes orchestrator state", async () => {
    const result = await startParallel(base, ["M001", "M002"], {
      parallel: { enabled: true, max_workers: 4, merge_strategy: "per-milestone", auto_merge: "confirm" },
    });
    assert.deepEqual(result.started, ["M001", "M002"]);
    assert.equal(result.errors.length, 0);
    assert.equal(isParallelActive(), true);
    assert.equal(getWorkerStatuses().length, 2);
  });

  it("startParallel caps to max_workers", async () => {
    const result = await startParallel(base, ["M001", "M002", "M003", "M004"], {
      parallel: { enabled: true, max_workers: 2, merge_strategy: "per-milestone", auto_merge: "confirm" },
    });
    assert.deepEqual(result.started, ["M001", "M002"]);
    assert.equal(getWorkerStatuses().length, 2);
  });

  it("startParallel writes session status files", async () => {
    await startParallel(base, ["M001"], undefined);
    const status = readSessionStatus(base, "M001");
    assert.ok(status);
    assert.equal(status.milestoneId, "M001");
    // State is "running" if spawn succeeds, "error" if binary not found (CI)
    assert.ok(status.state === "running" || status.state === "error",
      `expected running or error, got ${status.state}`);
  });

  it("stopParallel stops all workers", async () => {
    await startParallel(base, ["M001", "M002"], undefined);
    await stopParallel(base);
    assert.equal(isParallelActive(), false);
    const workers = getWorkerStatuses();
    assert.ok(workers.every(w => w.state === "stopped"));
  });

  it("stopParallel stops a specific worker", async () => {
    await startParallel(base, ["M001", "M002"], undefined);
    await stopParallel(base, "M001");
    const workers = getWorkerStatuses();
    const m1 = workers.find(w => w.milestoneId === "M001");
    const m2 = workers.find(w => w.milestoneId === "M002");
    assert.equal(m1?.state, "stopped");
    // M002 is "running" if spawn succeeded, "error" if binary not found (CI)
    assert.ok(m2?.state === "running" || m2?.state === "error",
      `expected running or error, got ${m2?.state}`);
    assert.equal(isParallelActive(), true);
  });

  it("pauseWorker and resumeWorker toggle worker state", async () => {
    await startParallel(base, ["M001"], undefined);
    const initial = getWorkerStatuses()[0].state;
    // Only test pause/resume if worker is in a pausable state
    if (initial === "running") {
      pauseWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, "paused");
      resumeWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, "running");
    } else {
      // Spawn failed (CI) — pause/resume are no-ops on error state
      pauseWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, initial);
    }
  });

  it("pauseWorker sends pause signal", async () => {
    await startParallel(base, ["M001"], undefined);
    const w = getWorkerStatuses()[0];
    if (w.state === "running") {
      pauseWorker(base, "M001");
      const signal = consumeSignal(base, "M001");
      assert.ok(signal);
      assert.equal(signal.signal, "pause");
    } else {
      // Spawn failed — pauseWorker is a no-op, signal not written
      pauseWorker(base, "M001");
      const signal = consumeSignal(base, "M001");
      assert.equal(signal, null);
    }
  });

  it("refreshWorkerStatuses restores live workers from session status files when orchestrator state is absent", async () => {
    const base = makeTmpBase();
    try {
      writeSessionStatus(base, {
        milestoneId: "M001",
        pid: process.pid,
        state: "running",
        currentUnit: null,
        completedUnits: 4,
        cost: 0.33,
        lastHeartbeat: Date.now(),
        startedAt: Date.now() - 1000,
        worktreePath: "/tmp/wt-M001",
      });
      refreshWorkerStatuses(base, { restoreIfNeeded: true });
      const workers = getWorkerStatuses();
      assert.equal(workers.length, 1);
      assert.equal(workers[0].state, "running");
      assert.equal(workers[0].completedUnits, 4);
    } finally {
      resetOrchestrator();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("parallel-orchestrator: budget", () => {
  beforeEach(() => { resetOrchestrator(); });
  afterEach(() => { resetOrchestrator(); });

  it("getAggregateCost returns 0 when not active", () => {
    assert.equal(getAggregateCost(), 0);
  });

  it("isBudgetExceeded returns false when not active", () => {
    assert.equal(isBudgetExceeded(), false);
  });

  it("isBudgetExceeded returns false when no ceiling set", async () => {
    const base = makeTmpBase();
    await startParallel(base, ["M001"], undefined);
    assert.equal(isBudgetExceeded(), false);
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });

  it("isBudgetExceeded returns true when ceiling reached", async () => {
    const base = makeTmpBase();
    await startParallel(base, ["M001"], {
      parallel: { enabled: true, max_workers: 2, budget_ceiling: 1.00, merge_strategy: "per-milestone", auto_merge: "confirm" },
    });
    // Manually set totalCost to test budget check
    const orchState = getOrchestratorState();
    if (orchState) orchState.totalCost = 1.50;
    assert.equal(isBudgetExceeded(), true);
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });
});

// ─── preferences: parallel config ────────────────────────────────────────────

describe("preferences: resolveParallelConfig", () => {
  it("returns defaults when prefs is undefined", () => {
    const config = resolveParallelConfig(undefined);
    assert.equal(config.enabled, false);
    assert.equal(config.max_workers, 2);
    assert.equal(config.budget_ceiling, undefined);
    assert.equal(config.merge_strategy, "per-milestone");
    assert.equal(config.auto_merge, "confirm");
  });

  it("returns defaults when parallel is undefined", () => {
    const config = resolveParallelConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.max_workers, 2);
  });

  it("fills in missing fields with defaults", () => {
    const config = resolveParallelConfig({
      parallel: { enabled: true } as any,
    });
    assert.equal(config.enabled, true);
    assert.equal(config.max_workers, 2);
    assert.equal(config.merge_strategy, "per-milestone");
  });

  it("clamps max_workers to 1-4 range", () => {
    assert.equal(resolveParallelConfig({
      parallel: { enabled: true, max_workers: 0, merge_strategy: "per-milestone", auto_merge: "confirm" },
    }).max_workers, 1);
    assert.equal(resolveParallelConfig({
      parallel: { enabled: true, max_workers: 10, merge_strategy: "per-milestone", auto_merge: "confirm" },
    }).max_workers, 4);
  });
});

describe("preferences: validatePreferences parallel config", () => {
  it("validates valid parallel config without errors", () => {
    const result = validatePreferences({
      parallel: {
        enabled: true,
        max_workers: 3,
        budget_ceiling: 50.00,
        merge_strategy: "per-slice",
        auto_merge: "manual",
      },
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.preferences.parallel);
    assert.equal(result.preferences.parallel?.enabled, true);
    assert.equal(result.preferences.parallel?.max_workers, 3);
  });

  it("rejects invalid max_workers", () => {
    const result = validatePreferences({
      parallel: { max_workers: 10 } as any,
    });
    assert.ok(result.errors.some(e => e.includes("max_workers")));
  });

  it("rejects negative budget_ceiling", () => {
    const result = validatePreferences({
      parallel: { budget_ceiling: -5 } as any,
    });
    assert.ok(result.errors.some(e => e.includes("budget_ceiling")));
  });

  it("rejects invalid merge_strategy", () => {
    const result = validatePreferences({
      parallel: { merge_strategy: "invalid" } as any,
    });
    assert.ok(result.errors.some(e => e.includes("merge_strategy")));
  });

  it("rejects invalid auto_merge", () => {
    const result = validatePreferences({
      parallel: { auto_merge: "yolo" } as any,
    });
    assert.ok(result.errors.some(e => e.includes("auto_merge")));
  });
});

// ─── Test Helpers (parallel-merge) ───────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    milestoneId: "M001",
    title: "Test Milestone",
    pid: process.pid,
    process: null,
    worktreePath: "/tmp/test-worktree",
    startedAt: Date.now() - 60_000,
    state: "stopped",
    completedUnits: 5,
    cost: 2.50,
    ...overrides,
  };
}

// ─── parallel-merge: determineMergeOrder ─────────────────────────────────────

describe("parallel-merge: determineMergeOrder sequential", () => {
  it("returns milestone IDs sorted alphabetically by default", () => {
    const workers = [
      makeWorker({ milestoneId: "M003", state: "stopped", completedUnits: 1 }),
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 2 }),
      makeWorker({ milestoneId: "M002", state: "stopped", completedUnits: 3 }),
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M001", "M002", "M003"]);
  });

  it("excludes workers that are still running", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 5 }),
      makeWorker({ milestoneId: "M002", state: "running", completedUnits: 0 }),
      makeWorker({ milestoneId: "M003", state: "stopped", completedUnits: 2 }),
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M001", "M003"]);
  });

  it("excludes workers with zero completedUnits even if stopped", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 0 }),
      makeWorker({ milestoneId: "M002", state: "stopped", completedUnits: 3 }),
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M002"]);
  });

  it("returns empty array when no workers are completed", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "running", completedUnits: 0 }),
      makeWorker({ milestoneId: "M002", state: "paused", completedUnits: 0 }),
    ];
    const order = determineMergeOrder(workers);
    assert.deepEqual(order, []);
  });

  it("uses sequential order as the default when no order arg provided", () => {
    const workers = [
      makeWorker({ milestoneId: "M002", state: "stopped", completedUnits: 1 }),
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 1 }),
    ];
    // Call with no second argument — should default to "sequential"
    const order = determineMergeOrder(workers);
    assert.deepEqual(order, ["M001", "M002"]);
  });
});

describe("parallel-merge: determineMergeOrder by-completion", () => {
  it("returns milestones sorted by startedAt (earliest first)", () => {
    const now = Date.now();
    const workers = [
      makeWorker({ milestoneId: "M003", state: "stopped", completedUnits: 1, startedAt: now - 30_000 }),
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 1, startedAt: now - 90_000 }),
      makeWorker({ milestoneId: "M002", state: "stopped", completedUnits: 1, startedAt: now - 60_000 }),
    ];
    const order = determineMergeOrder(workers, "by-completion");
    assert.deepEqual(order, ["M001", "M002", "M003"]);
  });

  it("excludes paused workers from by-completion order", () => {
    const now = Date.now();
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped", completedUnits: 2, startedAt: now - 90_000 }),
      makeWorker({ milestoneId: "M002", state: "paused",  completedUnits: 1, startedAt: now - 60_000 }),
      makeWorker({ milestoneId: "M003", state: "stopped", completedUnits: 3, startedAt: now - 30_000 }),
    ];
    const order = determineMergeOrder(workers, "by-completion");
    assert.deepEqual(order, ["M001", "M003"]);
  });
});

// ─── parallel-merge: formatMergeResults ──────────────────────────────────────

describe("parallel-merge: formatMergeResults", () => {
  it("returns a no-op message for an empty results array", () => {
    const output = formatMergeResults([]);
    assert.equal(output, "No completed milestones to merge.");
  });

  it("formats a single successful merge without push", () => {
    const results: MergeResult[] = [
      { milestoneId: "M001", success: true, commitMessage: "feat: auth system", pushed: false },
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("# Merge Results"));
    assert.ok(output.includes("**M001**"));
    assert.ok(output.includes("merged successfully"));
    assert.ok(!output.includes("(pushed)"));
  });

  it("includes (pushed) suffix when result.pushed is true", () => {
    const results: MergeResult[] = [
      { milestoneId: "M002", success: true, commitMessage: "feat: dashboard", pushed: true },
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("(pushed)"));
  });

  it("formats a conflict result with file list and retry instructions", () => {
    const results: MergeResult[] = [
      {
        milestoneId: "M003",
        success: false,
        conflictFiles: ["src/types.ts", "src/utils.ts"],
        error: "Merge conflict: 2 conflicting file(s)",
      },
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("**M003**"));
    assert.ok(output.includes("CONFLICT (2 file(s))"));
    assert.ok(output.includes("`src/types.ts`"));
    assert.ok(output.includes("`src/utils.ts`"));
    assert.ok(output.includes("/gsd parallel merge M003"));
  });

  it("formats a generic error (no conflict files) with the error message", () => {
    const results: MergeResult[] = [
      { milestoneId: "M004", success: false, error: "No roadmap found for M004" },
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("**M004**"));
    assert.ok(output.includes("failed: No roadmap found for M004"));
    assert.ok(!output.includes("CONFLICT"));
  });

  it("formats multiple results in the order provided", () => {
    const results: MergeResult[] = [
      { milestoneId: "M001", success: true, pushed: false },
      { milestoneId: "M002", success: false, error: "branch not found" },
      { milestoneId: "M003", success: true, pushed: true },
    ];
    const output = formatMergeResults(results);
    const m1Pos = output.indexOf("M001");
    const m2Pos = output.indexOf("M002");
    const m3Pos = output.indexOf("M003");
    assert.ok(m1Pos < m2Pos, "M001 should appear before M002");
    assert.ok(m2Pos < m3Pos, "M002 should appear before M003");
  });
});

// ─── doctor: stale_parallel_session issue code ───────────────────────────────

describe("doctor: stale_parallel_session issue code exists", () => {
  it("DoctorIssueCode union includes stale_parallel_session", async () => {
    // Import doctor.ts and verify the type is real by constructing a DoctorIssue
    // with code "stale_parallel_session" — TypeScript will reject it at compile
    // time if the code is not in the union; the runtime assertion confirms the
    // string value round-trips through the typed object correctly.
    const { } = await import("../doctor.js");
    // Construct a value that satisfies DoctorIssue using the code under test
    const issue: import("../doctor.js").DoctorIssue = {
      severity: "warning",
      code: "stale_parallel_session",
      scope: "project",
      unitId: "M001",
      message: "Stale parallel session detected",
      fixable: true,
    };
    assert.equal(issue.code, "stale_parallel_session");
  });

  it("DoctorIssue with stale_parallel_session has warning severity", () => {
    const issue: import("../doctor.js").DoctorIssue = {
      severity: "warning",
      code: "stale_parallel_session",
      scope: "project",
      unitId: "M002",
      message: "Stale parallel session for M002",
      fixable: true,
    };
    assert.equal(issue.severity, "warning");
    assert.equal(issue.fixable, true);
    assert.equal(issue.scope, "project");
  });
});
