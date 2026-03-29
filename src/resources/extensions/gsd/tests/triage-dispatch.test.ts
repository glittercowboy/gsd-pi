/**
 * Captures module behavioral tests.
 *
 * Tests actual behavior of captures.ts: file I/O, parsing, path resolution,
 * and LLM triage output parsing. No source-scanning. No regex-on-source-code.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveCapturesPath,
  appendCapture,
  loadAllCaptures,
  loadPendingCaptures,
  hasPendingCaptures,
  countPendingCaptures,
  markCaptureResolved,
  markCaptureExecuted,
  loadActionableCaptures,
  parseTriageOutput,
} from "../captures.js";

// ─── Shared temp directory ────────────────────────────────────────────────────

let tmpDir: string;
let testCounter = 0;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gsd-captures-test-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  // Each call gets a unique subdirectory under the shared tmpDir so tests
  // don't interfere with each other.
  const subdir = join(tmpDir, `t${++testCounter}`);
  mkdirSync(subdir, { recursive: true });
  return subdir;
}

function makeProject(root: string): string {
  mkdirSync(join(root, ".gsd"), { recursive: true });
  return root;
}

// ─── resolveCapturesPath ──────────────────────────────────────────────────────

test("resolveCapturesPath returns .gsd/CAPTURES.md for normal project", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const result = resolveCapturesPath(tmp);
  assert.ok(result.endsWith(`${sep}.gsd${sep}CAPTURES.md`) || result.endsWith("/.gsd/CAPTURES.md"),
    `Expected path to end with .gsd/CAPTURES.md, got: ${result}`);
});

test("resolveCapturesPath resolves worktree path to project root CAPTURES.md", () => {
  const tmp = makeTmpDir();
  // Simulate worktree layout: /project/.gsd/worktrees/MID001/
  const worktreePath = join(tmp, ".gsd", "worktrees", "MID001");
  mkdirSync(worktreePath, { recursive: true });

  const result = resolveCapturesPath(worktreePath);
  // Should resolve to project root (.gsd is at tmp), not inside worktrees
  const expected = join(tmp, ".gsd", "CAPTURES.md");
  assert.equal(result, expected);
});

test("resolveCapturesPath does not treat regular path as worktree", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const subdir = join(tmp, "src", "features");
  mkdirSync(subdir, { recursive: true });
  const result = resolveCapturesPath(subdir);
  // Should not point inside worktrees
  assert.ok(!result.includes("worktrees"),
    `Regular path should not resolve through worktrees: ${result}`);
});

// ─── appendCapture ─────────────────────────────────────────────────────────

test("appendCapture creates CAPTURES.md with header and entry", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "something to remember");
  assert.ok(id.startsWith("CAP-"), `Expected ID to start with CAP-, got: ${id}`);

  const filePath = resolveCapturesPath(tmp);
  const content = readFileSync(filePath, "utf-8");
  assert.ok(content.includes("# Captures"), "Should have header");
  assert.ok(content.includes(id), "Should contain the capture ID");
  assert.ok(content.includes("something to remember"), "Should contain the text");
  assert.ok(content.includes("**Status:** pending"), "Should be pending");
});

test("appendCapture appends to existing file without duplicating header", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "first capture");
  const id2 = appendCapture(tmp, "second capture");

  const filePath = resolveCapturesPath(tmp);
  const content = readFileSync(filePath, "utf-8");

  // Header should appear exactly once
  const headerCount = (content.match(/# Captures/g) ?? []).length;
  assert.equal(headerCount, 1, "Header should appear once");
  assert.ok(content.includes(id1), "First capture should be present");
  assert.ok(content.includes(id2), "Second capture should be present");
  assert.ok(content.indexOf(id1) < content.indexOf(id2), "First capture should appear before second");
});

test("appendCapture creates .gsd directory if it does not exist", () => {
  const tmp = makeTmpDir();
  // No makeProject — .gsd doesn't exist yet
  appendCapture(tmp, "create dir test");

  const filePath = resolveCapturesPath(tmp);
  const content = readFileSync(filePath, "utf-8");
  assert.ok(content.includes("create dir test"));
});

test("appendCapture returns unique IDs on each call", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const ids = new Set<string>();
  for (let i = 0; i < 5; i++) {
    ids.add(appendCapture(tmp, `capture ${i}`));
  }
  assert.equal(ids.size, 5, "Each appendCapture should return a unique ID");
});

// ─── loadAllCaptures ──────────────────────────────────────────────────────────

test("loadAllCaptures returns empty array when file does not exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const captures = loadAllCaptures(tmp);
  assert.deepEqual(captures, []);
});

test("loadAllCaptures parses a single pending capture", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "test capture text");
  const captures = loadAllCaptures(tmp);

  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, id);
  assert.equal(captures[0].text, "test capture text");
  assert.equal(captures[0].status, "pending");
  assert.ok(captures[0].timestamp, "Should have a timestamp");
});

test("loadAllCaptures returns multiple captures in order", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "first");
  const id2 = appendCapture(tmp, "second");
  const id3 = appendCapture(tmp, "third");

  const captures = loadAllCaptures(tmp);
  assert.equal(captures.length, 3);
  assert.equal(captures[0].id, id1);
  assert.equal(captures[1].id, id2);
  assert.equal(captures[2].id, id3);
});

test("loadAllCaptures returns empty array for empty CAPTURES.md", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const filePath = resolveCapturesPath(tmp);
  writeFileSync(filePath, "# Captures\n\n", "utf-8");
  const captures = loadAllCaptures(tmp);
  assert.deepEqual(captures, []);
});

// ─── loadPendingCaptures ──────────────────────────────────────────────────────

test("loadPendingCaptures returns only pending entries", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "pending one");
  const id2 = appendCapture(tmp, "to be resolved");
  markCaptureResolved(tmp, id2, "note", "acknowledged", "not actionable");

  const pending = loadPendingCaptures(tmp);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id1);
});

test("loadPendingCaptures returns empty array when all resolved", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "will resolve");
  markCaptureResolved(tmp, id, "defer", "later", "not urgent");
  const pending = loadPendingCaptures(tmp);
  assert.deepEqual(pending, []);
});

// ─── hasPendingCaptures ───────────────────────────────────────────────────────

test("hasPendingCaptures returns false when file does not exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  assert.equal(hasPendingCaptures(tmp), false);
});

test("hasPendingCaptures returns true when pending entries exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  appendCapture(tmp, "something pending");
  assert.equal(hasPendingCaptures(tmp), true);
});

test("hasPendingCaptures returns false after all captures resolved", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "resolve me");
  markCaptureResolved(tmp, id, "note", "done", "trivial");
  assert.equal(hasPendingCaptures(tmp), false);
});

// ─── countPendingCaptures ─────────────────────────────────────────────────────

test("countPendingCaptures returns 0 when file does not exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  assert.equal(countPendingCaptures(tmp), 0);
});

test("countPendingCaptures returns correct count", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  appendCapture(tmp, "one");
  appendCapture(tmp, "two");
  appendCapture(tmp, "three");
  assert.equal(countPendingCaptures(tmp), 3);
});

test("countPendingCaptures decrements as captures are resolved", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "one");
  appendCapture(tmp, "two");
  assert.equal(countPendingCaptures(tmp), 2);

  markCaptureResolved(tmp, id1, "note", "done", "trivial");
  assert.equal(countPendingCaptures(tmp), 1);
});

// ─── markCaptureResolved ──────────────────────────────────────────────────────

test("markCaptureResolved updates status to resolved", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "needs triage");
  markCaptureResolved(tmp, id, "quick-task", "add a unit test", "small and well-defined");

  const captures = loadAllCaptures(tmp);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].status, "resolved");
  assert.equal(captures[0].classification, "quick-task");
  assert.equal(captures[0].resolution, "add a unit test");
  assert.equal(captures[0].rationale, "small and well-defined");
  assert.ok(captures[0].resolvedAt, "Should have resolvedAt timestamp");
});

test("markCaptureResolved is idempotent — re-triage overwrites previous classification", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "re-triage me");
  markCaptureResolved(tmp, id, "note", "first pass", "initial assessment");
  markCaptureResolved(tmp, id, "inject", "inject into current slice", "more urgent than first thought");

  const captures = loadAllCaptures(tmp);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].classification, "inject");
  assert.equal(captures[0].resolution, "inject into current slice");

  // Should not have duplicate Classification fields
  const filePath = resolveCapturesPath(tmp);
  const content = readFileSync(filePath, "utf-8");
  const classificationMatches = content.match(/\*\*Classification:\*\*/g) ?? [];
  assert.equal(classificationMatches.length, 1, "Should have exactly one Classification field");
});

test("markCaptureResolved does not affect other captures in the file", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "bystander");
  const id2 = appendCapture(tmp, "target");
  markCaptureResolved(tmp, id2, "defer", "later", "low priority");

  const captures = loadAllCaptures(tmp);
  const bystander = captures.find(c => c.id === id1);
  const target = captures.find(c => c.id === id2);

  assert.ok(bystander, "Bystander capture should still exist");
  assert.equal(bystander!.status, "pending", "Bystander should remain pending");
  assert.equal(target!.status, "resolved", "Target should be resolved");
});

test("markCaptureResolved does nothing when file does not exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  // Should not throw — just a no-op
  assert.doesNotThrow(() => {
    markCaptureResolved(tmp, "CAP-nonexist", "note", "n/a", "n/a");
  });
});

// ─── markCaptureExecuted ──────────────────────────────────────────────────────

test("markCaptureExecuted sets executed flag on a resolved capture", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "execute me");
  markCaptureResolved(tmp, id, "quick-task", "run tests", "obvious");
  markCaptureExecuted(tmp, id);

  const captures = loadAllCaptures(tmp);
  assert.equal(captures[0].executed, true);
});

test("markCaptureExecuted is idempotent — calling twice does not corrupt state", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "double execute");
  markCaptureResolved(tmp, id, "inject", "inject step", "needed");
  markCaptureExecuted(tmp, id);
  markCaptureExecuted(tmp, id);

  const filePath = resolveCapturesPath(tmp);
  const content = readFileSync(filePath, "utf-8");
  const executedMatches = content.match(/\*\*Executed:\*\*/g) ?? [];
  assert.equal(executedMatches.length, 1, "Should have exactly one Executed field after double-execution");
});

test("markCaptureExecuted does nothing when file does not exist", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  assert.doesNotThrow(() => {
    markCaptureExecuted(tmp, "CAP-nonexist");
  });
});

// ─── loadActionableCaptures ───────────────────────────────────────────────────

test("loadActionableCaptures returns inject, replan, quick-task resolved captures", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id1 = appendCapture(tmp, "inject this");
  const id2 = appendCapture(tmp, "quick task");
  const id3 = appendCapture(tmp, "replan needed");
  const id4 = appendCapture(tmp, "just a note");
  const id5 = appendCapture(tmp, "defer it");

  markCaptureResolved(tmp, id1, "inject", "inject into slice", "urgent");
  markCaptureResolved(tmp, id2, "quick-task", "run the script", "easy");
  markCaptureResolved(tmp, id3, "replan", "update roadmap", "direction change");
  markCaptureResolved(tmp, id4, "note", "fyi", "informational");
  markCaptureResolved(tmp, id5, "defer", "later", "low priority");

  const actionable = loadActionableCaptures(tmp);
  const ids = actionable.map(c => c.id);
  assert.ok(ids.includes(id1), "inject should be actionable");
  assert.ok(ids.includes(id2), "quick-task should be actionable");
  assert.ok(ids.includes(id3), "replan should be actionable");
  assert.ok(!ids.includes(id4), "note should NOT be actionable");
  assert.ok(!ids.includes(id5), "defer should NOT be actionable");
});

test("loadActionableCaptures excludes already-executed captures", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  const id = appendCapture(tmp, "already done");
  markCaptureResolved(tmp, id, "inject", "was injected", "done");
  markCaptureExecuted(tmp, id);

  const actionable = loadActionableCaptures(tmp);
  assert.equal(actionable.length, 0, "Executed captures should not be actionable");
});

test("loadActionableCaptures excludes pending captures", () => {
  const tmp = makeTmpDir();
  makeProject(tmp);
  appendCapture(tmp, "still pending");

  const actionable = loadActionableCaptures(tmp);
  assert.equal(actionable.length, 0, "Pending captures should not be actionable");
});

// ─── parseTriageOutput ────────────────────────────────────────────────────────

test("parseTriageOutput parses clean JSON array", () => {
  const input = JSON.stringify([
    { captureId: "CAP-abc123", classification: "quick-task", rationale: "small change" },
  ]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].captureId, "CAP-abc123");
  assert.equal(results[0].classification, "quick-task");
  assert.equal(results[0].rationale, "small change");
});

test("parseTriageOutput parses JSON wrapped in fenced code block", () => {
  const input = "Here is my analysis:\n```json\n" +
    JSON.stringify([{ captureId: "CAP-def456", classification: "inject", rationale: "inject now" }]) +
    "\n```\nEnd of analysis.";
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].captureId, "CAP-def456");
  assert.equal(results[0].classification, "inject");
});

test("parseTriageOutput parses JSON embedded in prose", () => {
  const json = JSON.stringify([
    { captureId: "CAP-ghi789", classification: "defer", rationale: "not now" },
  ]);
  const input = `After careful consideration: ${json} That's my assessment.`;
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].captureId, "CAP-ghi789");
  assert.equal(results[0].classification, "defer");
});

test("parseTriageOutput wraps single object in array", () => {
  const input = JSON.stringify(
    { captureId: "CAP-single", classification: "note", rationale: "fyi" },
  );
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].captureId, "CAP-single");
});

test("parseTriageOutput preserves optional affectedFiles field", () => {
  const input = JSON.stringify([{
    captureId: "CAP-files",
    classification: "replan",
    rationale: "changes needed",
    affectedFiles: ["src/foo.ts", "src/bar.ts"],
  }]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].affectedFiles, ["src/foo.ts", "src/bar.ts"]);
});

test("parseTriageOutput preserves optional targetSlice field", () => {
  const input = JSON.stringify([{
    captureId: "CAP-slice",
    classification: "inject",
    rationale: "inject here",
    targetSlice: "S02",
  }]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].targetSlice, "S02");
});

test("parseTriageOutput returns empty array for malformed JSON", () => {
  const results = parseTriageOutput("{ this is not json at all }");
  assert.deepEqual(results, []);
});

test("parseTriageOutput returns empty array for empty string", () => {
  assert.deepEqual(parseTriageOutput(""), []);
});

test("parseTriageOutput returns empty array for whitespace-only input", () => {
  assert.deepEqual(parseTriageOutput("   \n  "), []);
});

test("parseTriageOutput filters out entries with invalid classification", () => {
  const input = JSON.stringify([
    { captureId: "CAP-valid", classification: "note", rationale: "ok" },
    { captureId: "CAP-bad", classification: "unknown-type", rationale: "nope" },
  ]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].captureId, "CAP-valid");
});

test("parseTriageOutput filters out entries missing required fields", () => {
  const input = JSON.stringify([
    { captureId: "CAP-ok", classification: "note", rationale: "good" },
    { classification: "note", rationale: "missing captureId" },
    { captureId: "CAP-no-class", rationale: "missing classification" },
    { captureId: "CAP-no-rationale", classification: "note" },
  ]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 1, "Only the complete entry should pass");
  assert.equal(results[0].captureId, "CAP-ok");
});

test("parseTriageOutput handles all valid classifications", () => {
  const classifications = ["quick-task", "inject", "defer", "replan", "note"];
  for (const classification of classifications) {
    const input = JSON.stringify([{ captureId: "CAP-test", classification, rationale: "test" }]);
    const results = parseTriageOutput(input);
    assert.equal(results.length, 1, `${classification} should be a valid classification`);
    assert.equal(results[0].classification, classification);
  }
});

test("parseTriageOutput handles multiple captures in one response", () => {
  const input = JSON.stringify([
    { captureId: "CAP-001", classification: "quick-task", rationale: "small" },
    { captureId: "CAP-002", classification: "inject", rationale: "urgent" },
    { captureId: "CAP-003", classification: "defer", rationale: "later" },
  ]);
  const results = parseTriageOutput(input);
  assert.equal(results.length, 3);
});
