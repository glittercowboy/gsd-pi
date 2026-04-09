import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  diagnoseExpectedArtifact,
  buildLoopRemediationSteps,
  hasImplementationArtifacts,
  reconcileMergeState,
} from "../../auto-recovery.ts";
import { parseRoadmap, parsePlan } from "../../parsers-legacy.ts";
import { parseTaskPlanFile, clearParseCache } from "../../files.ts";
import { invalidateAllCaches } from "../../cache.ts";
import { deriveState, invalidateStateCache } from "../../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../../gsd-db.ts";
import { renderPlanFromDb } from "../../markdown-renderer.ts";

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
  assert.ok(uatResult!.includes("ASSESSMENT"));
});

// ─── run-uat artifact path contract (#2873) ──────────────────────────────

test("resolveExpectedArtifactPath for run-uat returns ASSESSMENT path, not UAT (#2873)", (t) => {
  // The run-uat prompt instructs the agent to call gsd_summary_save with
  // artifact_type: "ASSESSMENT", which writes S##-ASSESSMENT.md. The artifact
  // verification path must match — otherwise verification fails and auto-mode
  // retries the unit in an infinite loop.
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const result = resolveExpectedArtifactPath("run-uat", "M001/S01", base);
  assert.ok(result, "run-uat should resolve to a non-null artifact path");
  assert.ok(
    result!.endsWith("S01-ASSESSMENT.md"),
    `run-uat artifact path should end with S01-ASSESSMENT.md, got: ${result}`,
  );
});

test("diagnoseExpectedArtifact for run-uat references ASSESSMENT (#2873)", (t) => {
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  const diag = diagnoseExpectedArtifact("run-uat", "M001/S01", base);
  assert.ok(diag, "run-uat should have a diagnostic message");
  assert.ok(
    diag!.includes("ASSESSMENT"),
    `run-uat diagnostic should reference ASSESSMENT, got: ${diag}`,
  );
});

test("verifyExpectedArtifact passes for run-uat when ASSESSMENT file exists (#2873)", (t) => {
  // Regression test: run-uat writes S##-ASSESSMENT.md via gsd_summary_save,
  // but verification looked for S##-UAT.md, causing false stuck retries.
  const base = makeTmpBase();
  t.after(() => cleanup(base));

  // Write the ASSESSMENT file (what gsd_summary_save actually produces)
  const assessPath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-ASSESSMENT.md");
  writeFileSync(assessPath, "---\nverdict: PASS\n---\n# UAT Assessment\n");

  const verified = verifyExpectedArtifact("run-uat", "M001/S01", base);
  assert.ok(verified, "verifyExpectedArtifact should pass when ASSESSMENT file exists");
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

test("verifyExpectedArtifact execute-task rejects heading-style plan without checked checkbox (#3607)", (t) => {
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
  // Heading-style entries no longer count as verified — only checked
  // checkboxes prove gsd_complete_task ran (#3607).
  assert.strictEqual(
    verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
    false,
    "heading-style without checked checkbox should NOT pass verification",
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

test("hasImplementationArtifacts returns 'absent' when only .gsd/ files committed (#1703)", (t) => {
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
  assert.equal(result, "absent", "should return 'absent' when only .gsd/ files were committed");
});

test("hasImplementationArtifacts returns 'present' when implementation files committed (#1703)", (t) => {
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
  assert.equal(result, "present", "should return 'present' when implementation files are present");
});

test("hasImplementationArtifacts returns 'unknown' on non-git directory (fail-open)", (t) => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  t.after(() => cleanup(base));

  const result = hasImplementationArtifacts(base);
  assert.equal(result, "unknown", "should return 'unknown' (fail-open) in non-git directory");
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

// ─── reconcileMergeState: silent nativeCommit failure (#2542) ─────────────

function makeMockCtx(): { ctx: any; notifications: Array<{ msg: string; level: string }> } {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    ui: {
      notify(msg: string, level: string) {
        notifications.push({ msg, level });
      },
    },
  };
  return { ctx, notifications };
}

test("reconcileMergeState returns blocked and notifies error when nativeCommit fails (#2542)", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Create a second branch with a commit, then start a merge on main
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "feature.txt"), "feature content");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add feature"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });

  // Start merge (no conflicts — fast path with MERGE_HEAD)
  execFileSync("git", ["merge", "--no-ff", "--no-commit", "feature"], { cwd: base, stdio: "ignore" });

  // Verify MERGE_HEAD exists
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")), "MERGE_HEAD should exist");

  // Make .git/objects read-only so git cannot write the commit object,
  // causing nativeCommit to throw a non-"nothing to commit" error.
  const objectsDir = join(base, ".git", "objects");
  chmodSync(objectsDir, 0o444);
  t.after(() => { try { chmodSync(objectsDir, 0o755); } catch { /* cleanup */ } });

  const { ctx, notifications } = makeMockCtx();
  const result = reconcileMergeState(base, ctx);

  assert.equal(result, "blocked", "reconcileMergeState should return blocked when nativeCommit fails");
  const errorNotifications = notifications.filter(n => n.level === "error");
  assert.ok(errorNotifications.length > 0, "should notify an error when nativeCommit fails");
  assert.ok(
    errorNotifications[0].msg.includes("Failed to finalize"),
    "error notification should describe the commit failure",
  );
});

test("reconcileMergeState returns clean when no merge state present", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  const { ctx, notifications } = makeMockCtx();
  const result = reconcileMergeState(base, ctx);

  assert.equal(result, "clean", "should return clean when no merge state exists");
  assert.equal(notifications.length, 0, "should not notify when no merge state present");
});

test("reconcileMergeState blocks and preserves unresolved code conflicts", (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  writeFileSync(join(base, "conflict.txt"), "base\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add conflict base"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "conflict.txt"), "feature\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feature change"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "conflict.txt"), "main\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "main change"], { cwd: base, stdio: "ignore" });

  let mergeFailed = false;
  try {
    execFileSync("git", ["merge", "--no-ff", "feature"], { cwd: base, stdio: "ignore" });
  } catch {
    mergeFailed = true;
  }
  assert.equal(mergeFailed, true, "merge should produce a conflict");
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")), "MERGE_HEAD should remain present before reconcile");

  const beforeContents = readFileSync(join(base, "conflict.txt"), "utf8");
  assert.match(beforeContents, /<<<<<<<|=======|>>>>>>>/, "fixture should contain conflict markers");

  const { ctx, notifications } = makeMockCtx();
  const result = reconcileMergeState(base, ctx);

  assert.equal(result, "blocked", "code conflicts should block reconciliation");
  assert.ok(existsSync(join(base, ".git", "MERGE_HEAD")), "MERGE_HEAD should be preserved for manual resolution");
  assert.equal(
    readFileSync(join(base, "conflict.txt"), "utf8"),
    beforeContents,
    "reconcile should preserve the conflicted file contents",
  );
  assert.ok(
    notifications.some((n) => n.level === "error" && n.msg.includes("manual conflict resolution is preserved")),
    "should notify that auto-mode paused and preserved manual work",
  );
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
