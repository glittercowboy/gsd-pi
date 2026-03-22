/**
 * run-manager.test.ts — Tests for run directory creation and listing.
 *
 * Uses real temp directories with actual definition YAML files and
 * GRAPH.yaml persistence — no mocks.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

import { createRun, listRuns } from "../run-manager.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-mgr-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ }
  }
  tmpDirs.length = 0;
});

/** Write a minimal valid workflow definition YAML to the expected location. */
function writeDefinition(
  basePath: string,
  name: string,
  content: string,
): void {
  const defsDir = join(basePath, ".gsd", "workflow-defs");
  mkdirSync(defsDir, { recursive: true });
  writeFileSync(join(defsDir, `${name}.yaml`), content, "utf-8");
}

const SIMPLE_DEF = `
version: 1
name: test-workflow
description: A test workflow
steps:
  - id: step-1
    name: First Step
    prompt: Do step 1
    requires: []
    produces: []
  - id: step-2
    name: Second Step
    prompt: Do step 2
    requires:
      - step-1
    produces: []
`;

const PARAMETERIZED_DEF = `
version: 1
name: param-workflow
description: A parameterized workflow
params:
  target: default-target
steps:
  - id: step-1
    name: Build
    prompt: "Build {{target}}"
    requires: []
    produces: []
`;

// ─── createRun ───────────────────────────────────────────────────────────

describe("createRun", () => {
  it("creates directory structure with DEFINITION.yaml and GRAPH.yaml", () => {
    const base = makeTmpBase();
    writeDefinition(base, "test-workflow", SIMPLE_DEF);

    const runDir = createRun(base, "test-workflow");

    // Run directory exists
    assert.ok(existsSync(runDir), "run directory should exist");

    // DEFINITION.yaml exists and contains the definition
    const defPath = join(runDir, "DEFINITION.yaml");
    assert.ok(existsSync(defPath), "DEFINITION.yaml should exist");
    const defContent = parse(readFileSync(defPath, "utf-8"));
    assert.equal(defContent.name, "test-workflow");
    assert.equal(defContent.steps.length, 2);

    // GRAPH.yaml exists with all steps pending
    const graphPath = join(runDir, "GRAPH.yaml");
    assert.ok(existsSync(graphPath), "GRAPH.yaml should exist");
    const graphContent = parse(readFileSync(graphPath, "utf-8"));
    assert.equal(graphContent.steps.length, 2);
    assert.equal(graphContent.steps[0].status, "pending");
    assert.equal(graphContent.steps[1].status, "pending");
    assert.equal(graphContent.metadata.name, "test-workflow");

    // No PARAMS.json without overrides
    assert.ok(!existsSync(join(runDir, "PARAMS.json")), "PARAMS.json should not exist without overrides");

    // Run directory path matches convention
    assert.ok(runDir.includes(join(".gsd", "workflow-runs", "test-workflow")), "path should follow convention");
  });

  it("writes PARAMS.json and substituted prompts when overrides provided", () => {
    const base = makeTmpBase();
    writeDefinition(base, "param-workflow", PARAMETERIZED_DEF);

    const runDir = createRun(base, "param-workflow", { target: "my-app" });

    // PARAMS.json exists with overrides
    const paramsPath = join(runDir, "PARAMS.json");
    assert.ok(existsSync(paramsPath), "PARAMS.json should exist");
    const params = JSON.parse(readFileSync(paramsPath, "utf-8"));
    assert.deepStrictEqual(params, { target: "my-app" });

    // DEFINITION.yaml has substituted prompts
    const defPath = join(runDir, "DEFINITION.yaml");
    const defContent = parse(readFileSync(defPath, "utf-8"));
    assert.equal(defContent.steps[0].prompt, "Build my-app");

    // GRAPH.yaml also has substituted prompts
    const graphPath = join(runDir, "GRAPH.yaml");
    const graphContent = parse(readFileSync(graphPath, "utf-8"));
    assert.equal(graphContent.steps[0].prompt, "Build my-app");
  });

  it("throws for unknown definition", () => {
    const base = makeTmpBase();
    // Don't write any definition file

    assert.throws(
      () => createRun(base, "nonexistent"),
      (err: Error) => err.message.includes("not found"),
    );
  });

  it("uses filesystem-safe timestamp directory names", () => {
    const base = makeTmpBase();
    writeDefinition(base, "test-workflow", SIMPLE_DEF);

    const runDir = createRun(base, "test-workflow");

    // Extract the timestamp directory name (use path.sep for cross-platform)
    const timestamp = runDir.split(/[/\\]/).pop()!;

    // Should not contain colons (filesystem-unsafe on Windows)
    assert.ok(!timestamp.includes(":"), `timestamp should not contain colons: ${timestamp}`);
    // Should match YYYY-MM-DDTHH-MM-SS pattern
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});

// ─── listRuns ────────────────────────────────────────────────────────────

describe("listRuns", () => {
  it("returns empty array when no runs exist", () => {
    const base = makeTmpBase();
    const runs = listRuns(base);
    assert.deepStrictEqual(runs, []);
  });

  it("returns correct metadata for existing runs", () => {
    const base = makeTmpBase();
    writeDefinition(base, "test-workflow", SIMPLE_DEF);

    // Create a run
    const runDir = createRun(base, "test-workflow");

    const runs = listRuns(base);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].name, "test-workflow");
    assert.equal(runs[0].runDir, runDir);
    assert.equal(runs[0].steps.total, 2);
    assert.equal(runs[0].steps.completed, 0);
    assert.equal(runs[0].steps.pending, 2);
    assert.equal(runs[0].steps.active, 0);
    assert.equal(runs[0].status, "pending");
  });

  it("filters by definition name", () => {
    const base = makeTmpBase();
    writeDefinition(base, "test-workflow", SIMPLE_DEF);
    writeDefinition(base, "param-workflow", PARAMETERIZED_DEF);

    createRun(base, "test-workflow");
    createRun(base, "param-workflow", { target: "app" });

    const allRuns = listRuns(base);
    assert.equal(allRuns.length, 2);

    const filtered = listRuns(base, "test-workflow");
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, "test-workflow");
  });

  it("returns newest-first within same definition", () => {
    const base = makeTmpBase();
    writeDefinition(base, "test-workflow", SIMPLE_DEF);

    const run1 = createRun(base, "test-workflow");
    // Ensure different timestamp by creating run dir manually with earlier timestamp
    const earlyDir = join(base, ".gsd", "workflow-runs", "test-workflow", "2020-01-01T00-00-00");
    mkdirSync(earlyDir, { recursive: true });
    // Copy GRAPH.yaml to make it a valid run
    const graphContent = readFileSync(join(run1, "GRAPH.yaml"), "utf-8");
    writeFileSync(join(earlyDir, "GRAPH.yaml"), graphContent, "utf-8");

    const runs = listRuns(base, "test-workflow");
    assert.equal(runs.length, 2);
    // First should be the newer one (the one we just created)
    assert.ok(runs[0].timestamp > runs[1].timestamp, "should be sorted newest-first");
  });
});
