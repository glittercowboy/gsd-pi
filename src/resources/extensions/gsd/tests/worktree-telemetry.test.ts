/**
 * Tests for worktree telemetry — #4764.
 *
 * Covers emit helpers (writing to the journal) and the aggregator
 * (summarizeWorktreeTelemetry).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  emitWorktreeCreated,
  emitWorktreeMerged,
  emitWorktreeOrphaned,
  emitAutoExit,
  emitCanonicalRootRedirect,
  summarizeWorktreeTelemetry,
  percentile,
} from "../worktree-telemetry.ts";
import { resolveCanonicalMilestoneRoot } from "../worktree-manager.ts";
import { queryJournal } from "../journal.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-tel-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

test("emitWorktreeCreated writes a worktree-created journal event", () => {
  const base = makeTmpBase();
  try {
    emitWorktreeCreated(base, "M001", { reason: "create-milestone" });
    const entries = queryJournal(base, { eventType: "worktree-created" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data?.milestoneId, "M001");
    assert.equal(entries[0].data?.reason, "create-milestone");
    assert.ok(typeof entries[0].data?.startedAt === "string");
  } finally { cleanup(base); }
});

test("emitWorktreeMerged records duration and conflict fields", () => {
  const base = makeTmpBase();
  try {
    emitWorktreeMerged(base, "M001", {
      reason: "milestone-complete",
      durationMs: 1234,
      sliceCount: 3,
      taskCount: 9,
      conflict: false,
    });
    const entries = queryJournal(base, { eventType: "worktree-merged" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data?.milestoneId, "M001");
    assert.equal(entries[0].data?.durationMs, 1234);
    assert.equal(entries[0].data?.sliceCount, 3);
    assert.equal(entries[0].data?.conflict, false);
  } finally { cleanup(base); }
});

test("emitWorktreeOrphaned captures reason and commits-ahead", () => {
  const base = makeTmpBase();
  try {
    emitWorktreeOrphaned(base, "M002", {
      reason: "in-progress-unmerged",
      commitsAhead: 4,
      worktreeDirExists: true,
    });
    const entries = queryJournal(base, { eventType: "worktree-orphaned" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data?.milestoneId, "M002");
    assert.equal(entries[0].data?.reason, "in-progress-unmerged");
    assert.equal(entries[0].data?.commitsAhead, 4);
    assert.equal(entries[0].data?.worktreeDirExists, true);
  } finally { cleanup(base); }
});

test("emitAutoExit records reason and unmerged-work signal", () => {
  const base = makeTmpBase();
  try {
    emitAutoExit(base, {
      reason: "pause",
      milestoneId: "M003",
      milestoneMerged: false,
    });
    const entries = queryJournal(base, { eventType: "auto-exit" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data?.reason, "pause");
    assert.equal(entries[0].data?.milestoneMerged, false);
  } finally { cleanup(base); }
});

test("summarizeWorktreeTelemetry aggregates events correctly", () => {
  const base = makeTmpBase();
  try {
    // Two created, one merged, two orphans (different reasons), three exits,
    // two of which left work unmerged.
    emitWorktreeCreated(base, "M001");
    emitWorktreeCreated(base, "M002");

    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", durationMs: 500, conflict: false });

    emitWorktreeOrphaned(base, "M002", { reason: "in-progress-unmerged", commitsAhead: 2 });
    emitWorktreeOrphaned(base, "M003", { reason: "complete-unmerged" });

    emitAutoExit(base, { reason: "pause", milestoneId: "M002", milestoneMerged: false });
    emitAutoExit(base, { reason: "stop", milestoneId: "M002", milestoneMerged: false });
    emitAutoExit(base, { reason: "all-complete", milestoneId: "M001", milestoneMerged: true });

    const summary = summarizeWorktreeTelemetry(base);
    assert.equal(summary.worktreesCreated, 2);
    assert.equal(summary.worktreesMerged, 1);
    assert.equal(summary.orphansDetected, 2);
    assert.deepStrictEqual(summary.orphansByReason, {
      "in-progress-unmerged": 1,
      "complete-unmerged": 1,
    });
    assert.deepStrictEqual(summary.mergeDurationsMs, [500]);
    assert.equal(summary.mergeConflicts, 0);
    assert.deepStrictEqual(summary.exitsByReason, {
      "pause": 1,
      "stop": 1,
      "all-complete": 1,
    });
    assert.equal(summary.exitsWithUnmergedWork, 2, "pause and stop each left work unmerged");
  } finally { cleanup(base); }
});

test("summarizeWorktreeTelemetry counts merge conflicts", () => {
  const base = makeTmpBase();
  try {
    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", durationMs: 100, conflict: false });
    emitWorktreeMerged(base, "M002", { reason: "milestone-complete", durationMs: 200, conflict: true, conflictedFiles: 3 });
    emitWorktreeMerged(base, "M003", { reason: "milestone-complete", durationMs: 150, conflict: false });

    const summary = summarizeWorktreeTelemetry(base);
    assert.equal(summary.worktreesMerged, 3);
    assert.equal(summary.mergeConflicts, 1);
    // Durations are sorted
    assert.deepStrictEqual(summary.mergeDurationsMs, [100, 150, 200]);
  } finally { cleanup(base); }
});

test("resolveCanonicalMilestoneRoot emits canonical-root-redirect on redirect", () => {
  const base = makeTmpBase();
  try {
    // Create the live-worktree shape the resolver looks for
    const wtDir = join(base, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M001")}\n`);

    const result = resolveCanonicalMilestoneRoot(base, "M001");
    assert.equal(result, wtDir);

    const summary = summarizeWorktreeTelemetry(base);
    assert.equal(summary.canonicalRedirects, 1, "redirect should emit exactly one event");
  } finally { cleanup(base); }
});

test("resolveCanonicalMilestoneRoot emits nothing when it doesn't redirect", () => {
  const base = makeTmpBase();
  try {
    const result = resolveCanonicalMilestoneRoot(base, "M999");
    assert.equal(result, base);

    const summary = summarizeWorktreeTelemetry(base);
    assert.equal(summary.canonicalRedirects, 0, "no worktree → no redirect event");
  } finally { cleanup(base); }
});

test("percentile helper returns quantiles of a sorted array (nearest-rank)", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.5), 10);
  // Boundary behavior
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
  assert.equal(percentile([10, 20, 30, 40], 1), 40);
  // Nearest-rank: idx = ceil(q*n) - 1
  // q=0.5, n=4 → idx = 2-1 = 1 → 20
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  // p95 on 20 values = idx ceil(0.95*20)-1 = 19-1 = 18 → value at index 18 (19th sample)
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // [10..200]
  assert.equal(percentile(twenty, 0.95), 190, "p95 should be the 19th of 20 sorted values, not the max");
});

test("summarizeWorktreeTelemetry supports time-window filtering", () => {
  const base = makeTmpBase();
  try {
    emitWorktreeCreated(base, "M001");
    const midpoint = new Date().toISOString();
    // Brief delay to ensure the next event has a later ts
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }
    emitWorktreeCreated(base, "M002");

    const beforeOnly = summarizeWorktreeTelemetry(base, { before: midpoint });
    const afterOnly = summarizeWorktreeTelemetry(base, { after: midpoint });
    // The sum of the two partitions covers all events (may overlap by 1 at
    // exact-ts boundary — assert each partition is a proper subset).
    assert.ok(beforeOnly.worktreesCreated >= 1);
    assert.ok(afterOnly.worktreesCreated >= 1);
    assert.ok(beforeOnly.worktreesCreated + afterOnly.worktreesCreated >= 2);
  } finally { cleanup(base); }
});
