/**
 * Unit tests for GSD Triage Resolution — resolution execution and file overlap detection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendCapture, markCaptureResolved, markCaptureExecuted, loadAllCaptures, loadActionableCaptures } from "../captures.ts";
// Import only the functions that don't depend on @gsd/pi-coding-agent
// (triage-ui.ts imports next-action-ui.ts which imports the unavailable package)
import { executeInject, executeReplan, detectFileOverlap, loadDeferredCaptures, loadReplanCaptures, buildQuickTaskPrompt, executeTriageResolutions, ensureDeferMilestoneDir } from "../triage-resolution.ts";

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
  assert.ok(
    prompt.includes("Verify the issue still exists"),
    "should instruct agent to verify issue still exists (#2872)",
  );
  assert.ok(
    prompt.includes("Already resolved"),
    "should instruct agent to report already resolved if fixed (#2872)",
  );
});

// ─── markCaptureExecuted ─────────────────────────────────────────────────────

test("resolution: markCaptureExecuted adds Executed field to capture", () => {
  const tmp = makeTempDir("res-executed");
  try {
    const id = appendCapture(tmp, "fix the button");
    markCaptureResolved(tmp, id, "quick-task", "execute as quick-task", "small fix");

    markCaptureExecuted(tmp, id);

    const all = loadAllCaptures(tmp);
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].executed, true, "should be marked as executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: markCaptureExecuted is idempotent", () => {
  const tmp = makeTempDir("res-executed-idem");
  try {
    const id = appendCapture(tmp, "fix something");
    markCaptureResolved(tmp, id, "inject", "inject task", "needed");

    markCaptureExecuted(tmp, id);
    markCaptureExecuted(tmp, id); // call again — should not duplicate

    const filePath = join(tmp, ".gsd", "CAPTURES.md");
    const content = readFileSync(filePath, "utf-8");
    const executedMatches = content.match(/\*\*Executed:\*\*/g);
    assert.strictEqual(executedMatches?.length, 1, "should have exactly one Executed field");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── loadActionableCaptures ──────────────────────────────────────────────────

test("resolution: loadActionableCaptures returns only unexecuted actionable captures", () => {
  const tmp = makeTempDir("res-actionable");
  try {
    const id1 = appendCapture(tmp, "inject this task");
    const id2 = appendCapture(tmp, "quick fix");
    const id3 = appendCapture(tmp, "just a note");
    const id4 = appendCapture(tmp, "replan needed");
    const id5 = appendCapture(tmp, "already executed inject");

    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "quick-task", "quick fix", "small");
    markCaptureResolved(tmp, id3, "note", "acknowledged", "info");
    markCaptureResolved(tmp, id4, "replan", "replan triggered", "approach changed");
    markCaptureResolved(tmp, id5, "inject", "add task", "needed");
    markCaptureExecuted(tmp, id5); // mark as executed

    const actionable = loadActionableCaptures(tmp);
    assert.strictEqual(actionable.length, 3, "should have 3 actionable captures");
    assert.deepStrictEqual(
      actionable.map(c => c.id),
      [id1, id2, id4],
      "should include inject, quick-task, replan but not note or executed inject",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── executeTriageResolutions ────────────────────────────────────────────────

test("resolution: executeTriageResolutions executes inject captures", () => {
  const tmp = makeTempDir("res-exec-inject");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id1 = appendCapture(tmp, "add error handling");
    const id2 = appendCapture(tmp, "add retry logic");
    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "inject", "add task", "also needed");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.injected, 2, "should inject 2 tasks");
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 0);

    // Verify tasks were added to plan
    const planPath = join(tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = readFileSync(planPath, "utf-8");
    assert.ok(planContent.includes("**T04:"), "should have T04");
    assert.ok(planContent.includes("**T05:"), "should have T05");

    // Verify captures marked as executed
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "first capture should be executed");
    assert.strictEqual(all[1].executed, true, "second capture should be executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions executes replan captures", () => {
  const tmp = makeTempDir("res-exec-replan");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id = appendCapture(tmp, "approach is wrong");
    markCaptureResolved(tmp, id, "replan", "replan triggered", "wrong approach");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 1, "should trigger 1 replan");
    assert.strictEqual(result.quickTasks.length, 0);

    // Verify trigger file was written
    const triggerPath = join(
      tmp, ".gsd", "milestones", "M001", "slices", "S01", "S01-REPLAN-TRIGGER.md",
    );
    assert.ok(existsSync(triggerPath), "replan trigger should exist");

    // Verify capture marked as executed
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "capture should be executed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions queues quick-tasks without executing inline", () => {
  const tmp = makeTempDir("res-exec-qt");
  try {
    const id = appendCapture(tmp, "fix typo in readme");
    markCaptureResolved(tmp, id, "quick-task", "execute as quick-task", "small fix");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 1, "should queue 1 quick-task");
    assert.strictEqual(result.quickTasks[0].id, id);

    // Quick-tasks should NOT be marked as executed yet (caller marks after dispatch)
    const all = loadAllCaptures(tmp);
    assert.ok(!all[0].executed, "quick-task should not be executed yet");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions handles mixed classifications", () => {
  const tmp = makeTempDir("res-exec-mixed");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id1 = appendCapture(tmp, "inject a task");
    const id2 = appendCapture(tmp, "quick fix typo");
    const id3 = appendCapture(tmp, "just a note");
    const id4 = appendCapture(tmp, "defer to later");

    markCaptureResolved(tmp, id1, "inject", "add task", "needed");
    markCaptureResolved(tmp, id2, "quick-task", "quick fix", "small");
    markCaptureResolved(tmp, id3, "note", "acknowledged", "info");
    markCaptureResolved(tmp, id4, "defer", "deferred", "later");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.injected, 1, "should inject 1 task");
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 1, "should queue 1 quick-task");
    assert.strictEqual(result.actions.length, 2, "should have 2 action entries (note/defer excluded)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions skips already-executed captures", () => {
  const tmp = makeTempDir("res-exec-skip");
  try {
    setupPlanFile(tmp, "M001", "S01", SAMPLE_PLAN);
    const id = appendCapture(tmp, "already done");
    markCaptureResolved(tmp, id, "inject", "add task", "needed");
    markCaptureExecuted(tmp, id); // already executed

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.injected, 0, "should not inject again");
    assert.strictEqual(result.actions.length, 0, "should have no actions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions returns empty result when no actionable captures", () => {
  const tmp = makeTempDir("res-exec-empty");
  try {
    const result = executeTriageResolutions(tmp, "M001", "S01");
    assert.strictEqual(result.injected, 0);
    assert.strictEqual(result.replanned, 0);
    assert.strictEqual(result.quickTasks.length, 0);
    assert.strictEqual(result.actions.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── ensureDeferMilestoneDir ─────────────────────────────────────────────────

test("resolution: ensureDeferMilestoneDir creates milestone directory with CONTEXT-DRAFT.md", () => {
  const tmp = makeTempDir("res-defer-create");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });

    const captures = [
      { id: "CAP-aaa111", text: "add performance monitoring", timestamp: "2026-03-15T20:00:00Z", status: "resolved" as const, classification: "defer" as const },
      { id: "CAP-bbb222", text: "optimize database queries", timestamp: "2026-03-15T20:01:00Z", status: "resolved" as const, classification: "defer" as const },
    ];

    const created = ensureDeferMilestoneDir(tmp, "M005", captures);
    assert.strictEqual(created, true, "should return true");

    const msDir = join(tmp, ".gsd", "milestones", "M005");
    assert.ok(existsSync(msDir), "milestone directory should exist");

    const draftPath = join(msDir, "M005-CONTEXT-DRAFT.md");
    assert.ok(existsSync(draftPath), "CONTEXT-DRAFT.md should exist");

    const content = readFileSync(draftPath, "utf-8");
    assert.ok(content.includes("# M005:"), "should have milestone heading");
    assert.ok(content.includes("CAP-aaa111"), "should list first capture");
    assert.ok(content.includes("CAP-bbb222"), "should list second capture");
    assert.ok(content.includes("add performance monitoring"), "should include capture text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: ensureDeferMilestoneDir returns true without overwriting existing directory", () => {
  const tmp = makeTempDir("res-defer-exists");
  try {
    const msDir = join(tmp, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "M003-CONTEXT.md"), "# M003: Existing\n", "utf-8");

    const created = ensureDeferMilestoneDir(tmp, "M003", []);
    assert.strictEqual(created, true, "should return true for existing dir");
    // Original file should still be there
    assert.ok(existsSync(join(msDir, "M003-CONTEXT.md")), "existing files should be preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: ensureDeferMilestoneDir rejects invalid milestone IDs", () => {
  const tmp = makeTempDir("res-defer-invalid");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "S03", []), false, "should reject slice IDs");
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "not-a-milestone", []), false, "should reject arbitrary strings");
    assert.strictEqual(ensureDeferMilestoneDir(tmp, "", []), false, "should reject empty string");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: ensureDeferMilestoneDir handles unique milestone IDs (M005-abc123)", () => {
  const tmp = makeTempDir("res-defer-unique");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });

    const created = ensureDeferMilestoneDir(tmp, "M005-abc123", [
      { id: "CAP-ccc333", text: "future work", timestamp: "2026-03-15T20:00:00Z", status: "resolved" as const, classification: "defer" as const },
    ]);
    assert.strictEqual(created, true);

    const msDir = join(tmp, ".gsd", "milestones", "M005-abc123");
    assert.ok(existsSync(msDir), "milestone directory should exist");
    assert.ok(
      existsSync(join(msDir, "M005-abc123-CONTEXT-DRAFT.md")),
      "CONTEXT-DRAFT.md should use full milestone ID",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── executeTriageResolutions + defer ────────────────────────────────────────

test("resolution: executeTriageResolutions creates milestone dir for deferred captures", () => {
  const tmp = makeTempDir("res-exec-defer");
  try {
    mkdirSync(join(tmp, ".gsd", "milestones"), { recursive: true });

    const id1 = appendCapture(tmp, "add caching layer");
    const id2 = appendCapture(tmp, "optimize queries");
    markCaptureResolved(tmp, id1, "defer", "deferred to M005", "future perf work");
    markCaptureResolved(tmp, id2, "defer", "deferred to M005", "future perf work");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.deferredMilestones, 1, "should create 1 milestone");
    assert.ok(
      existsSync(join(tmp, ".gsd", "milestones", "M005")),
      "M005 directory should exist",
    );
    assert.ok(
      existsSync(join(tmp, ".gsd", "milestones", "M005", "M005-CONTEXT-DRAFT.md")),
      "CONTEXT-DRAFT.md should exist",
    );

    // Deferred captures should be marked as executed
    const all = loadAllCaptures(tmp);
    assert.strictEqual(all[0].executed, true, "first defer should be marked executed");
    assert.strictEqual(all[1].executed, true, "second defer should be marked executed");

    // Verify the draft content includes both captures
    const draft = readFileSync(join(tmp, ".gsd", "milestones", "M005", "M005-CONTEXT-DRAFT.md"), "utf-8");
    assert.ok(draft.includes("add caching layer"), "should include first capture text");
    assert.ok(draft.includes("optimize queries"), "should include second capture text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolution: executeTriageResolutions skips defer when milestone already exists", () => {
  const tmp = makeTempDir("res-exec-defer-exists");
  try {
    // Pre-create M005
    const msDir = join(tmp, ".gsd", "milestones", "M005");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "M005-CONTEXT.md"), "# M005: Already Planned\n", "utf-8");

    const id = appendCapture(tmp, "defer this");
    markCaptureResolved(tmp, id, "defer", "deferred to M005", "later");

    const result = executeTriageResolutions(tmp, "M001", "S01");

    assert.strictEqual(result.deferredMilestones, 0, "should not count existing milestone");
    // Original file should be preserved
    assert.ok(existsSync(join(msDir, "M005-CONTEXT.md")), "existing files should be preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
