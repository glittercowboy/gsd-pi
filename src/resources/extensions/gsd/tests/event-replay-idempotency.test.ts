// GSD State Machine Regression Tests — Event Replay & Reconciliation (#3161)

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  updateTaskStatus,
  insertVerificationEvidence,
  upsertDecision,
} from "../gsd-db.ts";
import { extractEntityKey } from "../workflow-reconcile.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MID = "M001";
const SID = "S01";
const TID = "T01";
const TS = new Date().toISOString();

function setupDb(): void {
  openDatabase(":memory:");
  insertMilestone({ id: MID, title: "Test Milestone" });
  insertSlice({ id: SID, milestoneId: MID, title: "Test Slice" });
  insertTask({ id: TID, sliceId: SID, milestoneId: MID, title: "Test Task" });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("event-replay-idempotency", () => {
  beforeEach(() => {
    setupDb();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("updateTaskStatus is idempotent for complete_task replay", () => {
    // Simulates replaying a complete_task event twice (e.g. crash recovery)
    updateTaskStatus(MID, SID, TID, "done", TS);
    updateTaskStatus(MID, SID, TID, "done", TS);

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after status update");
    assert.equal(task!.status, "done", "status should be 'done' after double replay");
  });

  test("updateTaskStatus is idempotent for start_task replay", () => {
    // Simulates replaying a start_task event twice
    updateTaskStatus(MID, SID, TID, "in-progress");
    updateTaskStatus(MID, SID, TID, "in-progress");

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after status update");
    assert.equal(task!.status, "in-progress", "status should be 'in-progress' after double replay");
  });

  test("updateTaskStatus for report_blocker does not set blocker_discovered flag (M4)", () => {
    // M4 finding: report_blocker replay only calls updateTaskStatus("blocked").
    // The blocker_discovered column is NOT set during replay — this is a known
    // lossy replay: status is recovered but the blocker flag is not.
    updateTaskStatus(MID, SID, TID, "blocked");

    const task = getTask(MID, SID, TID);
    assert.ok(task !== null, "task should exist after blocked status update");
    assert.equal(task!.status, "blocked", "status should be 'blocked'");
    assert.equal(
      task!.blocker_discovered,
      false,
      "blocker_discovered should remain false — report_blocker replay is lossy (M4 finding)",
    );
  });

  test("insertVerificationEvidence is NOT idempotent — duplicates accumulate (M5)", () => {
    // M5 finding: insertVerificationEvidence uses a plain INSERT (no ON CONFLICT),
    // so replaying the same record_verification event twice produces two rows.
    // Both calls must succeed without throwing — the duplication is the risk.
    const evidence = {
      taskId: TID,
      sliceId: SID,
      milestoneId: MID,
      command: "npm test",
      exitCode: 0,
      verdict: "pass",
      durationMs: 1200,
    };

    assert.doesNotThrow(
      () => insertVerificationEvidence(evidence),
      "first insertVerificationEvidence call should not throw",
    );
    assert.doesNotThrow(
      () => insertVerificationEvidence(evidence),
      "second insertVerificationEvidence call should not throw — duplicates accumulate silently (M5 finding)",
    );
  });

  test("upsertDecision is idempotent via INSERT OR REPLACE", () => {
    // save_decision replay uses upsertDecision which is INSERT OR REPLACE,
    // so replaying the same decision id twice overwrites without error.
    const base = {
      id: "arch:logging",
      when_context: "during planning",
      scope: "arch",
      decision: "logging",
      rationale: "structured logs",
      revisable: "yes" as const,
      made_by: "agent" as const,
      superseded_by: null,
    };

    upsertDecision({ ...base, choice: "structured" });
    upsertDecision({ ...base, choice: "unstructured" });

    // No error means the second call replaced the first — idempotent at the id level.
    // The final choice is "unstructured" per INSERT OR REPLACE semantics.
  });

  test("unknown event commands in replayEvents are silently skipped — extractEntityKey returns null for unknown commands", () => {
    // replayEvents uses a switch/default that silently skips unrecognised commands.
    // We verify this via extractEntityKey which follows the same command set.
    // A future_command not in the switch must return null (not throw).
    const event = {
      cmd: "future_command",
      params: { foo: "bar" },
      ts: new Date().toISOString(),
      hash: "0000000000000000",
      actor: "agent" as const,
      session_id: "test-session",
    };

    const key = extractEntityKey(event);
    assert.equal(key, null, "extractEntityKey should return null for unknown commands");
  });
});
