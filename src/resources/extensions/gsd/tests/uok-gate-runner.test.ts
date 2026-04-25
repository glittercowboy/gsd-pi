import test from "node:test";
import assert from "node:assert/strict";

import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";
import { UokGateRunner } from "../uok/gate-runner.ts";

test.beforeEach(() => {
  closeDatabase();
  const ok = openDatabase(":memory:");
  assert.equal(ok, true);
});

test.afterEach(() => {
  closeDatabase();
});

test("uok gate runner retries timeout failures using deterministic matrix", async () => {
  const runner = new UokGateRunner();

  let calls = 0;
  runner.register({
    id: "timeout-gate",
    type: "verification",
    execute: async (_ctx, attempt) => {
      calls += 1;
      if (attempt < 2) {
        return {
          outcome: "fail",
          failureClass: "timeout",
          rationale: "first attempt timed out",
        };
      }
      return {
        outcome: "pass",
        failureClass: "none",
        rationale: "second attempt passed",
      };
    },
  });

  const result = await runner.run("timeout-gate", {
    basePath: process.cwd(),
    traceId: "trace-a",
    turnId: "turn-a",
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
  });

  assert.equal(result.outcome, "pass");
  assert.equal(calls, 2);

  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT gate_id, outcome, attempt FROM gate_runs ORDER BY id").all() ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.["outcome"], "retry");
  assert.equal(rows[1]?.["outcome"], "pass");
});

test("uok gate runner returns manual-attention for unknown gate id", async () => {
  const runner = new UokGateRunner();
  const result = await runner.run("missing-gate", {
    basePath: process.cwd(),
    traceId: "trace-b",
    turnId: "turn-b",
  });

  assert.equal(result.outcome, "manual-attention");
  assert.equal(result.failureClass, "unknown");
});
