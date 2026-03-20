import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSliceTaskIO,
  deriveTaskGraph,
  isGraphAmbiguous,
  getReadyTasks,
  chooseNonConflictingSubset,
  loadReactiveState,
  saveReactiveState,
  clearReactiveState,
} from "../reactive-graph.ts";
import { validatePreferences } from "../preferences-validation.ts";
import type { ReactiveExecutionState } from "../types.ts";

// ─── Preference Validation ────────────────────────────────────────────────

test("reactive_execution validation accepts valid config", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 4,
      isolation_mode: "same-tree",
    },
  });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.preferences.reactive_execution, {
    enabled: true,
    max_parallel: 4,
    isolation_mode: "same-tree",
  });
});

test("reactive_execution validation rejects max_parallel out of range", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 10,
      isolation_mode: "same-tree",
    } as any,
  });
  assert.ok(result.errors.some((e) => e.includes("max_parallel")));
});

test("reactive_execution validation rejects invalid isolation_mode", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "separate-branch",
    } as any,
  });
  assert.ok(result.errors.some((e) => e.includes("isolation_mode")));
});

test("reactive_execution validation warns on unknown keys", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      unknown_thing: true,
    } as any,
  });
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => w.includes("unknown_thing")));
});

// ─── Dispatch Rule Matching Logic ─────────────────────────────────────────

test("reactive dispatch requires enabled config and multiple ready tasks", async () => {
  // Build a minimal filesystem with a slice plan and task plans
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-dispatch-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });

    // Slice plan with 3 tasks
    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Test Slice",
        "",
        "**Goal:** Test reactive execution",
        "**Demo:** All three tasks run in parallel",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:15m`",
        "  Create initial types",
        "- [ ] **T02: Second** `est:15m`",
        "  Create models",
        "- [ ] **T03: Third** `est:15m`",
        "  Create service layer",
        "",
      ].join("\n"),
    );

    // Task plans with non-overlapping IO (all independent)
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      [
        "# T01: First",
        "",
        "## Description",
        "Create types.",
        "",
        "## Inputs",
        "",
        "- `src/config.json` — Config schema",
        "",
        "## Expected Output",
        "",
        "- `src/types.ts` — Type definitions",
      ].join("\n"),
    );

    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      [
        "# T02: Second",
        "",
        "## Description",
        "Create models.",
        "",
        "## Inputs",
        "",
        "- `src/schema.json` — Schema file",
        "",
        "## Expected Output",
        "",
        "- `src/models.ts` — Model definitions",
      ].join("\n"),
    );

    writeFileSync(
      join(gsd, "tasks", "T03-PLAN.md"),
      [
        "# T03: Third",
        "",
        "## Description",
        "Create service.",
        "",
        "## Inputs",
        "",
        "- `src/api.json` — API spec",
        "",
        "## Expected Output",
        "",
        "- `src/service.ts` — Service layer",
      ].join("\n"),
    );

    // Load IO and build graph
    const basePath = repo;
    const taskIO = await loadSliceTaskIO(basePath, "M001", "S01");
    assert.equal(taskIO.length, 3);

    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), false, "Graph should not be ambiguous");

    // All independent → all should be ready
    const ready = getReadyTasks(graph, new Set(), new Set());
    assert.equal(ready.length, 3);

    // Choose subset with max_parallel=2
    const selected = chooseNonConflictingSubset(ready, graph, 2, new Set());
    assert.equal(selected.length, 2);
    assert.deepEqual(selected, ["T01", "T02"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reactive dispatch falls back when graph is ambiguous (task without IO)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-ambiguous-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });

    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Test",
        "",
        "**Goal:** Test",
        "**Demo:** Test",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: A** `est:15m`",
        "- [ ] **T02: B** `est:15m`",
        "",
      ].join("\n"),
    );

    // T01 has IO, T02 has NO IO sections → ambiguous
    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: A\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n",
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: B\n\n## Description\n\nNo IO sections.\n",
    );

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    assert.equal(isGraphAmbiguous(graph), true, "Graph should be ambiguous");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("single ready task falls through to sequential", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-single-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });

    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Linear",
        "",
        "**Goal:** Linear chain",
        "**Demo:** Sequential",
        "",
        "## Tasks",
        "",
        "- [ ] **T01: First** `est:15m`",
        "- [ ] **T02: Second** `est:15m`",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: First\n\n## Inputs\n\n- `src/config.json`\n\n## Expected Output\n\n- `src/a.ts`\n",
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: Second\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n",
    );

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);
    const ready = getReadyTasks(graph, new Set(), new Set());
    // Only T01 is ready (T02 depends on T01)
    assert.equal(ready.length, 1);
    assert.deepEqual(ready, ["T01"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── State Persistence ────────────────────────────────────────────────────

test("saveReactiveState and loadReactiveState round-trip", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-state-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const state: ReactiveExecutionState = {
      sliceId: "S01",
      completed: ["T01", "T02"],
      dispatched: ["T03"],
      graphSnapshot: { taskCount: 4, edgeCount: 2, readySetSize: 1, ambiguous: false },
      updatedAt: "2025-01-01T00:00:00Z",
    };

    saveReactiveState(repo, "M001", "S01", state);
    const loaded = loadReactiveState(repo, "M001", "S01");
    assert.deepEqual(loaded, state);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("clearReactiveState removes the file", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-clear-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const state: ReactiveExecutionState = {
      sliceId: "S01",
      completed: [],
      dispatched: ["T01", "T02"],
      graphSnapshot: { taskCount: 2, edgeCount: 0, readySetSize: 2, ambiguous: false },
      updatedAt: "2025-01-01T00:00:00Z",
    };

    saveReactiveState(repo, "M001", "S01", state);
    assert.ok(existsSync(join(repo, ".gsd", "runtime", "M001-S01-reactive.json")));

    clearReactiveState(repo, "M001", "S01");
    assert.ok(!existsSync(join(repo, ".gsd", "runtime", "M001-S01-reactive.json")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("loadReactiveState returns null when no file exists", () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-nofile-"));
  mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
  try {
    const loaded = loadReactiveState(repo, "M001", "S01");
    assert.equal(loaded, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("completed tasks are not re-dispatched on next iteration", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-reentry-"));
  try {
    const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(join(gsd, "tasks"), { recursive: true });
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });

    writeFileSync(
      join(gsd, "S01-PLAN.md"),
      [
        "# S01: Reentry Test",
        "",
        "**Goal:** Test re-entry",
        "**Demo:** Correct resumption",
        "",
        "## Tasks",
        "",
        "- [x] **T01: Done** `est:15m`",
        "- [ ] **T02: Pending** `est:15m`",
        "- [ ] **T03: Also Pending** `est:15m`",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(gsd, "tasks", "T01-PLAN.md"),
      "# T01: Done\n\n## Inputs\n\n- `src/config.json`\n\n## Expected Output\n\n- `src/a.ts`\n",
    );
    writeFileSync(
      join(gsd, "tasks", "T02-PLAN.md"),
      "# T02: Pending\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/b.ts`\n",
    );
    writeFileSync(
      join(gsd, "tasks", "T03-PLAN.md"),
      "# T03: Also Pending\n\n## Inputs\n\n- `src/a.ts`\n\n## Expected Output\n\n- `src/c.ts`\n",
    );

    const taskIO = await loadSliceTaskIO(repo, "M001", "S01");
    const graph = deriveTaskGraph(taskIO);

    // T01 is done, T02 and T03 depend on T01
    const completed = new Set(["T01"]);
    const ready = getReadyTasks(graph, completed, new Set());
    // Both T02 and T03 should be ready (T01 is complete)
    assert.deepEqual(ready, ["T02", "T03"]);

    // Simulate T02 completes, re-derive
    completed.add("T02");
    const ready2 = getReadyTasks(graph, completed, new Set());
    // Only T03 should be ready
    assert.deepEqual(ready2, ["T03"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Batch Verification ───────────────────────────────────────────────────

test("verifyExpectedArtifact: reactive-execute passes when all dispatched summaries exist", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-pass-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02: Done\n");
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03: Done\n");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, true, "Should pass when all dispatched task summaries exist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute fails when a dispatched summary is missing", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-fail-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Only T02 has a summary, T03 does not
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02: Done\n");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "Should fail when dispatched task T03 summary is missing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute fails even with pre-existing summaries from other tasks", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-preexisting-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // T01 summary exists from before, but T02 and T03 were dispatched
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01: Prior\n");

    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive+T02,T03", repo);
    assert.equal(result, false, "Pre-existing T01 summary should not satisfy T02,T03 batch");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyExpectedArtifact: reactive-execute legacy format (no batch IDs) falls back", async () => {
  const { verifyExpectedArtifact } = await import("../auto-recovery.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-verify-legacy-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // Legacy format without +batch suffix
    const result = verifyExpectedArtifact("reactive-execute", "M001/S01/reactive", repo);
    assert.equal(result, true, "Legacy format should fall back to any-summary check");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unitId batch encoding round-trips correctly", () => {
  const mid = "M001";
  const sid = "S01";
  const selected = ["T02", "T03", "T05"];
  const unitId = `${mid}/${sid}/reactive+${selected.join(",")}`;

  // Parse it back
  const parts = unitId.split("/");
  assert.equal(parts[0], "M001");
  assert.equal(parts[1], "S01");
  const batchPart = parts[2];
  const plusIdx = batchPart.indexOf("+");
  assert.ok(plusIdx > 0, "Should have + separator");
  const batchIds = batchPart.slice(plusIdx + 1).split(",");
  assert.deepEqual(batchIds, ["T02", "T03", "T05"]);
});

// ─── Dependency-Based Carry-Forward ───────────────────────────────────────

test("getDependencyTaskSummaryPaths returns only dependency summaries", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // T01, T02, T03 all have summaries
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");
    writeFileSync(join(tasksDir, "T02-SUMMARY.md"), "---\nid: T02\n---\n# T02\n");
    writeFileSync(join(tasksDir, "T03-SUMMARY.md"), "---\nid: T03\n---\n# T03\n");

    // T04 depends only on T01 and T03 — should NOT get T02
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T04", ["T01", "T03"], repo);
    assert.equal(paths.length, 2, "Should get exactly 2 dependency summaries");
    assert.ok(paths.some((p) => p.includes("T01-SUMMARY")), "Should include T01");
    assert.ok(paths.some((p) => p.includes("T03-SUMMARY")), "Should include T03");
    assert.ok(!paths.some((p) => p.includes("T02-SUMMARY")), "Should NOT include T02");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getDependencyTaskSummaryPaths falls back to order-based for root tasks", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-root-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // T02 has no dependencies (root task) — should fall back to order-based
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T02", [], repo);
    assert.equal(paths.length, 1, "Root task should get order-based prior summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 via order fallback");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getDependencyTaskSummaryPaths handles missing dependency summaries gracefully", async () => {
  const { getDependencyTaskSummaryPaths } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-reactive-depcarry-missing-"));
  try {
    const tasksDir = join(repo, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // Only T01 has a summary, T02 does not
    writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "---\nid: T01\n---\n# T01\n");

    // T03 depends on T01 and T02, but T02 summary doesn't exist
    const paths = await getDependencyTaskSummaryPaths("M001", "S01", "T03", ["T01", "T02"], repo);
    assert.equal(paths.length, 1, "Should only return existing dependency summaries");
    assert.ok(paths[0].includes("T01-SUMMARY"), "Should include T01 (exists)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
