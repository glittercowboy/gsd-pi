import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  buildLoopRemediationSteps,
  hasImplementationArtifacts,
} from "../auto-recovery.ts";
import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
} from "../auto-artifact-paths.ts";
import { clearParseCache } from "../files.ts";
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
    assert.equal(result, false, "should return false when only .gsd/ files were committed");
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
    assert.equal(result, true, "should return true when implementation files are present");
  } finally {
    cleanup(base);
  }
});

// ─── Wave 0: removed export tests (DOC-02 — RED until Plan 4-03) ─────────

test("writeBlockerPlaceholder is not exported from auto-recovery (DOC-02)", async () => {
  // RED until Plan 4-03 removes these exports.
  // Dynamic import to check exported members at runtime.
  const mod = await import("../auto-recovery.ts") as Record<string, unknown>;
  assert.equal(
    typeof mod.writeBlockerPlaceholder,
    "undefined",
    "writeBlockerPlaceholder should not be exported (removed by DOC-02)",
  );
});

test("skipExecuteTask is not exported from auto-recovery (DOC-02)", async () => {
  // RED until Plan 4-03 removes these exports.
  const mod = await import("../auto-recovery.ts") as Record<string, unknown>;
  assert.equal(
    typeof mod.skipExecuteTask,
    "undefined",
    "skipExecuteTask should not be exported (removed by DOC-02)",
  );
});

test("hasImplementationArtifacts returns true on non-git directory (fail-open)", () => {
  const base = join(tmpdir(), `gsd-test-nogit-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  try {
    const result = hasImplementationArtifacts(base);
    assert.equal(result, true, "should return true (fail-open) in non-git directory");
  } finally {
    cleanup(base);
  }
});

