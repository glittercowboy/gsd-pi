// GSD Extension — Workflow Logger Audit Persistence Tests
// Validates error-only persistence, sanitization, and warning ephemeral behavior.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  logWarning,
  logError,
  setLogBasePath,
  _resetLogs,
  peekLogs,
  drainLogs,
} from "../workflow-logger.ts";

function createTempProject(): string {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-wflog-test-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  return tmp;
}

function readAuditLines(basePath: string): Record<string, unknown>[] {
  const auditPath = join(basePath, ".gsd", "audit-log.jsonl");
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

describe("workflow-logger audit persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempProject();
    _resetLogs();
    setLogBasePath(tmp);
  });

  afterEach(() => {
    _resetLogs();
    setLogBasePath(null as unknown as string);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("logError persists to audit-log.jsonl", () => {
    logError("engine", "something broke");
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].severity, "error");
    assert.equal(lines[0].component, "engine");
  });

  test("logWarning does NOT persist to audit-log.jsonl", () => {
    logWarning("engine", "something fishy");
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 0, "warnings must not be persisted to audit log");
  });

  test("logWarning still appears in in-memory buffer", () => {
    logWarning("recovery", "probe miss");
    const entries = peekLogs();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].severity, "warn");
    assert.equal(entries[0].component, "recovery");
  });

  test("persisted error messages are truncated at 200 chars", () => {
    const longMessage = "x".repeat(300);
    logError("engine", longMessage);
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const msg = lines[0].message as string;
    assert.ok(msg.length <= 215, `message should be truncated, got ${msg.length} chars`);
    assert.ok(msg.endsWith("…[truncated]"));
  });

  test("persisted errors have context filtered to safe allowlist", () => {
    logError("tool", "tool failed", {
      fn: "saveDecisionToDb",
      tool: "gsd_decision_save",
      error: "SQLITE_BUSY: database is locked",
      file: "/home/user/project/gsd.db",
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const ctx = lines[0].context as Record<string, string>;
    assert.ok(ctx, "context should exist");
    assert.equal(ctx.fn, "saveDecisionToDb");
    assert.equal(ctx.tool, "gsd_decision_save");
    assert.equal(ctx.error, "SQLITE_BUSY: database is locked", "error key should be preserved in persisted context");
    assert.equal(ctx.file, undefined, "file key must be stripped from persisted context");
  });

  test("persisted errors preserve error key but strip other unsafe keys", () => {
    logError("bootstrap", "ensureDbOpen failed", {
      error: "ENOENT",
      cwd: "/home/user/project",
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const ctx = lines[0].context as Record<string, string>;
    assert.ok(ctx, "context should exist when error key is present");
    assert.equal(ctx.error, "ENOENT", "error key should be preserved");
    assert.equal(ctx.cwd, undefined, "cwd key must be stripped");
  });

  test("mixed warnings and errors only persist errors", () => {
    logWarning("recovery", "main not found");
    logWarning("recovery", "master not found");
    logError("engine", "fatal failure");
    logWarning("prompt", "cache miss");

    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1, "only the error should be persisted");
    assert.equal(lines[0].severity, "error");

    const buffered = drainLogs();
    assert.equal(buffered.length, 4, "all entries should be in the in-memory buffer");
  });
});
