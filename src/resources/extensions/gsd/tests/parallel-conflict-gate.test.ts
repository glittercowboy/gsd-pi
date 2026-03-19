/**
 * Contract tests for checkConflictWithRunning() — the conflict gate that
 * intercepts mid-session worker additions when file overlap is detected.
 *
 * Strategy: mock files.js and paths.js so the real collectTouchedFiles →
 * checkConflictWithRunning chain runs with controlled file lists per milestone.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/parallel-conflict-gate.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Mutable registry: milestoneId → files it "touches" ─────────────────────
// If a milestoneId is in the map, its roadmap resolves and parsePlan returns
// these files. If NOT in the map, resolveMilestoneFile returns null → no files.
let filesMap: Record<string, string[]> = {};

// ─── Module-level mocks (K005 — set up BEFORE dynamic import) ──────────────

mock.module("../paths.js", {
  namedExports: {
    resolveMilestoneFile: (bp: string, mid: string, type: string) => {
      if (type === "ROADMAP" && mid in filesMap) return `${bp}/milestones/${mid}/ROADMAP.md`;
      return null;
    },
    resolveSliceFile: (bp: string, mid: string, sid: string, type: string) => {
      if (mid in filesMap) return `${bp}/milestones/${mid}/${sid}/${type}.md`;
      return null;
    },
  },
});

mock.module("../files.js", {
  namedExports: {
    loadFile: async (path: string) => path, // pass path through as "content"
    parseRoadmap: (_content: string) => ({ slices: [{ id: "S01" }] }),
    parsePlan: (content: string) => {
      // content is the path — extract milestoneId from "/base/milestones/M001/S01/PLAN.md"
      const match = content.match(/milestones\/([^/]+)\//);
      const mid = match?.[1] ?? "";
      return { filesLikelyTouched: filesMap[mid] ?? [] };
    },
  },
});

// Stub transitive deps that parallel-eligibility.ts imports but our tests don't use
mock.module("../state.js", {
  namedExports: {
    deriveState: async () => ({ registry: [] }),
    invalidateStateCache: () => {},
  },
});

mock.module("../guided-flow.js", {
  namedExports: {
    findMilestoneIds: () => [],
  },
});

// ─── Dynamic import after mock setup (K005 pattern) ─────────────────────────
let checkConflictWithRunning: typeof import("../parallel-eligibility.js").checkConflictWithRunning;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("checkConflictWithRunning", () => {
  beforeEach(async () => {
    filesMap = {};
    const mod = await import("../parallel-eligibility.js");
    checkConflictWithRunning = mod.checkConflictWithRunning;
  });

  it("no overlap — returns hasConflict false", async () => {
    filesMap = {
      M001: ["src/a.ts", "src/b.ts"],
      M002: ["src/c.ts", "src/d.ts"],
    };
    const result = await checkConflictWithRunning("/base", "M001", ["M002"]);
    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.overlappingFiles, []);
    assert.deepEqual(result.conflictingWorkerIds, []);
  });

  it("single file overlap — returns correct overlap", async () => {
    filesMap = {
      M001: ["src/a.ts", "src/shared.ts"],
      M002: ["src/shared.ts", "src/b.ts"],
    };
    const result = await checkConflictWithRunning("/base", "M001", ["M002"]);
    assert.equal(result.hasConflict, true);
    assert.deepEqual(result.overlappingFiles, ["src/shared.ts"]);
    assert.deepEqual(result.conflictingWorkerIds, ["M002"]);
  });

  it("multi-worker overlap — returns all conflicting workers", async () => {
    filesMap = {
      M001: ["src/a.ts", "src/shared.ts", "src/common.ts"],
      M002: ["src/shared.ts", "src/x.ts"],
      M003: ["src/common.ts", "src/y.ts"],
    };
    const result = await checkConflictWithRunning("/base", "M001", ["M002", "M003"]);
    assert.equal(result.hasConflict, true);
    assert.deepEqual(result.overlappingFiles.sort(), ["src/common.ts", "src/shared.ts"]);
    assert.deepEqual(result.conflictingWorkerIds, ["M002", "M003"]);
  });

  it("candidate with no touched files — returns no conflict", async () => {
    filesMap = {
      M001: [],       // candidate has no files
      M002: ["src/a.ts"],
    };
    const result = await checkConflictWithRunning("/base", "M001", ["M002"]);
    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.overlappingFiles, []);
    assert.deepEqual(result.conflictingWorkerIds, []);
  });

  it("running worker with no touched files — no conflict from that worker", async () => {
    filesMap = {
      M001: ["src/a.ts", "src/shared.ts"],
      M002: [],                  // this running worker has no files
      M003: ["src/shared.ts"],   // this one overlaps
    };
    const result = await checkConflictWithRunning("/base", "M001", ["M002", "M003"]);
    assert.equal(result.hasConflict, true);
    assert.deepEqual(result.overlappingFiles, ["src/shared.ts"]);
    assert.deepEqual(result.conflictingWorkerIds, ["M003"]);
  });
});
