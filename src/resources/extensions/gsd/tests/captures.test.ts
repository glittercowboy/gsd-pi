/**
 * Unit tests for GSD Captures — file I/O, parsing, and worktree path resolution.
 *
 * Exercises the boundary contract that S02 (auto-mode dispatch) depends on:
 * - appendCapture creates/appends entries to CAPTURES.md
 * - loadAllCaptures / loadPendingCaptures parse and filter correctly
 * - hasPendingCaptures does fast regex check without full parse
 * - markCaptureResolved updates entry in place
 * - resolveCapturesPath handles worktree paths
 * - parseTriageOutput handles valid, malformed, and partial JSON
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendCapture,
  loadAllCaptures,
  loadPendingCaptures,
  loadActionableCaptures,
  hasPendingCaptures,
  markCaptureResolved,
  markCaptureExecuted,
  stampCaptureMilestone,
  resolveCapturesPath,
  parseTriageOutput,
} from "../captures.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── appendCapture ────────────────────────────────────────────────────────────

test("captures: appendCapture creates CAPTURES.md on first call", (t) => {
  const tmp = makeTempDir("cap-create");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "first thought");
  assert.ok(id.startsWith("CAP-"), "ID should start with CAP-");
  assert.ok(
    existsSync(join(tmp, ".gsd", "CAPTURES.md")),
    "CAPTURES.md should exist",
  );
  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes("# Captures"), "should have header");
  assert.ok(content.includes(`### ${id}`), "should have entry heading");
  assert.ok(
    content.includes("**Text:** first thought"),
    "should have text field",
  );
  assert.ok(
    content.includes("**Status:** pending"),
    "should have pending status",
  );
});

test("captures: appendCapture appends to existing file", (t) => {
  const tmp = makeTempDir("cap-append");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "thought one");
  const id2 = appendCapture(tmp, "thought two");
  assert.notStrictEqual(id1, id2, "IDs should be unique");

  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes(`### ${id1}`), "should have first entry");
  assert.ok(content.includes(`### ${id2}`), "should have second entry");
  assert.ok(
    content.includes("**Text:** thought one"),
    "should have first text",
  );
  assert.ok(
    content.includes("**Text:** thought two"),
    "should have second text",
  );
});

// ─── loadAllCaptures / loadPendingCaptures ────────────────────────────────────

test("captures: loadAllCaptures parses entries correctly", (t) => {
  const tmp = makeTempDir("cap-load");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "alpha");
  appendCapture(tmp, "beta");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "should have 2 entries");
  assert.strictEqual(all[0].text, "alpha");
  assert.strictEqual(all[1].text, "beta");
  assert.strictEqual(all[0].status, "pending");
  assert.strictEqual(all[1].status, "pending");
});

test("captures: loadAllCaptures returns empty array when no file", (t) => {
  const tmp = makeTempDir("cap-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 0);
});

test("captures: loadPendingCaptures filters resolved entries", (t) => {
  const tmp = makeTempDir("cap-pending");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");

  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");

  const pending = loadPendingCaptures(tmp);
  assert.strictEqual(pending.length, 1, "should have 1 pending");
  assert.strictEqual(pending[0].text, "pending two");
});

test("captures: loadAllCaptures preserves resolved entries", (t) => {
  const tmp = makeTempDir("cap-all-resolved");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");

  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "all should still have 2");
  assert.strictEqual(all[0].status, "resolved");
  assert.strictEqual(all[1].status, "pending");
});

// ─── hasPendingCaptures ───────────────────────────────────────────────────────

test("captures: hasPendingCaptures returns false when no file", (t) => {
  const tmp = makeTempDir("cap-has-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.strictEqual(hasPendingCaptures(tmp), false);
});

test("captures: hasPendingCaptures returns true with pending entries", (t) => {
  const tmp = makeTempDir("cap-has-true");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "something");
  assert.strictEqual(hasPendingCaptures(tmp), true);
});

test("captures: hasPendingCaptures returns false when all resolved", (t) => {
  const tmp = makeTempDir("cap-has-false");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "will resolve");
  markCaptureResolved(tmp, id, "note", "done", "resolved it");
  assert.strictEqual(hasPendingCaptures(tmp), false);
});

// ─── markCaptureResolved ──────────────────────────────────────────────────────

test("captures: markCaptureResolved updates entry in place", (t) => {
  const tmp = makeTempDir("cap-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "keep pending");
  const id2 = appendCapture(tmp, "will resolve");
  appendCapture(tmp, "also pending");

  markCaptureResolved(tmp, id2, "quick-task", "executed inline", "small fix");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 3, "should still have 3 entries");

  const resolved = all.find((c) => c.id === id2)!;
  assert.strictEqual(resolved.status, "resolved");
  assert.strictEqual(resolved.classification, "quick-task");
  assert.strictEqual(resolved.resolution, "executed inline");
  assert.strictEqual(resolved.rationale, "small fix");
  assert.ok(resolved.resolvedAt, "should have resolved timestamp");

  // Others should be unaffected
  const kept = all.find((c) => c.id === id1)!;
  assert.strictEqual(kept.status, "pending");
  assert.strictEqual(kept.classification, undefined);
});

// ─── resolveCapturesPath ──────────────────────────────────────────────────────

test("captures: resolveCapturesPath returns .gsd/CAPTURES.md for normal path", () => {
  const base = join(tmpdir(), "cap-test-project");
  const result = resolveCapturesPath(base);
  assert.ok(result.endsWith(join(".gsd", "CAPTURES.md")));
  assert.ok(result.startsWith(base));
});

test("captures: resolveCapturesPath resolves worktree path to project root", () => {
  const base = join(tmpdir(), "cap-test-project");
  const worktreePath = join(base, ".gsd", "worktrees", "M004");
  const result = resolveCapturesPath(worktreePath);
  assert.ok(
    result.endsWith(join(".gsd", "CAPTURES.md")),
    `should end with .gsd/CAPTURES.md, got: ${result}`,
  );
  // Should resolve to project root, not worktree root
  assert.ok(
    !result.includes("worktrees"),
    `should not contain worktrees, got: ${result}`,
  );
  assert.ok(
    result.startsWith(base),
    `should start with ${base}, got: ${result}`,
  );
});

// ─── parseTriageOutput ────────────────────────────────────────────────────────

test("triage: parseTriageOutput handles valid JSON array", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-abc123",
      classification: "quick-task",
      rationale: "Small fix",
      affectedFiles: ["src/foo.ts"],
    },
    {
      captureId: "CAP-def456",
      classification: "defer",
      rationale: "Future work",
      targetSlice: "S03",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].captureId, "CAP-abc123");
  assert.strictEqual(results[0].classification, "quick-task");
  assert.deepStrictEqual(results[0].affectedFiles, ["src/foo.ts"]);
  assert.strictEqual(results[1].classification, "defer");
  assert.strictEqual(results[1].targetSlice, "S03");
});

test("triage: parseTriageOutput handles fenced code block", () => {
  const input = `Here are my classifications:

\`\`\`json
[
  {
    "captureId": "CAP-aaa",
    "classification": "note",
    "rationale": "Just informational"
  }
]
\`\`\`

That's my analysis.`;

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-aaa");
  assert.strictEqual(results[0].classification, "note");
});

test("triage: parseTriageOutput handles JSON with leading/trailing prose", () => {
  const input = `I've analyzed the captures. Here are my results:
[{"captureId": "CAP-bbb", "classification": "inject", "rationale": "Needs a new task"}]
Let me know if you need changes.`;

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].classification, "inject");
});

test("triage: parseTriageOutput returns empty array on malformed JSON", () => {
  const results = parseTriageOutput("this is not json at all");
  assert.strictEqual(results.length, 0);
});

test("triage: parseTriageOutput returns empty array on empty input", () => {
  assert.strictEqual(parseTriageOutput("").length, 0);
  assert.strictEqual(parseTriageOutput("  ").length, 0);
});

test("triage: parseTriageOutput filters invalid entries from partial results", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-good",
      classification: "note",
      rationale: "Valid entry",
    },
    {
      captureId: "CAP-bad",
      classification: "invalid-type",
      rationale: "Bad classification",
    },
    {
      // Missing required fields
      captureId: "CAP-incomplete",
    },
    {
      captureId: "CAP-also-good",
      classification: "replan",
      rationale: "Needs restructuring",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2, "should keep only valid entries");
  assert.strictEqual(results[0].captureId, "CAP-good");
  assert.strictEqual(results[1].captureId, "CAP-also-good");
});

test("triage: parseTriageOutput wraps single object in array", () => {
  const input = JSON.stringify({
    captureId: "CAP-single",
    classification: "quick-task",
    rationale: "Just one",
  });

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-single");
});

test("triage: parseTriageOutput handles all five classification types", () => {
  const types = [
    "quick-task",
    "inject",
    "defer",
    "replan",
    "note",
  ] as const;

  const input = JSON.stringify(
    types.map((t, i) => ({
      captureId: `CAP-${i}`,
      classification: t,
      rationale: `Type: ${t}`,
    })),
  );

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 5);
  for (let i = 0; i < types.length; i++) {
    assert.strictEqual(results[i].classification, types[i]);
  }
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

test("captures: appendCapture handles special characters in text", (t) => {
  const tmp = makeTempDir("cap-special");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, 'text with "quotes" and **bold** and `code`');
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.ok(all[0].text.includes('"quotes"'), "should preserve quotes");
  assert.ok(all[0].text.includes("**bold**"), "should preserve bold");
});

test("captures: markCaptureResolved is no-op for non-existent ID", (t) => {
  const tmp = makeTempDir("cap-noop");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "real capture");
  // Should not throw
  markCaptureResolved(tmp, "CAP-nonexistent", "note", "test", "test");
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].status, "pending", "original should be unchanged");
});

test("captures: markCaptureResolved is no-op when no file exists", (t) => {
  const tmp = makeTempDir("cap-nofile-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Should not throw
  markCaptureResolved(tmp, "CAP-abc", "note", "test", "test");
});

test("captures: re-resolving a capture overwrites previous resolution", (t) => {
  const tmp = makeTempDir("cap-reresolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "will re-resolve");
  markCaptureResolved(tmp, id, "note", "first resolution", "first rationale");
  markCaptureResolved(tmp, id, "inject", "second resolution", "second rationale");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].classification, "inject", "should have updated classification");
  assert.strictEqual(all[0].resolution, "second resolution");
  assert.strictEqual(all[0].rationale, "second rationale");
});

test("triage: parseTriageOutput preserves affectedFiles and targetSlice", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-files",
      classification: "quick-task",
      rationale: "Has files",
      affectedFiles: ["src/a.ts", "src/b.ts"],
    },
    {
      captureId: "CAP-target",
      classification: "defer",
      rationale: "Has target",
      targetSlice: "S04",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.deepStrictEqual(results[0].affectedFiles, ["src/a.ts", "src/b.ts"]);
  assert.strictEqual(results[0].targetSlice, undefined);
  assert.strictEqual(results[1].targetSlice, "S04");
  assert.strictEqual(results[1].affectedFiles, undefined);
});

// ─── Stale Quick-Task Captures (#2872) ────────────────────────────────────────

test("captures: markCaptureResolved stores milestone ID when provided", (t) => {
  const tmp = makeTempDir("cap-milestone");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "fix dialog width");
  markCaptureResolved(tmp, id, "quick-task", "widen the dialog", "small fix", "M003");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].resolvedInMilestone, "M003", "should store milestone ID");
});

test("captures: loadActionableCaptures excludes captures resolved in prior milestones", (t) => {
  const tmp = makeTempDir("cap-stale-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Capture resolved in M003 (prior milestone)
  const id1 = appendCapture(tmp, "dialog too narrow");
  markCaptureResolved(tmp, id1, "quick-task", "widen it", "small fix", "M003");

  // Capture resolved in M004 (current milestone)
  const id2 = appendCapture(tmp, "button misaligned");
  markCaptureResolved(tmp, id2, "quick-task", "fix alignment", "css fix", "M004");

  // Capture resolved without milestone context (legacy)
  const id3 = appendCapture(tmp, "typo in label");
  markCaptureResolved(tmp, id3, "quick-task", "fix typo", "trivial");

  // When loading for M004, only M004 and no-milestone captures should be returned
  const actionable = loadActionableCaptures(tmp, "M004");
  const ids = actionable.map(c => c.id);

  assert.ok(!ids.includes(id1), "should exclude capture resolved in M003");
  assert.ok(ids.includes(id2), "should include capture resolved in M004");
  assert.ok(ids.includes(id3), "should include capture with no milestone (legacy)");
});

test("captures: loadActionableCaptures without milestone returns all actionable", (t) => {
  const tmp = makeTempDir("cap-no-milestone-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "issue one");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M003");

  const id2 = appendCapture(tmp, "issue two");
  markCaptureResolved(tmp, id2, "inject", "inject it", "needed", "M004");

  // Without milestone filter, all actionable captures are returned (backward compat)
  const actionable = loadActionableCaptures(tmp);
  assert.strictEqual(actionable.length, 2, "should return all actionable without filter");
});

test("captures: loadActionableCaptures excludes already-executed captures", (t) => {
  const tmp = makeTempDir("cap-executed-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "already done");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M004");
  markCaptureExecuted(tmp, id1);

  const id2 = appendCapture(tmp, "still pending");
  markCaptureResolved(tmp, id2, "quick-task", "fix it too", "small", "M004");

  const actionable = loadActionableCaptures(tmp, "M004");
  assert.strictEqual(actionable.length, 1, "should exclude executed capture");
  assert.strictEqual(actionable[0].id, id2);
});

test("captures: stampCaptureMilestone adds milestone to capture missing it", (t) => {
  const tmp = makeTempDir("cap-stamp-milestone");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "fix alignment");
  markCaptureResolved(tmp, id, "quick-task", "fix it", "small");

  // Before stamping, no milestone
  let all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, undefined, "should have no milestone initially");

  stampCaptureMilestone(tmp, id, "M004");

  all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, "M004", "should have milestone after stamping");
});

test("captures: stampCaptureMilestone is no-op if milestone already present", (t) => {
  const tmp = makeTempDir("cap-stamp-noop");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "fix alignment");
  markCaptureResolved(tmp, id, "quick-task", "fix it", "small", "M003");

  stampCaptureMilestone(tmp, id, "M004");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all[0].resolvedInMilestone, "M003", "should keep original milestone");
});
