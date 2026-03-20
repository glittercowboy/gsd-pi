/**
 * Integration tests for S05 context injection + verification policies.
 *
 * Proves the full pipeline: context from prior step artifacts is injected
 * into the dispatch prompt via CustomWorkflowEngine.resolveDispatch(), and
 * all four verification policies return correct results through
 * CustomExecutionPolicy.verify().
 *
 * Validates R009 (context continuity) and R010 (verification policies)
 * at the integration level.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRun } from "../run-manager.ts";
import { readGraph, markStepComplete, writeGraph } from "../graph.ts";
import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { CustomExecutionPolicy } from "../custom-execution-policy.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-s05-integ-"));
}

function writeDefinitionYaml(
  basePath: string,
  name: string,
  yamlContent: string,
): string {
  const defsDir = join(basePath, "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, `${name}.yaml`), yamlContent, "utf-8");
  return defsDir;
}

// ─── Test 1: Context injection appears in dispatch prompt ────────────────

test("resolveDispatch prepends injected context from prior step artifacts", async () => {
  const basePath = makeTmpDir();
  try {
    // 2-step definition: step-1 produces research.md, step-2 has context_from: [step-1]
    const yaml = `version: 1
name: "context-test"
steps:
  - id: step-1
    name: "Research"
    prompt: "Do research"
    produces:
      - research.md
  - id: step-2
    name: "Outline"
    prompt: "Create outline"
    depends_on:
      - step-1
    context_from:
      - step-1
    produces:
      - outline.md
`;
    writeDefinitionYaml(basePath, "context-test", yaml);
    const { runDir } = createRun(basePath, "context-test");

    // Simulate step-1 output
    const researchContent = "# Research Findings\n\nKey insight: context injection works.";
    writeFileSync(join(runDir, "research.md"), researchContent, "utf-8");

    const engine = new CustomWorkflowEngine(runDir);

    // Complete step-1 via reconcile
    const state1 = await engine.deriveState(runDir);
    const dispatch1 = await engine.resolveDispatch(state1, { basePath: runDir });
    assert.equal(dispatch1.action, "dispatch");
    if (dispatch1.action === "dispatch") {
      assert.equal(dispatch1.step.unitId, "step-1");
    }
    await engine.reconcile(state1, {
      unitType: "custom-step",
      unitId: "step-1",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });

    // Now dispatch step-2 — should have injected context
    const state2 = await engine.deriveState(runDir);
    const dispatch2 = await engine.resolveDispatch(state2, { basePath: runDir });
    assert.equal(dispatch2.action, "dispatch");
    if (dispatch2.action === "dispatch") {
      assert.equal(dispatch2.step.unitId, "step-2");
      // Verify context injection header
      assert.ok(
        dispatch2.step.prompt.includes("## Context from prior steps"),
        "Dispatch prompt should contain context injection header",
      );
      // Verify actual artifact content is present
      assert.ok(
        dispatch2.step.prompt.includes("Key insight: context injection works."),
        "Dispatch prompt should contain artifact content from step-1",
      );
      // Verify step header
      assert.ok(
        dispatch2.step.prompt.includes("### Step: Research (step-1)"),
        "Dispatch prompt should contain step name and id header",
      );
      // Verify original prompt is still present
      assert.ok(
        dispatch2.step.prompt.includes("Create outline"),
        "Original step prompt should still be in dispatch",
      );
    }
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── Test 2: content-heuristic verification through policy ──────────────

test("CustomExecutionPolicy.verify dispatches content-heuristic policy", async () => {
  const basePath = makeTmpDir();
  try {
    // step-1 has no verify, step-2 has content-heuristic with min_size
    const yaml = `version: 1
name: "verify-heuristic"
steps:
  - id: step-1
    name: "Research"
    prompt: "Do research"
    produces:
      - research.md
  - id: step-2
    name: "Draft"
    prompt: "Write draft"
    depends_on:
      - step-1
    produces:
      - output.md
    verify:
      policy: content-heuristic
      min_size: 10
`;
    writeDefinitionYaml(basePath, "verify-heuristic", yaml);
    const { runDir } = createRun(basePath, "verify-heuristic");

    const policy = new CustomExecutionPolicy(runDir);

    // step-1 has no verify config → should return "continue"
    const result1 = await policy.verify("custom-step", "step-1", {
      basePath: runDir,
    });
    assert.equal(result1, "continue", "Step without verify should return continue");

    // step-2 has content-heuristic but output.md doesn't exist → "retry"
    const result2 = await policy.verify("custom-step", "step-2", {
      basePath: runDir,
    });
    assert.equal(
      result2,
      "retry",
      "Missing artifact should return retry",
    );

    // Write a 20-byte file to satisfy content-heuristic
    writeFileSync(
      join(runDir, "output.md"),
      "This is enough text!",
      "utf-8",
    );

    // Now step-2 should pass → "continue"
    const result3 = await policy.verify("custom-step", "step-2", {
      basePath: runDir,
    });
    assert.equal(
      result3,
      "continue",
      "Artifact meeting min_size should return continue",
    );
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── Test 3: shell-command verification through policy ───────────────────

test("CustomExecutionPolicy.verify dispatches shell-command policy", async () => {
  const basePath = makeTmpDir();
  try {
    const yaml = `version: 1
name: "verify-shell"
steps:
  - id: step-1
    name: "Generate"
    prompt: "Generate output"
    produces:
      - output.md
    verify:
      policy: shell-command
      command: "test -f output.md"
`;
    writeDefinitionYaml(basePath, "verify-shell", yaml);
    const { runDir } = createRun(basePath, "verify-shell");

    const policy = new CustomExecutionPolicy(runDir);

    // output.md doesn't exist → command fails → "retry"
    const result1 = await policy.verify("custom-step", "step-1", {
      basePath: runDir,
    });
    assert.equal(result1, "retry", "Missing file should cause shell command to fail → retry");

    // Create the file → command succeeds → "continue"
    writeFileSync(join(runDir, "output.md"), "content", "utf-8");
    const result2 = await policy.verify("custom-step", "step-1", {
      basePath: runDir,
    });
    assert.equal(result2, "continue", "Existing file should cause shell command to succeed → continue");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});

// ─── Test 4: prompt-verify and human-review return "pause" ──────────────

test("CustomExecutionPolicy.verify returns pause for prompt-verify and human-review", async () => {
  const basePath = makeTmpDir();
  try {
    const yaml = `version: 1
name: "verify-pause"
steps:
  - id: step-1
    name: "Quality check"
    prompt: "Do work"
    produces:
      - output.md
    verify:
      policy: prompt-verify
      prompt: "Check quality of the output"
  - id: step-2
    name: "Human gate"
    prompt: "Do more work"
    depends_on:
      - step-1
    produces:
      - final.md
    verify:
      policy: human-review
`;
    writeDefinitionYaml(basePath, "verify-pause", yaml);
    const { runDir } = createRun(basePath, "verify-pause");

    const policy = new CustomExecutionPolicy(runDir);

    // prompt-verify → "pause"
    const result1 = await policy.verify("custom-step", "step-1", {
      basePath: runDir,
    });
    assert.equal(result1, "pause", "prompt-verify should return pause");

    // human-review → "pause"
    const result2 = await policy.verify("custom-step", "step-2", {
      basePath: runDir,
    });
    assert.equal(result2, "pause", "human-review should return pause");
  } finally {
    rmSync(basePath, { recursive: true, force: true });
  }
});
