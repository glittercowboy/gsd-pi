// GSD State Machine — Wave 1 Critical Regression Tests
// Validates fixes for event log format mismatch, skipped milestone status,
// dead code removal, and replan disk-file fallback.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractEntityKey } from "../workflow-reconcile.js";
import { isClosedStatus } from "../status-guards.js";
import type { WorkflowEvent } from "../workflow-events.js";

// ── Fix 1: Event log cmd format — hyphens and underscores both accepted ──

describe("extractEntityKey normalizes cmd format", () => {
  const baseEvent = { params: {}, ts: "", hash: "", actor: "agent" as const, session_id: "" };

  test("accepts hyphenated complete-task", () => {
    const event: WorkflowEvent = { ...baseEvent, cmd: "complete-task", params: { taskId: "T01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "task", id: "T01" });
  });

  test("accepts underscored complete_task (legacy)", () => {
    const event: WorkflowEvent = { ...baseEvent, cmd: "complete_task", params: { taskId: "T01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "task", id: "T01" });
  });

  test("accepts hyphenated complete-slice", () => {
    const event: WorkflowEvent = { ...baseEvent, cmd: "complete-slice", params: { sliceId: "S01" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "slice", id: "S01" });
  });

  test("accepts hyphenated complete-milestone", () => {
    const event: WorkflowEvent = { ...baseEvent, cmd: "complete-milestone", params: { milestoneId: "M001" } };
    const key = extractEntityKey(event);
    assert.deepStrictEqual(key, { type: "milestone", id: "M001" });
  });
});

// ── Fix 3: getActiveMilestoneId must skip "skipped" milestones ──

describe("isClosedStatus includes skipped", () => {
  test("complete is closed", () => assert.ok(isClosedStatus("complete")));
  test("done is closed", () => assert.ok(isClosedStatus("done")));
  test("skipped is closed", () => assert.ok(isClosedStatus("skipped")));
  test("pending is not closed", () => assert.ok(!isClosedStatus("pending")));
  test("active is not closed", () => assert.ok(!isClosedStatus("active")));
});
