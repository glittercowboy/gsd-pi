/**
 * Integration tests for team signal routing and dashboard domain labels.
 *
 * Validates:
 * - Point-to-point signal routing (Worker A → Worker B)
 * - Broadcast signal routing (Worker A → all others)
 * - Domain field persistence through persistState()/restoreState()
 * - domainShortLabel() helper function correctness
 * - Backward compatibility: workers without domain field render gracefully
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  writeTeamSignal,
  readTeamSignals,
  clearTeamSignals,
  type TeamSignal,
} from "../session-status-io.js";
import {
  routeTeamSignals,
  persistState,
  restoreState,
  startParallel,
  resetOrchestrator,
  getOrchestratorState,
  type WorkerInfo,
  type PersistedState,
} from "../parallel-orchestrator.js";
import { domainShortLabel } from "../dashboard-overlay.js";
import { pendingTeamSignals } from "../auto-post-unit.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Create a temp directory with .gsd/parallel/ structure. */
function makeTempBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-routing-test-"));
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  return base;
}

describe("routeTeamSignals — point-to-point", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTempBase();
    resetOrchestrator();
  });

  afterEach(() => {
    resetOrchestrator();
    try { rmSync(basePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("routes a signal from Worker A to Worker B", async () => {
    // Set up orchestrator with two workers via fake state file
    const fakeState: PersistedState = {
      active: true,
      workers: [
        {
          milestoneId: "M-A",
          title: "Worker A",
          pid: process.pid, // use own PID so it's "alive"
          worktreePath: "/tmp/fake-a",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
          stderrLines: [],
          restartCount: 0,
        },
        {
          milestoneId: "M-B",
          title: "Worker B",
          pid: process.pid,
          worktreePath: "/tmp/fake-b",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
          stderrLines: [],
          restartCount: 0,
        },
      ],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 4 },
    };

    // Write the state file and restore to activate the orchestrator
    const stateFile = join(basePath, ".gsd", "orchestrator.json");
    writeFileSync(stateFile, JSON.stringify(fakeState), "utf-8");

    // Start parallel to adopt the workers (startParallel reads the state file)
    await startParallel(basePath, [], undefined);
    const orchState = getOrchestratorState();
    assert.ok(orchState, "Orchestrator should be active");
    assert.ok(orchState.workers.has("M-A"), "Should have Worker A");
    assert.ok(orchState.workers.has("M-B"), "Should have Worker B");

    // Write a point-to-point signal from Worker A targeting Worker B
    writeTeamSignal(basePath, "M-A", {
      type: "context-share",
      source: "M-A",
      workerMid: "M-B",
      payload: { info: "shared context" },
      timestamp: Date.now(),
    });

    // Verify signal exists for M-A before routing
    const beforeRouting = readTeamSignals(basePath, "M-A");
    assert.equal(beforeRouting.length, 1, "M-A should have 1 signal before routing");

    // Route signals
    routeTeamSignals(basePath);

    // Verify signal arrived at M-B
    const bSignals = readTeamSignals(basePath, "M-B");
    assert.equal(bSignals.length, 1, "M-B should have 1 routed signal");
    assert.equal(bSignals[0].type, "context-share");
    assert.equal(bSignals[0].source, "M-A");
    assert.deepEqual(bSignals[0].payload, { info: "shared context" });

    // Verify M-A's signals were cleared
    const aSignals = readTeamSignals(basePath, "M-A");
    assert.equal(aSignals.length, 0, "M-A signals should be cleared after routing");
  });
});

describe("routeTeamSignals — broadcast", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTempBase();
    resetOrchestrator();
  });

  afterEach(() => {
    resetOrchestrator();
    try { rmSync(basePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("broadcasts a signal from Worker A to all other workers", async () => {
    const fakeState: PersistedState = {
      active: true,
      workers: [
        {
          milestoneId: "M-A", title: "A", pid: process.pid,
          worktreePath: "/tmp/a", startedAt: Date.now(), state: "running",
          completedUnits: 0, cost: 0, stderrLines: [], restartCount: 0,
        },
        {
          milestoneId: "M-B", title: "B", pid: process.pid,
          worktreePath: "/tmp/b", startedAt: Date.now(), state: "running",
          completedUnits: 0, cost: 0, stderrLines: [], restartCount: 0,
        },
        {
          milestoneId: "M-C", title: "C", pid: process.pid,
          worktreePath: "/tmp/c", startedAt: Date.now(), state: "running",
          completedUnits: 0, cost: 0, stderrLines: [], restartCount: 0,
        },
      ],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 4 },
    };

    writeFileSync(join(basePath, ".gsd", "orchestrator.json"), JSON.stringify(fakeState), "utf-8");
    await startParallel(basePath, [], undefined);

    // Write a broadcast signal from Worker A
    writeTeamSignal(basePath, "M-A", {
      type: "dependency-alert",
      source: "M-A",
      workerMid: "*",
      payload: { warning: "shared dependency changed" },
      timestamp: Date.now(),
    });

    routeTeamSignals(basePath);

    // Both B and C should receive the signal
    const bSignals = readTeamSignals(basePath, "M-B");
    const cSignals = readTeamSignals(basePath, "M-C");
    assert.equal(bSignals.length, 1, "M-B should receive broadcast");
    assert.equal(cSignals.length, 1, "M-C should receive broadcast");
    assert.equal(bSignals[0].type, "dependency-alert");
    assert.equal(cSignals[0].type, "dependency-alert");

    // A should NOT receive its own broadcast
    const aSignals = readTeamSignals(basePath, "M-A");
    assert.equal(aSignals.length, 0, "M-A should not receive its own broadcast (cleared after routing)");
  });

  it("does nothing when orchestrator is inactive", () => {
    resetOrchestrator();
    // Should not throw
    routeTeamSignals(basePath);
  });
});

describe("WorkerInfo.domain persistence", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTempBase();
    resetOrchestrator();
  });

  afterEach(() => {
    resetOrchestrator();
    try { rmSync(basePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("persists and restores domain field through state round-trip", async () => {
    // Create state with domain set
    const fakeState: PersistedState = {
      active: true,
      workers: [
        {
          milestoneId: "M-FE",
          title: "Frontend Worker",
          pid: process.pid,
          worktreePath: "/tmp/fe",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
          stderrLines: [],
          restartCount: 0,
          domain: "frontend",
        },
      ],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 4 },
    };

    writeFileSync(join(basePath, ".gsd", "orchestrator.json"), JSON.stringify(fakeState), "utf-8");

    // Restore and adopt the worker
    await startParallel(basePath, [], undefined);
    const orchState = getOrchestratorState();
    assert.ok(orchState);
    const worker = orchState.workers.get("M-FE");
    assert.ok(worker, "Worker should be adopted");
    assert.equal(worker.domain, "frontend", "Domain should survive restore");

    // Now persist and restore again to prove round-trip
    persistState(basePath);
    resetOrchestrator();

    const restored = restoreState(basePath);
    assert.ok(restored, "State should restore from persisted file");
    assert.equal(restored.workers.length, 1);
    assert.equal(restored.workers[0].domain, "frontend", "Domain persists through second round-trip");
  });

  it("handles workers without domain field (backward compat)", async () => {
    // Simulate an old-format state file without domain
    const oldState = {
      active: true,
      workers: [
        {
          milestoneId: "M-OLD",
          title: "Old Worker",
          pid: process.pid,
          worktreePath: "/tmp/old",
          startedAt: Date.now(),
          state: "running",
          completedUnits: 0,
          cost: 0,
          stderrLines: [],
          restartCount: 0,
          // No domain field
        },
      ],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 4 },
    };

    writeFileSync(join(basePath, ".gsd", "orchestrator.json"), JSON.stringify(oldState), "utf-8");
    await startParallel(basePath, [], undefined);
    const orchState = getOrchestratorState();
    assert.ok(orchState);
    const worker = orchState.workers.get("M-OLD");
    assert.ok(worker);
    assert.equal(worker.domain, undefined, "Old worker should have undefined domain");
  });
});

describe("domainShortLabel()", () => {
  it("maps known domains to short abbreviations", () => {
    assert.equal(domainShortLabel("frontend"), "FE");
    assert.equal(domainShortLabel("backend"), "BE");
    assert.equal(domainShortLabel("infra"), "INF");
    assert.equal(domainShortLabel("data"), "DAT");
    assert.equal(domainShortLabel("test"), "TST");
  });

  it("returns dash for unclassified domain", () => {
    assert.equal(domainShortLabel("unclassified"), "—");
  });

  it("returns dash for undefined domain", () => {
    assert.equal(domainShortLabel(undefined), "—");
  });

  it("returns dash for unknown domain strings", () => {
    assert.equal(domainShortLabel("something-else"), "—");
  });
});

describe("backward compatibility — routing with missing domain", () => {
  let basePath: string;

  beforeEach(() => {
    basePath = makeTempBase();
    resetOrchestrator();
  });

  afterEach(() => {
    resetOrchestrator();
    try { rmSync(basePath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("routing works for workers without domain field", async () => {
    const fakeState: PersistedState = {
      active: true,
      workers: [
        {
          milestoneId: "M-1", title: "W1", pid: process.pid,
          worktreePath: "/tmp/1", startedAt: Date.now(), state: "running",
          completedUnits: 0, cost: 0, stderrLines: [], restartCount: 0,
          // No domain field
        },
        {
          milestoneId: "M-2", title: "W2", pid: process.pid,
          worktreePath: "/tmp/2", startedAt: Date.now(), state: "running",
          completedUnits: 0, cost: 0, stderrLines: [], restartCount: 0,
          // No domain field
        },
      ],
      totalCost: 0,
      startedAt: Date.now(),
      configSnapshot: { max_workers: 4 },
    };

    writeFileSync(join(basePath, ".gsd", "orchestrator.json"), JSON.stringify(fakeState), "utf-8");
    await startParallel(basePath, [], undefined);

    // Write a signal and route — should not crash even without domain
    writeTeamSignal(basePath, "M-1", {
      type: "progress-update",
      source: "M-1",
      workerMid: "M-2",
      payload: { progress: 50 },
      timestamp: Date.now(),
    });

    // Should not throw
    routeTeamSignals(basePath);

    const signals = readTeamSignals(basePath, "M-2");
    assert.equal(signals.length, 1, "Signal should route even without domain");
  });

  it("domainShortLabel renders dash for workers without domain in dashboard", () => {
    // Simulates what the dashboard does: call domainShortLabel(worker.domain)
    // when worker.domain is undefined
    const mockWorker = { domain: undefined } as WorkerInfo;
    assert.equal(domainShortLabel(mockWorker.domain), "—");
  });
});

describe("pendingTeamSignals export", () => {
  it("is initialized as empty array", () => {
    assert.ok(Array.isArray(pendingTeamSignals));
    assert.equal(pendingTeamSignals.length, 0);
  });
});
