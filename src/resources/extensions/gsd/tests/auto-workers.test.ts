// gsd-2 + Auto-mode worker registry tests (Phase B coordination)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase } from "../gsd-db.ts";
import { _getAdapter } from "../gsd-db.ts";
import {
  registerAutoWorker,
  heartbeatAutoWorker,
  markWorkerCrashed,
  markWorkerStopping,
  getActiveAutoWorkers,
  getAutoWorker,
} from "../db/auto-workers.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-auto-workers-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("registerAutoWorker creates a row with active status and heartbeat", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  assert.match(id, /^auto-/, "worker_id has expected prefix");

  const row = getAutoWorker(id);
  assert.ok(row, "row exists");
  assert.equal(row!.status, "active");
  assert.equal(row!.project_root_realpath, base);
  assert.equal(row!.pid, process.pid);
});

test("heartbeatAutoWorker updates last_heartbeat_at", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  const initial = getAutoWorker(id)!;
  await new Promise(r => setTimeout(r, 10));
  heartbeatAutoWorker(id);
  const after = getAutoWorker(id)!;
  assert.notEqual(after.last_heartbeat_at, initial.last_heartbeat_at, "heartbeat advanced");
});

test("markWorkerStopping flips status to stopping", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerStopping(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "stopping");
});

test("markWorkerCrashed flips status to crashed", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = registerAutoWorker({ projectRootRealpath: base });
  markWorkerCrashed(id);
  const row = getAutoWorker(id)!;
  assert.equal(row.status, "crashed");
});

test("getActiveAutoWorkers filters by status and TTL", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const a = registerAutoWorker({ projectRootRealpath: base });
  const b = registerAutoWorker({ projectRootRealpath: base });

  const active = getActiveAutoWorkers();
  assert.equal(active.length, 2);
  assert.ok(active.find(w => w.worker_id === a));
  assert.ok(active.find(w => w.worker_id === b));

  _getAdapter()!.prepare(
    `UPDATE workers SET last_heartbeat_at = '1970-01-01T00:00:00.000Z' WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": a });

  const after = getActiveAutoWorkers();
  assert.equal(after.length, 1);
  assert.equal(after[0].worker_id, b);
});
