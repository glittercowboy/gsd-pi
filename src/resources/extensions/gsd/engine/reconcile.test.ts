// GSD Extension — Event-Log Reconciliation Unit Tests
// Tests for reconcileWorktreeLogs, detectConflicts, extractEntityKey, writeConflictsFile.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import type { DbAdapter } from "../gsd-db.ts";
import { appendEvent, readEvents } from "../workflow-events.ts";
import type { WorkflowEvent } from "../workflow-events.ts";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileWorktreeLogs, extractEntityKey, detectConflicts } from "../workflow-reconcile.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Write a set of events as JSONL to a .gsd/event-log.jsonl file.
 */
function writeEventLog(basePath: string, events: WorkflowEvent[]): void {
  const dir = join(basePath, ".gsd");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dir, "event-log.jsonl"), lines + (lines.length > 0 ? "\n" : ""), "utf-8");
}

/**
 * Build a minimal WorkflowEvent with a deterministic hash.
 */
function makeEvent(
  cmd: string,
  params: Record<string, unknown>,
  ts: string,
  hash: string,
): WorkflowEvent {
  return { cmd, params, ts, hash, actor: "agent" };
}

// Shared base events (common history before fork)
const BASE_EVENTS: WorkflowEvent[] = [
  makeEvent("start_task", { milestoneId: "M001", sliceId: "S01", taskId: "T01" }, "2026-01-01T00:00:00Z", "aaaa000000000001"),
];

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("reconcileWorktreeLogs", () => {
  let mainDir: string;
  let wtDir: string;
  let db: DbAdapter;

  beforeEach(() => {
    mainDir = mkdtempSync(join(tmpdir(), "gsd-reconcile-main-"));
    wtDir = mkdtempSync(join(tmpdir(), "gsd-reconcile-wt-"));

    openDatabase(":memory:");
    db = _getAdapter()!;
    assert.ok(db, "DB adapter must be available");

    // Seed v5 schema tables required by engine replay
    db.exec(`CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT DEFAULT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS slices (
      id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      risk TEXT NOT NULL DEFAULT 'low', depends_on TEXT NOT NULL DEFAULT '[]',
      summary TEXT DEFAULT NULL, uat_result TEXT DEFAULT NULL, created_at TEXT NOT NULL,
      completed_at TEXT DEFAULT NULL, seq INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, slice_id TEXT NOT NULL, milestone_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      estimate TEXT NOT NULL DEFAULT '1h', summary TEXT DEFAULT NULL, files TEXT NOT NULL DEFAULT '[]',
      verify TEXT DEFAULT NULL, started_at TEXT DEFAULT NULL, completed_at TEXT DEFAULT NULL,
      blocker TEXT DEFAULT NULL, seq INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      when_context TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '', choice TEXT NOT NULL DEFAULT '',
      rationale TEXT NOT NULL DEFAULT '', revisable TEXT NOT NULL DEFAULT '',
      made_by TEXT NOT NULL DEFAULT 'agent', superseded_by TEXT DEFAULT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS verification_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, slice_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL, command TEXT NOT NULL, exit_code INTEGER DEFAULT NULL,
      stdout TEXT NOT NULL DEFAULT '', stderr TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER DEFAULT NULL, recorded_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)`);

    // Seed test data so engine commands can succeed
    db.prepare(
      `INSERT INTO milestones (id, title, status, created_at) VALUES ('M001', 'Test Milestone', 'active', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO slices (id, milestone_id, title, status, risk, depends_on, created_at, seq)
       VALUES ('S01', 'M001', 'Test Slice', 'active', 'low', '[]', '2026-01-01T00:00:00Z', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
       VALUES ('T01', 'S01', 'M001', 'Task One', 'Do thing one', 'in-progress', '1h', '[]', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
       VALUES ('T02', 'S01', 'M001', 'Task Two', 'Do thing two', 'pending', '1h', '[]', 1)`,
    ).run();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(wtDir, { recursive: true, force: true });
  });

  // ── Test 1: No divergence ───────────────────────────────────────────────

  it("Test 1: identical event logs returns autoMerged: 0, no conflicts", () => {
    writeEventLog(mainDir, BASE_EVENTS);
    writeEventLog(wtDir, BASE_EVENTS);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    assert.equal(result.autoMerged, 0, "no events to merge when logs are identical");
    assert.deepEqual(result.conflicts, [], "no conflicts for identical logs");
  });

  // ── Test 2: Main has extra events, worktree has none ───────────────────

  it("Test 2: main has 1 extra event touching T01, worktree has 0 extra — autoMerged: 1", () => {
    const mainEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Done" },
      "2026-01-01T01:00:00Z",
      "bbbb000000000001",
    );
    writeEventLog(mainDir, [...BASE_EVENTS, mainEvent]);
    writeEventLog(wtDir, BASE_EVENTS);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    assert.equal(result.autoMerged, 1, "should auto-merge 1 event");
    assert.deepEqual(result.conflicts, [], "no conflicts");
  });

  // ── Test 3: Non-conflicting diverged entities ──────────────────────────

  it("Test 3: main touches T01, worktree touches T02 — autoMerged: 2, no conflicts", () => {
    const mainEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Main done" },
      "2026-01-01T01:00:00Z",
      "cccc000000000001",
    );
    const wtEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T02", summary: "WT done" },
      "2026-01-01T01:30:00Z",
      "dddd000000000001",
    );
    writeEventLog(mainDir, [...BASE_EVENTS, mainEvent]);
    writeEventLog(wtDir, [...BASE_EVENTS, wtEvent]);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    assert.equal(result.autoMerged, 2, "should auto-merge both events");
    assert.deepEqual(result.conflicts, [], "no conflicts — different entities");
  });

  // ── Test 4: Conflicting entity on both sides ───────────────────────────

  it("Test 4: both sides complete T01 — conflict detected, CONFLICTS.md written, DB unchanged", () => {
    // Check task status before
    const taskBefore = db.prepare("SELECT status FROM tasks WHERE id = 'T01'").get();
    const statusBefore = (taskBefore as Record<string, unknown>)?.["status"];

    const mainEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Main version" },
      "2026-01-01T01:00:00Z",
      "eeee000000000001",
    );
    const wtEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "WT version" },
      "2026-01-01T01:30:00Z",
      "ffff000000000001",
    );
    writeEventLog(mainDir, [...BASE_EVENTS, mainEvent]);
    writeEventLog(wtDir, [...BASE_EVENTS, wtEvent]);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    assert.equal(result.autoMerged, 0, "no events merged on conflict");
    assert.equal(result.conflicts.length, 1, "exactly one conflict");
    assert.equal(result.conflicts[0]!.entityType, "task", "conflict entity type is task");
    assert.equal(result.conflicts[0]!.entityId, "T01", "conflict entity id is T01");

    // CONFLICTS.md must exist
    const conflictsPath = join(mainDir, ".gsd", "CONFLICTS.md");
    assert.ok(existsSync(conflictsPath), "CONFLICTS.md must be written on conflict");
    const conflictsContent = readFileSync(conflictsPath, "utf-8");
    assert.ok(conflictsContent.includes("T01"), "CONFLICTS.md must mention T01");

    // DB must be unchanged (atomic all-or-nothing)
    const taskAfter = db.prepare("SELECT status FROM tasks WHERE id = 'T01'").get();
    const statusAfter = (taskAfter as Record<string, unknown>)?.["status"];
    assert.equal(statusAfter, statusBefore, "DB must be unchanged on conflict");
  });

  // ── Test 5: Mixed — non-conflicting + conflicting → all-or-nothing ─────

  it("Test 5: 3 non-conflicting events + 1 conflicting entity — autoMerged: 0, CONFLICTS.md written", () => {
    const statusBefore = (db.prepare("SELECT status FROM tasks WHERE id = 'T01'").get() as Record<string, unknown>)?.["status"];

    // Main side: touch T01 (conflict) + touch T02
    const mainConflict = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Main T01" },
      "2026-01-01T01:00:00Z",
      "aaaa111111111001",
    );
    const mainExtra = makeEvent(
      "report_blocker",
      { milestoneId: "M001", sliceId: "S01", taskId: "T02", blocker: "Waiting on API" },
      "2026-01-01T01:15:00Z",
      "aaaa111111111002",
    );
    // WT side: touch T01 (conflict) + two more
    const wtConflict = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "WT T01" },
      "2026-01-01T01:05:00Z",
      "bbbb111111111001",
    );
    const wtExtra1 = makeEvent(
      "start_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T02" },
      "2026-01-01T01:20:00Z",
      "bbbb111111111002",
    );

    writeEventLog(mainDir, [...BASE_EVENTS, mainConflict, mainExtra]);
    writeEventLog(wtDir, [...BASE_EVENTS, wtConflict, wtExtra1]);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    // D-04: all-or-nothing — even though 2 events don't conflict, merge is blocked
    assert.equal(result.autoMerged, 0, "D-04: zero events apply when any conflict exists");
    assert.ok(result.conflicts.length >= 1, "at least one conflict detected");
    assert.ok(existsSync(join(mainDir, ".gsd", "CONFLICTS.md")), "CONFLICTS.md written");

    // DB unchanged
    const statusAfter = (db.prepare("SELECT status FROM tasks WHERE id = 'T01'").get() as Record<string, unknown>)?.["status"];
    assert.equal(statusAfter, statusBefore, "DB unchanged on mixed conflict");
  });

  // ── Test 6: extractEntityKey mapping ──────────────────────────────────

  it("Test 6: extractEntityKey maps commands to entity types correctly", () => {
    const taskCmds = ["complete_task", "start_task", "report_blocker", "record_verification"];
    for (const cmd of taskCmds) {
      const result = extractEntityKey({ cmd, params: { taskId: "T01" }, ts: "", hash: "", actor: "agent" });
      assert.ok(result !== null, `${cmd} should map to an entity`);
      assert.equal(result!.type, "task", `${cmd} should map to task`);
      assert.equal(result!.id, "T01", `${cmd} entity id should be T01`);
    }

    const sliceResult = extractEntityKey({ cmd: "complete_slice", params: { sliceId: "S01" }, ts: "", hash: "", actor: "agent" });
    assert.ok(sliceResult !== null, "complete_slice should map to entity");
    assert.equal(sliceResult!.type, "slice", "complete_slice maps to slice");
    assert.equal(sliceResult!.id, "S01");

    const planSliceResult = extractEntityKey({ cmd: "plan_slice", params: { sliceId: "S02" }, ts: "", hash: "", actor: "agent" });
    assert.ok(planSliceResult !== null, "plan_slice should map to entity");
    assert.equal(planSliceResult!.type, "slice_plan");
    assert.equal(planSliceResult!.id, "S02");

    const decisionResult = extractEntityKey({ cmd: "save_decision", params: { scope: "arch", decision: "use-sqlite" }, ts: "", hash: "", actor: "agent" });
    assert.ok(decisionResult !== null, "save_decision should map to entity");
    assert.equal(decisionResult!.type, "decision");
    assert.equal(decisionResult!.id, "arch:use-sqlite");

    const unknownResult = extractEntityKey({ cmd: "unknown_cmd", params: {}, ts: "", hash: "", actor: "agent" });
    assert.equal(unknownResult, null, "unknown commands return null");
  });

  // ── Test 7: Event log updated after successful merge ──────────────────

  it("Test 7: after successful merge, event log contains merged events in timestamp order", () => {
    const mainEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Main done" },
      "2026-01-01T02:00:00Z",
      "gggg000000000001",
    );
    const wtEvent = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T02", summary: "WT done" },
      "2026-01-01T01:00:00Z",  // earlier timestamp — should appear first
      "hhhh000000000001",
    );
    writeEventLog(mainDir, [...BASE_EVENTS, mainEvent]);
    writeEventLog(wtDir, [...BASE_EVENTS, wtEvent]);

    const result = reconcileWorktreeLogs(mainDir, wtDir);
    assert.equal(result.autoMerged, 2, "both events merged");

    // Event log should be updated with merged events
    const logPath = join(mainDir, ".gsd", "event-log.jsonl");
    const events = readEvents(logPath);
    // Should contain base events + merged events
    assert.ok(events.length >= 3, `event log must contain base + merged events, got ${events.length}`);

    // Check timestamp ordering of the diverged portion (last 2 events)
    const diverged = events.slice(BASE_EVENTS.length);
    assert.ok(diverged.length >= 2, "at least 2 diverged events in log");
    // WT event (01:00) should come before main event (02:00)
    assert.ok(diverged[0]!.ts <= diverged[1]!.ts, "events should be in timestamp order");
  });

  // ── Test 8: Empty worktree event log ─────────────────────────────────

  it("Test 8: empty worktree event log — main's diverged events returned as autoMerged", () => {
    const mainEvent1 = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T01", summary: "Done" },
      "2026-01-01T01:00:00Z",
      "iiii000000000001",
    );
    const mainEvent2 = makeEvent(
      "complete_task",
      { milestoneId: "M001", sliceId: "S01", taskId: "T02", summary: "Also done" },
      "2026-01-01T02:00:00Z",
      "iiii000000000002",
    );
    writeEventLog(mainDir, [...BASE_EVENTS, mainEvent1, mainEvent2]);
    // Worktree has no diverged events (just the base)
    writeEventLog(wtDir, BASE_EVENTS);

    const result = reconcileWorktreeLogs(mainDir, wtDir);

    assert.equal(result.autoMerged, 2, "2 main-side events auto-merged into empty wt log scenario");
    assert.deepEqual(result.conflicts, [], "no conflicts");
  });
});

// ── detectConflicts unit test ───────────────────────────────────────────────

describe("detectConflicts", () => {
  it("returns empty array when both sides touch different entities", () => {
    const mainDiverged: WorkflowEvent[] = [
      makeEvent("complete_task", { taskId: "T01" }, "2026-01-01T01:00:00Z", "aaaa"),
    ];
    const wtDiverged: WorkflowEvent[] = [
      makeEvent("complete_task", { taskId: "T02" }, "2026-01-01T01:00:00Z", "bbbb"),
    ];
    const conflicts = detectConflicts(mainDiverged, wtDiverged);
    assert.deepEqual(conflicts, []);
  });

  it("returns conflict entry when both sides touch same entity", () => {
    const mainDiverged: WorkflowEvent[] = [
      makeEvent("complete_task", { taskId: "T01", summary: "Main" }, "2026-01-01T01:00:00Z", "aaaa"),
    ];
    const wtDiverged: WorkflowEvent[] = [
      makeEvent("complete_task", { taskId: "T01", summary: "WT" }, "2026-01-01T01:00:00Z", "bbbb"),
    ];
    const conflicts = detectConflicts(mainDiverged, wtDiverged);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.entityType, "task");
    assert.equal(conflicts[0]!.entityId, "T01");
    assert.equal(conflicts[0]!.mainSideEvents.length, 1);
    assert.equal(conflicts[0]!.worktreeSideEvents.length, 1);
  });
});
