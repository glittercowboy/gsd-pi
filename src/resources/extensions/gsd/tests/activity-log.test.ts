/**
 * Activity log tests — consolidated from:
 *   - activity-log-prune.test.ts (age-based pruning with highest-seq preservation)
 *   - activity-log-save.test.ts (caching, dedup, collision recovery)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { pruneActivityLogs, saveActivityLog } from "../activity-log.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-activity-test-")));
}

function writeActivityFile(dir: string, seq: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${seq}-${name}.jsonl`);
  writeFileSync(filePath, `{"seq":${parseInt(seq, 10)},"name":"${name}"}\n`, "utf-8");
  return filePath;
}

function backdateFile(filePath: string, daysAgo: number): void {
  const pastMs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const pastDate = new Date(pastMs);
  utimesSync(filePath, pastDate, pastDate);
}

function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function activityDir(baseDir: string): string {
  return join(baseDir, ".gsd", "activity");
}

function createCtx(entries: unknown[]) {
  return { sessionManager: { getEntries: () => entries } };
}

// ── Pruning ──────────────────────────────────────────────────────────────────

test("pruneActivityLogs deletes old files, keeps recent and highest-seq", () => {
  const dir = createTmpDir();
  try {
    const f001 = writeActivityFile(dir, "001", "execute-task-M001-S01-T01");
    writeActivityFile(dir, "002", "execute-task-M001-S01-T02");
    writeActivityFile(dir, "003", "execute-task-M001-S01-T03");
    backdateFile(f001, 40);

    pruneActivityLogs(dir, 30);
    const remaining = listFiles(dir);
    assert.ok(!remaining.includes("001-execute-task-M001-S01-T01.jsonl"));
    assert.ok(remaining.includes("002-execute-task-M001-S01-T02.jsonl"));
    assert.ok(remaining.includes("003-execute-task-M001-S01-T03.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs preserves highest-seq even when all files are old", () => {
  const dir = createTmpDir();
  try {
    const f001 = writeActivityFile(dir, "001", "t1");
    const f002 = writeActivityFile(dir, "002", "t2");
    const f003 = writeActivityFile(dir, "003", "t3");
    backdateFile(f001, 40); backdateFile(f002, 40); backdateFile(f003, 40);

    pruneActivityLogs(dir, 30);
    const remaining = listFiles(dir);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].startsWith("003-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs with retentionDays=0 keeps only highest-seq", () => {
  const dir = createTmpDir();
  try {
    writeActivityFile(dir, "001", "t1");
    writeActivityFile(dir, "002", "t2");
    writeActivityFile(dir, "003", "t3");

    pruneActivityLogs(dir, 0);
    const remaining = listFiles(dir);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].startsWith("003-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs no-op when all files are recent", () => {
  const dir = createTmpDir();
  try {
    writeActivityFile(dir, "001", "t1");
    writeActivityFile(dir, "002", "t2");
    writeActivityFile(dir, "003", "t3");

    pruneActivityLogs(dir, 30);
    assert.equal(listFiles(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs handles empty directory", () => {
  const dir = createTmpDir();
  try {
    assert.doesNotThrow(() => pruneActivityLogs(dir, 30));
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs preserves single old file (it is highest-seq)", () => {
  const dir = createTmpDir();
  try {
    const f = writeActivityFile(dir, "001", "t1");
    backdateFile(f, 100);

    pruneActivityLogs(dir, 30);
    assert.equal(listFiles(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneActivityLogs ignores non-matching filenames", () => {
  const dir = createTmpDir();
  try {
    const f001 = writeActivityFile(dir, "001", "t1");
    writeFileSync(join(dir, "notes.txt"), "some notes\n", "utf-8");
    backdateFile(f001, 40);

    assert.doesNotThrow(() => pruneActivityLogs(dir, 30));
    const remaining = listFiles(dir);
    assert.ok(remaining.includes("notes.txt"));
    // 001 is the only seq file, so it's highest-seq and survives
    assert.ok(remaining.includes("001-t1.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Save: caching, dedup, collision recovery ─────────────────────────────────

test("saveActivityLog caches sequence instead of rescanning", () => {
  const baseDir = createTmpDir();
  try {
    saveActivityLog(createCtx([{ kind: "first", n: 1 }]) as any, baseDir, "execute-task", "M001/S01/T01");
    writeFileSync(join(activityDir(baseDir), "999-external.jsonl"), '{"x":1}\n', "utf-8");
    saveActivityLog(createCtx([{ kind: "second", n: 2 }]) as any, baseDir, "execute-task", "M001/S01/T02");

    const files = listFiles(activityDir(baseDir));
    assert.ok(files.includes("001-execute-task-M001-S01-T01.jsonl"));
    assert.ok(files.includes("002-execute-task-M001-S01-T02.jsonl"));
    assert.ok(!files.some(f => f.startsWith("1000-")));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("saveActivityLog deduplicates identical snapshots for same unit", () => {
  const baseDir = createTmpDir();
  try {
    const ctx = createCtx([{ role: "assistant", content: "same" }]);
    saveActivityLog(ctx as any, baseDir, "plan-slice", "M002/S01");
    saveActivityLog(ctx as any, baseDir, "plan-slice", "M002/S01");

    let files = listFiles(activityDir(baseDir));
    assert.equal(files.length, 1);

    saveActivityLog(createCtx([{ role: "assistant", content: "changed" }]) as any, baseDir, "plan-slice", "M002/S01");
    files = listFiles(activityDir(baseDir));
    assert.equal(files.length, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("saveActivityLog recovers on sequence collision", () => {
  const baseDir = createTmpDir();
  try {
    saveActivityLog(createCtx([{ turn: 1 }]) as any, baseDir, "execute-task", "M003/S02/T01");
    writeFileSync(join(activityDir(baseDir), "002-execute-task-M003-S02-T02.jsonl"), '{"collision":true}\n', "utf-8");
    saveActivityLog(createCtx([{ turn: 2 }]) as any, baseDir, "execute-task", "M003/S02/T02");

    const files = listFiles(activityDir(baseDir));
    assert.ok(files.includes("002-execute-task-M003-S02-T02.jsonl"));
    assert.ok(files.includes("003-execute-task-M003-S02-T02.jsonl"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ── Prompt text assertion ────────────────────────────────────────────────────

test("complete-slice.md contains refresh state instruction", () => {
  const promptPath = join(__dirname, "..", "prompts", "complete-slice.md");
  const content = readFileSync(promptPath, "utf-8");
  assert.ok(content.includes("refresh current state if needed"));
});
