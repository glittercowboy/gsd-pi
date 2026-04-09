import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleLogs } from "../commands-logs.ts";

// ─── Test helpers ───────────────────────────────────────────────────────────

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-logs-test-"));
  mkdirSync(join(dir, ".gsd", "activity"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "debug"), { recursive: true });
  return dir;
}

function createMockCtx(): { notifications: Array<{ msg: string; level: string }>; ui: any } {
  const notifications: Array<{ msg: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify(msg: string, level: string) { notifications.push({ msg, level }); },
      setStatus() {},
      setWidget() {},
      setFooter() {},
    },
  };
}

function writeActivityLog(dir: string, seq: number, unitType: string, unitId: string, entries: Record<string, unknown>[]): void {
  const safeId = unitId.replace(/\//g, "-");
  const filename = `${String(seq).padStart(3, "0")}-${unitType}-${safeId}.jsonl`;
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, ".gsd", "activity", filename), content);
}

function writeDebugLog(dir: string, name: string, entries: Record<string, unknown>[]): void {
  const content = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, ".gsd", "debug", name), content);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("logs shows empty state message when no logs exist", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].msg.includes("No logs found"));
});

test("logs lists activity logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: false },
  ]);
  writeActivityLog(dir, 2, "complete-slice", "M001/S01", [
    { role: "assistant", content: "Completing slice S01" },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Activity Logs"), "should show activity logs header");
  assert.ok(msg.includes("execute-task"), "should show unit type");
  assert.ok(msg.includes("complete-slice"), "should show second log");
  assert.ok(msg.includes("/gsd logs <#>"), "should show usage hint");
});

test("logs <N> shows activity log details", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    { type: "toolCall", name: "write", arguments: { file_path: "/tmp/test.ts" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: false },
    { role: "toolResult", toolCallId: "2", toolName: "write", isError: true },
    { role: "assistant", content: "I ran the tests and wrote a file" },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("1", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Activity Log #1"), "should show log number");
  assert.ok(msg.includes("execute-task"), "should show unit type");
  assert.ok(msg.includes("Tool calls: 2"), "should count tool calls");
  assert.ok(msg.includes("Errors: 1"), "should count errors");
  assert.ok(msg.includes("/tmp/test.ts"), "should show files written");
  assert.ok(msg.includes("npm test"), "should show commands run");
});

test("logs <N> shows not found for invalid seq", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("999", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(ctx.notifications[0].msg.includes("not found"));
  assert.equal(ctx.notifications[0].level, "warning");
});

test("logs debug lists debug logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeDebugLog(dir, "debug-2026-03-18T10-30-00.log", [
    { ts: "2026-03-18T10:30:00Z", event: "debug-start", platform: "darwin" },
    { ts: "2026-03-18T10:35:00Z", event: "debug-summary", dispatches: 5 },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("debug", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Debug Logs"), "should show debug logs header");
  assert.ok(msg.includes("debug-2026-03-18T10-30-00.log"), "should show filename");
});

test("logs debug <N> shows debug log summary", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeDebugLog(dir, "debug-2026-03-18T10-30-00.log", [
    { ts: "2026-03-18T10:30:00Z", event: "debug-start", platform: "darwin" },
    { ts: "2026-03-18T10:30:05Z", event: "dispatch-error", error: "missing plan" },
    { ts: "2026-03-18T10:35:00Z", event: "debug-summary", dispatches: 5 },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("debug 1", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Debug Log:"), "should show debug log header");
  assert.ok(msg.includes("Events: 3"), "should count events");
  assert.ok(msg.includes("Dispatches: 5"), "should show dispatch count");
  assert.ok(msg.includes("dispatch-error"), "should show errors");
});

test("logs tail shows recent activity summaries", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [
    { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
  ]);
  writeActivityLog(dir, 2, "execute-task", "M001/S01/T02", [
    { type: "toolCall", name: "bash", arguments: { command: "npm build" } },
    { role: "toolResult", toolCallId: "1", toolName: "bash", isError: true },
  ]);

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("tail 2", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  const msg = ctx.notifications[0].msg;
  assert.ok(msg.includes("Last 2 activity log(s)"), "should show count");
  assert.ok(msg.includes("#1"), "should show first log");
  assert.ok(msg.includes("#2"), "should show second log");
});

test("logs clear removes old logs", async (t) => {
  const dir = createTestDir();
  const ctx = createMockCtx();
  const origCwd = process.cwd();
  process.chdir(dir);

  // Create an old activity log (modify mtime to 10 days ago)
  writeActivityLog(dir, 1, "execute-task", "M001/S01/T01", [{ type: "toolCall" }]);
  const oldFile = join(dir, ".gsd", "activity", "001-execute-task-M001-S01-T01.jsonl");
  const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, oldTime, oldTime);

  // Create 6 recent activity logs so the old one is outside the "keep 5" window
  for (let i = 2; i <= 7; i++) {
    writeActivityLog(dir, i, "execute-task", `M001/S01/T0${i}`, [{ type: "toolCall" }]);
  }

  t.after(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  await handleLogs("clear", ctx as any);
  assert.equal(ctx.notifications.length, 1);
  // Old log should be removed, recent ones kept
  assert.ok(!existsSync(oldFile), "old log should be removed");
  assert.ok(
    existsSync(join(dir, ".gsd", "activity", "007-execute-task-M001-S01-T07.jsonl")),
    "most recent log should be kept",
  );
});
