// GSD State Machine — Wave 2 Event Log Regression Tests
// Validates fixes for appendEvent isolation, entity replay handlers,
// and post-reconcile cache invalidation.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractEntityKey } from "../workflow-reconcile.js";
import type { WorkflowEvent } from "../workflow-events.js";

const base = { params: {}, ts: "", hash: "", actor: "agent" as const, session_id: "" };

// ── Fix 8: New entity event types handled by extractEntityKey ──

describe("extractEntityKey handles plan events", () => {
  test("plan-milestone → milestone type", () => {
    const event: WorkflowEvent = { ...base, cmd: "plan-milestone", params: { milestoneId: "M001" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "milestone", id: "M001" });
  });

  test("plan-task → task type", () => {
    const event: WorkflowEvent = { ...base, cmd: "plan-task", params: { taskId: "T01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "task", id: "T01" });
  });

  test("plan-slice preserves slice_plan type (conflict isolation)", () => {
    const event: WorkflowEvent = { ...base, cmd: "plan-slice", params: { sliceId: "S01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "slice_plan", id: "S01" });
  });

  test("replan-slice → slice type", () => {
    const event: WorkflowEvent = { ...base, cmd: "replan-slice", params: { sliceId: "S01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "slice", id: "S01" });
  });
});

// ── Fix 8b: Unknown commands return null (don't crash) ──

describe("extractEntityKey handles unknown commands gracefully", () => {
  test("unknown-command returns null", () => {
    const event: WorkflowEvent = { ...base, cmd: "unknown-future-cmd", params: { foo: "bar" } };
    const key = extractEntityKey(event);
    assert.strictEqual(key, null);
  });
});
