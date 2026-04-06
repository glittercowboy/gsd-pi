// GSD Extension — Workflow Logger Tests
// Tests for the centralized warning/error accumulator.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanup } from "./test-utils.ts";
import {
  logWarning,
  logError,
  drainLogs,
  drainAndSummarize,
  peekLogs,
  hasErrors,
  hasWarnings,
  hasAnyIssues,
  summarizeLogs,
  formatForNotification,
  setLogBasePath,
  _resetLogs,
} from "../workflow-logger.ts";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("workflow-logger", () => {
  beforeEach(() => {
    _resetLogs();
  });

  describe("accumulation", () => {
    test("logWarning adds an entry with severity warn", () => {
      logWarning("engine", "test warning");
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "warn");
      assert.equal(entries[0].component, "engine");
      assert.equal(entries[0].message, "test warning");
      assert.match(entries[0].ts, ISO_RE);
    });

    test("logError adds an entry with severity error", () => {
      logError("intercept", "blocked write", { path: "/foo/STATE.md" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "intercept");
      assert.deepEqual(entries[0].context, { path: "/foo/STATE.md" });
    });

    test("accumulates multiple entries in order", () => {
      logWarning("projection", "render failed");
      logError("intercept", "blocked write");
      logWarning("manifest", "write failed");
      assert.equal(peekLogs().length, 3);
      assert.equal(peekLogs()[0].component, "projection");
      assert.equal(peekLogs()[1].component, "intercept");
      assert.equal(peekLogs()[2].component, "manifest");
    });

    test("omits context field when not provided", () => {
      logWarning("engine", "no context");
      assert.equal("context" in peekLogs()[0], false);
    });

    test("omits context field when undefined is passed", () => {
      logWarning("engine", "no context", undefined);
      assert.equal("context" in peekLogs()[0], false);
    });

    test("context with special characters is stored as-is", () => {
      logError("tool", "failed", { path: '/foo/"quoted".md', msg: "line1\nline2" });
      assert.deepEqual(peekLogs()[0].context, {
        path: '/foo/"quoted".md',
        msg: "line1\nline2",
      });
    });

    test("ts field is a valid ISO 8601 timestamp", () => {
      logWarning("engine", "ts check");
      assert.match(peekLogs()[0].ts, ISO_RE);
    });
  });

  describe("drain", () => {
    test("returns all entries and clears buffer", () => {
      logWarning("engine", "w1");
      logError("engine", "e1");
      const drained = drainLogs();
      assert.equal(drained.length, 2);
      assert.equal(peekLogs().length, 0);
    });

    test("returns empty array when no entries", () => {
      assert.deepEqual(drainLogs(), []);
    });

    test("second drain returns empty array", () => {
      logWarning("engine", "w1");
      drainLogs();
      assert.deepEqual(drainLogs(), []);
    });
  });

  describe("drainAndSummarize", () => {
    test("returns summary and clears buffer atomically", () => {
      logError("intercept", "blocked");
      logWarning("projection", "render failed");
      const { logs, summary } = drainAndSummarize();
      assert.equal(logs.length, 2);
      assert.equal(peekLogs().length, 0);
      assert.ok(summary?.includes("1 error(s)"));
      assert.ok(summary?.includes("1 warning(s)"));
    });

    test("returns null summary when buffer is empty", () => {
      const { logs, summary } = drainAndSummarize();
      assert.deepEqual(logs, []);
      assert.equal(summary, null);
    });
  });

  describe("hasErrors / hasWarnings / hasAnyIssues", () => {
    test("hasErrors returns false when only warnings", () => {
      logWarning("engine", "just a warning");
      assert.equal(hasErrors(), false);
      assert.equal(hasWarnings(), true);
    });

    test("hasErrors returns true when errors present", () => {
      logWarning("engine", "warning");
      logError("intercept", "error");
      assert.equal(hasErrors(), true);
    });

    test("hasWarnings returns false when buffer empty", () => {
      assert.equal(hasWarnings(), false);
    });

    test("hasWarnings returns false when buffer contains only errors", () => {
      logError("intercept", "only an error");
      assert.equal(hasWarnings(), false);
      assert.equal(hasErrors(), true);
    });

    test("hasAnyIssues returns true for warnings only", () => {
      logWarning("engine", "warn");
      assert.equal(hasAnyIssues(), true);
    });

    test("hasAnyIssues returns true for errors only", () => {
      logError("engine", "err");
      assert.equal(hasAnyIssues(), true);
    });

    test("hasAnyIssues returns false when buffer empty", () => {
      assert.equal(hasAnyIssues(), false);
    });
  });

  describe("summarizeLogs", () => {
    test("returns null when empty", () => {
      assert.equal(summarizeLogs(), null);
    });

    test("summarizes errors and warnings separately", () => {
      logError("intercept", "blocked STATE.md");
      logWarning("projection", "render failed");
      logWarning("manifest", "write failed");
      const summary = summarizeLogs()!;
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(summary.includes("blocked STATE.md"));
      assert.ok(summary.includes("2 warning(s)"));
    });

    test("only shows errors section when no warnings", () => {
      logError("intercept", "blocked");
      const summary = summarizeLogs()!;
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(!summary.includes("warning"));
    });

    test("only shows warnings section when no errors", () => {
      logWarning("projection", "render degraded");
      logWarning("manifest", "write slow");
      const summary = summarizeLogs()!;
      assert.ok(summary.includes("2 warning(s)"));
      assert.ok(!summary.includes("error"));
    });

    test("does not clear buffer", () => {
      logError("intercept", "blocked");
      summarizeLogs();
      assert.equal(peekLogs().length, 1);
    });
  });

  describe("formatForNotification", () => {
    test("returns empty string for empty array", () => {
      assert.equal(formatForNotification([]), "");
    });

    test("formats single entry without line breaks", () => {
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[intercept] blocked write");
    });

    test("formats multiple entries with line breaks", () => {
      logWarning("projection", "render failed");
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("[projection] render failed"));
      assert.ok(formatted.includes("[intercept] blocked write"));
      assert.ok(formatted.includes("\n"));
    });

    test("includes context fields in formatted output", () => {
      logError("tool", "failed", { cmd: "complete_task" });
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[tool] failed (cmd: complete_task)");
    });

    test("excludes error key from context to avoid redundancy", () => {
      logError("tool", "disk write failed", { error: "ENOSPC", path: "/tmp/foo" });
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("path: /tmp/foo"));
      assert.ok(!formatted.includes("error: ENOSPC"));
    });

    test("formats entry without context unchanged", () => {
      logError("intercept", "blocked write");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.equal(formatted, "[intercept] blocked write");
    });
  });

  describe("audit log persistence", () => {
    let dir: string;

    beforeEach(() => {
      dir = makeTempDir("wl-audit-");
    });

    afterEach(() => {
      setLogBasePath("");
      cleanup(dir);
    });

    test("writes entry to .gsd/audit-log.jsonl after setLogBasePath", () => {
      setLogBasePath(dir);
      logError("engine", "audit test entry");

      const auditPath = join(dir, ".gsd", "audit-log.jsonl");
      assert.ok(existsSync(auditPath), "audit-log.jsonl should exist");
      const content = readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());
      assert.equal(entry.severity, "error");
      assert.equal(entry.component, "engine");
      assert.equal(entry.message, "audit test entry");
    });

    test("_resetLogs does not clear the audit base path", () => {
      setLogBasePath(dir);
      _resetLogs();
      logError("engine", "post-reset entry");

      const auditPath = join(dir, ".gsd", "audit-log.jsonl");
      assert.ok(existsSync(auditPath), "audit-log.jsonl should exist after _resetLogs");
      const content = readFileSync(auditPath, "utf-8");
      const entry = JSON.parse(content.trim());
      assert.equal(entry.message, "post-reset entry");
    });
  });

  describe("buffer limit", () => {
    test("caps at MAX_BUFFER entries, dropping oldest", () => {
      const OVER = 110;
      const MAX = 100;
      for (let i = 0; i < OVER; i++) {
        logWarning("engine", `msg-${i}`);
      }
      const entries = peekLogs();
      assert.equal(entries.length, MAX);
      // First MAX entries dropped; oldest surviving = msg-(OVER-MAX)
      assert.equal(entries[0].message, `msg-${OVER - MAX}`);
      assert.equal(entries[MAX - 1].message, `msg-${OVER - 1}`);
    });
  });

  describe("new log components (db, dispatch)", () => {
    test("logError with 'db' component stores correct component", () => {
      logError("db", "failed to copy DB to worktree", { error: "ENOENT" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "db");
      assert.equal(entries[0].message, "failed to copy DB to worktree");
      assert.deepEqual(entries[0].context, { error: "ENOENT" });
    });

    test("logError with 'dispatch' component stores correct component", () => {
      logError("dispatch", "reactive graph derivation failed", { error: "timeout" });
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "error");
      assert.equal(entries[0].component, "dispatch");
      assert.deepEqual(entries[0].context, { error: "timeout" });
    });

    test("logWarning with 'reconcile' component for centralized logging path", () => {
      logWarning("reconcile", "could not acquire sync lock — another reconciliation may be in progress");
      const entries = peekLogs();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].severity, "warn");
      assert.equal(entries[0].component, "reconcile");
    });

    test("summarizeLogs includes db and dispatch entries", () => {
      logError("db", "worktree DB reconciliation failed: path contains unsafe characters");
      logWarning("dispatch", "graph derivation timeout");
      const summary = summarizeLogs()!;
      assert.ok(summary.includes("1 error(s)"));
      assert.ok(summary.includes("1 warning(s)"));
      assert.ok(summary.includes("unsafe characters"));
      assert.ok(summary.includes("graph derivation timeout"));
    });

    test("formatForNotification renders db and dispatch components", () => {
      logError("db", "copy failed");
      logWarning("dispatch", "slow derivation");
      const entries = drainLogs();
      const formatted = formatForNotification(entries);
      assert.ok(formatted.includes("[db] copy failed"));
      assert.ok(formatted.includes("[dispatch] slow derivation"));
    });
  });

  describe("stderr output", () => {
    test("writes WARN prefix to stderr for warnings", (t) => {
      const written: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      // @ts-ignore — patching for test
      process.stderr.write = (chunk: string) => { written.push(chunk); return true; };
      t.after(() => { process.stderr.write = orig; });

      logWarning("engine", "test warn");
      assert.equal(written.length, 1);
      assert.ok(written[0].includes("[gsd:engine] WARN: test warn"));
    });

    test("writes ERROR prefix to stderr for errors", (t) => {
      const written: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      // @ts-ignore — patching for test
      process.stderr.write = (chunk: string) => { written.push(chunk); return true; };
      t.after(() => { process.stderr.write = orig; });

      logError("intercept", "blocked");
      assert.ok(written[0].includes("[gsd:intercept] ERROR: blocked"));
    });

    test("includes serialized context in stderr output", (t) => {
      const written: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      // @ts-ignore — patching for test
      process.stderr.write = (chunk: string) => { written.push(chunk); return true; };
      t.after(() => { process.stderr.write = orig; });

      logError("tool", "failed", { cmd: "complete_task" });
      assert.ok(written[0].includes('"cmd":"complete_task"'));
    });
  });
});
