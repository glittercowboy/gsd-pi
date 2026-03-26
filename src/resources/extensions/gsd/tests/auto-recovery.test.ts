import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  diagnoseExpectedArtifact,
  writeBlockerPlaceholder,
  buildLoopRemediationSteps,
  selfHealRuntimeRecords,
  hasImplementationArtifacts,
} from "../auto-recovery.ts";
import { parseRoadmap, parsePlan } from "../parsers-legacy.ts";
import { parseTaskPlanFile, clearParseCache } from "../files.ts";
import { invalidateAllCaches } from "../cache.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";
import { renderPlanFromDb } from "../markdown-renderer.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  // Create .gsd/milestones/M001/slices/S01/tasks/ structure
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

// ─── resolveExpectedArtifactPath ──────────────────────────────────────────

test("resolveExpectedArtifactPath returns correct path for research-milestone", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("research-milestone", "M001", base);
  assert.ok(result);
  assert.ok(result!.includes("M001"));
  assert.ok(result!.includes("RESEARCH"));
});

test("resolveExpectedArtifactPath returns correct path for execute-task", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("execute-task", "M001/S01/T01", base);
  assert.ok(result);
  assert.ok(result!.includes("tasks"));
  assert.ok(result!.includes("SUMMARY"));
});

test("resolveExpectedArtifactPath returns correct path for complete-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("complete-slice", "M001/S01", base);
  assert.ok(result);
  assert.ok(result!.includes("SUMMARY"));
});

test("resolveExpectedArtifactPath returns correct path for plan-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
  assert.ok(result);
  assert.ok(result!.includes("PLAN"));
});

test("resolveExpectedArtifactPath returns null for unknown type", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("unknown-type", "M001", base);
  assert.equal(result, null);
});

test("resolveExpectedArtifactPath returns correct path for all milestone-level types", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const planResult = resolveExpectedArtifactPath("plan-milestone", "M001", base);
  assert.ok(planResult);
  assert.ok(planResult!.includes("ROADMAP"));

  const completeResult = resolveExpectedArtifactPath("complete-milestone", "M001", base);
  assert.ok(completeResult);
  assert.ok(completeResult!.includes("SUMMARY"));
});

test("resolveExpectedArtifactPath returns correct path for all slice-level types", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const researchResult = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
  assert.ok(researchResult);
  assert.ok(researchResult!.includes("RESEARCH"));

  const assessResult = resolveExpectedArtifactPath("reassess-roadmap", "M001/S01", base);
  assert.ok(assessResult);
  assert.ok(assessResult!.includes("ASSESSMENT"));

  const uatResult = resolveExpectedArtifactPath("run-uat", "M001/S01", base);
  assert.ok(uatResult);
  assert.ok(uatResult!.includes("UAT-RESULT"));
});

// ─── diagnoseExpectedArtifact ─────────────────────────────────────────────

test("diagnoseExpectedArtifact returns description for known types", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const research = diagnoseExpectedArtifact("research-milestone", "M001", base);
  assert.ok(research);
  assert.ok(research!.includes("research"));

  const plan = diagnoseExpectedArtifact("plan-slice", "M001/S01", base);
  assert.ok(plan);
  assert.ok(plan!.includes("plan"));

  const task = diagnoseExpectedArtifact("execute-task", "M001/S01/T01", base);
  assert.ok(task);
  assert.ok(task!.includes("T01"));
});

test("diagnoseExpectedArtifact returns null for unknown type", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  assert.equal(diagnoseExpectedArtifact("unknown", "M001", base), null);
});

// ─── buildLoopRemediationSteps ────────────────────────────────────────────

test("buildLoopRemediationSteps returns steps for execute-task", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const steps = buildLoopRemediationSteps("execute-task", "M001/S01/T01", base);
  assert.ok(steps);
  assert.ok(steps!.includes("T01"));
  assert.ok(steps!.includes("gsd undo-task"));
});

test("buildLoopRemediationSteps returns steps for plan-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const steps = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
  assert.ok(steps);
  assert.ok(steps!.includes("PLAN"));
  assert.ok(steps!.includes("gsd recover"));
});

test("buildLoopRemediationSteps returns steps for complete-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const steps = buildLoopRemediationSteps("complete-slice", "M001/S01", base);
  assert.ok(steps);
  assert.ok(steps!.includes("S01"));
  assert.ok(steps!.includes("gsd reset-slice"));
});

test("buildLoopRemediationSteps returns null for unknown type", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  assert.equal(buildLoopRemediationSteps("unknown", "M001", base), null);
});

// ─── verifyExpectedArtifact: parse cache collision regression ─────────────

test("verifyExpectedArtifact detects roadmap [x] change despite parse cache", (t) => {
  // Regression test: cacheKey collision when [ ] → [x] doesn't change
  // file length or first/last 100 chars. Without the fix, parseRoadmap
  // returns stale cached data with done=false even though the file has [x].
  const base = makeTmpBase();
  t.after(() => {
    clearParseCache();
    cleanup(base);
  });

  // Build a roadmap long enough that the [x] change is outside the first/last 100 chars
  const padding = "A".repeat(200);
  const roadmapBefore = [
    `# M001: Test Milestone ${padding}`,
    "",
    "## Slices",
    "",
    "- [ ] **S01: First slice** `risk:low`",
    "",
    `## Footer ${padding}`,
  ].join("\n");
  const roadmapAfter = roadmapBefore.replace("- [ ] **S01:", "- [x] **S01:");

  // Verify lengths are identical (the key collision condition)
  assert.equal(roadmapBefore.length, roadmapAfter.length);

  // Populate parse cache with the pre-edit roadmap
  const before = parseRoadmap(roadmapBefore);
  const sliceBefore = before.slices.find(s => s.id === "S01");
  assert.ok(sliceBefore);
  assert.equal(sliceBefore!.done, false);

  // Now write the post-edit roadmap to disk and create required artifacts
  const roadmapPath = join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
  writeFileSync(roadmapPath, roadmapAfter);
  const summaryPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
  writeFileSync(summaryPath, "# Summary\nDone.");
  const uatPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT.md");
  writeFileSync(uatPath, "# UAT\nPassed.");

  // verifyExpectedArtifact should see the [x] despite the parse cache
  // having the [ ] version. The fix clears the parse cache inside verify.
  const verified = verifyExpectedArtifact("complete-slice", "M001/S01", base);
  assert.equal(verified, true, "verifyExpectedArtifact should return true when roadmap has [x]");
});

// ─── verifyExpectedArtifact: plan-slice empty scaffold regression (#699) ──

test("verifyExpectedArtifact rejects plan-slice with empty scaffold", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Test Slice\n\n## Tasks\n\n");
  assert.strictEqual(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    false,
    "Empty scaffold should not be treated as completed artifact",
  );
});

test("verifyExpectedArtifact accepts plan-slice with actual tasks", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: Implement feature** `est:2h`",
    "- [ ] **T02: Write tests** `est:1h`",
  ].join("\n"));
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
  assert.strictEqual(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    true,
    "Plan with task entries should be treated as completed artifact",
  );
});

test("verifyExpectedArtifact accepts plan-slice with completed tasks", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "- [x] **T01: Implement feature** `est:2h`",
    "- [ ] **T02: Write tests** `est:1h`",
  ].join("\n"));
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
  assert.strictEqual(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    true,
    "Plan with completed task entries should be treated as completed artifact",
  );
});

// ─── verifyExpectedArtifact: plan-slice task plan check (#739) ────────────

test("verifyExpectedArtifact plan-slice passes when all task plan files exist", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  const planContent = [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: First task** `est:1h`",
    "- [ ] **T02: Second task** `est:2h`",
  ].join("\n");
  writeFileSync(planPath, planContent);
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan\n\nDo the other thing.");

  const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
  assert.equal(result, true, "should pass when all task plan files exist");
});

test("verifyExpectedArtifact plan-slice fails when a task plan file is missing (#739)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  const planContent = [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "- [ ] **T01: First task** `est:1h`",
    "- [ ] **T02: Second task** `est:2h`",
  ].join("\n");
  writeFileSync(planPath, planContent);
  // Only write T01-PLAN.md — T02 is missing
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.");

  const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
  assert.equal(result, false, "should fail when T02-PLAN.md is missing");
});

test("verifyExpectedArtifact plan-slice fails for plan with no tasks (#699)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const planPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  const planContent = [
    "# S01: Test Slice",
    "",
    "## Goal",
    "",
    "Just some documentation updates, no tasks.",
  ].join("\n");
  writeFileSync(planPath, planContent);

  const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
  assert.equal(result, false, "should fail when plan has no task entries (empty scaffold, #699)");
});

// ─── verifyExpectedArtifact: heading-style plan tasks (#1691) ─────────────

test("verifyExpectedArtifact accepts plan-slice with heading-style tasks (### T01 --)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "### T01 -- Implement feature",
    "",
    "Feature description.",
    "",
    "### T02 -- Write tests",
    "",
    "Test description.",
  ].join("\n"));
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02 Plan");
  assert.strictEqual(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    true,
    "Heading-style plan with task entries should be treated as completed artifact",
  );
});

test("verifyExpectedArtifact accepts plan-slice with colon-style heading tasks (### T01:)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "### T01: Implement feature",
    "",
    "Feature description.",
  ].join("\n"));
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan");
  assert.strictEqual(
    verifyExpectedArtifact("plan-slice", "M001/S01", base),
    true,
    "Colon heading-style plan should be treated as completed artifact",
  );
});

test("verifyExpectedArtifact execute-task passes for heading-style plan entry (#1691)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), [
    "# S01: Test Slice",
    "",
    "## Tasks",
    "",
    "### T01 -- Implement feature",
    "",
    "Feature description.",
  ].join("\n"));
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone.");
  assert.strictEqual(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    true,
    "execute-task should pass for heading-style plan entry when summary exists",
  );
});

test("verifyExpectedArtifact plan-slice passes for rendered slice/task plan artifacts from DB", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Rendered slice",
      status: "pending",
      demo: "Rendered plan artifacts exist.",
      planning: {
        goal: "Render plans from DB rows.",
        successCriteria: "- Slice plan parses\n- Task plan files exist on disk",
        proofLevel: "integration",
        integrationClosure: "DB rows are the source of truth for PLAN artifacts.",
        observabilityImpact: "- Recovery verification fails if a task plan file is missing",
      },
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Render plan",
      status: "pending",
      planning: {
        description: "Create the slice plan from DB state.",
        estimate: "30m",
        files: ["src/resources/extensions/gsd/markdown-renderer.ts"],
        verify: "node --test markdown-renderer.test.ts",
        inputs: ["src/resources/extensions/gsd/gsd-db.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/markdown-renderer.test.ts"],
        observabilityImpact: "Renderer tests cover the failure mode.",
      },
    });
    insertTask({
      id: "T02",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Verify recovery",
      status: "pending",
      planning: {
        description: "Prove task plan files remain present for recovery.",
        estimate: "20m",
        files: ["src/resources/extensions/gsd/auto-recovery.ts"],
        verify: "node --test auto-recovery.test.ts",
        inputs: ["src/resources/extensions/gsd/auto-recovery.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/auto-recovery.test.ts"],
        observabilityImpact: "Missing plan files surface as explicit verification failures.",
      },
    });

    const rendered = await renderPlanFromDb(base, "M001", "S01");
    assert.ok(existsSync(rendered.planPath), "renderPlanFromDb should write the slice plan");
    assert.equal(rendered.taskPlanPaths.length, 2, "renderPlanFromDb should render one task plan per task");

    const planContent = readFileSync(rendered.planPath, "utf-8");
    const parsedPlan = parsePlan(planContent);
    assert.equal(parsedPlan.tasks.length, 2, "rendered slice plan should parse into task entries");

    const taskPlanContent = readFileSync(rendered.taskPlanPaths[0], "utf-8");
    const taskPlan = parseTaskPlanFile(taskPlanContent);
    assert.deepEqual(taskPlan.frontmatter.skills_used, [], "rendered task plans should use conservative empty skills_used");

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, true, "plan-slice verification should pass when rendered task plan files exist");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice fails after deleting a rendered task plan file", async () => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  try {
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Rendered slice",
      status: "pending",
      demo: "Rendered plan artifacts exist.",
      planning: {
        goal: "Render plans from DB rows.",
        successCriteria: "- Slice plan parses\n- Task plan files exist on disk",
        proofLevel: "integration",
        integrationClosure: "DB rows are the source of truth for PLAN artifacts.",
        observabilityImpact: "- Recovery verification fails if a task plan file is missing",
      },
    });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Render plan",
      status: "pending",
      planning: {
        description: "Create the slice plan from DB state.",
        estimate: "30m",
        files: ["src/resources/extensions/gsd/markdown-renderer.ts"],
        verify: "node --test markdown-renderer.test.ts",
        inputs: ["src/resources/extensions/gsd/gsd-db.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/markdown-renderer.test.ts"],
        observabilityImpact: "Renderer tests cover the failure mode.",
      },
    });
    insertTask({
      id: "T02",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Verify recovery",
      status: "pending",
      planning: {
        description: "Prove task plan files remain present for recovery.",
        estimate: "20m",
        files: ["src/resources/extensions/gsd/auto-recovery.ts"],
        verify: "node --test auto-recovery.test.ts",
        inputs: ["src/resources/extensions/gsd/auto-recovery.ts"],
        expectedOutput: ["src/resources/extensions/gsd/tests/auto-recovery.test.ts"],
        observabilityImpact: "Missing plan files surface as explicit verification failures.",
      },
    });

    const rendered = await renderPlanFromDb(base, "M001", "S01");
    rmSync(rendered.taskPlanPaths[1]);

    const result = verifyExpectedArtifact("plan-slice", "M001/S01", base);
    assert.equal(result, false, "plan-slice verification should fail when a rendered task plan file is removed");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

// ─── selfHealRuntimeRecords — worktree base path (#769) ──────────────────

test("selfHealRuntimeRecords clears stale dispatched records (#769)", async (t) => {
  // selfHealRuntimeRecords now only clears stale dispatched records (>1h).
  // No completedKeySet parameter — deriveState is sole authority.
  const worktreeBase = makeTmpBase();
  const mainBase = makeTmpBase();
  t.after(() => {
    cleanup(worktreeBase);
    cleanup(mainBase);
  });

  const { writeUnitRuntimeRecord, readUnitRuntimeRecord } = await import("../unit-runtime.ts");

  // Write a stale runtime record in the worktree .gsd/runtime/units/
  writeUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01", Date.now() - 7200_000, {
    phase: "dispatched",
  });

  // Verify the runtime record exists before heal
  const before = readUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01");
  assert.ok(before, "runtime record should exist before heal");

  // Mock ExtensionContext with minimal notify
  const notifications: string[] = [];
  const mockCtx = {
    ui: { notify: (msg: string) => { notifications.push(msg); } },
  } as any;

  // Call selfHeal with worktreeBase — should clear the stale record
  await selfHealRuntimeRecords(worktreeBase, mockCtx);

  // The stale record should be cleared
  const after = readUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01");
  assert.equal(after, null, "runtime record should be cleared after heal");
  assert.ok(notifications.some(n => n.includes("Self-heal")), "should emit self-heal notification");

  // Write a stale record at mainBase
  writeUnitRuntimeRecord(mainBase, "run-uat", "M001/S01", Date.now() - 7200_000, {
    phase: "dispatched",
  });
  await selfHealRuntimeRecords(mainBase, mockCtx);

  // The record at mainBase should also be cleared by the stale timeout (>1h)
  const afterMain = readUnitRuntimeRecord(mainBase, "run-uat", "M001/S01");
  assert.equal(afterMain, null, "stale record at main base should be cleared by timeout");
});

// ─── #1625: selfHealRuntimeRecords on resume clears paused-session leftovers ──

test("selfHealRuntimeRecords clears recently-paused dispatched records on resume (#1625)", async (t) => {
  // When pauseAuto closes out a unit but clearUnitRuntimeRecord silently fails
  // (e.g. permission error), selfHealRuntimeRecords on resume should still
  // clean up stale dispatched records that are >1h old.
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const { writeUnitRuntimeRecord, readUnitRuntimeRecord } = await import("../unit-runtime.ts");

  // Simulate a record left behind after a pause — aged >1h to be considered stale
  writeUnitRuntimeRecord(base, "execute-task", "M001/S01/T01", Date.now() - 3700_000, {
    phase: "dispatched",
  });

  const before = readUnitRuntimeRecord(base, "execute-task", "M001/S01/T01");
  assert.ok(before, "dispatched record should exist before resume heal");
  assert.equal(before!.phase, "dispatched");

  const notifications: string[] = [];
  const mockCtx = {
    ui: { notify: (msg: string) => { notifications.push(msg); } },
  } as any;

  await selfHealRuntimeRecords(base, mockCtx);

  const after = readUnitRuntimeRecord(base, "execute-task", "M001/S01/T01");
  assert.equal(after, null, "stale dispatched record should be cleared on resume (#1625)");
});

// ─── #793: invalidateAllCaches unblocks skip-loop ─────────────────────────
// When the skip-loop breaker fires, it must call invalidateAllCaches() (not
// just invalidateStateCache()) to clear path/parse caches that deriveState
// depends on. Without this, even after cache invalidation, deriveState reads
// stale directory listings and returns the same unit, looping forever.
test("#793: invalidateAllCaches clears all caches so deriveState sees fresh disk state", async (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const mid = "M001";
  const sid = "S01";
  const planDir = join(base, ".gsd", "milestones", mid, "slices", sid);
  const tasksDir = join(planDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", mid), { recursive: true });

  writeFileSync(
    join(base, ".gsd", "milestones", mid, `${mid}-ROADMAP.md`),
    `# M001: Test Milestone\n\n**Vision:** test.\n\n## Slices\n\n- [ ] **${sid}: Slice One** \`risk:low\` \`depends:[]\`\n  > After this: done.\n`,
  );
  const planUnchecked = `# ${sid}: Slice One\n\n**Goal:** test.\n\n## Tasks\n\n- [ ] **T01: Task One** \`est:10m\`\n- [ ] **T02: Task Two** \`est:10m\`\n`;
  writeFileSync(join(planDir, `${sid}-PLAN.md`), planUnchecked);
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01: Task One\n\n**Goal:** t\n\n## Steps\n- step\n\n## Verification\n- v\n");
  writeFileSync(join(tasksDir, "T02-PLAN.md"), "# T02: Task Two\n\n**Goal:** t\n\n## Steps\n- step\n\n## Verification\n- v\n");

  // Warm all caches
  const state1 = await deriveState(base);
  assert.equal(state1.activeTask?.id, "T01", "initial: T01 is active");

  // Simulate task completion on disk (what the LLM does)
  const planChecked = `# ${sid}: Slice One\n\n**Goal:** test.\n\n## Tasks\n\n- [x] **T01: Task One** \`est:10m\`\n- [ ] **T02: Task Two** \`est:10m\`\n`;
  writeFileSync(join(planDir, `${sid}-PLAN.md`), planChecked);
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# Summary\n");

  // invalidateStateCache alone: _stateCache cleared but path/parse caches warm
  invalidateStateCache();

  // invalidateAllCaches: all caches cleared — deriveState must re-read disk
  invalidateAllCaches();
  const state2 = await deriveState(base);

  // After full invalidation, T01 should be complete and T02 should be next
  assert.notEqual(state2.activeTask?.id, "T01", "#793: T01 not re-dispatched after full invalidation");

  // Verify the caches are truly cleared by calling clearParseCache and clearPathCache
  // do not throw (they should be no-ops after invalidateAllCaches already cleared them)
  clearParseCache(); // no-op, but should not throw
  assert.ok(true, "clearParseCache after invalidateAllCaches is safe");
});

// ─── hasImplementationArtifacts (#1703) ───────────────────────────────────

import { execFileSync } from "node:child_process";

function makeGitBase(): string {
  const base = join(tmpdir(), `gsd-test-git-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  // Create initial commit so HEAD exists
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}

test("hasImplementationArtifacts returns false when only .gsd/ files committed (#1703)", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Create a feature branch and commit only .gsd/ files
  execFileSync("git", ["checkout", "-b", "feat/test-milestone"], { cwd: base, stdio: "ignore" });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: add plan files"], { cwd: base, stdio: "ignore" });

  const result = hasImplementationArtifacts(base);
  assert.equal(result, false, "should return false when only .gsd/ files were committed");
});

test("hasImplementationArtifacts returns true when implementation files committed (#1703)", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Create a feature branch with both .gsd/ and implementation files
  execFileSync("git", ["checkout", "-b", "feat/test-impl"], { cwd: base, stdio: "ignore" });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: add feature"], { cwd: base, stdio: "ignore" });

  const result = hasImplementationArtifacts(base);
  assert.equal(result, true, "should return true when implementation files are present");
});

test("hasImplementationArtifacts returns true on non-git directory (fail-open)", (t) => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  t.after(() => cleanup(base));

  const result = hasImplementationArtifacts(base);
  assert.equal(result, true, "should return true (fail-open) in non-git directory");
});

// ─── verifyExpectedArtifact: complete-milestone requires impl artifacts (#1703) ──

test("verifyExpectedArtifact complete-milestone fails with only .gsd/ files (#1703)", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Create feature branch with only .gsd/ files
  execFileSync("git", ["checkout", "-b", "feat/ms-only-gsd"], { cwd: base, stdio: "ignore" });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: milestone plan files"], { cwd: base, stdio: "ignore" });

  const result = verifyExpectedArtifact("complete-milestone", "M001", base);
  assert.equal(result, false, "complete-milestone should fail verification when only .gsd/ files present");
});

test("verifyExpectedArtifact complete-milestone passes with impl files (#1703)", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Create feature branch with implementation files AND milestone summary
  execFileSync("git", ["checkout", "-b", "feat/ms-with-impl"], { cwd: base, stdio: "ignore" });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: implementation"], { cwd: base, stdio: "ignore" });

  const result = verifyExpectedArtifact("complete-milestone", "M001", base);
  assert.equal(result, true, "complete-milestone should pass verification with implementation files");
});

// ─── verifyExpectedArtifact: execute-task ─────────────────────────────────

test("verifyExpectedArtifact execute-task fails when summary is missing", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    // PLAN exists with [x] but no SUMMARY file
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: Implement feature** `est:2h`",
    ].join("\n"));

    const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.equal(result, false, "should fail when T01-SUMMARY.md is missing");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact execute-task fails when task not checked in plan", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // SUMMARY exists but task is unchecked in PLAN
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Implement feature** `est:2h`",
    ].join("\n"));

    const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.equal(result, false, "should fail when task checkbox is not checked in PLAN");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact execute-task passes when summary exists and task checked", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Both SUMMARY and [x] in PLAN
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");
    writeFileSync(join(sliceDir, "S01-PLAN.md"), [
      "# S01: Test Slice",
      "",
      "## Tasks",
      "",
      "- [x] **T01: Implement feature** `est:2h`",
    ].join("\n"));

    const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.equal(result, true, "should pass when summary exists and task is checked in PLAN");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: complete-slice failure cases ─────────────────

test("verifyExpectedArtifact complete-slice fails when UAT file is missing", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });

    // Write SUMMARY
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
    // Write roadmap with [x]
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low`",
    ].join("\n"));
    // No UAT file

    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when UAT file is missing");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-slice fails when roadmap slice not marked done", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });

    // Write SUMMARY and UAT
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.");
    // Roadmap still shows [ ] — slice not marked done
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low`",
    ].join("\n"));

    const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
    assert.equal(result, false, "should fail when roadmap slice is not marked done");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: reactive-execute ─────────────────────────────

test("verifyExpectedArtifact reactive-execute legacy format passes when any summary exists", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

    // Legacy format: no "+" in batchPart
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive", base);
    assert.equal(result, true, "legacy format should pass when at least one summary exists");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact reactive-execute legacy format fails when no summaries", () => {
  const base = makeTmpBase();
  try {
    // tasks dir exists but no summary files
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive", base);
    assert.equal(result, false, "legacy format should fail when no summary files exist");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact reactive-execute batch passes when all task summaries exist", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "# T02 Summary\nDone.");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T01,T02", base);
    assert.equal(result, true, "batch should pass when all task summaries exist");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact reactive-execute batch fails when a task summary is missing", () => {
  const base = makeTmpBase();
  try {
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Only T01 summary — T02 is missing
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T01,T02", base);
    assert.equal(result, false, "batch should fail when T02-SUMMARY.md is missing");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: rewrite-docs ────────────────────────────────

test("verifyExpectedArtifact rewrite-docs passes when no OVERRIDES file exists", () => {
  const base = makeTmpBase();
  try {
    const result = verifyExpectedArtifact("rewrite-docs", "M001", base);
    assert.equal(result, true, "should pass when OVERRIDES.md does not exist");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rewrite-docs fails when OVERRIDES has active scope", () => {
  const base = makeTmpBase();
  try {
    const gsdDir = join(base, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "OVERRIDES.md"), [
      "# Overrides",
      "",
      "**Scope:** active",
      "",
      "Some override content.",
    ].join("\n"));

    const result = verifyExpectedArtifact("rewrite-docs", "M001", base);
    assert.equal(result, false, "should fail when OVERRIDES.md contains '**Scope:** active'");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rewrite-docs passes when OVERRIDES has no active scope", () => {
  const base = makeTmpBase();
  try {
    const gsdDir = join(base, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "OVERRIDES.md"), [
      "# Overrides",
      "",
      "**Scope:** resolved",
      "",
      "All overrides have been resolved.",
    ].join("\n"));

    const result = verifyExpectedArtifact("rewrite-docs", "M001", base);
    assert.equal(result, true, "should pass when OVERRIDES.md exists but has no active scope");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: validate-milestone ──────────────────────────

test("verifyExpectedArtifact validate-milestone fails when file missing", () => {
  const base = makeTmpBase();
  try {
    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "should fail when VALIDATION file does not exist");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact validate-milestone fails when verdict is not terminal", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    // Non-terminal verdict: in-progress
    writeFileSync(join(milestoneDir, "M001-VALIDATION.md"), [
      "---",
      "verdict: in-progress",
      "---",
      "",
      "# Validation Report",
      "",
      "Still running.",
    ].join("\n"));

    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, false, "should fail when verdict is non-terminal (in-progress)");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact validate-milestone passes when verdict is terminal", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-VALIDATION.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# Validation Report",
      "",
      "All checks passed.",
    ].join("\n"));

    const result = verifyExpectedArtifact("validate-milestone", "M001", base);
    assert.equal(result, true, "should pass when verdict is terminal (pass)");
  } finally {
    cleanup(base);
  }
});

// ─── writeBlockerPlaceholder ─────────────────────────────────────────────

test("writeBlockerPlaceholder returns null for unknown unit type", () => {
  const base = makeTmpBase();
  try {
    const result = writeBlockerPlaceholder("unknown-type", "M001", base, "test reason");
    assert.equal(result, null, "should return null for unknown unit types");
  } finally {
    cleanup(base);
  }
});

test("writeBlockerPlaceholder creates file and returns diagnosis for known type", () => {
  const base = makeTmpBase();
  try {
    const result = writeBlockerPlaceholder("research-milestone", "M001", base, "exhausted retries");
    assert.ok(result !== null, "should return a non-null diagnosis string");
    assert.ok(typeof result === "string", "diagnosis should be a string");

    // Verify the file was actually written
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const researchFile = join(milestoneDir, "M001-RESEARCH.md");
    assert.ok(existsSync(researchFile), "RESEARCH.md blocker placeholder should exist on disk");

    const content = readFileSync(researchFile, "utf-8");
    assert.ok(content.includes("BLOCKER"), "file should contain BLOCKER marker");
    assert.ok(content.includes("exhausted retries"), "file should contain the reason");

    assert.ok(result!.includes("RESEARCH"), "diagnosis should reference the RESEARCH artifact path");
    assert.ok(result!.includes("M001"), "diagnosis should reference the milestone ID");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: execute-task DB branches ─────────────────────

test("verifyExpectedArtifact execute-task: DB task status 'complete' → returns true", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "active",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "complete",
    planning: {
      description: "d",
      estimate: "1h",
      files: [],
      verify: "v",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "o",
    },
  });

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

  const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
  assert.equal(result, true, "DB task with status 'complete' and summary file should verify as true");
});

test("verifyExpectedArtifact execute-task: DB task status 'done' → returns true", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "active",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "done",
    planning: {
      description: "d",
      estimate: "1h",
      files: [],
      verify: "v",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "o",
    },
  });

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

  const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
  assert.equal(result, true, "DB task with status 'done' and summary file should verify as true");
});

test("verifyExpectedArtifact execute-task: DB task status 'pending' → returns false", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "active",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task",
    status: "pending",
    planning: {
      description: "d",
      estimate: "1h",
      files: [],
      verify: "v",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "o",
    },
  });

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

  const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
  assert.equal(result, false, "DB task with status 'pending' should verify as false even if summary file exists");
});

test("verifyExpectedArtifact execute-task: task not found but DB available → returns true", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  // DB is open but no task inserted — getTask will return null
  // The code path: DB available, task not found → treat as verified (summary file exists)
  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\nDone.");

  const result = verifyExpectedArtifact("execute-task", "M001/S01/T01", base);
  assert.equal(result, true, "DB available but task not found + summary file exists → should treat as verified");
});

// ─── verifyExpectedArtifact: complete-slice DB branches ───────────────────

test("verifyExpectedArtifact complete-slice: DB slice status 'complete' → returns true", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "complete",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# S01 UAT\nPassed.");

  const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
  assert.equal(result, true, "DB slice with status 'complete' + summary + UAT files should verify as true");
});

test("verifyExpectedArtifact complete-slice: DB slice status 'active' → returns false", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "active",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# S01 UAT\nPassed.");

  const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
  assert.equal(result, false, "DB slice with status 'active' should verify as false even if files exist");
});

test("verifyExpectedArtifact complete-slice: slice not found but DB available → returns true", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  // DB is open but no slice inserted — getSlice will return null
  // The code path: DB available, slice not found → treat as verified (summary + UAT exist)
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
  writeFileSync(join(sliceDir, "S01-UAT.md"), "# S01 UAT\nPassed.");

  const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
  assert.equal(result, true, "DB available but slice not found + summary + UAT files → should treat as verified");
});

test("verifyExpectedArtifact complete-slice: no UAT file → returns false even if DB says complete", (t) => {
  const base = makeTmpBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });

  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "complete",
    demo: "d",
    planning: {
      goal: "g",
      successCriteria: "s",
      proofLevel: "integration",
      integrationClosure: "c",
      observabilityImpact: "o",
    },
  });

  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\nDone.");
  // UAT file intentionally NOT written

  const result = verifyExpectedArtifact("complete-slice", "M001/S01", base);
  assert.equal(result, false, "complete-slice should return false when UAT file is missing even if DB says complete");
});

// ─── writeBlockerPlaceholder ───────────────────────────────────────────────

test("writeBlockerPlaceholder writes blocker file with reason in content", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const reason = "exhausted all retries after 5 attempts";
  writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, reason);

  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  const summaryPath = join(tasksDir, "T01-SUMMARY.md");
  assert.ok(existsSync(summaryPath), "blocker file should be written at the expected artifact path");

  const content = readFileSync(summaryPath, "utf-8");
  assert.ok(content.includes(reason), "blocker file content should include the reason");
  assert.ok(content.includes("BLOCKER"), "blocker file should be identifiable as a placeholder");
});

test("writeBlockerPlaceholder creates parent directory if it does not exist", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  // Remove the tasks dir so it doesn't exist
  const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  rmSync(tasksDir, { recursive: true, force: true });
  assert.ok(!existsSync(tasksDir), "tasks dir should not exist before test");

  writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "some reason");

  assert.ok(existsSync(tasksDir), "tasks dir should be created by writeBlockerPlaceholder");
  assert.ok(existsSync(join(tasksDir, "T01-SUMMARY.md")), "blocker file should exist after dir creation");
});

test("writeBlockerPlaceholder returns null for unknown unitType", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = writeBlockerPlaceholder("unknown-type", "M001", base, "some reason");
  assert.equal(result, null, "unknown unitType should cause writeBlockerPlaceholder to return null");
});

test("writeBlockerPlaceholder returns diagnostic string for known unitType", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "loop detected");
  assert.ok(result !== null, "known unitType should return a non-null diagnostic string");
  assert.ok(typeof result === "string", "diagnostic should be a string");
  assert.ok(result.includes("T01"), "diagnostic string should reference the task id");
});

// ─── diagnoseExpectedArtifact: remaining unit types ───────────────────────

test("diagnoseExpectedArtifact returns description for discuss-milestone", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("discuss-milestone", "M001", base);
  assert.ok(result !== null, "discuss-milestone should return a diagnostic string");
  assert.ok(result!.includes("context"), "discuss-milestone diagnostic should mention context");
});

test("diagnoseExpectedArtifact returns description for plan-milestone", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("plan-milestone", "M001", base);
  assert.ok(result !== null, "plan-milestone should return a non-null diagnostic");
  assert.ok(result!.includes("roadmap") || result!.includes("ROADMAP"), "plan-milestone diagnostic should mention roadmap");
});

test("diagnoseExpectedArtifact returns description for research-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("research-slice", "M001/S01", base);
  assert.ok(result !== null, "research-slice should return a non-null diagnostic");
  assert.ok(result!.includes("research"), "research-slice diagnostic should mention research");
});

test("diagnoseExpectedArtifact returns description for complete-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("complete-slice", "M001/S01", base);
  assert.ok(result !== null, "complete-slice should return a non-null diagnostic");
  assert.ok(result!.includes("S01"), "complete-slice diagnostic should reference slice id");
});

test("diagnoseExpectedArtifact returns description for replan-slice", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("replan-slice", "M001/S01", base);
  assert.ok(result !== null, "replan-slice should return a non-null diagnostic");
  assert.ok(result!.includes("REPLAN") || result!.includes("replan"), "replan-slice diagnostic should mention replan");
});

test("diagnoseExpectedArtifact returns description for rewrite-docs", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("rewrite-docs", "M001/S01", base);
  assert.ok(result !== null, "rewrite-docs should return a non-null diagnostic");
  assert.ok(result!.includes("OVERRIDES") || result!.includes("overrides"), "rewrite-docs diagnostic should mention overrides");
});

test("diagnoseExpectedArtifact returns description for reassess-roadmap", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("reassess-roadmap", "M001/S01", base);
  assert.ok(result !== null);
  assert.ok(result!.includes("ASSESSMENT") || result!.includes("assessment"), "reassess-roadmap diagnostic should mention assessment");
});

test("diagnoseExpectedArtifact returns description for run-uat", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("run-uat", "M001/S01", base);
  assert.ok(result !== null);
  assert.ok(result!.includes("UAT"), "run-uat diagnostic should mention UAT");
});

test("diagnoseExpectedArtifact returns description for validate-milestone", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("validate-milestone", "M001", base);
  assert.ok(result !== null, "validate-milestone should return a non-null diagnostic");
  assert.ok(result!.includes("VALIDATION") || result!.includes("validation"), "validate-milestone diagnostic should mention validation");
});

test("diagnoseExpectedArtifact returns description for complete-milestone", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = diagnoseExpectedArtifact("complete-milestone", "M001", base);
  assert.ok(result !== null, "complete-milestone should return a non-null diagnostic");
  assert.ok(result!.includes("SUMMARY") || result!.includes("summary"), "complete-milestone diagnostic should mention summary");
});
