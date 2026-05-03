// gsd-2 + Command queue tests (Phase B coordination — IPC inbox + broadcast NULL semantics)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase } from "../gsd-db.ts";
import {
  enqueueCommand,
  claimNextCommand,
  completeCommand,
  getCommand,
} from "../db/command-queue.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-cmd-q-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("enqueue + claim + complete round-trip for targeted command", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = enqueueCommand({
    targetWorker: "worker-A",
    command: "cancel",
    args: { reason: "user-request" },
  });
  assert.ok(id > 0);

  const claimed = claimNextCommand("worker-A");
  assert.ok(claimed);
  assert.equal(claimed!.id, id);
  assert.equal(claimed!.command, "cancel");
  assert.equal(claimed!.claimed_by, "worker-A");
  assert.ok(claimed!.claimed_at);

  completeCommand(id, { acknowledged: true });
  const final = getCommand(id);
  assert.ok(final!.completed_at);
  assert.equal(final!.result_json, JSON.stringify({ acknowledged: true }));
});

test("targeted command is invisible to other workers", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  enqueueCommand({ targetWorker: "worker-A", command: "for-A" });
  const wrong = claimNextCommand("worker-B");
  assert.equal(wrong, null, "worker-B sees nothing for worker-A");

  const right = claimNextCommand("worker-A");
  assert.ok(right);
  assert.equal(right!.command, "for-A");
});

test("broadcast command (target=null) is visible to ANY worker, claimed exactly once", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  enqueueCommand({ targetWorker: null, command: "broadcast-cancel" });

  const a = claimNextCommand("worker-A");
  assert.ok(a, "first poller wins");
  assert.equal(a!.command, "broadcast-cancel");

  // Second poller (different worker) sees nothing — broadcast is single-delivery
  const b = claimNextCommand("worker-B");
  assert.equal(b, null);
});

test("oldest-first ordering across mixed targeted + broadcast queue", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  enqueueCommand({ targetWorker: null, command: "first" });
  enqueueCommand({ targetWorker: "worker-A", command: "second" });
  enqueueCommand({ targetWorker: null, command: "third" });

  const c1 = claimNextCommand("worker-A")!;
  const c2 = claimNextCommand("worker-A")!;
  const c3 = claimNextCommand("worker-A")!;
  assert.equal(c1.command, "first");
  assert.equal(c2.command, "second");
  assert.equal(c3.command, "third");
  assert.equal(claimNextCommand("worker-A"), null);
});

test("completeCommand is idempotent — second call does not overwrite", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = enqueueCommand({ targetWorker: "w", command: "x" });
  claimNextCommand("w");
  completeCommand(id, { result: 1 });
  completeCommand(id, { result: 2 }); // second call should no-op
  const row = getCommand(id)!;
  assert.equal(row.result_json, JSON.stringify({ result: 1 }));
});

test("completeCommand does not complete an unclaimed command", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));

  const id = enqueueCommand({ targetWorker: "w", command: "x" });
  completeCommand(id, { result: 1 });
  const row = getCommand(id)!;
  assert.equal(row.completed_at, null);
  assert.equal(row.result_json, null);
});
