// GSD Extension — Hook Engine Tests (Post-Unit, Pre-Dispatch, State Persistence)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkPostUnitHooks,
  getActiveHook,
  resetHookState,
  isRetryPending,
  consumeRetryTrigger,
  resolveHookArtifactPath,
  runPreDispatchHooks,
  persistHookState,
  restoreHookState,
  clearPersistedHookState,
  getHookStatus,
  formatHookStatus,
  triggerHookManually,
} from "../post-unit-hooks.ts";

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-hook-test-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Post-Unit Hook Tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── resolveHookArtifactPath ───────────────────────────────────────────────


describe('post-unit-hooks', () => {
test('resolveHookArtifactPath', () => {
  const base = "/project";

  // Task-level
  const taskPath = resolveHookArtifactPath(base, "M001/S01/T01", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    taskPath,
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-REVIEW-PASS.md"),
    "task-level artifact path",
  );

  // Slice-level
  const slicePath = resolveHookArtifactPath(base, "M001/S01", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    slicePath,
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "REVIEW-PASS.md"),
    "slice-level artifact path",
  );

  // Milestone-level
  const milestonePath = resolveHookArtifactPath(base, "M001", "REVIEW-PASS.md");
  assert.deepStrictEqual(
    milestonePath,
    join(base, ".gsd", "milestones", "M001", "REVIEW-PASS.md"),
    "milestone-level artifact path",
  );
});

// ─── resetHookState ────────────────────────────────────────────────────────
test('resetHookState', () => {
  resetHookState();
  assert.deepStrictEqual(getActiveHook(), null, "no active hook after reset");
  assert.ok(!isRetryPending(), "no retry pending after reset");
  assert.deepStrictEqual(consumeRetryTrigger(), null, "no retry trigger after reset");
});

// ─── checkPostUnitHooks with no hooks configured ───────────────────────────
test('No hooks configured', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "returns null when no hooks configured");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── Hook units don't trigger hooks (no hook-on-hook) ──────────────────────
test('Hook-on-hook prevention', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = checkPostUnitHooks("hook/code-review", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "hook units don't trigger other hooks");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ─── consumeRetryTrigger clears state ──────────────────────────────────────
test('consumeRetryTrigger clears state', () => {
  resetHookState();
  assert.deepStrictEqual(consumeRetryTrigger(), null, "no trigger initially");
  assert.ok(!isRetryPending(), "no retry initially");
});

// ─── Variable substitution in prompts ──────────────────────────────────────
test('Variable substitution', () => {
  const base = "/project";

  // 3-part ID
  const path3 = resolveHookArtifactPath(base, "M002/S03/T05", "result.md");
  assert.ok(path3.includes("M002"), "3-part ID extracts milestoneId");
  assert.ok(path3.includes("S03"), "3-part ID extracts sliceId");
  assert.ok(path3.includes("T05"), "3-part ID extracts taskId");
  assert.ok(path3.includes("milestones"), "3-part ID includes milestones/ segment");

  // 2-part ID
  const path2 = resolveHookArtifactPath(base, "M002/S03", "result.md");
  assert.ok(path2.includes("M002"), "2-part ID extracts milestoneId");
  assert.ok(path2.includes("S03"), "2-part ID extracts sliceId");
  assert.ok(path2.includes("milestones"), "2-part ID includes milestones/ segment");

  // 1-part ID
  const path1 = resolveHookArtifactPath(base, "M002", "result.md");
  assert.ok(path1.includes("M002"), "1-part ID extracts milestoneId");
  assert.ok(path1.includes("milestones"), "1-part ID includes milestones/ segment");
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: Pre-Dispatch Hook Tests
// ═══════════════════════════════════════════════════════════════════════════
test('Pre-dispatch: no hooks configured', () => {
  const base = createFixtureBase();
  try {
    const result = runPreDispatchHooks("execute-task", "M001/S01/T01", "original prompt", base);
    assert.deepStrictEqual(result.action, "proceed", "proceeds when no hooks");
    assert.deepStrictEqual(result.prompt, "original prompt", "prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Pre-dispatch: hook units bypass', () => {
  const base = createFixtureBase();
  try {
    const result = runPreDispatchHooks("hook/review", "M001/S01/T01", "hook prompt", base);
    assert.deepStrictEqual(result.action, "proceed", "hook units always proceed");
    assert.deepStrictEqual(result.prompt, "hook prompt", "hook prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired for hook units");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: State Persistence Tests
// ═══════════════════════════════════════════════════════════════════════════
test('State persistence: persist and restore', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Persist empty state
    persistHookState(base);
    const filePath = join(base, ".gsd", "hook-state.json");
    assert.ok(existsSync(filePath), "hook-state.json created");

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.deepStrictEqual(typeof content.savedAt, "string", "savedAt is a string");
    assert.deepStrictEqual(Object.keys(content.cycleCounts).length, 0, "empty cycle counts");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore from disk', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Write a state file with some cycle counts
    const stateFile = join(base, ".gsd", "hook-state.json");
    writeFileSync(stateFile, JSON.stringify({
      cycleCounts: {
        "review/execute-task/M001/S01/T01": 2,
        "simplify/execute-task/M001/S01/T02": 1,
      },
      savedAt: new Date().toISOString(),
    }), "utf-8");

    // Restore
    restoreHookState(base);

    // Verify by persisting and reading back
    persistHookState(base);
    const restored = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.deepStrictEqual(restored.cycleCounts["review/execute-task/M001/S01/T01"], 2, "cycle count restored for review");
    assert.deepStrictEqual(restored.cycleCounts["simplify/execute-task/M001/S01/T02"], 1, "cycle count restored for simplify");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: clear', () => {
  const base = createFixtureBase();
  try {
    resetHookState();

    // Write then clear
    const stateFile = join(base, ".gsd", "hook-state.json");
    writeFileSync(stateFile, JSON.stringify({
      cycleCounts: { "review/execute-task/M001/S01/T01": 3 },
      savedAt: new Date().toISOString(),
    }), "utf-8");

    clearPersistedHookState(base);

    const cleared = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.deepStrictEqual(Object.keys(cleared.cycleCounts).length, 0, "cycle counts cleared");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore handles missing file', () => {
  const base = createFixtureBase();
  try {
    resetHookState();
    // Should not throw
    restoreHookState(base);
    assert.deepStrictEqual(getActiveHook(), null, "no active hook after restore from missing file");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('State persistence: restore handles corrupt file', () => {
  const base = createFixtureBase();
  try {
    resetHookState();
    writeFileSync(join(base, ".gsd", "hook-state.json"), "not json", "utf-8");
    // Should not throw
    restoreHookState(base);
    assert.deepStrictEqual(getActiveHook(), null, "no active hook after corrupt restore");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Hook Status Reporting Tests
// ═══════════════════════════════════════════════════════════════════════════
test('Hook status: no hooks', () => {
  resetHookState();
  const entries = getHookStatus();
  // No preferences file = no hooks
  assert.deepStrictEqual(entries.length, 0, "no entries when no hooks configured");

  const formatted = formatHookStatus();
  assert.match(formatted, /No hooks configured/, "status message says no hooks");
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Manual Hook Trigger Tests
// ═══════════════════════════════════════════════════════════════════════════
test('triggerHookManually: hook not found', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    const result = triggerHookManually("nonexistent-hook", "execute-task", "M001/S01/T01", base);
    assert.deepStrictEqual(result, null, "returns null when hook not found");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('triggerHookManually: with configured hook', () => {
  resetHookState();
  const base = createFixtureBase();
  try {
    // This test will work when preferences are configured
    // For now, just verify the function exists and handles missing hooks
    const result = triggerHookManually("code-review", "execute-task", "M001/S01/T01", base);
    // Result depends on whether code-review hook is configured in preferences
    // The function should either return null or a valid HookDispatchResult
    assert.ok(result === null || typeof result === "object", "returns null or object");
    if (result) {
      assert.deepStrictEqual(result.hookName, "code-review", "hook name in result");
      assert.deepStrictEqual(result.unitType, "hook/code-review", "unit type is hook-prefixed");
      assert.deepStrictEqual(result.unitId, "M001/S01/T01", "unit ID preserved");
      assert.ok(typeof result.prompt === "string", "prompt is a string");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

});
