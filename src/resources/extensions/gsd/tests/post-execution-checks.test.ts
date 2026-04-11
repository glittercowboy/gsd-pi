/**
 * post-execution-checks.test.ts — Unit tests for post-execution validation checks.
 *
 * Tests all 3 check types:
 *   1. Import resolution — verify relative imports resolve to existing files
 *   2. Cross-task signatures — detect signature drift and hallucination cascades
 *   3. Pattern consistency — async style drift, naming convention warnings
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  extractRelativeImports,
  resolveImportPath,
  checkImportResolution,
  checkCrossTaskSignatures,
  checkPatternConsistency,
  runPostExecutionChecks,
  type PostExecutionResult,
} from "../post-execution-checks.ts";
import type { TaskRow } from "../gsd-db.ts";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

/**
 * Create a minimal TaskRow for testing.
 */
function createTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    milestone_id: "M001",
    slice_id: "S01",
    id: overrides.id ?? "T01",
    title: "Test Task",
    status: "complete",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: new Date().toISOString(),
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: overrides.key_files ?? [],
    key_decisions: [],
    full_summary_md: "",
    description: overrides.description ?? "",
    estimate: "",
    files: overrides.files ?? [],
    verify: "",
    inputs: overrides.inputs ?? [],
    expected_output: overrides.expected_output ?? [],
    observability_impact: "",
    full_plan_md: "",
    sequence: overrides.sequence ?? 0,
    ...overrides,
  };
}

// ─── Import Extraction Tests ─────────────────────────────────────────────────

describe("extractRelativeImports", () => {
  test("extracts import ... from statements", () => {
    const source = `
import { foo } from './utils';
import bar from "../helpers/bar";
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    assert.ok(imports.some((i) => i.importPath === "./utils"));
    assert.ok(imports.some((i) => i.importPath === "../helpers/bar"));
  });

  test("extracts side-effect imports", () => {
    const source = `import './polyfill';`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].importPath, "./polyfill");
  });

  test("extracts require statements", () => {
    const source = `
const utils = require('./utils');
const { bar } = require("../helpers/bar");
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    assert.ok(imports.some((i) => i.importPath === "./utils"));
    assert.ok(imports.some((i) => i.importPath === "../helpers/bar"));
  });

  test("ignores non-relative imports", () => {
    const source = `
import express from 'express';
import { readFile } from 'node:fs';
const lodash = require('lodash');
    `;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 0);
  });

  test("reports correct line numbers", () => {
    const source = `// comment
import { a } from './a';
// another comment
import { b } from './b';
`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
    const importA = imports.find((i) => i.importPath === "./a");
    const importB = imports.find((i) => i.importPath === "./b");
    assert.equal(importA?.lineNum, 2);
    assert.equal(importB?.lineNum, 4);
  });

  test("handles multiple imports on same line", () => {
    const source = `import a from './a'; import b from './b';`;
    const imports = extractRelativeImports(source);
    assert.equal(imports.length, 2);
  });

  test("handles empty source", () => {
    const imports = extractRelativeImports("");
    assert.deepEqual(imports, []);
  });
});

// ─── Import Resolution Tests ─────────────────────────────────────────────────

describe("resolveImportPath", () => {
  let tempDir: string;

  test("resolves file with exact extension", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(join(tempDir, "src", "main.ts"), "import { a } from './utils';");

    try {
      const result = resolveImportPath("./utils", "src/main.ts", tempDir);
      assert.ok(result.exists);
      assert.ok(result.resolvedPath?.endsWith("utils.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves file without extension", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "helpers.js"), "module.exports = {};");
    writeFileSync(join(tempDir, "src", "index.ts"), "");

    try {
      const result = resolveImportPath("./helpers", "src/index.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves directory index file", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src", "utils"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils", "index.ts"), "export {};");
    writeFileSync(join(tempDir, "src", "main.ts"), "");

    try {
      const result = resolveImportPath("./utils", "src/main.ts", tempDir);
      assert.ok(result.exists);
      assert.ok(result.resolvedPath?.endsWith("index.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolves parent directory imports", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src", "nested"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export {};");
    writeFileSync(join(tempDir, "src", "nested", "child.ts"), "");

    try {
      const result = resolveImportPath("../utils", "src/nested/child.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fails for non-existent file", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "main.ts"), "");

    try {
      const result = resolveImportPath("./nonexistent", "src/main.ts", tempDir);
      assert.ok(!result.exists);
      assert.equal(result.resolvedPath, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles explicit extension in import", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "data.json"), "{}");
    writeFileSync(join(tempDir, "src", "main.ts"), "");

    try {
      const result = resolveImportPath("./data.json", "src/main.ts", tempDir);
      assert.ok(result.exists);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Import Resolution Check Tests ───────────────────────────────────────────

describe("checkImportResolution", () => {
  let tempDir: string;

  test("passes when all imports resolve", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './utils';"
    );

    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/main.ts"],
      });

      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fails when import doesn't resolve", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './nonexistent';"
    );

    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/main.ts"],
      });

      const results = checkImportResolution(task, [], tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "import");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, true);
      assert.ok(results[0].message.includes("nonexistent"));
      assert.ok(results[0].target.includes("src/main.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("skips non-JS/TS files", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "README.md"), "# Docs");

    try {
      const task = createTask({
        id: "T01",
        key_files: ["README.md"],
      });

      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles multiple files with multiple imports", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "a.ts"),
      "import { a } from './utils';\nimport { b } from './missing';"
    );
    writeFileSync(
      join(tempDir, "src", "b.ts"),
      "import { x } from './also-missing';"
    );

    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/a.ts", "src/b.ts"],
      });

      const results = checkImportResolution(task, [], tempDir);
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.message.includes("missing")));
      assert.ok(results.some((r) => r.message.includes("also-missing")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("skips if key_file doesn't exist", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const task = createTask({
        id: "T01",
        key_files: ["src/deleted.ts"],
      });

      const results = checkImportResolution(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Cross-Task Signature Tests ──────────────────────────────────────────────

describe("checkCrossTaskSignatures", () => {
  let tempDir: string;

  test("passes when no prior tasks exist", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function getData(): string { return ''; }"
    );

    try {
      const task = createTask({
        id: "T02",
        key_files: ["src/api.ts"],
      });

      const results = checkCrossTaskSignatures(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("passes when signatures match", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function process(data: string): boolean { return true; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function process(data: string): boolean { return false; }"
    );

    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"],
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"],
      });

      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("warns on parameter mismatch (non-blocking)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function save(name: string): void {}"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function save(name: string, id: number): void {}"
    );

    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"],
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"],
      });

      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "signature");
      assert.equal(results[0].target, "save");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, false);
      assert.ok(results[0].message.includes("parameters"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("warns on return type mismatch (non-blocking)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function fetch(): string { return ''; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      "export function fetch(): number { return 0; }"
    );

    try {
      const priorTask = createTask({
        id: "T01",
        key_files: ["src/utils.ts"],
      });
      const currentTask = createTask({
        id: "T02",
        key_files: ["src/api.ts"],
      });

      const results = checkCrossTaskSignatures(currentTask, [priorTask], tempDir);
      assert.equal(results.length, 1);
      assert.ok(results[0].message.includes("return"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles multiple prior tasks", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "types.ts"),
      "export function parse(s: string): object { return {}; }"
    );
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function validate(x: object): boolean { return true; }"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `export function parse(s: number): object { return {}; }
       export function validate(x: object): boolean { return true; }`
    );

    try {
      const priorTask1 = createTask({ id: "T01", key_files: ["src/types.ts"] });
      const priorTask2 = createTask({ id: "T02", key_files: ["src/utils.ts"] });
      const currentTask = createTask({ id: "T03", key_files: ["src/api.ts"] });

      const results = checkCrossTaskSignatures(
        currentTask,
        [priorTask1, priorTask2],
        tempDir
      );
      // Should have 1 warning for parse() parameter mismatch
      assert.equal(results.length, 1);
      assert.ok(results[0].message.includes("parse"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Pattern Consistency Tests ───────────────────────────────────────────────

describe("checkPatternConsistency", () => {
  let tempDir: string;

  test("passes when async style is consistent (await only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `async function getData(): Promise<string> {
        const result = await fetch('/api');
        return await result.text();
      }`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("passes when async style is consistent (.then only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getData(): Promise<string> {
        return fetch('/api').then(r => r.text());
      }`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("warns when mixing async/await with .then()", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `async function getData(): Promise<string> {
        const result = await fetch('/api');
        return result.text().then(t => t.toUpperCase());
      }`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const asyncResults = results.filter((r) => r.message.includes("async"));
      assert.equal(asyncResults.length, 1);
      assert.equal(asyncResults[0].category, "pattern");
      assert.equal(asyncResults[0].passed, true); // Warning only
      assert.equal(asyncResults[0].blocking, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("passes when naming is consistent (camelCase only)", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getUserData() {}
       const processItems = () => {};
       function validateInput() {}`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const namingResults = results.filter((r) => r.message.includes("naming") || r.message.includes("Case"));
      assert.equal(namingResults.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("warns when mixing camelCase and snake_case", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      join(tempDir, "api.ts"),
      `function getUserData() {}
       function process_items() {}
       const validate_input = () => {};`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["api.ts"] });
      const results = checkPatternConsistency(task, [], tempDir);
      const namingResults = results.filter((r) => r.message.includes("camelCase") || r.message.includes("snake_case"));
      assert.equal(namingResults.length, 1);
      assert.equal(namingResults[0].category, "pattern");
      assert.equal(namingResults[0].blocking, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("skips non-JS/TS files", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "config.json"), '{"key": "value"}');

    try {
      const task = createTask({ id: "T01", key_files: ["config.json"] });
      const results = checkPatternConsistency(task, [], tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── runPostExecutionChecks Integration Tests ────────────────────────────────

describe("runPostExecutionChecks", () => {
  let tempDir: string;

  test("returns pass status when all checks pass", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "utils.ts"), "export const a = 1;");
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      `import { a } from './utils';
       function processData(): void {}`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "pass");
      assert.equal(result.checks.length, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns fail status when blocking failure exists", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './nonexistent';"
    );

    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "fail");
      assert.ok(result.checks.length > 0);
      assert.ok(result.checks.some((c) => c.blocking === true));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns warn status for non-blocking issues only", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `async function getData() {
        const result = await fetch('/api');
        return result.text().then(t => t);
      }`
    );

    try {
      const task = createTask({ id: "T01", key_files: ["src/api.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "warn");
      assert.ok(result.checks.some((c) => c.category === "pattern"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("combines results from all check types", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "utils.ts"),
      "export function process(s: string): void {}"
    );
    writeFileSync(
      join(tempDir, "src", "api.ts"),
      `import { x } from './missing';
       async function getData() {
         await fetch('/api');
         return fetch('/api2').then(r => r);
       }
       export function process(n: number): void {}`
    );

    try {
      const priorTask = createTask({ id: "T01", key_files: ["src/utils.ts"] });
      const currentTask = createTask({ id: "T02", key_files: ["src/api.ts"] });

      const result = runPostExecutionChecks(currentTask, [priorTask], tempDir);
      assert.equal(result.status, "fail"); // Import failure is blocking

      const categories = new Set(result.checks.map((c) => c.category));
      assert.ok(categories.has("import")); // From unresolved import
      assert.ok(categories.has("signature")); // From signature mismatch
      assert.ok(categories.has("pattern")); // From async style drift
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reports duration in milliseconds", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.ok(typeof result.durationMs === "number");
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles empty key_files array", () => {
    tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.equal(result.status, "pass");
      assert.deepEqual(result.checks, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── PostExecutionResult Type Tests ──────────────────────────────────────────

describe("PostExecutionResult type", () => {
  test("status is one of pass, warn, fail", () => {
    const tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const task = createTask({ id: "T01", key_files: [] });
      const result = runPostExecutionChecks(task, [], tempDir);
      assert.ok(["pass", "warn", "fail"].includes(result.status));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("checks array matches PostExecutionCheckJSON schema", () => {
    const tempDir = join(tmpdir(), `post-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "main.ts"),
      "import { a } from './missing';"
    );

    try {
      const task = createTask({ id: "T01", key_files: ["src/main.ts"] });
      const result = runPostExecutionChecks(task, [], tempDir);

      for (const check of result.checks) {
        assert.ok(
          ["import", "signature", "pattern"].includes(check.category),
          `Invalid category: ${check.category}`
        );
        assert.ok(typeof check.target === "string");
        assert.ok(typeof check.passed === "boolean");
        assert.ok(typeof check.message === "string");
        if (check.blocking !== undefined) {
          assert.ok(typeof check.blocking === "boolean");
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
