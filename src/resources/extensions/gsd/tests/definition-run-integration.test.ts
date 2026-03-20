/**
 * Integration tests for the S04 pipeline: YAML definition → createRun → dispatch cycle.
 *
 * Proves the full lifecycle: a YAML workflow definition is loaded, a run is
 * created with an immutable DEFINITION.yaml snapshot and generated GRAPH.yaml,
 * and a 3-step dispatch cycle completes through CustomWorkflowEngine with
 * dependency ordering enforced.
 *
 * Validates R006 (V1 schema), R007 (immutable snapshot), R008 (GRAPH.yaml tracking).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadDefinition } from "../definition-loader.ts";
import { createRun, listRuns } from "../run-manager.ts";
import { readGraph } from "../graph.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-integ-"));
}

const YAML_3_STEP = `version: 1
name: "test-pipeline"
description: "Integration test workflow"
steps:
  - id: research
    name: "Research phase"
    prompt: "Research the topic"
    produces:
      - research.md
  - id: outline
    name: "Create outline"
    prompt: "Create an outline based on research"
    depends_on:
      - research
    produces:
      - outline.md
  - id: draft
    name: "Write draft"
    prompt: "Write the first draft from outline"
    depends_on:
      - outline
    produces:
      - draft.md
`;

function writeDefinition(basePath: string, yamlContent: string = YAML_3_STEP): string {
  const defsDir = join(basePath, "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, "test-pipeline.yaml"), yamlContent, "utf-8");
  return defsDir;
}

// ─── Full pipeline test ──────────────────────────────────────────────────

test("Full pipeline: YAML definition → createRun → dispatch cycle → all steps complete", async () => {
  const basePath = makeTmpDir();
  try {
    const defsDir = writeDefinition(basePath);

    // --- Load definition (R006) ---
    const def = loadDefinition(defsDir, "test-pipeline");
    assert.equal(def.steps.length, 3);
    assert.equal(def.steps[0].id, "research");
    assert.equal(def.steps[1].id, "outline");
    assert.equal(def.steps[2].id, "draft");

    // --- Create run (R007 + R008) ---
    const { runDir, runId } = createRun(basePath, "test-pipeline");
    assert.ok(runId, "runId must be non-empty");
    assert.ok(runDir, "runDir must be non-empty");

    // --- Verify DEFINITION.yaml is byte-identical to source (R007) ---
    const sourceBytes = readFileSync(join(defsDir, "test-pipeline.yaml"));
    const snapshotBytes = readFileSync(join(runDir, "DEFINITION.yaml"));
    assert.deepEqual(sourceBytes, snapshotBytes, "DEFINITION.yaml must be an exact byte copy of source");

    // --- Verify GRAPH.yaml structure before dispatch (R008) ---
    const graphBefore = readGraph(runDir);
    assert.equal(graphBefore.steps.length, 3);
    for (const step of graphBefore.steps) {
      assert.equal(step.status, "pending", `${step.id} should start as pending`);
    }
    assert.deepEqual(graphBefore.steps[0].dependsOn, []);
    assert.deepEqual(graphBefore.steps[1].dependsOn, ["research"]);
    assert.deepEqual(graphBefore.steps[2].dependsOn, ["outline"]);

    // --- Run 3-step dispatch cycle with dependency ordering ---
    const engine = new CustomWorkflowEngine(runDir);
    const expectedOrder = ["research", "outline", "draft"];

    for (let i = 0; i < 3; i++) {
      const state = await engine.deriveState(runDir);
      assert.equal(state.isComplete, false, `Should not be complete at iteration ${i}`);

      const dispatch = await engine.resolveDispatch(state, { basePath: runDir });
      assert.equal(dispatch.action, "dispatch", `Should dispatch at iteration ${i}`);
      if (dispatch.action === "dispatch") {
        assert.equal(dispatch.step.unitId, expectedOrder[i],
          `Iteration ${i}: expected ${expectedOrder[i]}, got ${dispatch.step.unitId}`);
      }

      const result = await engine.reconcile(state, {
        unitType: "custom-step",
        unitId: expectedOrder[i],
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      });

      if (i < 2) {
        assert.equal(result.outcome, "continue", `Iteration ${i} should continue`);
      } else {
        assert.equal(result.outcome, "stop", "Final iteration should stop");
      }
    }

    // --- Verify final state ---
    const finalState = await engine.deriveState(runDir);
    assert.equal(finalState.isComplete, true);

    const finalDispatch = await engine.resolveDispatch(finalState, { basePath: runDir });
    assert.equal(finalDispatch.action, "stop");

    // --- Verify on-disk state (R008) ---
    const graphAfter = readGraph(runDir);
    for (const step of graphAfter.steps) {
      assert.equal(step.status, "complete", `${step.id} should be complete on disk`);
    }

    // --- Verify display metadata shows definition name ---
    const meta = engine.getDisplayMetadata(finalState);
    assert.equal(meta.engineLabel, "test-pipeline",
      'engineLabel should show definition name, not "Custom Pipeline"');
    assert.equal(meta.currentPhase, "complete");
    assert.ok(meta.stepCount);
    assert.equal(meta.stepCount.completed, 3);
    assert.equal(meta.stepCount.total, 3);
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── Negative: nonexistent definition ────────────────────────────────────

test("createRun with nonexistent definition throws", () => {
  const basePath = makeTmpDir();
  try {
    // No workflow-defs directory at all
    assert.throws(
      () => createRun(basePath, "nonexistent"),
      (err: Error) => {
        assert.ok(err.message.includes("nonexistent"),
          `Error should mention the definition name: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── listRuns returns created runs ───────────────────────────────────────

test("listRuns returns created runs ordered newest-first", async () => {
  const basePath = makeTmpDir();
  try {
    writeDefinition(basePath);

    const run1 = createRun(basePath, "test-pipeline");
    // Compact timestamp has 1-second resolution — wait >1s for distinct ordering
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const run2 = createRun(basePath, "test-pipeline");

    const runs = listRuns(basePath);
    assert.equal(runs.length, 2, "Should have 2 runs");

    // Both should have the correct definition name
    for (const run of runs) {
      assert.equal(run.definitionName, "test-pipeline");
    }

    // Newest first: run2 should be first
    assert.equal(runs[0].runId, run2.runId, "Newest run should be first");
    assert.equal(runs[1].runId, run1.runId, "Oldest run should be second");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── Snapshot immutability ───────────────────────────────────────────────

test("DEFINITION.yaml snapshot is immune to source modification", () => {
  const basePath = makeTmpDir();
  try {
    writeDefinition(basePath);

    const originalSource = readFileSync(
      join(basePath, "workflow-defs", "test-pipeline.yaml"),
    );

    const { runDir } = createRun(basePath, "test-pipeline");

    // Modify the source YAML after run creation
    writeFileSync(
      join(basePath, "workflow-defs", "test-pipeline.yaml"),
      YAML_3_STEP.replace("test-pipeline", "MODIFIED-NAME"),
      "utf-8",
    );

    // Snapshot should still match original, not modified content
    const snapshotBytes = readFileSync(join(runDir, "DEFINITION.yaml"));
    assert.deepEqual(snapshotBytes, originalSource,
      "Snapshot must match original source, not modified version");

    // Double-check: snapshot should NOT match modified source
    const modifiedSource = readFileSync(
      join(basePath, "workflow-defs", "test-pipeline.yaml"),
    );
    assert.notDeepEqual(snapshotBytes, modifiedSource,
      "Snapshot must differ from modified source");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
