// gsd-2 + Paused-session via runtime_kv (Phase C pt 2 — paused-session.json migration)
//
// runtime/paused-session.json is gone. The metadata that the old file
// stored now lives in runtime_kv (global scope, key PAUSED_SESSION_KV_KEY).
// readPausedSessionMetadata reads the key; the writer in pauseAuto +
// the cleanup in stopAuto/startAuto/guided-flow all use the same key.
//
// These tests verify the round-trip via the storage layer directly.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
} from "../gsd-db.ts";
import {
  setRuntimeKv,
  getRuntimeKv,
  deleteRuntimeKv,
} from "../db/runtime-kv.ts";
import {
  readPausedSessionMetadata,
  PAUSED_SESSION_KV_KEY,
  type PausedSessionMetadata,
} from "../interrupted-session.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-session-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("readPausedSessionMetadata returns null when no row exists", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(readPausedSessionMetadata(base), null);
});

test("readPausedSessionMetadata round-trips a real PausedSessionMetadata payload", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const meta: PausedSessionMetadata = {
    milestoneId: "M001",
    worktreePath: "/tmp/wt",
    originalBasePath: base,
    stepMode: false,
    pausedAt: new Date().toISOString(),
    sessionFile: "/tmp/session.jsonl",
    unitType: "plan-slice",
    unitId: "M001/S01",
    activeEngineId: "dev",
    activeRunDir: null,
    autoStartTime: Date.now(),
    milestoneLock: null,
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, meta);

  const loaded = readPausedSessionMetadata(base);
  assert.ok(loaded);
  assert.equal(loaded!.milestoneId, "M001");
  assert.equal(loaded!.unitType, "plan-slice");
  assert.equal(loaded!.unitId, "M001/S01");
  assert.equal(loaded!.sessionFile, "/tmp/session.jsonl");
});

test("readPausedSessionMetadata auto-deletes stale pseudo-milestone pause rows", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  // discuss-milestone with a non-MID-shaped unitId triggers
  // isStalePseudoMilestonePause → returns null + deletes the row.
  const stale: PausedSessionMetadata = {
    milestoneId: "M001",
    unitType: "discuss-milestone",
    unitId: "PROJECT-thing",
    activeEngineId: "dev",
  };
  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, stale);

  assert.equal(readPausedSessionMetadata(base), null);
  assert.equal(getRuntimeKv("global", "", PAUSED_SESSION_KV_KEY), null,
    "stale row was deleted by readPausedSessionMetadata");
});

test("deleteRuntimeKv on PAUSED_SESSION_KV_KEY removes the row idempotently", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, { milestoneId: "M001" });
  deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
  deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY); // idempotent — no throw
  assert.equal(readPausedSessionMetadata(base), null);
});

test("readPausedSessionMetadata returns null when DB is unavailable", () => {
  // No openDatabase call — DB is closed.
  try { closeDatabase(); } catch { /* noop */ }
  // Use a tmpdir-style base; the function should handle DB-unavailable gracefully.
  const base = mkdtempSync(join(tmpdir(), "gsd-paused-no-db-"));
  try {
    assert.equal(readPausedSessionMetadata(base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
