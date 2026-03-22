// GSD Extension — Event Log Compaction Unit Tests
// Tests for compactMilestoneEvents(): archive milestone events, retain others.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactMilestoneEvents } from "../workflow-events.ts";
import type { WorkflowEvent } from "../workflow-events.ts";

// Sample events used across tests
const M001_EVENT_1: WorkflowEvent = {
  cmd: "complete_task",
  params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
  ts: "2026-03-22T10:00:00Z",
  hash: "abc1234567890123",
  actor: "agent",
};

const M002_EVENT_1: WorkflowEvent = {
  cmd: "complete_task",
  params: { milestoneId: "M002", sliceId: "S01", taskId: "T01" },
  ts: "2026-03-22T11:00:00Z",
  hash: "def1234567890123",
  actor: "agent",
};

const M001_EVENT_2: WorkflowEvent = {
  cmd: "complete_slice",
  params: { milestoneId: "M001", sliceId: "S01" },
  ts: "2026-03-22T12:00:00Z",
  hash: "ghi1234567890123",
  actor: "agent",
};

function writeEvents(logPath: string, events: WorkflowEvent[]): void {
  writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function readJsonlEvents(filePath: string): WorkflowEvent[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as WorkflowEvent);
}

describe("compactMilestoneEvents()", () => {
  let tempDir: string;
  let logPath: string;
  let archivePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gsd-compact-test-"));
    mkdirSync(join(tempDir, ".gsd"), { recursive: true });
    logPath = join(tempDir, ".gsd", "event-log.jsonl");
    archivePath = join(tempDir, ".gsd", "event-log-M001.jsonl.archived");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Test 1: moves M001 events to event-log-M001.jsonl.archived", () => {
    writeEvents(logPath, [M001_EVENT_1, M002_EVENT_1, M001_EVENT_2]);

    compactMilestoneEvents(tempDir, "M001");

    assert.ok(existsSync(archivePath), "archive file must exist after compaction");
    const archived = readJsonlEvents(archivePath);
    assert.equal(archived.length, 2, "archive must contain 2 M001 events");
    assert.ok(
      archived.every((e) => (e.params as { milestoneId?: string }).milestoneId === "M001"),
      "all archived events must belong to M001",
    );
  });

  it("Test 2: active event-log.jsonl retains only non-M001 events after compaction", () => {
    writeEvents(logPath, [M001_EVENT_1, M002_EVENT_1, M001_EVENT_2]);

    compactMilestoneEvents(tempDir, "M001");

    const remaining = readJsonlEvents(logPath);
    assert.equal(remaining.length, 1, "active log must retain only 1 non-M001 event");
    assert.equal(
      (remaining[0]!.params as { milestoneId?: string }).milestoneId,
      "M002",
      "remaining event must be M002",
    );
  });

  it("Test 3: returns { archived: N } where N = count of moved events", () => {
    writeEvents(logPath, [M001_EVENT_1, M002_EVENT_1, M001_EVENT_2]);

    const result = compactMilestoneEvents(tempDir, "M001");

    assert.deepEqual(result, { archived: 2 });
  });

  it("Test 4: when no events match milestoneId, returns { archived: 0 } and files are untouched", () => {
    writeEvents(logPath, [M002_EVENT_1]);

    const result = compactMilestoneEvents(tempDir, "M001");

    assert.deepEqual(result, { archived: 0 });
    assert.ok(!existsSync(archivePath), "archive file must NOT be created when no events match");
    // Active log should still contain M002 event
    const remaining = readJsonlEvents(logPath);
    assert.equal(remaining.length, 1, "active log must be untouched");
  });

  it("Test 5: multiple milestones in log — compacting M001 leaves M002 events intact", () => {
    const m002Event2: WorkflowEvent = {
      cmd: "complete_slice",
      params: { milestoneId: "M002", sliceId: "S02" },
      ts: "2026-03-22T13:00:00Z",
      hash: "jkl1234567890123",
      actor: "agent",
    };
    writeEvents(logPath, [M001_EVENT_1, M002_EVENT_1, M001_EVENT_2, m002Event2]);

    compactMilestoneEvents(tempDir, "M001");

    const remaining = readJsonlEvents(logPath);
    assert.equal(remaining.length, 2, "both M002 events must remain in active log");
    assert.ok(
      remaining.every((e) => (e.params as { milestoneId?: string }).milestoneId === "M002"),
      "all remaining events must belong to M002",
    );
  });

  it("Test 6: empty event log returns { archived: 0 }, no archive file created", () => {
    // Create an empty log file
    writeFileSync(logPath, "", "utf-8");

    const result = compactMilestoneEvents(tempDir, "M001");

    assert.deepEqual(result, { archived: 0 });
    assert.ok(!existsSync(archivePath), "no archive file should be created for empty log");
  });

  it("Test 7: all events belong to M001 — archive gets all, active log becomes empty", () => {
    writeEvents(logPath, [M001_EVENT_1, M001_EVENT_2]);

    const result = compactMilestoneEvents(tempDir, "M001");

    assert.deepEqual(result, { archived: 2 });
    assert.ok(existsSync(archivePath), "archive file must exist");
    const archived = readJsonlEvents(archivePath);
    assert.equal(archived.length, 2, "archive must contain all 2 events");
    // Active log should be empty (empty string or whitespace-only)
    const activeContent = readFileSync(logPath, "utf-8");
    assert.equal(activeContent.trim(), "", "active log must be empty string after full compaction");
  });
});
