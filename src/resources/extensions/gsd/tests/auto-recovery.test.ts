import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact,
  buildLoopRemediationSteps,
  completedKeysPath,
  persistCompletedKey,
  removePersistedKey,
  loadPersistedKeys,
} from "../auto-recovery.ts";

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
