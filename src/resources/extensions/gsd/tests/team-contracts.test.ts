/**
 * Contract tests for team-contracts.ts — contract parsing, formatting,
 * round-trip fidelity, sync logic, version gating, and signal emission.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/team-contracts.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mutable state for mocks ───────────────────────────────────────────────

let mockWorkers: Array<{
  milestoneId: string;
  worktreePath: string;
  state: string;
}> = [];

let writeTeamSignalCalls: Array<{
  basePath: string;
  targetMid: string;
  signal: { type: string; source: string; workerMid: string; payload: Record<string, unknown> };
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
      writeTeamSignalCalls.push({ basePath, targetMid, signal: signal as typeof writeTeamSignalCalls[0]["signal"] });
    },
  },
});

// ─── Dynamic imports (after mocks) ─────────────────────────────────────────

const {
  parseContract,
  formatContract,
  syncContracts,
  getConsumedVersion,
  setConsumedVersion,
  buildCrossContextSection,
} = await import("../team-contracts.js");

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gsd-contract-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeContractToWorker(worktreePath: string, content: string): void {
  const gsdDir = join(worktreePath, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "CONTRACT.md"), content, "utf-8");
}

// ─── Parsing Tests ─────────────────────────────────────────────────────────

describe("parseContract", () => {
  it("parses well-formed contract with all fields", () => {
    const content = `---
version: 3
domain: auth
interfaces:
  - name: validateToken
    type: function
    signature: (token: string) => boolean
  - name: UserSession
    type: interface
    signature: "{ userId: string; expiresAt: number }"
---

# Auth Contract

This worker owns authentication.
`;
    const c = parseContract(content);
    assert.equal(c.version, 3);
    assert.equal(c.domain, "auth");
    assert.equal(c.interfaces.length, 2);
    assert.equal(c.interfaces[0].name, "validateToken");
    assert.equal(c.interfaces[0].type, "function");
    assert.equal(c.interfaces[0].signature, "(token: string) => boolean");
    assert.equal(c.interfaces[1].name, "UserSession");
    assert.equal(c.interfaces[1].type, "interface");
    assert.equal(c.interfaces[1].signature, "{ userId: string; expiresAt: number }");
    assert.ok(c.body.includes("# Auth Contract"));
    assert.ok(c.body.includes("This worker owns authentication."));
  });

  it("returns defaults for missing frontmatter", () => {
    const c = parseContract("# Just a body\n\nNo frontmatter here.");
    assert.equal(c.version, 0);
    assert.equal(c.domain, "unclassified");
    assert.deepEqual(c.interfaces, []);
    assert.equal(c.body, "# Just a body\n\nNo frontmatter here.");
  });

  it("returns defaults for empty content", () => {
    const c = parseContract("");
    assert.equal(c.version, 0);
    assert.equal(c.domain, "unclassified");
    assert.deepEqual(c.interfaces, []);
  });

  it("handles missing version field", () => {
    const content = `---
domain: data
interfaces: []
---

Body.
`;
    const c = parseContract(content);
    assert.equal(c.version, 0);
    assert.equal(c.domain, "data");
    assert.deepEqual(c.interfaces, []);
  });

  it("handles missing domain field", () => {
    const content = `---
version: 5
interfaces: []
---

Body.
`;
    const c = parseContract(content);
    assert.equal(c.version, 5);
    assert.equal(c.domain, "unclassified");
  });

  it("handles empty interfaces array", () => {
    const content = `---
version: 1
domain: core
interfaces: []
---

Body.
`;
    const c = parseContract(content);
    assert.deepEqual(c.interfaces, []);
  });

  it("handles malformed interfaces gracefully (non-object items ignored)", () => {
    const content = `---
version: 1
domain: core
interfaces:
  - just a string
  - name: valid
    type: function
    signature: () => void
---

Body.
`;
    const c = parseContract(content);
    // "just a string" is a plain string, not an object with .name — filtered out
    assert.equal(c.interfaces.length, 1);
    assert.equal(c.interfaces[0].name, "valid");
  });
});

// ─── Formatting Tests ──────────────────────────────────────────────────────

describe("formatContract", () => {
  it("formats a full contract with interfaces", () => {
    const formatted = formatContract({
      version: 2,
      domain: "api",
      interfaces: [
        { name: "getUser", type: "function", signature: "(id: string) => User" },
      ],
      body: "# API Contract\n",
    });
    assert.ok(formatted.startsWith("---\n"));
    assert.ok(formatted.includes("version: 2"));
    assert.ok(formatted.includes("domain: api"));
    assert.ok(formatted.includes("  - name: getUser"));
    assert.ok(formatted.includes("# API Contract"));
  });

  it("formats empty interfaces as []", () => {
    const formatted = formatContract({
      version: 1,
      domain: "core",
      interfaces: [],
      body: "",
    });
    assert.ok(formatted.includes("interfaces: []"));
  });

  it("quotes signatures with special characters", () => {
    const formatted = formatContract({
      version: 1,
      domain: "core",
      interfaces: [
        { name: "fn", type: "function", signature: "{ a: string }" },
      ],
      body: "",
    });
    // Should be quoted since it contains { and }
    assert.ok(formatted.includes('signature: "'));
  });

  it("does not quote simple signatures", () => {
    const formatted = formatContract({
      version: 1,
      domain: "core",
      interfaces: [
        { name: "fn", type: "function", signature: "() => void" },
      ],
      body: "",
    });
    assert.ok(formatted.includes("    signature: () => void"));
  });
});

// ─── Round-Trip Tests ──────────────────────────────────────────────────────

describe("parseContract + formatContract round-trip", () => {
  const testCases = [
    {
      name: "full contract",
      contract: {
        version: 3,
        domain: "auth",
        interfaces: [
          { name: "validateToken", type: "function", signature: "(token: string) => boolean" },
          { name: "UserSession", type: "interface", signature: "{ userId: string; expiresAt: number }" },
        ],
        body: "# Auth Contract\n\nThis worker owns authentication.\n",
      },
    },
    {
      name: "minimal contract",
      contract: {
        version: 1,
        domain: "core",
        interfaces: [],
        body: "",
      },
    },
    {
      name: "no interfaces, large body",
      contract: {
        version: 10,
        domain: "data-pipeline",
        interfaces: [],
        body: "# Data Pipeline\n\n" + "Line of context.\n".repeat(50),
      },
    },
    {
      name: "many interfaces",
      contract: {
        version: 7,
        domain: "api",
        interfaces: [
          { name: "getUser", type: "function", signature: "(id: string) => User" },
          { name: "createUser", type: "function", signature: "(data: CreateUserInput) => User" },
          { name: "deleteUser", type: "function", signature: "(id: string) => void" },
        ],
        body: "# API Contract\n",
      },
    },
  ];

  for (const { name, contract } of testCases) {
    it(`round-trips ${name}`, () => {
      const formatted = formatContract(contract);
      const parsed = parseContract(formatted);

      assert.equal(parsed.version, contract.version, `version mismatch for ${name}`);
      assert.equal(parsed.domain, contract.domain, `domain mismatch for ${name}`);
      assert.equal(parsed.interfaces.length, contract.interfaces.length, `interfaces count mismatch for ${name}`);
      assert.equal(parsed.body, contract.body, `body mismatch for ${name}`);

      for (let i = 0; i < contract.interfaces.length; i++) {
        assert.equal(parsed.interfaces[i].name, contract.interfaces[i].name);
        assert.equal(parsed.interfaces[i].type, contract.interfaces[i].type);
        assert.equal(parsed.interfaces[i].signature, contract.interfaces[i].signature);
      }
    });
  }
});

// ─── Consumed Version Tests ────────────────────────────────────────────────

describe("consumed version tracking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });

  it("returns 0 when no consumed-versions.json exists", () => {
    assert.equal(getConsumedVersion(tmpDir, "M001"), 0);
  });

  it("writes and reads back consumed version", () => {
    setConsumedVersion(tmpDir, "M001", 5);
    assert.equal(getConsumedVersion(tmpDir, "M001"), 5);
  });

  it("overwrites existing version", () => {
    setConsumedVersion(tmpDir, "M001", 3);
    setConsumedVersion(tmpDir, "M001", 7);
    assert.equal(getConsumedVersion(tmpDir, "M001"), 7);
  });

  it("tracks multiple source milestones independently", () => {
    setConsumedVersion(tmpDir, "M001", 3);
    setConsumedVersion(tmpDir, "M002", 5);
    assert.equal(getConsumedVersion(tmpDir, "M001"), 3);
    assert.equal(getConsumedVersion(tmpDir, "M002"), 5);
  });
});

// ─── Sync Tests ────────────────────────────────────────────────────────────

describe("syncContracts", () => {
  let tmpBase: string;
  let workerAPath: string;
  let workerBPath: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    workerAPath = join(tmpBase, "worktree-A");
    workerBPath = join(tmpBase, "worktree-B");
    mkdirSync(workerAPath, { recursive: true });
    mkdirSync(workerBPath, { recursive: true });

    mockWorkers = [
      { milestoneId: "M001-aaa", worktreePath: workerAPath, state: "running" },
      { milestoneId: "M002-bbb", worktreePath: workerBPath, state: "running" },
    ];
    writeTeamSignalCalls = [];
  });

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true }); } catch { /* cleanup */ }
    mockWorkers = [];
    writeTeamSignalCalls = [];
  });

  it("copies contract from worker A to worker B's team-contracts dir", () => {
    const contractContent = formatContract({
      version: 1,
      domain: "auth",
      interfaces: [{ name: "login", type: "function", signature: "(cred: Cred) => Token" }],
      body: "# Auth\n",
    });
    writeContractToWorker(workerAPath, contractContent);

    syncContracts(tmpBase);

    const copiedPath = join(workerBPath, ".gsd", "team-contracts", "M001-aaa", "CONTRACT.md");
    assert.ok(existsSync(copiedPath), "Contract should be copied to worker B");

    const copiedContent = readFileSync(copiedPath, "utf-8");
    const parsed = parseContract(copiedContent);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.domain, "auth");
    assert.equal(parsed.interfaces[0].name, "login");
  });

  it("updates consumed-versions.json in target worktree", () => {
    writeContractToWorker(workerAPath, formatContract({
      version: 2, domain: "data", interfaces: [], body: "",
    }));

    syncContracts(tmpBase);

    const consumed = getConsumedVersion(workerBPath, "M001-aaa");
    assert.equal(consumed, 2);
  });

  it("emits contract-change team signal on update", () => {
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "api", interfaces: [
        { name: "getUser", type: "function", signature: "() => User" },
      ], body: "",
    }));

    syncContracts(tmpBase);

    assert.equal(writeTeamSignalCalls.length, 1, "Should emit exactly one signal");
    const call = writeTeamSignalCalls[0];
    assert.equal(call.targetMid, "M002-bbb");
    assert.equal(call.signal.type, "contract-change");
    assert.equal(call.signal.source, "M001-aaa");
    assert.equal(call.signal.payload.domain, "api");
    assert.equal(call.signal.payload.version, 1);
    assert.equal(call.signal.payload.interfaceCount, 1);
  });

  it("skips sync when version has not changed", () => {
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "auth", interfaces: [], body: "",
    }));

    // First sync — should copy
    syncContracts(tmpBase);
    assert.equal(writeTeamSignalCalls.length, 1);

    // Second sync — same version, should skip
    writeTeamSignalCalls = [];
    syncContracts(tmpBase);
    assert.equal(writeTeamSignalCalls.length, 0, "Should not emit signal when version unchanged");
  });

  it("syncs again when source version is bumped", () => {
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "auth", interfaces: [], body: "",
    }));

    syncContracts(tmpBase);
    assert.equal(writeTeamSignalCalls.length, 1);

    // Bump version
    writeContractToWorker(workerAPath, formatContract({
      version: 2, domain: "auth", interfaces: [
        { name: "newFn", type: "function", signature: "() => void" },
      ], body: "Updated.\n",
    }));

    writeTeamSignalCalls = [];
    syncContracts(tmpBase);
    assert.equal(writeTeamSignalCalls.length, 1);
    assert.equal(writeTeamSignalCalls[0].signal.payload.version, 2);
  });

  it("syncs bidirectionally when both workers have contracts", () => {
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "auth", interfaces: [], body: "",
    }));
    writeContractToWorker(workerBPath, formatContract({
      version: 1, domain: "data", interfaces: [], body: "",
    }));

    syncContracts(tmpBase);

    // Worker A should get B's contract, worker B should get A's
    assert.ok(existsSync(join(workerBPath, ".gsd", "team-contracts", "M001-aaa", "CONTRACT.md")));
    assert.ok(existsSync(join(workerAPath, ".gsd", "team-contracts", "M002-bbb", "CONTRACT.md")));
    assert.equal(writeTeamSignalCalls.length, 2, "Should emit two signals (one per direction)");
  });

  it("does nothing when fewer than 2 workers exist", () => {
    mockWorkers = [
      { milestoneId: "M001-aaa", worktreePath: workerAPath, state: "running" },
    ];
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "auth", interfaces: [], body: "",
    }));

    syncContracts(tmpBase);
    assert.equal(writeTeamSignalCalls.length, 0);
  });

  it("skips workers without CONTRACT.md files", () => {
    // Only worker A has a contract, worker B does not
    writeContractToWorker(workerAPath, formatContract({
      version: 1, domain: "auth", interfaces: [], body: "",
    }));
    // No contract for worker B

    syncContracts(tmpBase);

    // A's contract copied to B
    assert.ok(existsSync(join(workerBPath, ".gsd", "team-contracts", "M001-aaa", "CONTRACT.md")));
    assert.equal(writeTeamSignalCalls.length, 1);
    // No copy from B to A (B has no contract)
    assert.ok(!existsSync(join(workerAPath, ".gsd", "team-contracts", "M002-bbb", "CONTRACT.md")));
  });
});

// ─── Cross-Context Prompt Injection Tests ──────────────────────────────────

/** Write a synced contract into a worker's team-contracts directory (as if syncContracts ran). */
function writeSyncedContract(worktreePath: string, sourceMid: string, content: string): void {
  const dir = join(worktreePath, ".gsd", "team-contracts", sourceMid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CONTRACT.md"), content, "utf-8");
}

describe("buildCrossContextSection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });

  it("returns empty string when no contract files and no signals", () => {
    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, []);
    assert.equal(result, "");
  });

  it("returns empty string when team-contracts directory does not exist", () => {
    // tmpDir has no .gsd/team-contracts/ at all
    const result = buildCrossContextSection(tmpDir, "M001-self", 10000);
    assert.equal(result, "");
  });

  it("includes contract domain and interfaces in output", () => {
    const contract = formatContract({
      version: 2,
      domain: "auth",
      interfaces: [
        { name: "validateToken", type: "function", signature: "(token: string) => boolean" },
        { name: "UserSession", type: "interface", signature: "{ userId: string }" },
      ],
      body: "# Auth Contract\n",
    });
    writeSyncedContract(tmpDir, "M002-other", contract);

    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, []);
    assert.ok(result.includes("M002-other"), "Should include source worker's milestone ID");
    assert.ok(result.includes("auth"), "Should include domain");
    assert.ok(result.includes("validateToken"), "Should include interface name");
    assert.ok(result.includes("UserSession"), "Should include second interface name");
    assert.ok(result.includes("Contract v2"), "Should include version");
    assert.ok(result.includes("awareness only"), "Should include awareness-only label");
  });

  it("includes team signals in output", () => {
    const signals = [
      {
        type: "contract-change" as const,
        source: "M003-src",
        workerMid: "M001-self",
        payload: { domain: "api", version: 1, interfaceCount: 3 },
        timestamp: Date.now(),
      },
    ];

    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, signals);
    assert.ok(result.includes("contract-change"), "Should include signal type");
    assert.ok(result.includes("M003-src"), "Should include signal source");
    assert.ok(result.includes("Recent Team Signals"), "Should include signals header");
  });

  it("includes both contracts and signals together", () => {
    const contract = formatContract({
      version: 1, domain: "data",
      interfaces: [{ name: "fetchData", type: "function", signature: "() => Data" }],
      body: "",
    });
    writeSyncedContract(tmpDir, "M005-data", contract);

    const signals = [
      {
        type: "schema-update" as const,
        source: "M005-data",
        workerMid: "M001-self",
        payload: { table: "users" },
        timestamp: Date.now(),
      },
    ];

    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, signals);
    assert.ok(result.includes("M005-data"), "Should include contract source");
    assert.ok(result.includes("fetchData"), "Should include interface");
    assert.ok(result.includes("schema-update"), "Should include signal type");
  });

  it("reads multiple synced contracts from different workers", () => {
    writeSyncedContract(tmpDir, "M002-auth", formatContract({
      version: 1, domain: "auth",
      interfaces: [{ name: "login", type: "function", signature: "() => Token" }],
      body: "",
    }));
    writeSyncedContract(tmpDir, "M003-data", formatContract({
      version: 3, domain: "data",
      interfaces: [{ name: "query", type: "function", signature: "(sql: string) => Row[]" }],
      body: "",
    }));

    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, []);
    assert.ok(result.includes("M002-auth"), "Should include first worker");
    assert.ok(result.includes("M003-data"), "Should include second worker");
    assert.ok(result.includes("login"), "Should include first worker's interface");
    assert.ok(result.includes("query"), "Should include second worker's interface");
  });

  it("enforces budget — output never exceeds budgetChars", () => {
    // Create multiple large contracts that would exceed the budget
    for (let i = 0; i < 10; i++) {
      const interfaces = Array.from({ length: 20 }, (_, j) => ({
        name: `functionNameThatIsQuiteLong_${i}_${j}`,
        type: "function",
        signature: `(arg1: VeryLongTypeName_${i}_${j}, arg2: AnotherLongType_${i}_${j}) => ResultType_${i}_${j}`,
      }));
      writeSyncedContract(tmpDir, `M${String(i + 10).padStart(3, "0")}-worker`, formatContract({
        version: i + 1,
        domain: `domain-with-a-long-name-${i}`,
        interfaces,
        body: `# Contract Body ${i}\n\n${"Detail paragraph. ".repeat(20)}\n`,
      }));
    }

    const budgetChars = 500;
    const result = buildCrossContextSection(tmpDir, "M001-self", budgetChars, []);
    assert.ok(result.length <= budgetChars, `Output (${result.length} chars) should not exceed budget (${budgetChars})`);
  });

  it("budget compliance with large signals array", () => {
    // Create many signals that would exceed budget
    const signals = Array.from({ length: 50 }, (_, i) => ({
      type: "pattern-discovered" as const,
      source: `M${String(i + 10).padStart(3, "0")}-worker`,
      workerMid: "M001-self",
      payload: { description: `A detailed pattern description that takes up space: pattern number ${i} with extra details` },
      timestamp: Date.now() + i,
    }));

    const budgetChars = 300;
    const result = buildCrossContextSection(tmpDir, "M001-self", budgetChars, signals);
    assert.ok(result.length <= budgetChars, `Output (${result.length} chars) should not exceed budget (${budgetChars})`);
  });

  it("handles contract with no interfaces gracefully", () => {
    writeSyncedContract(tmpDir, "M002-minimal", formatContract({
      version: 1, domain: "minimal",
      interfaces: [],
      body: "",
    }));

    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, []);
    assert.ok(result.includes("M002-minimal"), "Should include worker");
    assert.ok(result.includes("no public interfaces declared"), "Should note empty interfaces");
  });

  it("does not crash on malformed CONTRACT.md in team-contracts dir", () => {
    const dir = join(tmpDir, ".gsd", "team-contracts", "M099-broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CONTRACT.md"), "{{{{not valid yaml{{{", "utf-8");

    // Should not throw
    const result = buildCrossContextSection(tmpDir, "M001-self", 10000, []);
    // The malformed contract may parse with defaults but should not crash
    assert.ok(typeof result === "string");
  });
});
