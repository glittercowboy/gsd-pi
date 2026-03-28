import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventLog, getEventLogDir } from "../event-log.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "event-log-test-"));
}

async function collectEntries(gen: AsyncIterable<{ seq: number; event: unknown; ts: string }>) {
  const entries: { seq: number; event: unknown; ts: string }[] = [];
  for await (const entry of gen) {
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventLog", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    log = new EventLog(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- init ---

  test("init() on a non-existent file starts seq at 0", async () => {
    await log.init();
    assert.equal(log.currentSeq, 0);
  });

  test("init() restores seq from last valid line of existing log file", async () => {
    // Write a stub log with some entries
    const lines = [
      JSON.stringify({ seq: 10, event: { type: "a" }, ts: "2024-01-01T00:00:00.000Z" }),
      JSON.stringify({ seq: 20, event: { type: "b" }, ts: "2024-01-01T00:00:01.000Z" }),
      JSON.stringify({ seq: 42, event: { type: "c" }, ts: "2024-01-01T00:00:02.000Z" }),
    ].join("\n") + "\n";
    writeFileSync(join(tmpDir, "events.jsonl"), lines);

    await log.init();
    assert.equal(log.currentSeq, 42);
  });

  test("init() with a truncated/malformed last line restores seq from last valid line", async () => {
    const lines = [
      JSON.stringify({ seq: 5, event: { type: "a" }, ts: "2024-01-01T00:00:00.000Z" }),
      JSON.stringify({ seq: 7, event: { type: "b" }, ts: "2024-01-01T00:00:01.000Z" }),
      '{"seq":99,"event":{"type":"c"},"ts":"TRUNCATED', // malformed — no closing
    ].join("\n") + "\n";
    writeFileSync(join(tmpDir, "events.jsonl"), lines);

    await log.init();
    assert.equal(log.currentSeq, 7);
  });

  // --- append ---

  test("append() writes a JSON line with seq and event fields", async () => {
    await log.init();
    log.append({ type: "test_event", data: "hello" });

    const content = readFileSync(join(tmpDir, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.seq, 1);
    assert.deepEqual(parsed.event, { type: "test_event", data: "hello" });
    assert.ok(typeof parsed.ts === "string");
  });

  test("append() increments seq monotonically", async () => {
    await log.init();
    log.append({ type: "e1" });
    log.append({ type: "e2" });
    log.append({ type: "e3" });

    const content = readFileSync(join(tmpDir, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).seq, 1);
    assert.equal(JSON.parse(lines[1]).seq, 2);
    assert.equal(JSON.parse(lines[2]).seq, 3);
  });

  test("append() continues seq from restored value after init", async () => {
    const existingLines = [
      JSON.stringify({ seq: 42, event: { type: "x" }, ts: "2024-01-01T00:00:00.000Z" }),
    ].join("\n") + "\n";
    writeFileSync(join(tmpDir, "events.jsonl"), existingLines);

    await log.init();
    log.append({ type: "new" });

    const content = readFileSync(join(tmpDir, "events.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).seq, 43);
  });

  test("append() catches write errors gracefully (does not throw)", async () => {
    await log.init();

    // Make log file read-only to simulate write error — skip if root
    const logPath = join(tmpDir, "events.jsonl");
    // Write a valid entry first so the file exists
    log.append({ type: "first" });
    chmodSync(logPath, 0o444);

    // Should not throw even though file is read-only
    try {
      assert.doesNotThrow(() => log.append({ type: "second" }));
    } finally {
      chmodSync(logPath, 0o644);
    }
  });

  // --- currentSeq ---

  test("currentSeq getter returns the current sequence number", async () => {
    await log.init();
    assert.equal(log.currentSeq, 0);
    log.append({ type: "a" });
    assert.equal(log.currentSeq, 1);
    log.append({ type: "b" });
    assert.equal(log.currentSeq, 2);
  });

  // --- filePath ---

  test("filePath getter returns path to events.jsonl inside logDir", async () => {
    assert.equal(log.filePath, join(tmpDir, "events.jsonl"));
  });

  // --- readSince ---

  test("readSince(5) returns only entries with seq > 5", async () => {
    await log.init();
    for (let i = 0; i < 10; i++) {
      log.append({ type: `event_${i}` });
    }

    const entries = await collectEntries(log.readSince(5));
    assert.equal(entries.length, 5);
    assert.equal(entries[0].seq, 6);
    assert.equal(entries[4].seq, 10);
  });

  test("readSince(0) returns all entries", async () => {
    await log.init();
    log.append({ type: "a" });
    log.append({ type: "b" });

    const entries = await collectEntries(log.readSince(0));
    assert.equal(entries.length, 2);
  });

  test("readSince(-1) returns no entries (skip replay)", async () => {
    await log.init();
    log.append({ type: "a" });
    log.append({ type: "b" });

    const entries = await collectEntries(log.readSince(-1));
    assert.equal(entries.length, 0);
  });

  test("readSince() on empty/missing file returns empty", async () => {
    await log.init();
    const entries = await collectEntries(log.readSince(0));
    assert.equal(entries.length, 0);
  });

  test("readSince() skips malformed lines silently", async () => {
    await log.init();
    log.append({ type: "a" });
    // Inject a malformed line
    const logPath = join(tmpDir, "events.jsonl");
    const current = readFileSync(logPath, "utf-8");
    writeFileSync(logPath, current + "NOT_JSON\n");
    log.append({ type: "b" });

    const entries = await collectEntries(log.readSince(0));
    // Should get 2 valid entries, malformed line skipped
    assert.equal(entries.length, 2);
  });

  // --- oldestSeq ---

  test("oldestSeq() returns seq of first line", async () => {
    await log.init();
    for (let i = 0; i < 5; i++) {
      log.append({ type: `e_${i}` });
    }
    const oldest = await log.oldestSeq();
    assert.equal(oldest, 1);
  });

  test("oldestSeq() returns null for missing/empty file", async () => {
    await log.init();
    const oldest = await log.oldestSeq();
    assert.equal(oldest, null);
  });

  // --- rotateIfNeeded ---

  test("rotateIfNeeded() with file < 50MB does nothing", async () => {
    await log.init();
    log.append({ type: "small" });
    const sizeBefore = statSync(join(tmpDir, "events.jsonl")).size;
    await log.rotateIfNeeded();
    const sizeAfter = statSync(join(tmpDir, "events.jsonl")).size;
    assert.equal(sizeBefore, sizeAfter);
  });

  test("rotateIfNeeded() with file > 50MB truncates to ~10MB keeping newest entries", async () => {
    await log.init();

    // Write a large synthetic file (>50MB) directly to bypass append counter
    const logPath = join(tmpDir, "events.jsonl");

    // Build entries: 60MB worth of data
    const lines: string[] = [];
    let totalBytes = 0;
    let seq = 1;
    while (totalBytes < 52 * 1024 * 1024) {
      const line = JSON.stringify({ seq, event: { type: "bulk", data: "x".repeat(500) }, ts: new Date().toISOString() });
      lines.push(line);
      totalBytes += Buffer.byteLength(line + "\n");
      seq++;
    }
    writeFileSync(logPath, lines.join("\n") + "\n");

    // Patch internal seq to match
    // We can't access private fields, so just test on the file directly
    await log.rotateIfNeeded();

    const sizeAfter = statSync(logPath).size;
    // Should be less than 50MB now
    assert.ok(sizeAfter < 50 * 1024 * 1024, `Expected size < 50MB, got ${sizeAfter}`);
    // Should still have some content (around 10MB)
    assert.ok(sizeAfter > 0, "File should not be empty after rotation");
  });

  test("after rotation, all remaining lines are valid JSON (no truncated lines)", async () => {
    await log.init();
    const logPath = join(tmpDir, "events.jsonl");

    // Create a >50MB file
    const lines: string[] = [];
    let totalBytes = 0;
    let seq = 1;
    while (totalBytes < 52 * 1024 * 1024) {
      const line = JSON.stringify({ seq, event: { type: "bulk", data: "x".repeat(200) }, ts: new Date().toISOString() });
      lines.push(line);
      totalBytes += Buffer.byteLength(line + "\n");
      seq++;
    }
    writeFileSync(logPath, lines.join("\n") + "\n");

    await log.rotateIfNeeded();

    const content = readFileSync(logPath, "utf-8");
    const remaining = content.trim().split("\n").filter(l => l.length > 0);
    assert.ok(remaining.length > 0, "Should have remaining entries after rotation");
    for (const line of remaining) {
      assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line.slice(0, 80)}`);
    }
  });

  test("rotation uses atomic rename — .tmp file does not persist after rotation", async () => {
    await log.init();
    const logPath = join(tmpDir, "events.jsonl");
    const tmpPath = logPath + ".tmp";

    // Create >50MB file
    const lines: string[] = [];
    let totalBytes = 0;
    let seq = 1;
    while (totalBytes < 52 * 1024 * 1024) {
      const line = JSON.stringify({ seq, event: { type: "bulk", data: "x".repeat(200) }, ts: new Date().toISOString() });
      lines.push(line);
      totalBytes += Buffer.byteLength(line + "\n");
      seq++;
    }
    writeFileSync(logPath, lines.join("\n") + "\n");

    await log.rotateIfNeeded();

    // .tmp file should not exist after rotation completes
    let tmpExists = false;
    try {
      statSync(tmpPath);
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    assert.equal(tmpExists, false, ".tmp file should not persist after rotation");
  });

  test("append() triggers inline rotation check after 100 appends when file exceeds threshold", async () => {
    await log.init();
    const logPath = join(tmpDir, "events.jsonl");

    // Pre-write a >50MB file so that when the 100th append triggers the check, rotation occurs
    const lines: string[] = [];
    let totalBytes = 0;
    let seq = 1;
    while (totalBytes < 52 * 1024 * 1024) {
      const line = JSON.stringify({ seq, event: { type: "bulk", data: "x".repeat(200) }, ts: new Date().toISOString() });
      lines.push(line);
      totalBytes += Buffer.byteLength(line + "\n");
      seq++;
    }
    writeFileSync(logPath, lines.join("\n") + "\n");

    // Do 99 appends — no rotation yet (counter resets at 100)
    for (let i = 0; i < 99; i++) {
      log.append({ type: "pre" });
    }

    const sizeBefore = statSync(logPath).size;

    // 100th append triggers the inline check
    log.append({ type: "trigger" });

    // Wait briefly for async rotation to fire (fire-and-forget)
    await new Promise(resolve => setTimeout(resolve, 200));

    const sizeAfter = statSync(logPath).size;
    // File should have been rotated (size decreased significantly)
    assert.ok(sizeAfter < sizeBefore, `Expected rotation to reduce file size (before: ${sizeBefore}, after: ${sizeAfter})`);
  });

  // --- dispose ---

  test("dispose() does not throw", async () => {
    await log.init();
    assert.doesNotThrow(() => log.dispose());
  });
});

// ---------------------------------------------------------------------------
// getEventLogDir
// ---------------------------------------------------------------------------

describe("getEventLogDir", () => {
  test("returns a path under appRoot/web-events/<hash>", () => {
    const dir = getEventLogDir("/some/project/path");
    assert.ok(dir.includes("web-events"), `Expected 'web-events' in path: ${dir}`);
    // Should have a 16-char hex segment
    const parts = dir.split("/");
    const lastPart = parts[parts.length - 1];
    assert.match(lastPart, /^[0-9a-f]{16}$/);
  });

  test("returns consistent path for same projectCwd", () => {
    const dir1 = getEventLogDir("/my/project");
    const dir2 = getEventLogDir("/my/project");
    assert.equal(dir1, dir2);
  });

  test("returns different path for different projectCwd", () => {
    const dir1 = getEventLogDir("/project/a");
    const dir2 = getEventLogDir("/project/b");
    assert.notEqual(dir1, dir2);
  });
});
