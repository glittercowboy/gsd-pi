// GSD Extension — Workflow Tools Integration Tests
// Tests for deriveState engine bridge, telemetry, and tool registration smoke test.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import type { DbAdapter } from "../gsd-db.ts";
import { getEngine, resetEngine, isEngineAvailable } from "../workflow-engine.ts";
import {
  invalidateStateCache,
  getDeriveTelemetry,
  resetDeriveTelemetry,
} from "../state.ts";

/**
 * Helper: seed a test DB with one active milestone, one active slice, and two tasks.
 */
function seedTestData(db: DbAdapter): void {
  db.prepare(
    `INSERT INTO milestones (id, title, status, created_at)
     VALUES ('M001', 'Test Milestone', 'active', '2026-01-01T00:00:00Z')`,
  ).run();

  db.prepare(
    `INSERT INTO slices (id, milestone_id, title, status, risk, depends_on, created_at, seq)
     VALUES ('S01', 'M001', 'Test Slice', 'active', 'low', '', '2026-01-01T00:00:00Z', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
     VALUES ('T01', 'S01', 'M001', 'Task One', 'First task', 'pending', '30min', '[]', 0)`,
  ).run();

  db.prepare(
    `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
     VALUES ('T02', 'S01', 'M001', 'Task Two', 'Second task', 'pending', '30min', '[]', 1)`,
  ).run();
}

describe("Workflow Tools", () => {
  let db: DbAdapter;

  beforeEach(() => {
    openDatabase(":memory:");
    db = _getAdapter()!;
    assert.ok(db, "DB adapter should be available");
    seedTestData(db);
    resetEngine();
    invalidateStateCache();
    resetDeriveTelemetry();
  });

  afterEach(() => {
    resetEngine();
    closeDatabase();
  });

  describe("registerWorkflowTools (smoke test)", () => {
    it("should export registerWorkflowTools as a function", async () => {
      // Dynamic import to avoid pulling in @gsd/pi-coding-agent at module load.
      // We only verify the export shape, not the full registration (which requires
      // the real ExtensionAPI from the host package).
      const mod = await import("../bootstrap/workflow-tools.ts").catch(() => null);
      if (mod) {
        assert.equal(typeof mod.registerWorkflowTools, "function");
      } else {
        // If import fails due to missing @gsd/pi-coding-agent, verify the file exists
        // by checking that our other imports (which don't depend on it) work.
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const toolsPath = join(
          import.meta.dirname,
          "..",
          "bootstrap",
          "workflow-tools.ts",
        );
        assert.ok(existsSync(toolsPath), "workflow-tools.ts should exist");
      }
    });
  });

  describe("deriveState engine bridge", () => {
    it("should return GSDState shape when engine is available", () => {
      assert.ok(isEngineAvailable(process.cwd()), "engine should be available with :memory: DB");
      const engine = getEngine(process.cwd());
      const state = engine.deriveState();

      // Verify GSDState shape
      assert.ok(state.activeMilestone, "should have active milestone");
      assert.equal(state.activeMilestone!.id, "M001");
      assert.ok(state.activeSlice, "should have active slice");
      assert.equal(state.activeSlice!.id, "S01");
      assert.ok(state.activeTask, "should have active task");
      assert.equal(state.activeTask!.id, "T01");
      assert.equal(state.phase, "executing");
      assert.ok(Array.isArray(state.recentDecisions));
      assert.ok(Array.isArray(state.blockers));
      assert.ok(typeof state.nextAction === "string");
      assert.ok(Array.isArray(state.registry));
      assert.ok(state.progress);
      assert.ok(state.progress.milestones);
    });

    it("should not be available when no DB is open", () => {
      resetEngine();
      closeDatabase();
      assert.equal(isEngineAvailable(process.cwd()), false);
      // Re-open for afterEach cleanup
      openDatabase(":memory:");
    });

    it("should include task and slice progress in engine-derived state", () => {
      const engine = getEngine(process.cwd());
      const state = engine.deriveState();

      assert.ok(state.progress.milestones, "should have milestone progress");
      assert.equal(state.progress.milestones.total, 1);
      assert.equal(state.progress.milestones.done, 0);

      // Slice and task progress should be present since there's an active milestone/slice
      assert.ok(state.progress.slices, "should have slice progress");
      assert.ok(state.progress.tasks, "should have task progress");
      assert.equal(state.progress.tasks!.total, 2);
      assert.equal(state.progress.tasks!.done, 0);
    });
  });

  describe("telemetry", () => {
    it("should start with zero counts", () => {
      const t = getDeriveTelemetry();
      assert.equal(t.engineDeriveCount, 0);
      assert.equal(t.markdownDeriveCount, 0);
    });

    it("should reset telemetry counters", () => {
      const t1 = getDeriveTelemetry();
      assert.equal(t1.engineDeriveCount, 0);
      resetDeriveTelemetry();
      const t2 = getDeriveTelemetry();
      assert.equal(t2.engineDeriveCount, 0);
      assert.equal(t2.markdownDeriveCount, 0);
    });

    it("should return a copy (not a reference) from getDeriveTelemetry", () => {
      const t1 = getDeriveTelemetry();
      const t2 = getDeriveTelemetry();
      assert.deepEqual(t1, t2);
      // Mutating the returned object should not affect the internal state
      t1.engineDeriveCount = 999;
      const t3 = getDeriveTelemetry();
      assert.equal(t3.engineDeriveCount, 0);
    });
  });
});
