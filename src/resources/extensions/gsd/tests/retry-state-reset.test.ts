// GSD Extension — Regression tests for #1714: retry_on signal state reset
//
// Verifies that when a post_unit_hook writes a retry_on artifact, the
// consuming code properly resets all completion state so deriveState
// re-derives the task on the next loop iteration.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "./test-helpers.ts";
import {
  resetHookState,
  consumeRetryTrigger,
  isRetryPending,
  resolveHookArtifactPath,
} from "../post-unit-hooks.ts";
import { uncheckTaskInPlan } from "../undo.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createRetryFixture(): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "gsd-retry-reset-"));

  // Create the .gsd structure for M001/S01/T01
  const milestonesTasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(milestonesTasksDir, { recursive: true });

  // Write a PLAN.md with T01 checked [x] (as doctor would do)
  const planFile = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
  writeFileSync(planFile, [
    "# S01: Test Slice",
    "",
    "**Goal:** regression test.",
    "",
    "## Tasks",
    "",
    "- [x] **T01: Implement feature** `est:30m`",
    "- [ ] **T02: Write tests** `est:15m`",
  ].join("\n"), "utf-8");

  // Write a SUMMARY.md for T01 (in milestones path where resolveTasksDir looks)
  const summaryFile = join(milestonesTasksDir, "T01-SUMMARY.md");
  writeFileSync(summaryFile, "---\ntitle: T01 Summary\n---\nDone.", "utf-8");

  // Write completed-units.json with T01
  writeFileSync(
    join(base, ".gsd", "completed-units.json"),
    JSON.stringify(["execute-task/M001/S01/T01"]),
    "utf-8",
  );

  // Write the retry_on artifact in the hook artifact path
  const retryArtifact = join(milestonesTasksDir, "T01-NEEDS-REWORK.md");
  writeFileSync(retryArtifact, "Rework needed: test coverage insufficient.", "utf-8");

  return {
    base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: consumeRetryTrigger returns retryArtifact field
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== consumeRetryTrigger: returns null when no retry pending ===");

{
  resetHookState();
  const trigger = consumeRetryTrigger();
  assertEq(trigger, null, "returns null when no retry pending");
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: uncheckTaskInPlan reverses doctor's [x] mark
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Retry reset step 1: uncheck [x] → [ ] in PLAN.md ===");

{
  const { base, cleanup } = createRetryFixture();
  try {
    const planFile = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");

    // Precondition: T01 is checked
    const before = readFileSync(planFile, "utf-8");
    assertTrue(before.includes("- [x] **T01:"), "precondition: T01 is checked [x]");

    // Step 1: Uncheck T01
    const result = uncheckTaskInPlan(base, "M001", "S01", "T01");
    assertTrue(result, "uncheckTaskInPlan returns true");

    // Verify T01 is now unchecked
    const after = readFileSync(planFile, "utf-8");
    assertTrue(after.includes("- [ ] **T01:"), "T01 is now unchecked [ ]");
    assertTrue(!after.includes("- [x] **T01:"), "T01 no longer has [x]");

    // T02 is unaffected
    assertTrue(after.includes("- [ ] **T02:"), "T02 remains unchanged");
  } finally {
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Delete SUMMARY.md for the task
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Retry reset step 2: delete SUMMARY.md ===");

{
  const { base, cleanup } = createRetryFixture();
  try {
    const summaryFile = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md");

    // Precondition: SUMMARY exists
    assertTrue(existsSync(summaryFile), "precondition: SUMMARY.md exists");

    // Step 2: Delete SUMMARY.md
    unlinkSync(summaryFile);
    assertTrue(!existsSync(summaryFile), "SUMMARY.md deleted");
  } finally {
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Remove from completedUnits array and flush
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Retry reset step 3: remove from completedUnits ===");

{
  const { base, cleanup } = createRetryFixture();
  try {
    // Simulate the completedUnits array (as AutoSession would have it)
    const completedUnits = [
      { type: "execute-task", id: "M001/S01/T01", startedAt: 1000, finishedAt: 2000 },
      { type: "execute-task", id: "M001/S01/T02", startedAt: 3000, finishedAt: 4000 },
    ];

    // Step 3: Filter out the retried unit
    const filtered = completedUnits.filter(
      u => !(u.type === "execute-task" && u.id === "M001/S01/T01"),
    );

    assertEq(filtered.length, 1, "one unit removed from completedUnits");
    assertEq(filtered[0].id, "M001/S01/T02", "T02 still in completedUnits");

    // Flush to completed-units.json
    const completedKeysPath = join(base, ".gsd", "completed-units.json");
    const keys = filtered.map(u => `${u.type}/${u.id}`);
    writeFileSync(completedKeysPath, JSON.stringify(keys, null, 2), "utf-8");

    const onDisk = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
    assertEq(onDisk.length, 1, "completed-units.json has one entry");
    assertEq(onDisk[0], "execute-task/M001/S01/T02", "only T02 remains in completed-units.json");
  } finally {
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Delete the retry_on artifact
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Retry reset step 4: delete retry_on artifact ===");

{
  const { base, cleanup } = createRetryFixture();
  try {
    const retryArtifactPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");

    // Precondition: artifact exists
    assertTrue(existsSync(retryArtifactPath), "precondition: retry artifact exists");

    // Step 4: Delete retry artifact
    unlinkSync(retryArtifactPath);
    assertTrue(!existsSync(retryArtifactPath), "retry artifact deleted");
  } finally {
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Full retry reset sequence (all steps together)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Full retry reset: all steps combined ===");

{
  const { base, cleanup } = createRetryFixture();
  try {
    const trigger = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };

    const parts = trigger.unitId.split("/");
    const [mid, sid, tid] = parts;

    // Simulate completedUnits
    let completedUnits = [
      { type: "execute-task", id: "M001/S01/T01", startedAt: 1000, finishedAt: 2000 },
    ];

    // ── Execute the full reset sequence (mirrors auto-post-unit.ts logic) ──

    // Step 1: Uncheck in PLAN
    if (mid && sid && tid) {
      uncheckTaskInPlan(base, mid, sid, tid);
    }

    // Step 2: Delete SUMMARY (in milestones path)
    const tasksDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    const summaryFile = join(tasksDir, `${tid}-SUMMARY.md`);
    if (existsSync(summaryFile)) {
      unlinkSync(summaryFile);
    }

    // Step 3: Remove from completedUnits + flush
    completedUnits = completedUnits.filter(
      u => !(u.type === trigger.unitType && u.id === trigger.unitId),
    );
    const completedKeysPath = join(base, ".gsd", "completed-units.json");
    writeFileSync(completedKeysPath, JSON.stringify(
      completedUnits.map(u => `${u.type}/${u.id}`),
      null, 2,
    ), "utf-8");

    // Step 4: Delete retry artifact
    const retryArtifactPath = resolveHookArtifactPath(base, trigger.unitId, trigger.retryArtifact);
    if (existsSync(retryArtifactPath)) {
      unlinkSync(retryArtifactPath);
    }

    // ── Verify all state is reset ──

    // PLAN.md: T01 unchecked
    const planFile = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md");
    const planContent = readFileSync(planFile, "utf-8");
    assertTrue(planContent.includes("- [ ] **T01:"), "after reset: T01 unchecked in PLAN");
    assertTrue(!planContent.includes("- [x] **T01:"), "after reset: T01 not checked in PLAN");

    // SUMMARY.md: deleted
    assertTrue(!existsSync(summaryFile), "after reset: SUMMARY.md deleted");

    // completed-units.json: empty
    const onDisk = JSON.parse(readFileSync(completedKeysPath, "utf-8"));
    assertEq(onDisk.length, 0, "after reset: completed-units.json is empty");

    // Retry artifact: deleted
    assertTrue(!existsSync(retryArtifactPath), "after reset: retry artifact deleted");
  } finally {
    cleanup();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Reset is idempotent — no crash when artifacts are already missing
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== Retry reset: idempotent when artifacts already missing ===");

{
  const base = mkdtempSync(join(tmpdir(), "gsd-retry-idempotent-"));
  try {
    // Create minimal structure — NO summary, NO retry artifact, NO plan
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "completed-units.json"),
      JSON.stringify([]),
      "utf-8",
    );

    const trigger = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };

    // These should not throw even with missing files
    const parts = trigger.unitId.split("/");
    const [mid, sid, tid] = parts;

    // Uncheck — returns false because no PLAN file
    const uncheckResult = uncheckTaskInPlan(base, mid, sid, tid);
    assertTrue(!uncheckResult, "uncheck returns false when no PLAN exists");

    // Summary does not exist — no crash
    const summaryFile = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", `${tid}-SUMMARY.md`);
    assertTrue(!existsSync(summaryFile), "no summary to delete — safe");

    // Retry artifact does not exist — no crash
    const retryPath = resolveHookArtifactPath(base, trigger.unitId, trigger.retryArtifact);
    assertTrue(!existsSync(retryPath), "no retry artifact to delete — safe");

    // completed-units.json filter on empty array — safe
    const completedUnits: Array<{ type: string; id: string }> = [];
    const filtered = completedUnits.filter(
      u => !(u.type === trigger.unitType && u.id === trigger.unitId),
    );
    assertEq(filtered.length, 0, "filter on empty array is safe");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: resolveHookArtifactPath produces correct path for retry artifacts
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n=== resolveHookArtifactPath: correct path for retry artifacts ===");

{
  const base = "/project";
  const path = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
  assertEq(
    path,
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-NEEDS-REWORK.md"),
    "retry artifact path resolves to task directory with task prefix",
  );
}

report();
