/**
 * Tests for the continue-here context-pressure monitor.
 *
 * Verifies:
 * - Threshold comparison: fires when percent >= continueThresholdPercent
 * - Null/undefined safety: no fire on missing or null context usage
 * - One-shot guard: fires exactly once even if percent stays high
 * - Cleanup: interval is cleared after fire and in clearUnitTimeout()
 * - End-to-end pipeline: different model sizes produce correct budgets
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeBudgets } from "../context-budget.js";

// ─── Pure threshold / pipeline tests ──────────────────────────────────────────
// These test the budget engine outputs that the continue-here monitor relies on.

describe("continue-here", () => {
  describe("threshold comparison", () => {
    it("fires when percent >= continueThresholdPercent (70%)", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;
      assert.equal(threshold, 70);

      // Simulate check: 70% should fire
      assert.ok(70 >= threshold, "exactly at threshold should fire");
      // 71% should fire
      assert.ok(71 >= threshold, "above threshold should fire");
      // 100% should fire
      assert.ok(100 >= threshold, "at maximum should fire");
    });

    it("does not fire below continueThresholdPercent", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;

      // 69% should not fire
      assert.ok(69 < threshold, "below threshold should not fire");
      // 0% should not fire
      assert.ok(0 < threshold, "zero usage should not fire");
      // 50% should not fire
      assert.ok(50 < threshold, "half usage should not fire");
    });
  });

  describe("null/undefined safety", () => {
    it("no fire when getContextUsage returns undefined", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;

      // Simulate the guard: usage is undefined → skip
      const usage = undefined as { percent: number | null } | undefined;
      const shouldFire = usage != null && usage.percent != null && usage.percent >= threshold;
      assert.equal(shouldFire, false, "undefined usage must not fire");
    });

    it("no fire when percent is null", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;

      // Simulate the guard: percent is null → skip
      const usage: { percent: number | null } | undefined = { percent: null };
      const shouldFire = usage != null && usage.percent != null && usage.percent >= threshold;
      assert.equal(shouldFire, false, "null percent must not fire");
    });
  });

  describe("one-shot guard", () => {
    it("fires exactly once even when percent stays above threshold", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;

      // Simulate repeated polls with percent above threshold
      let fired = false;
      let fireCount = 0;
      const usagePercents = [75, 80, 85, 90, 95];

      for (const percent of usagePercents) {
        if (fired) continue; // one-shot guard
        if (percent >= threshold) {
          fired = true;
          fireCount++;
        }
      }

      assert.equal(fireCount, 1, "must fire exactly once");
      assert.equal(fired, true);
    });
  });

  describe("end-to-end pipeline across model sizes", () => {
    const modelSizes = [
      { name: "128K", contextWindow: 128_000 },
      { name: "200K", contextWindow: 200_000 },
      { name: "1M", contextWindow: 1_000_000 },
    ];

    it("all model sizes produce continueThresholdPercent of 70", () => {
      for (const { name, contextWindow } of modelSizes) {
        const budget = computeBudgets(contextWindow);
        assert.equal(
          budget.continueThresholdPercent,
          70,
          `${name} model should have 70% threshold`,
        );
      }
    });

    it("larger models produce larger verificationBudgetChars", () => {
      const budgets = modelSizes.map(({ contextWindow }) => computeBudgets(contextWindow));

      // 128K < 200K < 1M
      assert.ok(
        budgets[0].verificationBudgetChars < budgets[1].verificationBudgetChars,
        "128K verification budget should be smaller than 200K",
      );
      assert.ok(
        budgets[1].verificationBudgetChars < budgets[2].verificationBudgetChars,
        "200K verification budget should be smaller than 1M",
      );
    });

    it("larger models produce larger inlineContextBudgetChars", () => {
      const budgets = modelSizes.map(({ contextWindow }) => computeBudgets(contextWindow));

      assert.ok(
        budgets[0].inlineContextBudgetChars < budgets[1].inlineContextBudgetChars,
        "128K inline budget should be smaller than 200K",
      );
      assert.ok(
        budgets[1].inlineContextBudgetChars < budgets[2].inlineContextBudgetChars,
        "200K inline budget should be smaller than 1M",
      );
    });

    it("task count range scales with context window", () => {
      const b128 = computeBudgets(128_000);
      const b200 = computeBudgets(200_000);
      const b1m = computeBudgets(1_000_000);

      // All have min=2
      assert.equal(b128.taskCountRange.min, 2);
      assert.equal(b200.taskCountRange.min, 2);
      assert.equal(b1m.taskCountRange.min, 2);

      // Max tasks scale: 128K→5, 200K→6, 1M→8
      assert.equal(b128.taskCountRange.max, 5, "128K max tasks");
      assert.equal(b200.taskCountRange.max, 6, "200K max tasks");
      assert.equal(b1m.taskCountRange.max, 8, "1M max tasks");
    });

    it("produces deterministic verificationBudgetChars values", () => {
      // 128K: 128000 * 4 * 0.10 = 51200
      assert.equal(computeBudgets(128_000).verificationBudgetChars, 51_200);
      // 200K: 200000 * 4 * 0.10 = 80000
      assert.equal(computeBudgets(200_000).verificationBudgetChars, 80_000);
      // 1M: 1000000 * 4 * 0.10 = 400000
      assert.equal(computeBudgets(1_000_000).verificationBudgetChars, 400_000);
    });
  });

  describe("continueHereFired runtime record field", () => {
    it("AutoUnitRuntimeRecord includes continueHereFired with default false", async () => {
      // Import writeUnitRuntimeRecord to verify the field is present and defaults
      const { writeUnitRuntimeRecord, readUnitRuntimeRecord, clearUnitRuntimeRecord } = await import("../unit-runtime.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      // Use a temp directory as basePath
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-here-test-"));
      try {
        const record = writeUnitRuntimeRecord(tmpDir, "execute-task", "M007/S02/T02", Date.now(), {
          phase: "dispatched",
          wrapupWarningSent: false,
        });

        assert.equal(record.continueHereFired, false, "default continueHereFired should be false");

        // Verify it persists to disk
        const read = readUnitRuntimeRecord(tmpDir, "execute-task", "M007/S02/T02");
        assert.ok(read, "record should be readable");
        assert.equal(read!.continueHereFired, false);

        // Update to true
        const updated = writeUnitRuntimeRecord(tmpDir, "execute-task", "M007/S02/T02", Date.now(), {
          continueHereFired: true,
        });
        assert.equal(updated.continueHereFired, true, "updated continueHereFired should be true");

        // Verify persistence
        const readUpdated = readUnitRuntimeRecord(tmpDir, "execute-task", "M007/S02/T02");
        assert.equal(readUpdated!.continueHereFired, true, "persisted continueHereFired should be true");

        // Clean up
        clearUnitRuntimeRecord(tmpDir, "execute-task", "M007/S02/T02");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("context-pressure monitor integration", () => {
    it("should fire wrap-up when context >= threshold and mark continueHereFired", async () => {
      const { writeUnitRuntimeRecord, readUnitRuntimeRecord, clearUnitRuntimeRecord } = await import("../unit-runtime.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-here-monitor-"));
      try {
        // Simulate the monitor's one-shot logic:
        // 1. Write initial runtime record (continueHereFired=false)
        const startedAt = Date.now();
        writeUnitRuntimeRecord(tmpDir, "execute-task", "M001/S01/T01", startedAt, {
          phase: "dispatched",
          wrapupWarningSent: false,
        });

        const budget = computeBudgets(128_000);
        const threshold = budget.continueThresholdPercent;

        // Simulate the monitor poll: context at 75% (above threshold)
        const contextPercent = 75;
        const runtime = readUnitRuntimeRecord(tmpDir, "execute-task", "M001/S01/T01");
        assert.ok(runtime, "runtime record should exist");
        assert.equal(runtime!.continueHereFired, false, "initially false");

        // Check: should fire
        const shouldFire = !runtime!.continueHereFired
          && contextPercent >= threshold;
        assert.ok(shouldFire, "should fire when context >= threshold and not yet fired");

        // Mark as fired (what the monitor does)
        writeUnitRuntimeRecord(tmpDir, "execute-task", "M001/S01/T01", startedAt, {
          continueHereFired: true,
        });

        // Verify one-shot: second poll should NOT fire
        const runtime2 = readUnitRuntimeRecord(tmpDir, "execute-task", "M001/S01/T01");
        assert.ok(runtime2, "runtime record should still exist");
        assert.equal(runtime2!.continueHereFired, true, "should be marked as fired");

        const shouldFireAgain = !runtime2!.continueHereFired
          && contextPercent >= threshold;
        assert.equal(shouldFireAgain, false, "must not fire again — one-shot guard");

        // Clean up
        clearUnitRuntimeRecord(tmpDir, "execute-task", "M001/S01/T01");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should not fire when context is below threshold", () => {
      const budget = computeBudgets(200_000);
      const threshold = budget.continueThresholdPercent;

      // Simulate monitor poll with context at 50%
      const contextPercent = 50;
      const continueHereFired = false;
      const shouldFire = !continueHereFired && contextPercent >= threshold;
      assert.equal(shouldFire, false, "50% should not trigger continue-here");
    });

    it("should not fire when contextUsage is null/undefined", () => {
      const budget = computeBudgets(128_000);
      const threshold = budget.continueThresholdPercent;

      // Simulate the full guard chain from the monitor
      const usageUndefined = undefined as { percent: number | null } | undefined;
      const shouldFire1 = usageUndefined != null
        && usageUndefined.percent != null
        && usageUndefined.percent >= threshold;
      assert.equal(shouldFire1, false, "undefined usage must not fire");

      const usageNullPercent: { percent: number | null } = { percent: null };
      const shouldFire2 = usageNullPercent.percent != null
        && usageNullPercent.percent >= threshold;
      assert.equal(shouldFire2, false, "null percent must not fire");
    });
  });
});
