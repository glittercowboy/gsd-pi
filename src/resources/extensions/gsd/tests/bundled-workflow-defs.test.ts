/**
 * Bundled workflow definition validation tests.
 *
 * Verifies that every example YAML in src/resources/skills/create-workflow/templates/
 * passes validateDefinition() from definition-loader.ts with { valid: true, errors: [] }.
 *
 * Also validates scaffold template and structural properties of each example
 * (step counts, feature usage) to guard against accidental regressions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { validateDefinition } from "../definition-loader.ts";

// ─── Path resolution ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// Navigate from tests/ → extensions/gsd/ → extensions/ → resources/ → skills/create-workflow/templates/
const templatesDir = join(
  __dirname,
  "..",
  "..",
  "..",
  "skills",
  "create-workflow",
  "templates",
);

function loadYaml(filename: string): unknown {
  const raw = readFileSync(join(templatesDir, filename), "utf-8");
  return parse(raw);
}

// ─── Scaffold template ──────────────────────────────────────────────────

test("scaffold template (workflow-definition.yaml) passes validation", () => {
  const parsed = loadYaml("workflow-definition.yaml");
  const result = validateDefinition(parsed);
  assert.equal(result.valid, true, `Scaffold invalid: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

// ─── blog-post-pipeline.yaml ────────────────────────────────────────────

test("blog-post-pipeline.yaml passes validation", () => {
  const parsed = loadYaml("blog-post-pipeline.yaml");
  const result = validateDefinition(parsed);
  assert.equal(result.valid, true, `Invalid: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

test("blog-post-pipeline.yaml: 3 steps, context_from, params, content-heuristic", () => {
  const parsed = loadYaml("blog-post-pipeline.yaml") as Record<string, unknown>;
  const steps = parsed.steps as Array<Record<string, unknown>>;

  // 3 steps
  assert.equal(steps.length, 3, "Expected 3 steps");

  // params defined
  assert.ok(parsed.params, "Expected params to be defined");
  const params = parsed.params as Record<string, string>;
  assert.ok("topic" in params, "Expected 'topic' param");
  assert.ok("audience" in params, "Expected 'audience' param");

  // At least one step uses context_from
  const hasContextFrom = steps.some(
    (s) => Array.isArray(s.context_from) && s.context_from.length > 0,
  );
  assert.ok(hasContextFrom, "Expected at least one step with context_from");

  // All steps use content-heuristic verify
  for (const step of steps) {
    const verify = step.verify as Record<string, unknown> | undefined;
    assert.ok(verify, `Step "${step.id}" missing verify`);
    assert.equal(verify.policy, "content-heuristic", `Step "${step.id}" should use content-heuristic`);
  }
});

// ─── code-audit.yaml ────────────────────────────────────────────────────

test("code-audit.yaml passes validation", () => {
  const parsed = loadYaml("code-audit.yaml");
  const result = validateDefinition(parsed);
  assert.equal(result.valid, true, `Invalid: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

test("code-audit.yaml: iterate with capture group and shell-command verify", () => {
  const parsed = loadYaml("code-audit.yaml") as Record<string, unknown>;
  const steps = parsed.steps as Array<Record<string, unknown>>;

  // Find step with iterate
  const iterateStep = steps.find((s) => s.iterate != null);
  assert.ok(iterateStep, "Expected a step with iterate config");

  const iterate = iterateStep.iterate as Record<string, unknown>;
  assert.equal(typeof iterate.source, "string", "iterate.source must be a string");
  assert.equal(typeof iterate.pattern, "string", "iterate.pattern must be a string");

  // Pattern has a capture group
  const pattern = iterate.pattern as string;
  assert.ok(/\((?!\?)/.test(pattern), "iterate.pattern must contain a capture group");

  // Pattern is valid regex
  assert.doesNotThrow(() => new RegExp(pattern), "iterate.pattern must be valid regex");

  // Has shell-command verify
  const verify = iterateStep.verify as Record<string, unknown>;
  assert.equal(verify.policy, "shell-command");
  assert.equal(typeof verify.command, "string");
});

// ─── release-checklist.yaml ─────────────────────────────────────────────

test("release-checklist.yaml passes validation", () => {
  const parsed = loadYaml("release-checklist.yaml");
  const result = validateDefinition(parsed);
  assert.equal(result.valid, true, `Invalid: ${result.errors.join("; ")}`);
  assert.equal(result.errors.length, 0);
});

test("release-checklist.yaml: diamond dependencies and human-review", () => {
  const parsed = loadYaml("release-checklist.yaml") as Record<string, unknown>;
  const steps = parsed.steps as Array<Record<string, unknown>>;

  // 4 steps
  assert.equal(steps.length, 4, "Expected 4 steps");

  // Diamond pattern: two steps depend on the same parent
  const changelog = steps.find((s) => s.id === "changelog");
  const versionBump = steps.find((s) => s.id === "version-bump");
  const testSuite = steps.find((s) => s.id === "test-suite");
  const publish = steps.find((s) => s.id === "publish");

  assert.ok(changelog, "Expected 'changelog' step");
  assert.ok(versionBump, "Expected 'version-bump' step");
  assert.ok(testSuite, "Expected 'test-suite' step");
  assert.ok(publish, "Expected 'publish' step");

  // Both version-bump and test-suite depend on changelog
  const vbReqs = versionBump.requires as string[];
  const tsReqs = testSuite.requires as string[];
  assert.ok(vbReqs.includes("changelog"), "version-bump should require changelog");
  assert.ok(tsReqs.includes("changelog"), "test-suite should require changelog");

  // publish depends on both (diamond join)
  const pubReqs = publish.requires as string[];
  assert.ok(pubReqs.includes("version-bump"), "publish should require version-bump");
  assert.ok(pubReqs.includes("test-suite"), "publish should require test-suite");

  // publish uses human-review
  const verify = publish.verify as Record<string, unknown>;
  assert.equal(verify.policy, "human-review");
});

// ─── Cross-cutting: no path traversal in produces ───────────────────────

test("no produces path contains '..'", () => {
  const files = [
    "blog-post-pipeline.yaml",
    "code-audit.yaml",
    "release-checklist.yaml",
  ];

  for (const file of files) {
    const parsed = loadYaml(file) as Record<string, unknown>;
    const steps = parsed.steps as Array<Record<string, unknown>>;
    for (const step of steps) {
      const produces = (step.produces as string[]) ?? [];
      for (const p of produces) {
        assert.ok(!p.includes(".."), `${file} step "${step.id}" produces path contains '..': ${p}`);
      }
    }
  }
});
