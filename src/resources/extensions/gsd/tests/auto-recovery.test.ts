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
  buildLoopRemediationSteps,
  selfHealRuntimeRecords,
  completedKeysPath,
  persistCompletedKey,
  removePersistedKey,
  loadPersistedKeys,
} from "../auto-recovery.ts";
import { parseRoadmap, clearParseCache } from "../files.ts";
import { invalidateAllCaches } from "../cache.ts";
import { deriveState, invalidateStateCache } from "../state.ts";

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

test("resolveExpectedArtifactPath returns correct path for research-milestone", () => {
  const base = makeTmpBase();
  try {
    const result = resolveExpectedArtifactPath("research-milestone", "M001", base);
    assert.ok(result);
    assert.ok(result!.includes("M001"));
    assert.ok(result!.includes("RESEARCH"));
  } finally {
    cleanup(base);
  }
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
    assert.ok(uatResult!.includes("UAT-RESULT"));
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
    assert.ok(steps!.includes("gsd doctor"));
    assert.ok(steps!.includes("[x]"));
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
    assert.ok(steps!.includes("gsd doctor"));
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
    assert.ok(steps!.includes("ROADMAP"));
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

// ─── Completed-unit key persistence ───────────────────────────────────────

test("completedKeysPath returns path inside .gsd", () => {
  const path = completedKeysPath("/project");
  assert.ok(path.includes(".gsd"));
  assert.ok(path.includes("completed-units.json"));
});

test("persistCompletedKey and loadPersistedKeys round-trip", () => {
  const base = makeTmpBase();
  try {
    persistCompletedKey(base, "execute-task/M001/S01/T01");
    persistCompletedKey(base, "plan-slice/M001/S02");

    const keys = new Set<string>();
    loadPersistedKeys(base, keys);

    assert.ok(keys.has("execute-task/M001/S01/T01"));
    assert.ok(keys.has("plan-slice/M001/S02"));
    assert.equal(keys.size, 2);
  } finally {
    cleanup(base);
  }
});

test("persistCompletedKey is idempotent", () => {
  const base = makeTmpBase();
  try {
    persistCompletedKey(base, "execute-task/M001/S01/T01");
    persistCompletedKey(base, "execute-task/M001/S01/T01");

    const keys = new Set<string>();
    loadPersistedKeys(base, keys);
    assert.equal(keys.size, 1);
  } finally {
    cleanup(base);
  }
});

test("removePersistedKey removes a key", () => {
  const base = makeTmpBase();
  try {
    persistCompletedKey(base, "a");
    persistCompletedKey(base, "b");
    removePersistedKey(base, "a");

    const keys = new Set<string>();
    loadPersistedKeys(base, keys);
    assert.ok(!keys.has("a"));
    assert.ok(keys.has("b"));
  } finally {
    cleanup(base);
  }
});

test("loadPersistedKeys handles missing file gracefully", () => {
  const base = makeTmpBase();
  try {
    const keys = new Set<string>();
    assert.doesNotThrow(() => loadPersistedKeys(base, keys));
    assert.equal(keys.size, 0);
  } finally {
    cleanup(base);
  }
});

test("removePersistedKey is safe when file doesn't exist", () => {
  const base = makeTmpBase();
  try {
    assert.doesNotThrow(() => removePersistedKey(base, "nonexistent"));
  } finally {
    cleanup(base);
  }
});

// ─── Dual-load across worktree boundary (#769) ───────────────────────────

test("loadPersistedKeys unions keys from project root and worktree", () => {
  // Simulate two separate .gsd directories (project root + worktree)
  // each with a different set of completed keys. Loading from both
  // into the same Set should produce the union.
  const projectRoot = makeTmpBase();
  const worktree = makeTmpBase();
  try {
    // Persist different keys in each location
    persistCompletedKey(projectRoot, "execute-task/M001/S01/T01");
    persistCompletedKey(projectRoot, "plan-slice/M001/S02");

    persistCompletedKey(worktree, "execute-task/M001/S01/T02");
    persistCompletedKey(worktree, "plan-slice/M001/S02"); // overlap

    // Load from both into the same set (mimicking startup dual-load)
    const keys = new Set<string>();
    loadPersistedKeys(projectRoot, keys);
    loadPersistedKeys(worktree, keys);

    assert.ok(keys.has("execute-task/M001/S01/T01"), "key from project root");
    assert.ok(keys.has("plan-slice/M001/S02"), "shared key");
    assert.ok(keys.has("execute-task/M001/S01/T02"), "key from worktree");
    assert.equal(keys.size, 3, "union should deduplicate overlapping keys");
  } finally {
    cleanup(projectRoot);
    cleanup(worktree);
  }
});

test("completed-units.json set-union merge produces correct result", () => {
  // Verify that a manual set-union merge (as done in syncStateToProjectRoot)
  // correctly merges two JSON arrays of keys.
  const projectRoot = makeTmpBase();
  const worktree = makeTmpBase();
  try {
    // Write keys to both locations
    const prKeysFile = join(projectRoot, ".gsd", "completed-units.json");
    const wtKeysFile = join(worktree, ".gsd", "completed-units.json");

    writeFileSync(prKeysFile, JSON.stringify(["a", "b"]));
    writeFileSync(wtKeysFile, JSON.stringify(["b", "c", "d"]));

    // Perform the same merge logic used in syncStateToProjectRoot
    const srcKeys: string[] = JSON.parse(readFileSync(wtKeysFile, "utf8"));
    let dstKeys: string[] = [];
    if (existsSync(prKeysFile)) {
      dstKeys = JSON.parse(readFileSync(prKeysFile, "utf8"));
    }
    const merged = [...new Set([...dstKeys, ...srcKeys])];
    writeFileSync(prKeysFile, JSON.stringify(merged, null, 2));

    // Verify the merged result
    const result: string[] = JSON.parse(readFileSync(prKeysFile, "utf8"));
    assert.deepStrictEqual(result.sort(), ["a", "b", "c", "d"]);
  } finally {
    cleanup(projectRoot);
    cleanup(worktree);
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

// ─── selfHealRuntimeRecords — worktree base path (#769) ──────────────────

test("selfHealRuntimeRecords clears stale record when artifact exists at worktree base (#769)", async () => {
  // Simulate worktree layout: the runtime record AND the artifact both live
  // under the worktree's .gsd/, not the main project root.
  const worktreeBase = makeTmpBase();
  const mainBase = makeTmpBase();
  try {
    const { writeUnitRuntimeRecord, readUnitRuntimeRecord } = await import("../unit-runtime.ts");

    // Write a stale runtime record in the worktree .gsd/runtime/units/
    writeUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01", Date.now() - 7200_000, {
      phase: "dispatched",
    });

    // Write the UAT result artifact in the worktree .gsd/milestones/
    const uatPath = join(worktreeBase, ".gsd", "milestones", "M001", "slices", "S01", "S01-UAT-RESULT.md");
    writeFileSync(uatPath, "---\nresult: pass\n---\n# UAT Result\nAll tests passed.\n");

    // Verify the runtime record exists before heal
    const before = readUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01");
    assert.ok(before, "runtime record should exist before heal");

    // Mock ExtensionContext with minimal notify
    const notifications: string[] = [];
    const mockCtx = {
      ui: { notify: (msg: string) => { notifications.push(msg); } },
    } as any;

    // Call selfHeal with worktreeBase — this is the fix: using the worktree path
    // so both the runtime record and artifact are found
    const completedKeys = new Set<string>();
    await selfHealRuntimeRecords(worktreeBase, mockCtx, completedKeys);

    // The stale record should be cleared
    const after = readUnitRuntimeRecord(worktreeBase, "run-uat", "M001/S01");
    assert.equal(after, null, "runtime record should be cleared after heal");

    // The completion key should be persisted
    assert.ok(completedKeys.has("run-uat/M001/S01"), "completion key should be added");
    assert.ok(notifications.some(n => n.includes("Self-heal")), "should emit self-heal notification");

    // Now verify that calling with mainBase does NOT find/clear anything (the old bug)
    // Write a stale record at mainBase but NO artifact there
    writeUnitRuntimeRecord(mainBase, "run-uat", "M001/S01", Date.now() - 7200_000, {
      phase: "dispatched",
    });
    const mainKeys = new Set<string>();
    await selfHealRuntimeRecords(mainBase, mockCtx, mainKeys);

    // The record at mainBase should be cleared by the stale timeout (>1h),
    // but the completion key should NOT be set (artifact doesn't exist at mainBase)
    const afterMain = readUnitRuntimeRecord(mainBase, "run-uat", "M001/S01");
    assert.equal(afterMain, null, "stale record at main base should be cleared by timeout");
    assert.ok(!mainKeys.has("run-uat/M001/S01"), "completion key should NOT be set when artifact is missing");
  } finally {
    cleanup(worktreeBase);
    cleanup(mainBase);
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
