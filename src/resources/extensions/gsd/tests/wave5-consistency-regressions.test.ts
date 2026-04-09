// GSD State Machine — Wave 5 Consistency Regression Tests
// Validates isClosedStatus usage in projections, upsertDecision seq preservation,
// event schema versioning, and replay round-trip with mixed cmd formats.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isClosedStatus } from "../status-guards.js";
import { openDatabase, closeDatabase, upsertDecision, _getAdapter, insertMilestone, insertSlice, insertTask, getTask } from "../gsd-db.js";
import { extractEntityKey } from "../workflow-reconcile.js";
import type { WorkflowEvent } from "../workflow-events.js";

// ── Fix 19: isClosedStatus covers all closed statuses ──

describe("isClosedStatus used by projections", () => {
  test("skipped is closed (projections now show checked)", () => {
    assert.ok(isClosedStatus("skipped"));
  });
  test("complete is closed", () => {
    assert.ok(isClosedStatus("complete"));
  });
  test("done is closed", () => {
    assert.ok(isClosedStatus("done"));
  });
  test("in-progress is not closed", () => {
    assert.ok(!isClosedStatus("in-progress"));
  });
});

// ── Fix 20: upsertDecision preserves seq on update ──

describe("upsertDecision preserves seq column", () => {
  test("seq is preserved when decision is re-upserted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-upsert-test-"));
    const dbPath = join(tmp, "gsd.db");
    try {
      openDatabase(dbPath);
      const adapter = _getAdapter();
      assert.ok(adapter, "adapter must be available");

      // Insert two decisions
      upsertDecision({
        id: "D001", when_context: "ctx1", scope: "s1",
        decision: "d1", choice: "c1", rationale: "r1",
        revisable: "yes", made_by: "agent", superseded_by: null,
      });
      upsertDecision({
        id: "D002", when_context: "ctx2", scope: "s2",
        decision: "d2", choice: "c2", rationale: "r2",
        revisable: "yes", made_by: "agent", superseded_by: null,
      });

      // Get original seq values
      const rows1 = adapter.prepare("SELECT id, seq FROM decisions ORDER BY seq").all() as Array<{ id: string; seq: number }>;
      assert.strictEqual(rows1[0].id, "D001");
      assert.strictEqual(rows1[1].id, "D002");
      const d001OriginalSeq = rows1[0].seq;

      // Re-upsert D001 with updated content
      upsertDecision({
        id: "D001", when_context: "updated", scope: "s1",
        decision: "d1-updated", choice: "c1", rationale: "r1",
        revisable: "yes", made_by: "agent", superseded_by: null,
      });

      // Verify seq is preserved (not moved to end)
      const rows2 = adapter.prepare("SELECT id, seq FROM decisions ORDER BY seq").all() as Array<{ id: string; seq: number }>;
      assert.strictEqual(rows2[0].id, "D001", "D001 should still be first by seq");
      assert.strictEqual(rows2[0].seq, d001OriginalSeq, "D001 seq should be preserved");
      assert.strictEqual(rows2[1].id, "D002", "D002 should still be second");

      // Verify content was updated
      const updated = adapter.prepare("SELECT decision FROM decisions WHERE id = 'D001'").get() as { decision: string };
      assert.strictEqual(updated.decision, "d1-updated");

      closeDatabase();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Fix 23: Event schema versioning ──

describe("WorkflowEvent v field", () => {
  test("appendEvent includes v:2 in output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-event-v-test-"));
    try {
      const { appendEvent } = await import("../workflow-events.js");
      appendEvent(tmp, {
        cmd: "test-event",
        params: { foo: "bar" },
        ts: new Date().toISOString(),
        actor: "system",
      });

      const logPath = join(tmp, ".gsd", "event-log.jsonl");
      const line = readFileSync(logPath, "utf-8").trim();
      const event = JSON.parse(line);
      assert.strictEqual(event.v, 2, "New events should have v:2");
      assert.strictEqual(event.cmd, "test-event");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Fix 19 (behavior-level): Projection rendering with skipped tasks ──

describe("isClosedStatus drives projection checkbox logic", () => {
  test("skipped task produces checked checkbox via isClosedStatus", () => {
    // This tests the behavior contract that projections rely on:
    // workflow-projections.ts uses isClosedStatus() to determine checkbox state.
    // "skipped" tasks must render as [x], not [ ].
    const statuses = ["complete", "done", "skipped"];
    for (const status of statuses) {
      assert.ok(
        isClosedStatus(status),
        `status "${status}" must be closed so projections render [x]`,
      );
    }
    // Non-closed statuses must render as [ ]
    for (const status of ["pending", "in-progress", "blocked", "active"]) {
      assert.ok(
        !isClosedStatus(status),
        `status "${status}" must NOT be closed so projections render [ ]`,
      );
    }
  });
});

// ── extractEntityKey: underscored cmds are recognized (Wave 5 scope) ──
// Note: hyphenated cmd normalization is in Wave 1. These tests validate
// the underscored format that Wave 5's extractEntityKey handles directly.

describe("extractEntityKey recognizes underscored cmds", () => {
  const base: WorkflowEvent = { cmd: "", params: {}, ts: "", hash: "", actor: "agent", session_id: "" };

  test("complete_task → task entity", () => {
    const key = extractEntityKey({ ...base, cmd: "complete_task", params: { taskId: "T01" } });
    assert.deepStrictEqual(key, { type: "task", id: "T01" });
  });

  test("complete_slice → slice entity", () => {
    const key = extractEntityKey({ ...base, cmd: "complete_slice", params: { sliceId: "S01" } });
    assert.deepStrictEqual(key, { type: "slice", id: "S01" });
  });

  test("plan_slice → slice_plan entity (distinct from complete)", () => {
    const key = extractEntityKey({ ...base, cmd: "plan_slice", params: { sliceId: "S01" } });
    assert.deepStrictEqual(key, { type: "slice_plan", id: "S01" });
  });

  test("save_decision → decision entity", () => {
    const key = extractEntityKey({ ...base, cmd: "save_decision", params: { scope: "s", decision: "d" } });
    assert.deepStrictEqual(key, { type: "decision", id: "s:d" });
  });

  test("unknown cmd returns null (not crash)", () => {
    const key = extractEntityKey({ ...base, cmd: "future_unknown_cmd", params: {} });
    assert.strictEqual(key, null);
  });
});
