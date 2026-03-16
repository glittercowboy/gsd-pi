/**
 * Unit tests for GSD Triage Resolution — resolution execution and file overlap detection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCapture, markCaptureResolved, loadAllCaptures } from "../captures.ts";
// Import only the functions that don't depend on @gsd/pi-coding-agent
// (triage-ui.ts imports next-action-ui.ts which imports the unavailable package)
import { executeInject, executeReplan, detectFileOverlap, loadDeferredCaptures, loadReplanCaptures, buildQuickTaskPrompt } from "../triage-resolution.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupPlanFile(tmp: string, mid: string, sid: string, content: string): string {
  const planDir = join(tmp, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, `${sid}-PLAN.md`);
  writeFileSync(planPath, content, "utf-8");
  return planPath;
}

const SAMPLE_PLAN = `# S01: Test Slice

**Goal:** Test
**Demo:** Test

## Must-Haves

- Something works

## Tasks

- [x] **T01: First task** \`est:1h\`
  - Why: Setup
  - Files: \`src/foo.ts\`, \`src/bar.ts\`
  - Do: Build it
  - Done when: Tests pass

- [ ] **T02: Second task** \`est:1h\`
  - Why: Feature
  - Files: \`src/baz.ts\`, \`src/qux.ts\`
  - Do: Build it
  - Done when: Tests pass

- [ ] **T03: Third task** \`est:30m\`
  - Why: Polish
  - Files: \`src/qux.ts\`, \`src/config.ts\`
  - Do: Build it
  - Done when: Tests pass

## Files Likely Touched

- \`src/foo.ts\`
- \`src/bar.ts\`
`;

// ─── executeInject ────────────────────────────────────────────────────────────

test("resolution: executeInject appends a new task to the plan", () => {
  const tmp = makeTempDir("res-inject");
  try {
    const planPath = setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const captureId = appendCapture(tmp, "add retry logic");
    const captures = loadAllCaptures(tmp);
    const capture = captures[0];

    const newId = executeInject(tmp, "M001", "S01", capture);

    assert.strictEqual(newId, "T04", "should be T04 (next after T03)");

    const updated = readFileSync(planPath, "utf-8");
    assert.ok(updated.includes("**T04:"), "should have T04 in plan");
    assert.ok(updated.includes(capture.text), "should include capture text");
    assert.ok(updated.includes("## Files Likely Touched"), "should preserve files section");

    // T04 should appear before Files Likely Touched
    const t04Pos = updated.indexOf("**T04:");
    const filesPos = updated.indexOf("## Files Likely Touched");
    assert.ok(t04Pos < filesPos, "T04 should be before Files section");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeInject returns null when plan doesn't exist", () => {
  const tmp = makeTempDir("res-inject-noplan");
  try {
    const captureId = appendCapture(tmp, "some task");
    const captures = loadAllCaptures(tmp);
    const result = executeInject(tmp, "M001", "S01", captures[0]);
    assert.strictEqual(result, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── executeReplan ────────────────────────────────────────────────────────────

test("resolution: executeReplan writes REPLAN-TRIGGER.md", () => {
  const tmp = makeTempDir("res-replan");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const captureId = appendCapture(tmp, "approach is wrong, need different strategy");
    const captures = loadAllCaptures(tmp);
    const capture = captures[0];

    const result = executeReplan(tmp, "M001", "S01", capture);
    assert.strictEqual(result, true);

    const triggerPath = join(
      tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN-TRIGGER.md",
    );
    assert.ok(existsSync(triggerPath), "trigger file should exist");

    const content = readFileSync(triggerPath, "utf-8");
    assert.ok(content.includes(capture.id), "should include capture ID");
    assert.ok(content.includes(capture.text), "should include capture text");
    assert.ok(content.includes("# Replan Trigger"), "should have header");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── detectFileOverlap ───────────────────────────────────────────────────────

test("resolution: detectFileOverlap finds overlapping incomplete tasks", () => {
  const overlaps = detectFileOverlap(["src/qux.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, ["T02", "T03"]);
});

test("resolution: detectFileOverlap ignores completed tasks", () => {
  // T01 is [x] and uses src/foo.ts — should NOT be returned
  const overlaps = detectFileOverlap(["src/foo.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, []);
});

test("resolution: detectFileOverlap returns empty when no overlap", () => {
  const overlaps = detectFileOverlap(["src/unrelated.ts"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, []);
});

test("resolution: detectFileOverlap returns empty for empty affected files", () => {
  assert.deepStrictEqual(detectFileOverlap([], SAMPLE_PLAN), []);
});

test("resolution: detectFileOverlap is case-insensitive", () => {
  const overlaps = detectFileOverlap(["SRC/QUX.TS"], SAMPLE_PLAN);
  assert.deepStrictEqual(overlaps, ["T02", "T03"]);
});

// ─── loadDeferredCaptures / loadReplanCaptures ───────────────────────────────

test("resolution: loadDeferredCaptures returns only deferred captures", () => {
  const tmp = makeTempDir("res-deferred");
  try {
    const id1 = appendCapture(tmp, "deferred one");
    const id2 = appendCapture(tmp, "note one");
    const id3 = appendCapture(tmp, "deferred two");

    markCaptureResolved(tmp, id1, "defer", "deferred to S03", "future work");
    markCaptureResolved(tmp, id2, "note", "acknowledged", "just a note");
    markCaptureResolved(tmp, id3, "defer", "deferred to S04", "later");

    const deferred = loadDeferredCaptures(tmp);
    assert.strictEqual(deferred.length, 2);
    assert.strictEqual(deferred[0].id, id1);
    assert.strictEqual(deferred[1].id, id3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: loadReplanCaptures returns only replan captures", () => {
  const tmp = makeTempDir("res-replan-load");
  try {
    const id1 = appendCapture(tmp, "needs replan");
    const id2 = appendCapture(tmp, "just a note");

    markCaptureResolved(tmp, id1, "replan", "replan triggered", "approach changed");
    markCaptureResolved(tmp, id2, "note", "acknowledged", "info only");

    const replans = loadReplanCaptures(tmp);
    assert.strictEqual(replans.length, 1);
    assert.strictEqual(replans[0].id, id1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── buildQuickTaskPrompt ────────────────────────────────────────────────────

test("resolution: buildQuickTaskPrompt includes capture text and ID", () => {
  const prompt = buildQuickTaskPrompt({
    id: "CAP-abc123",
    text: "add retry logic to OAuth",
    timestamp: "2026-03-15T20:00:00Z",
    status: "resolved",
    classification: "quick-task",
  });

  assert.ok(prompt.includes("CAP-abc123"), "should include capture ID");
  assert.ok(prompt.includes("add retry logic to OAuth"), "should include capture text");
  assert.ok(prompt.includes("Quick Task"), "should have Quick Task header");
  assert.ok(prompt.includes("Do NOT modify"), "should warn about plan files");
});
