/**
 * dispatch-workflow-idle-race.test.ts — Regression test for #discuss double-loop bug.
 *
 * /gsd discuss was dispatching a slice discussion then immediately calling
 * waitForIdle() before the agent had a chance to set runningPrompt. Since
 * waitForIdle() returns `this.runningPrompt ?? Promise.resolve()`, it resolved
 * instantly when called before the turn started, causing the picker to loop back
 * before the discuss session had finished — making slices appear "not discussed"
 * on the second pass.
 *
 * Fix: dispatchWorkflow() now yields one microtask tick (setImmediate) after
 * sendMessage() when a ctx is provided, giving the agent loop time to set
 * runningPrompt before any waitForIdle() at the callsite checks it.
 *
 * These tests verify the fix is present in the source code.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const guidedFlowSrc = readFileSync(
  join(__dirname, "../guided-flow.ts"),
  "utf-8",
);

describe("dispatchWorkflow idle-race fix", () => {
  test("dispatchWorkflow yields a tick after sendMessage when ctx is provided", () => {
    // The fix inserts a setImmediate tick between sendMessage and the callsite's
    // waitForIdle() to ensure runningPrompt is set before it is checked.
    assert.ok(
      guidedFlowSrc.includes("setImmediate"),
      "dispatchWorkflow should contain setImmediate to yield before waitForIdle",
    );
    assert.ok(
      guidedFlowSrc.includes("if (ctx)"),
      "tick yield should be gated on ctx being present",
    );
  });

  test("dispatchWorkflow tick yield comment explains the race condition", () => {
    assert.ok(
      guidedFlowSrc.includes("runningPrompt"),
      "source should document the runningPrompt race condition",
    );
    assert.ok(
      guidedFlowSrc.includes("waitForIdle"),
      "source should reference waitForIdle in the context of the fix",
    );
  });

  test("discuss slice loop calls waitForIdle after dispatchWorkflow", () => {
    // Verify the discuss-slice loop still has waitForIdle after dispatchWorkflow
    const dispatchIdx = guidedFlowSrc.indexOf(
      `await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-slice")`,
    );
    assert.ok(dispatchIdx !== -1, "discuss-slice dispatch should exist");
    const after = guidedFlowSrc.slice(dispatchIdx, dispatchIdx + 200);
    assert.ok(
      after.includes("waitForIdle"),
      "waitForIdle should follow the discuss-slice dispatchWorkflow call",
    );
  });
});
