// GSD State Machine Regression Tests — Stuck Detection Coverage (#3161)

import test from "node:test";
import assert from "node:assert/strict";

import { detectStuck } from "../auto/detect-stuck.ts";

// ─── Baseline: window too small ──────────────────────────────────────────────

test("returns null for empty window", () => {
  assert.equal(detectStuck([]), null);
});

test("returns null for single entry", () => {
  assert.equal(detectStuck([{ key: "A" }]), null);
});

test("returns null for two different entries without errors", () => {
  assert.equal(detectStuck([{ key: "A" }, { key: "B" }]), null);
});

// ─── Rule 1: Same error repeated consecutively ───────────────────────────────

test("Rule 1: same error twice consecutively triggers stuck", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: no such file" },
    { key: "A", error: "ENOENT: no such file" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(result!.reason.includes("Same error"), `reason was: ${result!.reason}`);
});

test("Rule 1: different errors do not trigger stuck", () => {
  // Only 2 entries with different errors — Rule 2 needs 3 entries, so null.
  const result = detectStuck([
    { key: "A", error: "err1" },
    { key: "A", error: "err2" },
  ]);
  assert.equal(result, null);
});

test("Rule 1: only last two entries matter for error check", () => {
  // First two share an error, but the last two have distinct errors — no trigger.
  const result = detectStuck([
    { key: "A", error: "same-error" },
    { key: "A", error: "same-error" },
    { key: "B", error: "different-error-1" },
    { key: "C", error: "different-error-2" },
  ]);
  assert.equal(result, null);
});

// ─── Rule 2: Same unit key 3+ consecutive times ───────────────────────────────

test("Rule 2: same unit key 3 consecutive times triggers stuck", () => {
  const result = detectStuck([
    { key: "A" },
    { key: "A" },
    { key: "A" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(
    result!.reason.includes("3 consecutive times"),
    `reason was: ${result!.reason}`,
  );
});

test("Rule 2: same key twice is not enough", () => {
  assert.equal(detectStuck([{ key: "A" }, { key: "A" }]), null);
});

test("Rule 2: interrupted sequence does not trigger", () => {
  // A, B, A — last three are not all the same key.
  assert.equal(
    detectStuck([{ key: "A" }, { key: "B" }, { key: "A" }]),
    null,
  );
});

test("Rule 2b: same unit repeated 3 times in the window triggers stuck even with an intervening unit", () => {
  const result = detectStuck([
    { key: "execute-task/M002/S03/T01" },
    { key: "execute-task/M002/S03/T01" },
    { key: "reassess-roadmap/M002/S02" },
    { key: "execute-task/M002/S03/T01" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(
    result!.reason.includes("3 times in last 4 attempts"),
    `reason was: ${result!.reason}`,
  );
});

// ─── Rule 3: Oscillation A→B→A→B ─────────────────────────────────────────────

test("Rule 3: A-B-A-B oscillation triggers stuck", () => {
  const result = detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "A" },
    { key: "B" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(
    result!.reason.includes("Oscillation"),
    `reason was: ${result!.reason}`,
  );
});

test("Rule 3: A-B-A-C does not trigger oscillation", () => {
  assert.equal(
    detectStuck([{ key: "A" }, { key: "B" }, { key: "A" }, { key: "C" }]),
    null,
  );
});

test("Rule 3: A-A-A-A triggers Rule 2 not Rule 3", () => {
  // Rule 2 fires first (last 3 are all the same key).
  const result = detectStuck([
    { key: "A" },
    { key: "A" },
    { key: "A" },
    { key: "A" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(
    result!.reason.includes("3 consecutive times"),
    `expected Rule 2 reason but got: ${result!.reason}`,
  );
  assert.ok(
    !result!.reason.includes("Oscillation"),
    `unexpectedly matched Rule 3: ${result!.reason}`,
  );
});

// ─── Rule 4: ENOENT same path twice in window (#3575) ───────────────────────

test("Rule 4: same ENOENT path in two entries triggers stuck", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: no such file or directory, access '/home/user/.gsd/agent/skills/debug-like-expert/SKILL.md'" },
    { key: "B" },
    { key: "A", error: "ENOENT: no such file or directory, access '/home/user/.gsd/agent/skills/debug-like-expert/SKILL.md'" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(result!.reason.includes("Missing file"), `reason was: ${result!.reason}`);
  assert.ok(result!.reason.includes("ENOENT"), `reason was: ${result!.reason}`);
});

test("Rule 4: different ENOENT paths do not trigger stuck", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: no such file or directory, access '/path/a'" },
    { key: "B", error: "ENOENT: no such file or directory, access '/path/b'" },
  ]);
  assert.equal(result, null);
});

test("Rule 4: single ENOENT does not trigger stuck", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: no such file or directory, access '/path/a'" },
    { key: "B" },
  ]);
  assert.equal(result, null);
});

test("Rule 4: ENOENT paths non-consecutive still triggers", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: no such file or directory, access '/missing/skill'" },
    { key: "B" },
    { key: "C" },
    { key: "D", error: "ENOENT: no such file or directory, access '/missing/skill'" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(result!.reason.includes("/missing/skill"), `reason was: ${result!.reason}`);
});


// ─── Gap documentation: 3-unit cycle evades detection ────────────────────────

test("Three-unit cycle A-B-C-A-B-C does NOT trigger stuck (documents gap L13)", () => {
  // None of the three rules fires for a 3-unit repeating cycle.
  // This test intentionally documents the coverage gap where such cycles
  // slip through undetected (#3161).
  const result = detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "C" },
    { key: "A" },
    { key: "B" },
    { key: "C" },
  ]);
  assert.equal(result, null);
});

// ─── Window boundary: earlier patterns do not contaminate recent check ─────────

test("window bounded: detection uses last N entries correctly", () => {
  // The first three entries would trigger Rule 2, but the last entries are
  // healthy — only the tail matters.
  const result = detectStuck([
    { key: "X" },
    { key: "X" },
    { key: "X" }, // would be stuck if this were the end
    { key: "A" },
    { key: "B" }, // last two: different keys, no error
  ]);
  assert.equal(result, null);
});

// ─── Rule priority: Rule 1 before Rule 2 ─────────────────────────────────────

test("Rule 1 takes priority over Rule 2 when both match", () => {
  // Last 3 entries share the same key (Rule 2 candidate) AND last 2 share
  // the same error (Rule 1 candidate). Rule 1 is evaluated first.
  const result = detectStuck([
    { key: "A", error: "boom" },
    { key: "A", error: "boom" },
    { key: "A", error: "boom" },
  ]);
  assert.notEqual(result, null);
  assert.equal(result!.stuck, true);
  assert.ok(
    result!.reason.includes("Same error"),
    `expected Rule 1 reason but got: ${result!.reason}`,
  );
});
