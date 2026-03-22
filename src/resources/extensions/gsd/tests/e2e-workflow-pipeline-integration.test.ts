/**
 * e2e-workflow-pipeline-integration.test.ts — End-to-end integration test
 * proving the assembled workflow engine pipeline works.
 *
 * Exercises every engine feature in a single multi-step workflow:
 * - Dependency-ordered dispatch
 * - Parameter substitution ({{target}})
 * - Content-heuristic verification (minSize)
 * - Shell-command verification (test -f)
 * - Context injection via context_from
 * - Iterate/fan-out expansion
 * - Dashboard metadata (step N/M)
 * - Completion detection (isComplete: true)
 *
 * Operates at the engine level (CustomWorkflowEngine + CustomExecutionPolicy
 * + real temp directories) — NOT through autoLoop() — to avoid the
 * timing-dependent resolveAgentEnd pattern that causes flakiness.
 *
 * Follows the pattern from iterate-engine-integration.test.ts:
 * real temp dirs via mkdtempSync, dispatch()/reconcile() helpers, afterEach cleanup.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify, parse } from "yaml";

import { CustomWorkflowEngine } from "../custom-workflow-engine.ts";
import { CustomExecutionPolicy } from "../custom-execution-policy.ts";
import { createRun, listRuns } from "../run-manager.ts";
import { readGraph, writeGraph } from "../graph.ts";
import { validateDefinition } from "../definition-loader.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-pipeline-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
  }
  tmpDirs.length = 0;
});

/** Drive deriveState → resolveDispatch. */
async function dispatch(engine: CustomWorkflowEngine) {
  const state = await engine.deriveState("/unused");
  return { state, result: engine.resolveDispatch(state, { basePath: "/unused" }) };
}

/** Drive deriveState → reconcile for a given unitId. */
async function reconcile(engine: CustomWorkflowEngine, unitId: string) {
  const state = await engine.deriveState("/unused");
  return engine.reconcile(state, {
    unitType: "custom-step",
    unitId,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });
}

// ─── The multi-feature YAML definition (snake_case for loadDefinition) ───

/**
 * 4-step workflow definition exercising every engine feature:
 *
 * gather → scan (iterate) → analyze (context_from scan) → report (context_from analyze)
 *
 * Note: The scan step prompt uses a literal string instead of {{item}} in the
 * definition YAML because substituteParams() checks for unresolved {{key}}
 * placeholders. After createRun, we patch GRAPH.yaml to add the {{item}}
 * placeholder so iterate expansion produces item-specific prompts.
 */
const E2E_DEFINITION_YAML = `
version: 1
name: e2e-pipeline
description: End-to-end integration test workflow
params:
  target: default-target
steps:
  - id: gather
    name: Gather Information
    prompt: "Gather information about {{target}} and produce a bullet list of findings"
    requires: []
    produces:
      - output/gather-results.md
    verify:
      policy: content-heuristic
      minSize: 10
  - id: scan
    name: Scan Items
    prompt: "Scan item: ITEM_PLACEHOLDER"
    requires:
      - gather
    produces:
      - output/scan-result.txt
    verify:
      policy: shell-command
      command: "test -f output/scan-result.txt"
    iterate:
      source: output/gather-results.md
      pattern: "^- (.+)$"
  - id: analyze
    name: Analyze Results
    prompt: "Analyze all scan results and produce a summary"
    requires:
      - scan
    produces:
      - output/analysis.md
    context_from:
      - scan
    verify:
      policy: content-heuristic
      minSize: 5
  - id: report
    name: Final Report
    prompt: "Write final report for {{target}}"
    requires:
      - analyze
    produces:
      - output/report.md
    context_from:
      - analyze
`;

/**
 * Create a temp project directory with the e2e-pipeline definition YAML,
 * call createRun with param overrides, and patch GRAPH.yaml so the scan
 * step's prompt contains {{item}} for iterate expansion.
 */
function setupProject(overrides?: Record<string, string>): {
  basePath: string;
  runDir: string;
} {
  const basePath = makeTmpDir();
  const defsDir = join(basePath, ".gsd", "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, "e2e-pipeline.yaml"), E2E_DEFINITION_YAML, "utf-8");

  const runDir = createRun(basePath, "e2e-pipeline", overrides);

  // Patch GRAPH.yaml: replace the scan step's placeholder with {{item}}
  // so iterate expansion produces item-specific prompts. This works around
  // substituteParams() rejecting unresolved {{item}} in the definition.
  const graph = readGraph(runDir);
  const scanStep = graph.steps.find((s) => s.id === "scan");
  if (scanStep) {
    scanStep.prompt = "Scan item: {{item}}";
    writeGraph(runDir, graph);
  }

  return { basePath, runDir };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("e2e-workflow-pipeline", () => {
  it("drives the full engine pipeline: create → dispatch → verify → complete", async () => {
    // ── 1. Create run with param overrides ────────────────────────────
    const { basePath, runDir } = setupProject({ target: "my-project" });

    // Verify run directory structure
    assert.ok(existsSync(join(runDir, "DEFINITION.yaml")), "DEFINITION.yaml should exist");
    assert.ok(existsSync(join(runDir, "GRAPH.yaml")), "GRAPH.yaml should exist");
    assert.ok(existsSync(join(runDir, "PARAMS.json")), "PARAMS.json should exist");

    // Verify PARAMS.json has the override
    const params = JSON.parse(readFileSync(join(runDir, "PARAMS.json"), "utf-8"));
    assert.deepStrictEqual(params, { target: "my-project" });

    // Verify the frozen DEFINITION.yaml has substituted params in non-iterate steps
    const frozenDef = readFileSync(join(runDir, "DEFINITION.yaml"), "utf-8");
    assert.ok(
      frozenDef.includes("my-project"),
      "Frozen definition should have substituted 'my-project' for {{target}}",
    );

    // Instantiate engine and policy
    const engine = new CustomWorkflowEngine(runDir);
    const policy = new CustomExecutionPolicy(runDir);

    // Verify initial graph has 4 steps all pending
    const initialGraph = readGraph(runDir);
    assert.equal(initialGraph.steps.length, 4, "Initial graph should have 4 steps");
    assert.ok(
      initialGraph.steps.every((s) => s.status === "pending"),
      "All steps should start as pending",
    );

    // Verify initial state is not complete
    let state = await engine.deriveState("/unused");
    assert.equal(state.isComplete, false, "Workflow should not be complete initially");

    // Dashboard metadata: 0/4 initially
    let meta = engine.getDisplayMetadata(state);
    assert.equal(meta.stepCount!.completed, 0);
    assert.equal(meta.stepCount!.total, 4);
    assert.equal(meta.progressSummary, "Step 0/4");

    // ── 2. Step 1: gather ─────────────────────────────────────────────
    const { result: r1 } = await dispatch(engine);
    const d1 = await r1;
    assert.equal(d1.action, "dispatch", "Should dispatch gather step");
    if (d1.action !== "dispatch") throw new Error("unreachable");

    assert.equal(d1.step.unitId, "e2e-pipeline/gather");
    assert.ok(
      d1.step.prompt.includes("my-project"),
      `Gather prompt should contain substituted param "my-project", got: "${d1.step.prompt}"`,
    );
    assert.ok(
      !d1.step.prompt.includes("default-target"),
      "Gather prompt should NOT contain default param value",
    );

    // Simulate agent work: write the gather artifact with bullet items for iterate
    const outputDir = join(runDir, "output");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(runDir, "output/gather-results.md"),
      "# Findings for my-project\n\n- security-audit\n- performance-review\n- code-quality\n",
      "utf-8",
    );

    // Reconcile gather
    await reconcile(engine, "e2e-pipeline/gather");

    // Verify gather: content-heuristic (minSize: 10) should pass
    const gatherVerify = await policy.verify("custom-step", "e2e-pipeline/gather", {
      basePath: "/unused",
    });
    assert.equal(
      gatherVerify,
      "continue",
      "Gather verification (content-heuristic) should pass",
    );

    // Dashboard after gather: 1 completed (gather), total still 4
    state = await engine.deriveState("/unused");
    meta = engine.getDisplayMetadata(state);
    assert.equal(meta.stepCount!.completed, 1);
    assert.equal(meta.progressSummary, "Step 1/4");
    assert.equal(state.isComplete, false);

    // ── 3. Step 2: scan with iterate ──────────────────────────────────
    // Dispatch should trigger iterate expansion from gather-results.md
    const { result: r2 } = await dispatch(engine);
    const d2 = await r2;
    assert.equal(d2.action, "dispatch", "Should dispatch first scan instance");
    if (d2.action !== "dispatch") throw new Error("unreachable");

    // First instance should be scan--001 for "security-audit"
    assert.equal(d2.step.unitId, "e2e-pipeline/scan--001");
    assert.ok(
      d2.step.prompt.includes("security-audit"),
      `First scan instance prompt should contain "security-audit", got: "${d2.step.prompt}"`,
    );

    // Verify graph expanded: parent "scan" is "expanded", 3 instances exist
    let graph = readGraph(runDir);
    const scanParent = graph.steps.find((s) => s.id === "scan");
    assert.ok(scanParent, "Parent scan step should exist");
    assert.equal(scanParent.status, "expanded", "Parent scan should be expanded");

    const scanInstances = graph.steps.filter((s) => s.parentStepId === "scan");
    assert.equal(scanInstances.length, 3, "Should have 3 scan instances");
    assert.equal(scanInstances[0].id, "scan--001");
    assert.equal(scanInstances[1].id, "scan--002");
    assert.equal(scanInstances[2].id, "scan--003");

    // Verify iterate prompts contain item-specific content
    assert.ok(scanInstances[0].prompt.includes("security-audit"));
    assert.ok(scanInstances[1].prompt.includes("performance-review"));
    assert.ok(scanInstances[2].prompt.includes("code-quality"));

    // Verify dependency rewriting: analyze should now depend on scan--001, scan--002, scan--003
    const analyzeStep = graph.steps.find((s) => s.id === "analyze");
    assert.ok(analyzeStep);
    assert.deepStrictEqual(
      analyzeStep.dependsOn.sort(),
      ["scan--001", "scan--002", "scan--003"],
      "Analyze should depend on all scan instances after expansion",
    );

    // Graph step count increased: 4 original + 3 instances = 7 (parent stays as "expanded")
    assert.equal(graph.steps.length, 7, "Graph should have 7 steps after expansion");

    // Dashboard after expansion: total now includes instance steps
    state = await engine.deriveState("/unused");
    meta = engine.getDisplayMetadata(state);
    // completed: gather(1), expanded steps don't count as "complete" in getDisplayMetadata
    assert.equal(meta.stepCount!.completed, 1, "Only gather should be complete");

    // Write scan artifact (same path for all instances since the verify command checks run-dir-relative path)
    writeFileSync(join(runDir, "output/scan-result.txt"), "scan output data", "utf-8");

    // Complete scan--001, dispatch scan--002
    await reconcile(engine, "e2e-pipeline/scan--001");

    // Verify analyze is still blocked (not all scan instances complete)
    const { result: r3a } = await dispatch(engine);
    const d3a = await r3a;
    assert.equal(d3a.action, "dispatch");
    if (d3a.action !== "dispatch") throw new Error("unreachable");
    assert.equal(
      d3a.step.unitId,
      "e2e-pipeline/scan--002",
      "Should dispatch scan--002 (analyze still blocked)",
    );
    assert.ok(d3a.step.prompt.includes("performance-review"));

    // Complete scan--002, dispatch scan--003
    await reconcile(engine, "e2e-pipeline/scan--002");
    const { result: r3b } = await dispatch(engine);
    const d3b = await r3b;
    assert.equal(d3b.action, "dispatch");
    if (d3b.action !== "dispatch") throw new Error("unreachable");
    assert.equal(d3b.step.unitId, "e2e-pipeline/scan--003");
    assert.ok(d3b.step.prompt.includes("code-quality"));

    // Complete scan--003 — now analyze should be unblocked
    await reconcile(engine, "e2e-pipeline/scan--003");

    // Dashboard after all scan instances: 4 complete (gather + 3 instances)
    state = await engine.deriveState("/unused");
    meta = engine.getDisplayMetadata(state);
    assert.equal(meta.stepCount!.completed, 4, "gather + 3 scan instances should be complete");
    assert.equal(state.isComplete, false);

    // ── 4. Step 3: analyze (with context_from scan) ───────────────────
    const { result: r4 } = await dispatch(engine);
    const d4 = await r4;
    assert.equal(d4.action, "dispatch", "Should dispatch analyze step");
    if (d4.action !== "dispatch") throw new Error("unreachable");

    assert.equal(d4.step.unitId, "e2e-pipeline/analyze");

    // Context injection: the analyze prompt should include content from scan's produces
    // scan produces output/scan-result.txt and context_from references "scan"
    assert.ok(
      d4.step.prompt.includes("scan output data"),
      `Analyze prompt should include injected context from scan artifact, got: "${d4.step.prompt.slice(0, 200)}"`,
    );
    assert.ok(
      d4.step.prompt.includes("Analyze all scan results"),
      "Analyze prompt should still contain the original prompt text",
    );

    // Write analyze artifact
    writeFileSync(
      join(runDir, "output/analysis.md"),
      "# Analysis Summary\n\nAll scans completed successfully with findings.\n",
      "utf-8",
    );

    await reconcile(engine, "e2e-pipeline/analyze");

    // Verify analyze: content-heuristic (minSize: 5) should pass
    const analyzeVerify = await policy.verify("custom-step", "e2e-pipeline/analyze", {
      basePath: "/unused",
    });
    assert.equal(
      analyzeVerify,
      "continue",
      "Analyze verification (content-heuristic) should pass",
    );

    // Dashboard after analyze: 5 complete
    state = await engine.deriveState("/unused");
    meta = engine.getDisplayMetadata(state);
    assert.equal(meta.stepCount!.completed, 5);
    assert.equal(state.isComplete, false, "Should not be complete yet (report remaining)");

    // ── 5. Step 4: report (with context_from analyze + param) ─────────
    const { result: r5 } = await dispatch(engine);
    const d5 = await r5;
    assert.equal(d5.action, "dispatch", "Should dispatch report step");
    if (d5.action !== "dispatch") throw new Error("unreachable");

    assert.equal(d5.step.unitId, "e2e-pipeline/report");

    // Context injection: report prompt should include content from analyze's produces
    assert.ok(
      d5.step.prompt.includes("Analysis Summary"),
      `Report prompt should include injected context from analyze artifact, got: "${d5.step.prompt.slice(0, 200)}"`,
    );

    // Parameter substitution: report prompt should contain "my-project"
    assert.ok(
      d5.step.prompt.includes("my-project"),
      `Report prompt should contain substituted param "my-project", got: "${d5.step.prompt}"`,
    );

    // Write report artifact
    writeFileSync(
      join(runDir, "output/report.md"),
      "# Final Report for my-project\n\nComprehensive findings documented.\n",
      "utf-8",
    );

    await reconcile(engine, "e2e-pipeline/report");

    // ── 6. Completion ─────────────────────────────────────────────────
    state = await engine.deriveState("/unused");
    assert.equal(state.isComplete, true, "Workflow should be complete after all steps");
    assert.equal(state.phase, "complete");

    // Dashboard: all steps complete
    meta = engine.getDisplayMetadata(state);
    assert.equal(meta.stepCount!.completed, 6, "All 6 dispatchable steps should be complete");
    assert.equal(meta.currentPhase, "complete");

    // Dispatch should return stop
    const { result: rFinal } = await dispatch(engine);
    const dFinal = await rFinal;
    assert.equal(dFinal.action, "stop");
    if (dFinal.action === "stop") {
      assert.equal(dFinal.reason, "All steps complete");
    }

    // Verify shell-command policy works on the scan step (parent, not instance)
    const shellVerify = await policy.verify("custom-step", "e2e-pipeline/scan", {
      basePath: "/unused",
    });
    assert.equal(
      shellVerify,
      "continue",
      "Shell-command verification (test -f output/scan-result.txt) should pass",
    );
  });

  describe("createRun + listRuns integration", () => {
    it("created run appears in listRuns with correct metadata", () => {
      const { basePath, runDir } = setupProject({ target: "list-test" });

      const runs = listRuns(basePath, "e2e-pipeline");
      assert.ok(runs.length >= 1, "Should list at least one run");

      const thisRun = runs.find((r) => r.runDir === runDir);
      assert.ok(thisRun, "Created run should appear in listRuns");
      assert.equal(thisRun.name, "e2e-pipeline");
      assert.equal(thisRun.status, "pending", "New run should have pending status");
      assert.equal(thisRun.steps.total, 4, "Should have 4 steps");
      assert.equal(thisRun.steps.completed, 0);
      assert.equal(thisRun.steps.pending, 4);
    });
  });

  describe("validateDefinition accepts the e2e definition", () => {
    it("validates the e2e-pipeline YAML as valid V1 schema", () => {
      const parsed = parse(E2E_DEFINITION_YAML);
      const { valid, errors } = validateDefinition(parsed);
      assert.equal(
        valid,
        true,
        `Definition should be valid but got errors: ${errors.join(", ")}`,
      );
      assert.deepStrictEqual(errors, []);
    });
  });
});
