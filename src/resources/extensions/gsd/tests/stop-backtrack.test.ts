/**
 * Unit tests for stop/backtrack capture classifications and milestone regression (#3487).
 *
 * Tests:
 * - "stop" and "backtrack" are valid classification types
 * - loadStopCaptures returns unexecuted stop+backtrack captures
 * - loadBacktrackCaptures returns only backtrack captures
 * - revertExecutorResolvedCaptures reverts silenced captures
 * - executeBacktrack writes trigger and regression markers
 * - readBacktrackTrigger parses trigger file
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isClosedStatus } from "../status-guards.ts";
import {
  appendCapture,
  loadAllCaptures,
  loadStopCaptures,
  loadBacktrackCaptures,
  markCaptureResolved,
  revertExecutorResolvedCaptures,
  hasPendingCaptures,
} from "../captures.ts";
import {
  executeBacktrack,
  readBacktrackTrigger,
} from "../triage-resolution.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupGsdDir(tmp: string): void {
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
}

// ─── Classification Types ─────────────────────────────────────────────────────

test("stop is a valid classification", () => {
  const tmp = makeTempDir("stop-class");
  setupGsdDir(tmp);
  const id = appendCapture(tmp, "stop running immediately");
  markCaptureResolved(tmp, id, "stop", "Halt auto-mode", "User said stop", "M005");
  const all = loadAllCaptures(tmp);
  const cap = all.find(c => c.id === id);
  assert.equal(cap?.classification, "stop");
  rmSync(tmp, { recursive: true, force: true });
});

test("backtrack is a valid classification", () => {
  const tmp = makeTempDir("bt-class");
  setupGsdDir(tmp);
  const id = appendCapture(tmp, "restart from M003");
  markCaptureResolved(tmp, id, "backtrack", "Backtrack to M003", "User wants to restart", "M005");
  const all = loadAllCaptures(tmp);
  const cap = all.find(c => c.id === id);
  assert.equal(cap?.classification, "backtrack");
  rmSync(tmp, { recursive: true, force: true });
});

// ─── loadStopCaptures ─────────────────────────────────────────────────────────

test("loadStopCaptures returns unexecuted stop and backtrack captures", () => {
  const tmp = makeTempDir("load-stop");
  setupGsdDir(tmp);
  const stopId = appendCapture(tmp, "halt execution");
  const btId = appendCapture(tmp, "go back to M003");
  const noteId = appendCapture(tmp, "just a note");
  markCaptureResolved(tmp, stopId, "stop", "Halt", "User stop", "M005");
  markCaptureResolved(tmp, btId, "backtrack", "Backtrack to M003", "User backtrack", "M005");
  markCaptureResolved(tmp, noteId, "note", "Info only", "Not actionable", "M005");

  const stops = loadStopCaptures(tmp);
  assert.equal(stops.length, 2);
  assert.ok(stops.some(c => c.classification === "stop"));
  assert.ok(stops.some(c => c.classification === "backtrack"));
  rmSync(tmp, { recursive: true, force: true });
});

test("loadBacktrackCaptures returns only backtrack captures", () => {
  const tmp = makeTempDir("load-bt");
  setupGsdDir(tmp);
  const stopId = appendCapture(tmp, "halt execution");
  const btId = appendCapture(tmp, "go back to M003");
  markCaptureResolved(tmp, stopId, "stop", "Halt", "User stop", "M005");
  markCaptureResolved(tmp, btId, "backtrack", "Backtrack to M003", "User backtrack", "M005");

  const bts = loadBacktrackCaptures(tmp);
  assert.equal(bts.length, 1);
  assert.equal(bts[0].classification, "backtrack");
  rmSync(tmp, { recursive: true, force: true });
});

// ─── revertExecutorResolvedCaptures ───────────────────────────────────────────

test("revertExecutorResolvedCaptures reverts captures resolved without classification", () => {
  const tmp = makeTempDir("revert-exec");
  setupGsdDir(tmp);
  const id = appendCapture(tmp, "stop everything");

  // Simulate an executor writing Status: resolved directly (no classification)
  const capPath = join(tmp, ".gsd", "CAPTURES.md");
  let content = readFileSync(capPath, "utf-8");
  content = content.replace("**Status:** pending", "**Status:** resolved");
  writeFileSync(capPath, content, "utf-8");

  // Verify it's now "resolved" without classification
  assert.equal(hasPendingCaptures(tmp), false);

  // Revert should detect and fix it
  const reverted = revertExecutorResolvedCaptures(tmp);
  assert.equal(reverted, 1);

  // Should be pending again
  assert.equal(hasPendingCaptures(tmp), true);
  rmSync(tmp, { recursive: true, force: true });
});

test("revertExecutorResolvedCaptures does NOT revert properly triaged captures", () => {
  const tmp = makeTempDir("revert-skip");
  setupGsdDir(tmp);
  const id = appendCapture(tmp, "restart from M003");
  markCaptureResolved(tmp, id, "backtrack", "Backtrack to M003", "User wants restart", "M005");

  // This capture was properly triaged — should NOT be reverted
  const reverted = revertExecutorResolvedCaptures(tmp);
  assert.equal(reverted, 0);
  rmSync(tmp, { recursive: true, force: true });
});

// ─── executeBacktrack ─────────────────────────────────────────────────────────

test("executeBacktrack writes trigger and regression markers", () => {
  const tmp = makeTempDir("exec-bt");
  setupGsdDir(tmp);

  // Create target milestone directory
  mkdirSync(join(tmp, ".gsd", "milestones", "M003"), { recursive: true });

  const targetMid = executeBacktrack(tmp, "M005", {
    id: "CAP-test123",
    text: "restart from M003 — milestones after 2 failed",
    timestamp: new Date().toISOString(),
    status: "resolved",
    classification: "backtrack",
    resolution: "Backtrack to M003",
    rationale: "User directive",
  });

  assert.equal(targetMid, "M003");

  // Check trigger file exists
  const triggerPath = join(tmp, ".gsd", "BACKTRACK-TRIGGER.md");
  assert.ok(existsSync(triggerPath));
  const triggerContent = readFileSync(triggerPath, "utf-8");
  assert.ok(triggerContent.includes("M005"));
  assert.ok(triggerContent.includes("M003"));

  // Check regression marker exists on target milestone
  const regressionPath = join(tmp, ".gsd", "milestones", "M003", "M003-REGRESSION.md");
  assert.ok(existsSync(regressionPath));
  const regressionContent = readFileSync(regressionPath, "utf-8");
  assert.ok(regressionContent.includes("M005"));
  rmSync(tmp, { recursive: true, force: true });
});

// ─── readBacktrackTrigger ─────────────────────────────────────────────────────

test("readBacktrackTrigger parses trigger file", () => {
  const tmp = makeTempDir("read-bt");
  setupGsdDir(tmp);
  mkdirSync(join(tmp, ".gsd", "milestones", "M003"), { recursive: true });

  executeBacktrack(tmp, "M005", {
    id: "CAP-abc",
    text: "go back to M003",
    timestamp: new Date().toISOString(),
    status: "resolved",
    classification: "backtrack",
    resolution: "Backtrack to M003",
    rationale: "Regression",
  });

  const trigger = readBacktrackTrigger(tmp);
  assert.ok(trigger);
  assert.equal(trigger.target, "M003");
  assert.equal(trigger.from, "M005");
  rmSync(tmp, { recursive: true, force: true });
});

test("readBacktrackTrigger returns null when no trigger exists", () => {
  const tmp = makeTempDir("no-bt");
  setupGsdDir(tmp);
  const trigger = readBacktrackTrigger(tmp);
  assert.equal(trigger, null);
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Slice Skip Status (#3477) ──────────────────────────────────────────────

test("isClosedStatus treats 'skipped' as closed", () => {
  assert.equal(isClosedStatus("skipped"), true);
  assert.equal(isClosedStatus("complete"), true);
  assert.equal(isClosedStatus("done"), true);
  assert.equal(isClosedStatus("pending"), false);
  assert.equal(isClosedStatus("active"), false);
});
