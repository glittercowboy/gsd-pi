/**
 * Unit tests for definition-loader.ts.
 *
 * Covers V1 YAML schema validation (valid + various rejection cases),
 * filesystem loading, snake_case → camelCase conversion, forward
 * compatibility with unknown fields, parameter substitution, and the
 * four gap validations (duplicate IDs, dangling deps, self-deps, cycles).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadDefinition,
  validateDefinition,
  substituteParams,
  substitutePromptString,
} from "../definition-loader.ts";
import type { WorkflowDefinition } from "../definition-loader.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-defloader-test-"));
}

/** Write a YAML string into a temp definitions directory. Returns the dir path. */
function writeDefYaml(yaml: string, name = "test-workflow"): string {
  const dir = makeTmpDir();
  writeFileSync(join(dir, `${name}.yaml`), yaml, "utf-8");
  return dir;
}

const VALID_3STEP_YAML = `
version: 1
name: "test-workflow"
description: "A test workflow"
params:
  topic: "AI"
steps:
  - id: research
    name: "Research the topic"
    prompt: "Research {{topic}} and write findings to research.md"
    requires: []
    produces:
      - research.md
  - id: outline
    name: "Create outline"
    prompt: "Based on research.md, create an outline in outline.md"
    requires: [research]
    produces:
      - outline.md
  - id: draft
    name: "Write draft"
    prompt: "Write a draft based on outline.md"
    requires: [outline]
    produces:
      - draft.md
`;

// ─── loadDefinition: valid YAML ──────────────────────────────────────────

test("loadDefinition: valid 3-step YAML returns correct structure", (t) => {
  const dir = writeDefYaml(VALID_3STEP_YAML);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");

  assert.equal(def.version, 1);
  assert.equal(def.name, "test-workflow");
  assert.equal(def.description, "A test workflow");
  assert.deepEqual(def.params, { topic: "AI" });
  assert.equal(def.steps.length, 3);

  // Step 1: research
  assert.equal(def.steps[0].id, "research");
  assert.equal(def.steps[0].name, "Research the topic");
  assert.equal(def.steps[0].prompt, "Research {{topic}} and write findings to research.md");
  assert.deepEqual(def.steps[0].requires, []);
  assert.deepEqual(def.steps[0].produces, ["research.md"]);

  // Step 2: outline — depends on research
  assert.equal(def.steps[1].id, "outline");
  assert.deepEqual(def.steps[1].requires, ["research"]);

  // Step 3: draft — depends on outline
  assert.equal(def.steps[2].id, "draft");
  assert.deepEqual(def.steps[2].requires, ["outline"]);
  assert.deepEqual(def.steps[2].produces, ["draft.md"]);
});

// ─── validateDefinition: rejection cases ─────────────────────────────────

test("validateDefinition: missing version → error", () => {
  const result = validateDefinition({
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("validateDefinition: version 2 (unsupported) → error", () => {
  const result = validateDefinition({
    version: 2,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unsupported version: 2")));
});

test("validateDefinition: missing step id → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ name: "A", prompt: "do A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("id")));
});

test("validateDefinition: missing step prompt → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("prompt")));
});

test("validateDefinition: produces with '..' path traversal → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A", produces: ["../secret.txt"] }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("..") && e.includes("produces")));
});

test("validateDefinition: unknown fields (context_from, iterate) → accepted silently", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    future_top_level_field: true,
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      context_from: ["other-step"],
      iterate: { source: "file.md", pattern: "^## (.+)" },
      some_future_field: 42,
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: collects multiple errors in one pass", () => {
  const result = validateDefinition({
    // missing version and name
    steps: [
      { id: "a" }, // missing name and prompt
      { name: "B", prompt: "do B" }, // missing id
    ],
  });
  assert.equal(result.valid, false);
  // Should have errors for: version, name, step 0 name, step 0 prompt, step 1 id
  assert.ok(result.errors.length >= 4, `Expected ≥4 errors, got ${result.errors.length}: ${result.errors.join("; ")}`);
});

test("validateDefinition: null input → error", () => {
  const result = validateDefinition(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("non-null object")));
});

test("validateDefinition: empty steps array → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("at least one step")));
});

test("validateDefinition: missing name → error", () => {
  const result = validateDefinition({
    version: 1,
    steps: [{ id: "a", name: "A", prompt: "do A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("validateDefinition: step is not an object → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: ["not-an-object"],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("not an object")));
});

test("validateDefinition: missing step name → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", prompt: "do A" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("index 0") && e.includes("name")));
});

// ─── loadDefinition: error cases ─────────────────────────────────────────

test("loadDefinition: missing file → descriptive error", (t) => {
  const dir = makeTmpDir();
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  assert.throws(
    () => loadDefinition(dir, "nonexistent"),
    (err: Error) => {
      assert.ok(err.message.includes("not found"));
      assert.ok(err.message.includes("nonexistent.yaml"));
      return true;
    },
  );
});

test("loadDefinition: invalid YAML schema → descriptive error", (t) => {
  const dir = writeDefYaml(`
version: 2
name: "bad"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  assert.throws(
    () => loadDefinition(dir, "test-workflow"),
    (err: Error) => {
      assert.ok(err.message.includes("Invalid workflow definition"));
      assert.ok(err.message.includes("Unsupported version"));
      return true;
    },
  );
});

// ─── loadDefinition: snake_case → camelCase conversion ───────────────────

test("loadDefinition: depends_on in YAML maps to requires in TypeScript", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "dep-test"
steps:
  - id: first
    name: "First"
    prompt: "do first"
  - id: second
    name: "Second"
    prompt: "do second"
    depends_on: [first]
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[1].requires, ["first"]);
});

test("loadDefinition: context_from in YAML maps to contextFrom in TypeScript", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "ctx-test"
steps:
  - id: first
    name: "First"
    prompt: "do first"
  - id: second
    name: "Second"
    prompt: "do second"
    context_from: [first]
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[1].contextFrom, ["first"]);
});

// ─── validateDefinition: iterate field validation ────────────────────────

test("validateDefinition: valid iterate config accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "outline.md", pattern: "^## (.+)" },
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: iterate missing source → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { pattern: "^## (.+)" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("source")));
});

test("validateDefinition: iterate source with .. → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "../escape.md", pattern: "(.+)" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("path traversal") || e.includes("..")));
});

test("validateDefinition: iterate invalid regex → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "f.md", pattern: "[invalid" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("regex")));
});

test("validateDefinition: iterate pattern without capture group → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      iterate: { source: "f.md", pattern: "^## .+" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("capture group")));
});

// ─── validateDefinition: verify field validation ─────────────────────────

test("validateDefinition: valid content-heuristic verify → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "content-heuristic", minSize: 100, pattern: "^## " },
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: valid shell-command verify → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "shell-command", command: "cat output.md | grep '^## '" },
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: valid prompt-verify → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "prompt-verify", prompt: "Does the output contain at least 3 sections?" },
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: valid human-review verify → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "human-review" },
    }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: invalid verify policy name → rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "magic-check" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("verify.policy must be one of")));
});

test("validateDefinition: shell-command missing command → rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "shell-command" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requires a non-empty "command"')));
});

test("validateDefinition: prompt-verify missing prompt → rejected", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{
      id: "a",
      name: "A",
      prompt: "do A",
      verify: { policy: "prompt-verify" },
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('requires a non-empty "prompt"')));
});

// ─── Gap validations: duplicate IDs ──────────────────────────────────────

test("validateDefinition: duplicate step IDs → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "dup", name: "A", prompt: "do A" },
      { id: "dup", name: "B", prompt: "do B" },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Duplicate step id")));
  assert.ok(result.errors.some((e) => e.includes("dup")));
});

// ─── Gap validations: dangling dependencies ──────────────────────────────

test("validateDefinition: dangling dependency → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["nonexistent"] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("requires unknown step")));
  assert.ok(result.errors.some((e) => e.includes("nonexistent")));
});

test("validateDefinition: dangling dependency via depends_on → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", depends_on: ["ghost"] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("requires unknown step")));
  assert.ok(result.errors.some((e) => e.includes("ghost")));
});

// ─── Gap validations: self-referencing dependencies ──────────────────────

test("validateDefinition: self-referencing dependency → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["a"] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("depends on itself")));
});

// ─── Gap validations: cycle detection ────────────────────────────────────

test("validateDefinition: simple cycle (A→B→A) → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["b"] },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Cycle detected")));
});

test("validateDefinition: complex cycle (A→B→C→A) → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A", requires: ["c"] },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["b"] },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Cycle detected")));
});

test("validateDefinition: diamond dependency (no cycle) → accepted", () => {
  // A→B, A→C, B→D, C→D — classic diamond, no cycle
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["a"] },
      { id: "d", name: "D", prompt: "do D", requires: ["b", "c"] },
    ],
  });
  assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

test("validateDefinition: linear chain (no cycle) → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "do A" },
      { id: "b", name: "B", prompt: "do B", requires: ["a"] },
      { id: "c", name: "C", prompt: "do C", requires: ["b"] },
      { id: "d", name: "D", prompt: "do D", requires: ["c"] },
    ],
  });
  assert.equal(result.valid, true);
});

// ─── substituteParams ────────────────────────────────────────────────────

test("substituteParams: replaces placeholders with defaults", () => {
  const def: WorkflowDefinition = {
    version: 1,
    name: "test",
    params: { topic: "AI", format: "markdown" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}} in {{format}}", requires: [], produces: [] },
    ],
  };
  const result = substituteParams(def);
  assert.equal(result.steps[0].prompt, "Write about AI in markdown");
});

test("substituteParams: overrides win over defaults", () => {
  const def: WorkflowDefinition = {
    version: 1,
    name: "test",
    params: { topic: "AI" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] },
    ],
  };
  const result = substituteParams(def, { topic: "Robotics" });
  assert.equal(result.steps[0].prompt, "Write about Robotics");
});

test("substituteParams: rejects values containing '..'", () => {
  const def: WorkflowDefinition = {
    version: 1,
    name: "test",
    params: { path: "safe" },
    steps: [
      { id: "a", name: "A", prompt: "Read {{path}}", requires: [], produces: [] },
    ],
  };
  assert.throws(
    () => substituteParams(def, { path: "../etc/passwd" }),
    (err: Error) => {
      assert.ok(err.message.includes(".."));
      assert.ok(err.message.includes("path traversal"));
      return true;
    },
  );
});

test("substituteParams: errors on unresolved placeholders", () => {
  const def: WorkflowDefinition = {
    version: 1,
    name: "test",
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] },
    ],
  };
  assert.throws(
    () => substituteParams(def),
    (err: Error) => {
      assert.ok(err.message.includes("Unresolved"));
      assert.ok(err.message.includes("topic"));
      return true;
    },
  );
});

test("substituteParams: does not mutate the original definition", () => {
  const def: WorkflowDefinition = {
    version: 1,
    name: "test",
    params: { topic: "AI" },
    steps: [
      { id: "a", name: "A", prompt: "Write about {{topic}}", requires: [], produces: [] },
    ],
  };
  const original = def.steps[0].prompt;
  substituteParams(def);
  assert.equal(def.steps[0].prompt, original, "Original definition should not be mutated");
});

// ─── substitutePromptString ──────────────────────────────────────────────

test("substitutePromptString: replaces known placeholders, leaves unknown", () => {
  const result = substitutePromptString(
    "Hello {{name}}, write about {{topic}}",
    { name: "Agent" },
  );
  assert.equal(result, "Hello Agent, write about {{topic}}");
});

test("substitutePromptString: no placeholders → unchanged", () => {
  const result = substitutePromptString("No placeholders here", {});
  assert.equal(result, "No placeholders here");
});

// ─── Edge cases ──────────────────────────────────────────────────────────

test("validateDefinition: steps is not an array → error", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: "not-an-array",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("steps") && e.includes("array")));
});

test("validateDefinition: valid minimal step (no requires/produces) → accepted", () => {
  const result = validateDefinition({
    version: 1,
    name: "test",
    steps: [{ id: "a", name: "A", prompt: "do A" }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("loadDefinition: loads without params field → params is undefined", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "no-params"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");
  assert.equal(def.params, undefined);
});

test("loadDefinition: loads without description → description is undefined", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "no-desc"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");
  assert.equal(def.description, undefined);
});

test("loadDefinition: step with no requires/produces defaults to empty arrays", (t) => {
  const dir = writeDefYaml(`
version: 1
name: "defaults"
steps:
  - id: a
    name: "A"
    prompt: "do A"
`);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Windows EPERM */ } });

  const def = loadDefinition(dir, "test-workflow");
  assert.deepEqual(def.steps[0].requires, []);
  assert.deepEqual(def.steps[0].produces, []);
});
