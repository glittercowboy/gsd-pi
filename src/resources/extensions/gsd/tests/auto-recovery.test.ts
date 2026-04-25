import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { verifyExpectedArtifact, hasImplementationArtifacts, resolveExpectedArtifactPath, diagnoseExpectedArtifact, buildLoopRemediationSteps, writeBlockerPlaceholder } from "../auto-recovery.ts";
import { resolveMilestoneFile } from "../paths.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertGateRow } from "../gsd-db.ts";
import { clearParseCache } from "../files.ts";
import { parseRoadmap } from "../parsers-legacy.ts";
import { invalidateAllCaches } from "../cache.ts";
import { deriveState, invalidateStateCache } from "../state.ts";

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  // Create .gsd/milestones/M001/slices/S01/tasks/ structure
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-recovery-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "low",
    depends: [],
  });
  insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tmpDirs.length = 0;
});

test("resolveExpectedArtifactPath returns correct path for execute-task", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("execute-task", "M001/S01/T01", base);
    assert.ok(result);
    assert.ok(result!.includes("tasks"));
    assert.ok(result!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("complete-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("plan-slice", "M001/S01", base);
    assert.ok(result);
    assert.ok(result!.includes("PLAN"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("unknown-type", "M001", base);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for all milestone-level types", () => {
  const base = makeTmpBase();
  try {
    const planResult = resolveExpectedArtifactPath("plan-milestone", "M001", base);
    assert.ok(planResult);
    assert.ok(planResult!.includes("ROADMAP"));

    const completeResult = resolveExpectedArtifactPath("complete-milestone", "M001", base);
    assert.ok(completeResult);
    assert.ok(completeResult!.includes("SUMMARY"));
  } finally {
    cleanup(base);
  }
});

test("resolveExpectedArtifactPath returns correct path for all slice-level types", () => {
  const base = makeTmpBase();
  try {
    const researchResult = resolveExpectedArtifactPath("research-slice", "M001/S01", base);
    assert.ok(researchResult);
    assert.ok(researchResult!.includes("RESEARCH"));

    const assessResult = resolveExpectedArtifactPath("reassess-roadmap", "M001/S01", base);
    assert.ok(assessResult);
    assert.ok(assessResult!.includes("ASSESSMENT"));

    const uatResult = resolveExpectedArtifactPath("run-uat", "M001/S01", base);
    assert.ok(uatResult);
    assert.ok(uatResult!.includes("ASSESSMENT"));
  } finally {
    cleanup(base);
  }
});

// ─── diagnoseExpectedArtifact ─────────────────────────────────────────────

test("diagnoseExpectedArtifact returns description for known types", () => {
  const base = makeTmpBase();
  try {
    const research = diagnoseExpectedArtifact("research-milestone", "M001", base);
    assert.ok(research);
    assert.ok(research!.includes("research"));

    const plan = diagnoseExpectedArtifact("plan-slice", "M001/S01", base);
    assert.ok(plan);
    assert.ok(plan!.includes("plan"));

    const task = diagnoseExpectedArtifact("execute-task", "M001/S01/T01", base);
    assert.ok(task);
    assert.ok(task!.includes("T01"));
  } finally {
    cleanup(base);
  }
});

test("diagnoseExpectedArtifact returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(diagnoseExpectedArtifact("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});

// ─── buildLoopRemediationSteps ────────────────────────────────────────────

test("buildLoopRemediationSteps returns steps for execute-task", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("execute-task", "M001/S01/T01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("T01"));
    assert.ok(steps!.includes("gsd undo-task"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns steps for plan-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("plan-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("PLAN"));
    assert.ok(steps!.includes("gsd recover"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns steps for complete-slice", () => {
  const base = makeTmpBase();
  try {
    const steps = buildLoopRemediationSteps("complete-slice", "M001/S01", base);
    assert.ok(steps);
    assert.ok(steps!.includes("S01"));
    assert.ok(steps!.includes("gsd reset-slice"));
  } finally {
    cleanup(base);
  }
});

test("buildLoopRemediationSteps returns null for unknown type", () => {
  const base = makeTmpBase();
  try {
    assert.equal(buildLoopRemediationSteps("unknown", "M001", base), null);
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: parse cache collision regression ─────────────

test("verifyExpectedArtifact detects roadmap [x] change despite parse cache", () => {
  // Regression test: cacheKey collision when [ ] → [x] doesn't change
  // file length or first/last 100 chars. Without the fix, parseRoadmap
  // returns stale cached data with done=false even though the file has [x].
  const base = makeTmpBase();
  try {
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
  } finally {
    clearParseCache();
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: plan-slice empty scaffold regression (#699) ──

test("verifyExpectedArtifact rejects plan-slice with empty scaffold", () => {
  const base = makeTmpBase();
  try {
    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01: Test Slice\n\n## Tasks\n\n");
    assert.strictEqual(
      verifyExpectedArtifact("plan-slice", "M001/S01", base),
      false,
      "Empty scaffold should not be treated as completed artifact",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with actual tasks", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with completed tasks", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact treats complete-slice as satisfied when summary, UAT, and roadmap checkbox exist", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low`",
      "",
      "## Boundary Map",
      "",
      "- S01 → terminal",
      "  - Produces: done",
      "  - Consumes: nothing",
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      true,
      "complete-slice should verify when expected artifact and state mutation are already satisfied",
    );
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact rejects complete-slice when roadmap checkbox is still unchecked", () => {
  const base = makeTmpBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low`",
      "",
      "## Boundary Map",
      "",
      "- S01 → terminal",
      "  - Produces: done",
      "  - Consumes: nothing",
    ].join("\n"));
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# Summary\nDone.\n");
    writeFileSync(join(sliceDir, "S01-UAT.md"), "# UAT\nPassed.\n");

    assert.equal(
      verifyExpectedArtifact("complete-slice", "M001/S01", base),
      false,
      "complete-slice should remain unsatisfied when roadmap state still requires the unit to run",
    );
  } finally {
    cleanup(base);
  }
});


// ─── verifyExpectedArtifact: plan-slice task plan check (#739) ────────────

test("verifyExpectedArtifact plan-slice passes when all task plan files exist", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice fails when a task plan file is missing (#739)", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact plan-slice fails for plan with no tasks (#699)", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: heading-style plan tasks (#1691) ─────────────

test("verifyExpectedArtifact accepts plan-slice with heading-style tasks (### T01 --)", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact accepts plan-slice with colon-style heading tasks (### T01:)", () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact execute-task requires checked checkbox or DB status for heading-style plan entry (#1691, #3607)", () => {
  const base = makeTmpBase();
  try {
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
    // Without DB or checked checkbox, heading-style plans cannot verify
    // execute-task completion (summary file alone is insufficient, #3607)
    assert.strictEqual(
      verifyExpectedArtifact("execute-task", "M001/S01/T01", base),
      false,
      "execute-task requires DB status or checked checkbox, not just heading + summary (#3607)",
    );
  } finally {
    cleanup(base);
  }
});

// ─── #793: invalidateAllCaches unblocks skip-loop ─────────────────────────
// When the skip-loop breaker fires, it must call invalidateAllCaches() (not
// just invalidateStateCache()) to clear path/parse caches that deriveState
// depends on. Without this, even after cache invalidation, deriveState reads
// stale directory listings and returns the same unit, looping forever.
test("#793: invalidateAllCaches clears all caches so deriveState sees fresh disk state", async () => {
  const base = makeTmpBase();
  try {
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
  } finally {
    cleanup(base);
  }
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

test("hasImplementationArtifacts returns false when only .gsd/ files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create a feature branch and commit only .gsd/ files
    execFileSync("git", ["checkout", "-b", "feat/test-milestone"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: add plan files"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base);
    assert.equal(result, "absent", "should return absent when only .gsd/ files were committed");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns true when implementation files committed (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create a feature branch with both .gsd/ and implementation files
    execFileSync("git", ["checkout", "-b", "feat/test-impl"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), "# Roadmap");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "feature.ts"), "export function feature() {}");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: add feature"], { cwd: base, stdio: "ignore" });

    const result = hasImplementationArtifacts(base);
    assert.equal(result, "present", "should return present when implementation files are present");
  } finally {
    cleanup(base);
  }
});

test("hasImplementationArtifacts returns true on non-git directory (fail-open)", () => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    const result = hasImplementationArtifacts(base);
    assert.equal(result, "unknown", "should return unknown (fail-open) in non-git directory");
  } finally {
    cleanup(base);
  }
});

// ─── verifyExpectedArtifact: complete-milestone requires impl artifacts (#1703) ──

test("verifyExpectedArtifact complete-milestone fails with only .gsd/ files (#1703)", () => {
  const base = makeGitBase();
  try {
    // Create feature branch with only .gsd/ files
    execFileSync("git", ["checkout", "-b", "feat/ms-only-gsd"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: milestone plan files"], { cwd: base, stdio: "ignore" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone should fail verification when only .gsd/ files present");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone passes with impl files (#1703)", () => {
  const base = makeGitBase();
  try {
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
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone fails when DB milestone is not complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-active"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nverification FAILED — not complete.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with failed summary"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, false, "complete-milestone must fail when DB status is not complete");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone passes when DB milestone is complete (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-complete"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Milestone Summary\nDone.");
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation complete"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "complete" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "complete-milestone should pass when DB status is complete");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact complete-milestone tolerates transient DB lag when SUMMARY is canonical success (#4658)", () => {
  const base = makeGitBase();
  try {
    execFileSync("git", ["checkout", "-b", "feat/ms-db-lag-success"], { cwd: base, stdio: "ignore" });
    mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
      [
        "---",
        "id: M001",
        "status: complete",
        "---",
        "",
        "# M001: Success",
      ].join("\n"),
    );
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "console.log('hello');");
    execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: implementation with stale db"], { cwd: base, stdio: "ignore" });

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const result = verifyExpectedArtifact("complete-milestone", "M001", base);
    assert.equal(result, true, "canonical success SUMMARY should pass verification during transient DB lag");
  } finally {
    cleanup(base);
  }
});

test("verifyExpectedArtifact checks pending gate-evaluate artifacts without ESM require failures", () => {
  const base = makeTmpProject();

  const verified = verifyExpectedArtifact("gate-evaluate", "M001/S01/gates+Q3", base);

  assert.equal(verified, false, "pending gates should keep gate-evaluate unverified");
});

// ─── #4414 regressions ────────────────────────────────────────────────────────

test("#4414: writeBlockerPlaceholder invalidates path cache so dispatch guard sees file", () => {
  const base = makeTmpBase();
  try {
    // Prime the readdir cache by resolving a DIFFERENT file first — this
    // mirrors the stuck-loop condition where the dispatch guard cached an
    // empty directory listing before the placeholder was written.
    invalidateAllCaches();
    assert.equal(
      resolveMilestoneFile(base, "M001", "RESEARCH"),
      null,
      "no RESEARCH file yet",
    );

    const result = writeBlockerPlaceholder(
      "research-milestone",
      "M001",
      base,
      "verification retries exhausted",
    );
    assert.ok(result, "placeholder path returned");

    // After writeBlockerPlaceholder, the dispatch guard must see the new file
    // immediately — otherwise the rule re-fires (#4414, 7× re-dispatch).
    const postResolve = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.ok(
      postResolve,
      "resolveMilestoneFile finds the placeholder post-write (cache invalidated)",
    );
  } finally {
    cleanup(base);
  }
});

test("#4414: parallel-research sentinel path does not collide with RESEARCH suffix", () => {
  const base = makeTmpBase();
  try {
    // Write only the parallel-research blocker (sentinel).
    const sentinel = resolveExpectedArtifactPath(
      "research-slice",
      "M001/parallel-research",
      base,
    );
    assert.ok(sentinel, "sentinel path resolves for parallel-research");
    writeFileSync(sentinel!, "# blocker\n", "utf-8");

    // Critical: the sentinel filename must NOT be matched by the legacy regex
    // used when callers look up milestone-level RESEARCH. Otherwise the
    // dispatch guard for research-milestone would short-circuit falsely.
    const milestoneResearch = resolveMilestoneFile(base, "M001", "RESEARCH");
    assert.equal(
      milestoneResearch,
      null,
      "sentinel must not be mistaken for M001-RESEARCH.md via legacy pattern match",
    );
  } finally {
    cleanup(base);
  }
});

test("#4068: verifyExpectedArtifact parallel-research treats PARALLEL-BLOCKER as terminal completion", () => {
  // Regression: when a parallel-research unit times out and the timeout-recovery
  // machinery writes a PARALLEL-BLOCKER placeholder, verifyExpectedArtifact must
  // return true so the dispatch loop can advance.  Previously it only returned
  // true when every slice had a RESEARCH file — meaning a timeout always left
  // verifyExpectedArtifact returning false, the unit was never cleared from
  // unitDispatchCount, and the dispatch rule re-fired on the next iteration
  // (infinite loop, issue #4068 / #4355).
  const base = makeTmpBase();
  try {
    // Write a minimal roadmap
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Timeout Test",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "utf-8",
    );

    // No RESEARCH files written — subagents timed out
    clearParseCache();
    invalidateAllCaches();

    // Simulate timeout-recovery writing the PARALLEL-BLOCKER placeholder
    const blockerPath = resolveExpectedArtifactPath("research-slice", "M001/parallel-research", base);
    assert.ok(blockerPath, "PARALLEL-BLOCKER path must resolve for parallel-research unit");
    writeFileSync(blockerPath!, "# BLOCKER — timeout recovery\n\n**Reason**: hard timeout.\n", "utf-8");

    clearParseCache();
    invalidateAllCaches();

    // After blocker is written, verifyExpectedArtifact must return true
    // so the dispatch loop treats this unit as complete and moves on.
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "#4068: PARALLEL-BLOCKER on disk must satisfy verifyExpectedArtifact so the loop does not re-dispatch",
    );
  } finally {
    cleanup(base);
  }
});

test("#4414: verifyExpectedArtifact parallel-research succeeds when all research-ready slices have RESEARCH", () => {
  const base = makeTmpBase();
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "tasks"), { recursive: true });

    // Minimal roadmap with three slices
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      [
        "# M001: Regression",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
        "- [ ] **S02: Beta** `risk:low` `depends:[]`",
        "- [ ] **S03: Gamma** `risk:low` `depends:[]`",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Only 2 of 3 have RESEARCH — should fail verification
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-RESEARCH.md"),
      "# research",
      "utf-8",
    );
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S02", "S02-RESEARCH.md"),
      "# research",
      "utf-8",
    );

    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      false,
      "missing S03 RESEARCH → verification fails",
    );

    // All three RESEARCH present → verification passes
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "slices", "S03", "S03-RESEARCH.md"),
      "# research",
      "utf-8",
    );
    clearParseCache();
    invalidateAllCaches();
    assert.equal(
      verifyExpectedArtifact("research-slice", "M001/parallel-research", base),
      true,
      "all slices have RESEARCH → verification passes",
    );
  } finally {
    cleanup(base);
  }
});
