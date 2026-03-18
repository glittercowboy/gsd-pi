/**
 * memory-leak-guards.test.ts — Tests for #611 memory leak fixes.
 *
 * Verifies that module-level state accumulators are properly bounded
 * and cleared to prevent OOM during long-running auto-mode sessions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { saveActivityLog, clearActivityLogState } from "../activity-log.ts";
import { clearPathCache } from "../paths.ts";
import type { ExtensionContext } from "@gsd/pi-coding-agent";

function createCtx(entries: unknown[]) {
  return { sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
}

// ─── activity-log: clearActivityLogState ─────────────────────────────────────

test("clearActivityLogState resets dedup state so identical saves write again", () => {
  clearActivityLogState();
  // Pre-resolve baseDir so gsdRoot() returns a stable key across calls.
  // On macOS, /tmp is a symlink to /private/tmp — without realpathSync, the
  // key changes between the first save (dir doesn't exist, realpathSync throws)
  // and subsequent saves (dir exists, realpathSync resolves to /private/tmp/...).
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-memleak-test-")));
  try {
    const entries = [{ role: "assistant", content: "test entry" }];
    const ctx = createCtx(entries);

    // First save
    saveActivityLog(ctx, baseDir, "execute-task", "M001/S01/T01");

    const actDir = join(baseDir, ".gsd", "activity");
    assert.equal(readdirSync(actDir).length, 1, "first save creates one file");

    // Same content, same unit — deduped
    saveActivityLog(ctx, baseDir, "execute-task", "M001/S01/T01");
    assert.equal(readdirSync(actDir).length, 1, "dedup prevents duplicate write");

    // Clear state
    clearActivityLogState();

    // Same content again — after clear, writes again (fresh state)
    saveActivityLog(ctx, baseDir, "execute-task", "M001/S01/T01");
    assert.equal(readdirSync(actDir).length, 2, "after clear, dedup state is reset");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── activity-log: streaming JSONL write ────────────────────────────────────

test("saveActivityLog writes valid JSONL via streaming", () => {
  clearActivityLogState();
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-memleak-jsonl-")));
  try {
    const entries = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "world" } },
      { type: "message", message: { role: "user", content: "test" } },
    ];
    const ctx = createCtx(entries);

    saveActivityLog(ctx, baseDir, "execute-task", "M002/S01/T01");

    const actDir = join(baseDir, ".gsd", "activity");
    const files = readdirSync(actDir);
    assert.equal(files.length, 1, "one file written");

    const content = readFileSync(join(actDir, files[0]), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3, "three JSONL lines");

    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line is valid JSON`);
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ─── paths.ts: directory cache bounds ───────────────────────────────────────

test("clearPathCache does not throw", () => {
  assert.doesNotThrow(() => clearPathCache(), "clearPathCache should not throw");
});
