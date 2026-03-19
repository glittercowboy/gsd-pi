/**
 * Pre-merge impact analysis tests.
 *
 * T01: Unit tests for diffContracts() pure function (9 tests)
 * T02: Integration tests for analyzePreMergeImpact() and emitAdaptationSignals() (7+ tests)
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/pre-merge-impact.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Contract } from "../team-contracts.js";

// ─── Mutable mock state ────────────────────────────────────────────────────

let mockWorkers: Array<{
  milestoneId: string;
  worktreePath: string;
  state: string;
  completedUnits: number;
  startedAt: number;
  title: string;
  pid: number;
  process: null;
  cost: number;
  stderrLines: string[];
}> = [];

let writeTeamSignalCalls: Array<{
  basePath: string;
  targetMid: string;
  signal: { type: string; source: string; workerMid: string; payload: Record<string, unknown>; timestamp: number };
}> = [];

// ─── Module-level mocks (before dynamic imports) ───────────────────────────

mock.module("../parallel-orchestrator.js", {
  namedExports: {
    getWorkerStatuses: () => mockWorkers,
  },
});

mock.module("../session-status-io.js", {
  namedExports: {
    writeTeamSignal: (basePath: string, targetMid: string, signal: unknown) => {
      writeTeamSignalCalls.push({
        basePath,
        targetMid,
        signal: signal as typeof writeTeamSignalCalls[0]["signal"],
      });
    },
  },
});

// ─── Dynamic imports (after mocks are in place) ────────────────────────────

const {
  diffContracts,
  analyzePreMergeImpact,
  emitAdaptationSignals,
} = await import("../pre-merge-impact.js");

const { formatContract } = await import("../team-contracts.js");

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal Contract for unit tests.
 * Defaults version=1, domain="test", body="" so tests focus on interfaces.
 */
function makeContract(
  interfaces: Array<{ name: string; type: string; signature: string }>,
): Contract {
  return {
    version: 1,
    domain: "test",
    interfaces,
    body: "",
  };
}

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `gsd-impact-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a CONTRACT.md file using formatContract for YAML fidelity.
 */
function writeContractToDisk(
  dirPath: string,
  interfaces: Array<{ name: string; type: string; signature: string }>,
  version = 1,
  domain = "test",
): void {
  mkdirSync(dirPath, { recursive: true });
  const contract: Contract = { version, domain, interfaces, body: "" };
  writeFileSync(join(dirPath, "CONTRACT.md"), formatContract(contract), "utf-8");
}

/**
 * Build a mock WorkerInfo-compatible object with required fields.
 */
function makeWorker(mid: string, worktreePath: string) {
  return {
    milestoneId: mid,
    worktreePath,
    state: "running" as const,
    completedUnits: 0,
    startedAt: Date.now(),
    title: `Worker ${mid}`,
    pid: 1000,
    process: null,
    cost: 0,
    stderrLines: [],
  };
}

// ─── T01: Unit tests — diffContracts() ─────────────────────────────────────

describe("diffContracts", () => {
  it("detects removed interface", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);
    const after = makeContract([]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].interfaceName, "getUser");
    assert.equal(breaks[0].changeType, "removed");
    assert.deepEqual(breaks[0].before, before.interfaces[0]);
    assert.equal(breaks[0].after, undefined);
  });

  it("detects signature change", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);
    const after = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: number): User" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].interfaceName, "getUser");
    assert.equal(breaks[0].changeType, "signature-changed");
    assert.deepEqual(breaks[0].before, before.interfaces[0]);
    assert.deepEqual(breaks[0].after, after.interfaces[0]);
  });

  it("detects type change when signature is identical", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);
    const after = makeContract([
      { name: "getUser", type: "endpoint", signature: "getUser(id: string): User" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].interfaceName, "getUser");
    assert.equal(breaks[0].changeType, "type-changed");
    assert.deepEqual(breaks[0].after, after.interfaces[0]);
  });

  it("does NOT flag added interfaces as breaking", () => {
    const before = makeContract([]);
    const after = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 0);
  });

  it("returns empty array for two empty contracts", () => {
    const before = makeContract([]);
    const after = makeContract([]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 0);
  });

  it("returns empty array when contracts are identical", () => {
    const ifaces = [
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
      { name: "listUsers", type: "function", signature: "listUsers(): User[]" },
    ];
    const before = makeContract(ifaces);
    const after = makeContract(ifaces);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 0);
  });

  it("detects multiple simultaneous breaks", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
      { name: "deleteUser", type: "function", signature: "deleteUser(id: string): void" },
    ]);
    const after = makeContract([
      // getUser removed (not present)
      // deleteUser signature changed
      { name: "deleteUser", type: "function", signature: "deleteUser(id: number): boolean" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 2);

    const removed = breaks.find((b) => b.changeType === "removed");
    assert.ok(removed, "should have a removed break");
    assert.equal(removed!.interfaceName, "getUser");

    const sigChanged = breaks.find((b) => b.changeType === "signature-changed");
    assert.ok(sigChanged, "should have a signature-changed break");
    assert.equal(sigChanged!.interfaceName, "deleteUser");
  });

  it("handles reordered interfaces without false positives", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
      { name: "listUsers", type: "function", signature: "listUsers(): User[]" },
    ]);
    const after = makeContract([
      // Same interfaces, reversed order
      { name: "listUsers", type: "function", signature: "listUsers(): User[]" },
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 0, "reordered interfaces should not produce breaks");
  });

  it("prioritizes signature-changed over type-changed when both differ", () => {
    const before = makeContract([
      { name: "getUser", type: "function", signature: "getUser(id: string): User" },
    ]);
    const after = makeContract([
      { name: "getUser", type: "endpoint", signature: "getUser(id: number): User" },
    ]);

    const breaks = diffContracts(before, after);
    assert.equal(breaks.length, 1, "should produce exactly one break, not two");
    assert.equal(breaks[0].changeType, "signature-changed",
      "signature change takes priority over type change to avoid double-counting");
  });
});

// ─── T02: Integration tests — analyzePreMergeImpact() ─────────────────────

describe("analyzePreMergeImpact", () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    mockWorkers = [];
    writeTeamSignalCalls = [];
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("returns empty analysis when no workers are running", () => {
    mockWorkers = [];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 0);
    assert.equal(result.affectedWorkers.length, 0);
    assert.equal(result.adaptationSignals.length, 0);
    assert.equal(result.mergingMid, "M001");
  });

  it("returns empty analysis when merging worker has no contract file", () => {
    const workerDir = makeTmpDir();
    tmpDirs.push(workerDir);

    // Worker exists but has no .gsd/CONTRACT.md
    mockWorkers = [makeWorker("M001", workerDir)];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 0);
    assert.equal(result.affectedWorkers.length, 0);
  });

  it("returns empty analysis when target worker has no consumed contract", () => {
    const mergingDir = makeTmpDir();
    const targetDir = makeTmpDir();
    tmpDirs.push(mergingDir, targetDir);

    // Merging worker has a contract
    writeContractToDisk(join(mergingDir, ".gsd"), [
      { name: "getUser", type: "function", signature: "getUser(id) => User" },
    ]);

    // Target worker has NO consumed copy (no .gsd/team-contracts/M001/ directory)
    mockWorkers = [
      makeWorker("M001", mergingDir),
      makeWorker("M002", targetDir),
    ];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 0);
    assert.equal(result.affectedWorkers.length, 0);
  });

  it("detects breaking change when merging worker removed an interface", () => {
    const mergingDir = makeTmpDir();
    const targetDir = makeTmpDir();
    tmpDirs.push(mergingDir, targetDir);

    // Merging worker's CURRENT contract: getUser is removed
    writeContractToDisk(join(mergingDir, ".gsd"), [], 2);

    // Target worker's CONSUMED copy still has getUser
    writeContractToDisk(
      join(targetDir, ".gsd", "team-contracts", "M001"),
      [{ name: "getUser", type: "function", signature: "getUser(id) => User" }],
      1,
    );

    mockWorkers = [
      makeWorker("M001", mergingDir),
      makeWorker("M002", targetDir),
    ];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 1);
    assert.equal(result.breakingChanges[0].interfaceName, "getUser");
    assert.equal(result.breakingChanges[0].changeType, "removed");
    assert.deepEqual(result.affectedWorkers, ["M002"]);
    assert.equal(result.adaptationSignals.length, 1);
    assert.equal(result.adaptationSignals[0].type, "contract-change");
    assert.equal(result.adaptationSignals[0].workerMid, "M002");
    assert.equal((result.adaptationSignals[0].payload as Record<string, unknown>).breaking, true);
  });

  it("returns empty breakingChanges when contracts are unchanged", () => {
    const mergingDir = makeTmpDir();
    const targetDir = makeTmpDir();
    tmpDirs.push(mergingDir, targetDir);

    const ifaces = [
      { name: "getUser", type: "function", signature: "getUser(id) => User" },
    ];

    // Both have the same contract content
    writeContractToDisk(join(mergingDir, ".gsd"), ifaces, 1);
    writeContractToDisk(join(targetDir, ".gsd", "team-contracts", "M001"), ifaces, 1);

    mockWorkers = [
      makeWorker("M001", mergingDir),
      makeWorker("M002", targetDir),
    ];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 0);
    assert.equal(result.affectedWorkers.length, 0);
    assert.equal(result.adaptationSignals.length, 0);
  });

  it("detects multiple affected workers with stale consumed contracts", () => {
    const mergingDir = makeTmpDir();
    const target1Dir = makeTmpDir();
    const target2Dir = makeTmpDir();
    tmpDirs.push(mergingDir, target1Dir, target2Dir);

    // Merging worker removed getUser
    writeContractToDisk(join(mergingDir, ".gsd"), [], 2);

    // Both target workers still have the old consumed copy
    const oldIfaces = [
      { name: "getUser", type: "function", signature: "getUser(id) => User" },
    ];
    writeContractToDisk(join(target1Dir, ".gsd", "team-contracts", "M001"), oldIfaces, 1);
    writeContractToDisk(join(target2Dir, ".gsd", "team-contracts", "M001"), oldIfaces, 1);

    mockWorkers = [
      makeWorker("M001", mergingDir),
      makeWorker("M002", target1Dir),
      makeWorker("M003", target2Dir),
    ];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.affectedWorkers.length, 2);
    assert.ok(result.affectedWorkers.includes("M002"));
    assert.ok(result.affectedWorkers.includes("M003"));
    assert.equal(result.adaptationSignals.length, 2);
    // Each signal targets a different worker
    const signalTargets = result.adaptationSignals.map(s => s.workerMid).sort();
    assert.deepEqual(signalTargets, ["M002", "M003"]);
  });

  it("returns empty analysis when merging worker MID not found in workers list", () => {
    const workerDir = makeTmpDir();
    tmpDirs.push(workerDir);

    // Workers exist but none match the merging MID
    mockWorkers = [makeWorker("M099", workerDir)];

    const result = analyzePreMergeImpact("/tmp/base", "M001");
    assert.equal(result.breakingChanges.length, 0);
    assert.equal(result.affectedWorkers.length, 0);
    assert.equal(result.mergingMid, "M001");
  });
});

// ─── T02: Integration tests — emitAdaptationSignals() ─────────────────────

describe("emitAdaptationSignals", () => {
  beforeEach(() => {
    writeTeamSignalCalls = [];
  });

  it("calls writeTeamSignal with correct payload for each affected worker", () => {
    const analysis = {
      breakingChanges: [
        {
          interfaceName: "getUser",
          changeType: "removed" as const,
          before: { name: "getUser", type: "function", signature: "getUser(id) => User" },
        },
      ],
      affectedWorkers: ["M002", "M003"],
      adaptationSignals: [
        {
          type: "contract-change" as const,
          source: "M001",
          workerMid: "M002",
          payload: {
            breaking: true,
            breakingChanges: [{ interfaceName: "getUser", changeType: "removed" }],
          },
          timestamp: 1000,
        },
        {
          type: "contract-change" as const,
          source: "M001",
          workerMid: "M003",
          payload: {
            breaking: true,
            breakingChanges: [{ interfaceName: "getUser", changeType: "removed" }],
          },
          timestamp: 1000,
        },
      ],
      mergingMid: "M001",
    };

    emitAdaptationSignals("/tmp/base", analysis);

    assert.equal(writeTeamSignalCalls.length, 2);

    // Verify first signal targets M002
    const call1 = writeTeamSignalCalls.find(c => c.targetMid === "M002");
    assert.ok(call1, "should have called writeTeamSignal for M002");
    assert.equal(call1!.basePath, "/tmp/base");
    assert.equal(call1!.signal.type, "contract-change");
    assert.equal(call1!.signal.source, "M001");
    assert.equal((call1!.signal.payload as Record<string, unknown>).breaking, true);

    // Verify second signal targets M003
    const call2 = writeTeamSignalCalls.find(c => c.targetMid === "M003");
    assert.ok(call2, "should have called writeTeamSignal for M003");
    assert.equal(call2!.basePath, "/tmp/base");
    assert.equal(call2!.signal.type, "contract-change");
  });

  it("does nothing when analysis has no adaptation signals", () => {
    const emptyAnalysis = {
      breakingChanges: [],
      affectedWorkers: [],
      adaptationSignals: [],
      mergingMid: "M001",
    };

    emitAdaptationSignals("/tmp/base", emptyAnalysis);
    assert.equal(writeTeamSignalCalls.length, 0);
  });
});
