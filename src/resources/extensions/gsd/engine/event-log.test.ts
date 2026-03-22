// GSD Extension — Event Log Unit Tests
// Tests for appendEvent, readEvents, findForkPoint, and WorkflowEngine afterCommand wiring.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.ts";
import type { DbAdapter } from "../gsd-db.ts";
import { appendEvent, readEvents, findForkPoint } from "../workflow-events.ts";
import type { WorkflowEvent } from "../workflow-events.ts";
import { WorkflowEngine } from "../workflow-engine.ts";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("workflow-events", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gsd-events-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("appendEvent()", () => {
    it("writes one JSON line to event-log.jsonl", () => {
      appendEvent(tempDir, {
        cmd: "complete_task",
        params: { taskId: "T01" },
        ts: "2026-01-01T00:00:00Z",
        actor: "agent",
      });

      const logPath = join(tempDir, ".gsd", "event-log.jsonl");
      assert.ok(existsSync(logPath), "event-log.jsonl must exist");

      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 1);

      const event = JSON.parse(lines[0]!) as WorkflowEvent;
      assert.equal(event.cmd, "complete_task");
    });

    it("includes cmd, params, ts, hash, actor fields per D-10", () => {
      appendEvent(tempDir, {
        cmd: "start_task",
        params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
        ts: "2026-01-01T00:00:00Z",
        actor: "agent",
      });

      const content = readFileSync(join(tempDir, ".gsd", "event-log.jsonl"), "utf-8");
      const event = JSON.parse(content.trim()) as WorkflowEvent;

      assert.equal(event.cmd, "start_task");
      assert.deepEqual(event.params, { milestoneId: "M001", sliceId: "S01", taskId: "T01" });
      assert.equal(event.ts, "2026-01-01T00:00:00Z");
      assert.equal(event.actor, "agent");
      assert.ok(event.hash, "hash must be present");
    });

    it("hash is a hex string derived from cmd+params content", () => {
      appendEvent(tempDir, {
        cmd: "complete_task",
        params: { taskId: "T01" },
        ts: "2026-01-01T00:00:00Z",
        actor: "agent",
      });

      const content = readFileSync(join(tempDir, ".gsd", "event-log.jsonl"), "utf-8");
      const event = JSON.parse(content.trim()) as WorkflowEvent;

      // Hash should be 16-char hex
      assert.ok(/^[0-9a-f]{16}$/.test(event.hash), `hash must be 16-char hex, got: ${event.hash}`);

      // Same cmd+params should produce same hash (deterministic)
      appendEvent(tempDir, {
        cmd: "complete_task",
        params: { taskId: "T01" },
        ts: "2026-02-01T00:00:00Z", // different ts
        actor: "system", // different actor
      });

      const allContent = readFileSync(join(tempDir, ".gsd", "event-log.jsonl"), "utf-8");
      const lines = allContent.split("\n").filter((l) => l.length > 0);
      const event2 = JSON.parse(lines[1]!) as WorkflowEvent;

      assert.equal(event.hash, event2.hash, "same cmd+params should produce same hash regardless of ts/actor");
    });
  });

  describe("readEvents()", () => {
    it("reads all events from JSONL file and returns typed array", () => {
      appendEvent(tempDir, { cmd: "start_task", params: { taskId: "T01" }, ts: "2026-01-01T00:00:00Z", actor: "agent" });
      appendEvent(tempDir, { cmd: "complete_task", params: { taskId: "T01" }, ts: "2026-01-01T01:00:00Z", actor: "agent" });

      const logPath = join(tempDir, ".gsd", "event-log.jsonl");
      const events = readEvents(logPath);

      assert.equal(events.length, 2);
      assert.equal(events[0]!.cmd, "start_task");
      assert.equal(events[1]!.cmd, "complete_task");
    });

    it("returns empty array when file does not exist", () => {
      const events = readEvents(join(tempDir, ".gsd", "nonexistent.jsonl"));
      assert.deepEqual(events, []);
    });
  });

  describe("findForkPoint()", () => {
    it("returns last event index for two identical logs", () => {
      const events: WorkflowEvent[] = [
        { cmd: "start_task", params: { taskId: "T01" }, ts: "2026-01-01T00:00:00Z", hash: "aaaa000000000001", actor: "agent" },
        { cmd: "complete_task", params: { taskId: "T01" }, ts: "2026-01-01T01:00:00Z", hash: "bbbb000000000002", actor: "agent" },
      ];
      assert.equal(findForkPoint(events, [...events]), 1);
    });

    it("returns index of last common event for diverged logs", () => {
      const common: WorkflowEvent = { cmd: "start_task", params: { taskId: "T01" }, ts: "2026-01-01T00:00:00Z", hash: "aaaa000000000001", actor: "agent" };
      const logA: WorkflowEvent[] = [
        common,
        { cmd: "complete_task", params: { taskId: "T01" }, ts: "2026-01-01T01:00:00Z", hash: "bbbb000000000002", actor: "agent" },
      ];
      const logB: WorkflowEvent[] = [
        common,
        { cmd: "report_blocker", params: { taskId: "T01" }, ts: "2026-01-01T01:00:00Z", hash: "cccc000000000003", actor: "agent" },
      ];
      assert.equal(findForkPoint(logA, logB), 0);
    });

    it("returns -1 for completely different logs", () => {
      const logA: WorkflowEvent[] = [
        { cmd: "start_task", params: { taskId: "T01" }, ts: "2026-01-01T00:00:00Z", hash: "aaaa000000000001", actor: "agent" },
      ];
      const logB: WorkflowEvent[] = [
        { cmd: "complete_task", params: { taskId: "T02" }, ts: "2026-01-01T00:00:00Z", hash: "bbbb000000000002", actor: "agent" },
      ];
      assert.equal(findForkPoint(logA, logB), -1);
    });
  });

  describe("WorkflowEngine afterCommand wiring", () => {
    let db: DbAdapter;

    beforeEach(() => {
      openDatabase(":memory:");
      db = _getAdapter()!;
      assert.ok(db, "DB adapter must be available");

      // Seed test data for completeTask to work
      db.prepare(
        `INSERT INTO milestones (id, title, status, created_at)
         VALUES ('M001', 'Test Milestone', 'active', '2026-01-01T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO slices (id, milestone_id, title, status, risk, depends_on, created_at, seq)
         VALUES ('S01', 'M001', 'Test Slice', 'active', 'low', '[]', '2026-01-01T00:00:00Z', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, slice_id, milestone_id, title, description, status, estimate, files, seq)
         VALUES ('T01', 'S01', 'M001', 'Task One', 'Do thing one', 'in-progress', '1h', '[]', 0)`,
      ).run();
    });

    afterEach(() => {
      closeDatabase();
    });

    it("WorkflowEngine.completeTask calls writeManifest and appendEvent after DB write", () => {
      const engine = new WorkflowEngine(tempDir);
      engine.completeTask({
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        summary: "Done",
      });

      // Check manifest was written
      const manifestPath = join(tempDir, ".gsd", "state-manifest.json");
      assert.ok(existsSync(manifestPath), "state-manifest.json must exist after completeTask");

      // Check event was logged
      const eventPath = join(tempDir, ".gsd", "event-log.jsonl");
      assert.ok(existsSync(eventPath), "event-log.jsonl must exist after completeTask");

      const events = readEvents(eventPath);
      assert.ok(events.length >= 1, "at least one event must be logged");
      assert.equal(events[events.length - 1]!.cmd, "complete_task");
    });
  });
});
