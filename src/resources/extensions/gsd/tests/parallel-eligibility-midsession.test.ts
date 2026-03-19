/**
 * Contract tests for getMidSessionCandidates() — mid-session eligibility filtering.
 *
 * Covers: filtering out already-running milestones, capacity detection,
 * ROADMAP/CONTEXT readiness annotation, passthrough of eligible results.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/parallel-eligibility-midsession.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Module-level mocks (K005 — set up BEFORE dynamic import) ──────────────

let mockEligible: any[] = [];
let mockIneligible: any[] = [];
let mockFileOverlaps: any[] = [];
let mockExistingFiles = new Set<string>();

mock.module("../parallel-eligibility.js", {
  namedExports: {
    // We need the original module's exports PLUS the function we're testing.
    // Since we're mocking the module that contains the function under test,
    // we need to mock analyzeParallelEligibility and re-export getMidSessionCandidates.
    // Actually, getMidSessionCandidates calls analyzeParallelEligibility from the SAME module.
    // With mock.module, we can't partially mock — so we need a different approach.
    // We'll mock the DEPENDENCIES of parallel-eligibility.ts instead.
  },
});

// Actually, we need to mock the dependencies that analyzeParallelEligibility calls,
// not the module itself. Let's mock state, files, paths, and guided-flow.

// Reset and redo mocks properly:
mock.restoreAll();

let mockMilestoneIds: string[] = [];
let mockRegistry: any[] = [];

mock.module("../state.js", {
  namedExports: {
    deriveState: async (_path: string) => ({
      registry: mockRegistry,
    }),
    invalidateStateCache: () => {},
  },
});

mock.module("../files.js", {
  namedExports: {
    loadFile: async () => null,
    parseRoadmap: () => ({ slices: [] }),
    parsePlan: () => ({ filesLikelyTouched: [] }),
  },
});

mock.module("../paths.js", {
  namedExports: {
    resolveMilestoneFile: (_basePath: string, milestoneId: string, suffix: string) => {
      const key = `${milestoneId}/${suffix}`;
      if (mockExistingFiles.has(key)) return `/mock/${milestoneId}/${milestoneId}-${suffix}.md`;
      return `/mock/${milestoneId}/${milestoneId}-${suffix}.md`; // path always resolves; existsSync gates it
    },
    resolveSliceFile: () => null,
    gsdRoot: (bp: string) => bp + "/.gsd",
  },
});

mock.module("../guided-flow.js", {
  namedExports: {
    findMilestoneIds: (_basePath: string) => mockMilestoneIds,
  },
});

// Mock existsSync via node:fs — only the files in mockExistingFiles return true
const originalFs = await import("node:fs");

mock.module("node:fs", {
  namedExports: {
    ...originalFs,
    existsSync: (p: string) => {
      if (typeof p === "string" && p.startsWith("/mock/")) {
        // Extract milestoneId/SUFFIX from path like /mock/M001/M001-ROADMAP.md
        for (const key of mockExistingFiles) {
          const [mid, suffix] = key.split("/");
          if (p.includes(`${mid}-${suffix}`)) return true;
        }
        return false;
      }
      return originalFs.existsSync(p);
    },
    writeFileSync: originalFs.writeFileSync,
    readFileSync: originalFs.readFileSync,
    mkdirSync: originalFs.mkdirSync,
    renameSync: originalFs.renameSync,
    unlinkSync: originalFs.unlinkSync,
  },
});

// ─── Dynamic import (picks up mocks) ──────────────────────────────────────

const { getMidSessionCandidates } = await import("../parallel-eligibility.js");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("getMidSessionCandidates", () => {
  beforeEach(() => {
    mockMilestoneIds = [];
    mockRegistry = [];
    mockExistingFiles = new Set();
  });

  it("filters out already-running milestones from eligible list", async () => {
    mockMilestoneIds = ["M001", "M002", "M003"];
    mockRegistry = [
      { id: "M001", title: "Milestone 1", status: "active", dependsOn: [] },
      { id: "M002", title: "Milestone 2", status: "active", dependsOn: [] },
      { id: "M003", title: "Milestone 3", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", ["M001", "M002"], 4);

    assert.equal(result.candidates.length, 1, "Should have 1 candidate (M003)");
    assert.equal(result.candidates[0].milestoneId, "M003");
  });

  it("returns all eligible milestones when none are running", async () => {
    mockMilestoneIds = ["M001", "M002"];
    mockRegistry = [
      { id: "M001", title: "Milestone 1", status: "active", dependsOn: [] },
      { id: "M002", title: "Milestone 2", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", [], 4);

    assert.equal(result.candidates.length, 2, "Should return all 2 eligible milestones");
    const ids = result.candidates.map(c => c.milestoneId);
    assert.ok(ids.includes("M001"));
    assert.ok(ids.includes("M002"));
  });

  it("atCapacity is true when running count >= maxWorkers", async () => {
    mockMilestoneIds = ["M001", "M002", "M003"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
      { id: "M002", title: "M2", status: "active", dependsOn: [] },
      { id: "M003", title: "M3", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", ["M001", "M002"], 2);

    assert.equal(result.atCapacity, true, "Should be at capacity (2 running, max 2)");
    assert.equal(result.currentWorkerCount, 2);
    assert.equal(result.maxWorkers, 2);
  });

  it("atCapacity is false when running count < maxWorkers", async () => {
    mockMilestoneIds = ["M001", "M002"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
      { id: "M002", title: "M2", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", ["M001"], 4);

    assert.equal(result.atCapacity, false, "Should not be at capacity (1 running, max 4)");
    assert.equal(result.currentWorkerCount, 1);
    assert.equal(result.maxWorkers, 4);
  });

  it("annotates hasRoadmap: true when ROADMAP file exists", async () => {
    mockMilestoneIds = ["M001"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
    ];
    mockExistingFiles = new Set(["M001/ROADMAP"]);

    const result = await getMidSessionCandidates("/fake", [], 4);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].hasRoadmap, true);
  });

  it("annotates hasRoadmap: false when ROADMAP file does not exist", async () => {
    mockMilestoneIds = ["M001"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
    ];
    mockExistingFiles = new Set(); // no files

    const result = await getMidSessionCandidates("/fake", [], 4);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].hasRoadmap, false);
  });

  it("annotates hasContext: true when CONTEXT file exists", async () => {
    mockMilestoneIds = ["M001"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
    ];
    mockExistingFiles = new Set(["M001/CONTEXT"]);

    const result = await getMidSessionCandidates("/fake", [], 4);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].hasContext, true);
  });

  it("annotates hasContext: false when CONTEXT file does not exist", async () => {
    mockMilestoneIds = ["M001"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
    ];
    mockExistingFiles = new Set(["M001/ROADMAP"]); // ROADMAP exists but not CONTEXT

    const result = await getMidSessionCandidates("/fake", [], 4);

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].hasContext, false);
  });

  it("ready field matches hasRoadmap", async () => {
    mockMilestoneIds = ["M001", "M002"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
      { id: "M002", title: "M2", status: "active", dependsOn: [] },
    ];
    mockExistingFiles = new Set(["M001/ROADMAP"]); // M001 has ROADMAP, M002 does not

    const result = await getMidSessionCandidates("/fake", [], 4);

    const m001 = result.candidates.find(c => c.milestoneId === "M001")!;
    const m002 = result.candidates.find(c => c.milestoneId === "M002")!;
    assert.equal(m001.ready, true, "M001 ready should be true (has ROADMAP)");
    assert.equal(m002.ready, false, "M002 ready should be false (no ROADMAP)");
    assert.equal(m001.ready, m001.hasRoadmap);
    assert.equal(m002.ready, m002.hasRoadmap);
  });

  it("excludes ineligible milestones (complete, blocked by deps)", async () => {
    mockMilestoneIds = ["M001", "M002", "M003"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "complete", dependsOn: [] },
      { id: "M002", title: "M2", status: "active", dependsOn: ["M003"] }, // M003 not complete
      { id: "M003", title: "M3", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", [], 4);

    // M001 is complete (ineligible), M002 blocked by M003 (ineligible), only M003 is eligible
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].milestoneId, "M003");
  });

  it("defaults maxWorkers to 4 when not provided", async () => {
    mockMilestoneIds = ["M001"];
    mockRegistry = [
      { id: "M001", title: "M1", status: "active", dependsOn: [] },
    ];

    const result = await getMidSessionCandidates("/fake", ["A", "B", "C"]);

    assert.equal(result.maxWorkers, 4);
    assert.equal(result.atCapacity, false, "3 running < 4 max");
  });
});
