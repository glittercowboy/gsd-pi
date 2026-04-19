/**
 * pre-execution-checks.test.ts — Unit tests for pre-execution validation checks.
 *
 * Tests all 4 check types:
 *   1. Package existence — npm view mocking, timeout handling
 *   2. File path consistency — files exist vs prior expected_output
 *   3. Task ordering — detect impossible read-before-create
 *   4. Interface contracts — contradictory function signatures
 */

import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  extractPackageReferences,
  checkFilePathConsistency,
  checkTaskOrdering,
  checkInterfaceContracts,
  runPreExecutionChecks,
  normalizeFilePath,
  type PreExecutionResult,
} from "../pre-execution-checks.ts";
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
    status: "pending",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: null,
    blocker_discovered: false,
    deviations: "",
    known_issues: "",
    key_files: [],
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
    blocker_source: "",
    escalation_pending: 0,
    escalation_awaiting_review: 0,
    escalation_artifact_path: null,
    escalation_override_applied_at: null,
    ...overrides,
  };
}

// ─── Package Reference Extraction Tests ──────────────────────────────────────

describe("extractPackageReferences", () => {
  test("extracts npm install patterns", () => {
    const desc = "Run npm install lodash then npm i axios";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages.sort(), ["axios", "lodash"]);
  });

  test("extracts yarn add patterns", () => {
    const desc = "yarn add react-dom";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, ["react-dom"]);
  });

  test("extracts scoped packages", () => {
    const desc = "npm install @types/node @babel/core";
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("@types/node"));
    assert.ok(packages.includes("@babel/core"));
  });

  test("extracts require statements from code blocks", () => {
    const desc = `
\`\`\`javascript
const fs = require('fs-extra');
const path = require('path');
\`\`\`
    `;
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("fs-extra"));
  });

  test("extracts import statements from code blocks", () => {
    const desc = `
\`\`\`typescript
import express from 'express';
import { Router } from 'express';
import type { Request } from 'express';
\`\`\`
    `;
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("express"));
  });

  test("ignores relative imports", () => {
    const desc = `import { foo } from './local-file';`;
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, []);
  });

  test("ignores node builtins", () => {
    const desc = `import fs from 'node:fs';`;
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, []);
  });

  test("normalizes package subpaths", () => {
    const desc = "npm install lodash/get";
    const packages = extractPackageReferences(desc);
    assert.deepEqual(packages, ["lodash"]);
  });

  test("handles empty description", () => {
    const packages = extractPackageReferences("");
    assert.deepEqual(packages, []);
  });

  test("ignores flags in npm install", () => {
    const desc = "npm install -D typescript";
    const packages = extractPackageReferences(desc);
    assert.ok(packages.includes("typescript"));
    assert.ok(!packages.includes("-D"));
  });
});

// ─── File Path Consistency Tests ─────────────────────────────────────────────

describe("checkFilePathConsistency", () => {
  let tempDir: string;

  test("passes when files exist on disk", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["existing.ts"],
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("passes when files are in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["generated.ts"],
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["generated.ts"],
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fails when inputs don't exist and not in prior outputs", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["nonexistent.ts"],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 1);
      assert.equal(results[0].category, "file");
      assert.equal(results[0].passed, false);
      assert.equal(results[0].blocking, true);
      assert.ok(results[0].message.includes("nonexistent.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("checks only inputs array, not files array", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["missing-file.ts"],
          inputs: ["missing-input.ts"],
          expected_output: [],
        }),
      ];

      // Only inputs are checked — files ("files likely touched") are excluded
      // because they may include files the task will create (#3626)
      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 1);
      assert.ok(results.some((r) => r.target === "missing-input.ts"));
      // missing-file.ts should NOT produce a failure
      assert.ok(!results.some((r) => r.target === "missing-file.ts"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("skips empty file strings", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["", "  "],
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Path Normalization Tests ────────────────────────────────────────────────

describe("normalizeFilePath", () => {
  test("strips leading ./", () => {
    assert.equal(normalizeFilePath("./src/a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("././foo.ts"), "foo.ts");
  });

  test("normalizes backslashes to forward slashes", () => {
    assert.equal(normalizeFilePath("src\\a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("src\\sub\\file.ts"), "src/sub/file.ts");
  });

  test("removes duplicate slashes", () => {
    assert.equal(normalizeFilePath("src//a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("src///sub//file.ts"), "src/sub/file.ts");
  });

  test("handles empty string", () => {
    assert.equal(normalizeFilePath(""), "");
  });

  test("removes trailing slash", () => {
    assert.equal(normalizeFilePath("src/"), "src");
    assert.equal(normalizeFilePath("src/sub/"), "src/sub");
  });

  test("handles paths without any normalization needed", () => {
    assert.equal(normalizeFilePath("src/a.ts"), "src/a.ts");
    assert.equal(normalizeFilePath("index.ts"), "index.ts");
  });
});

describe("checkFilePathConsistency with path normalization", () => {
  let tempDir: string;

  test("./path matches path in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["src/generated.ts"], // Output without ./
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["./src/generated.ts"], // Input with ./
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because ./src/generated.ts matches src/generated.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("path matches ./path in prior expected_output", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["./src/generated.ts"], // Output with ./
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["src/generated.ts"], // Input without ./
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because src/generated.ts matches ./src/generated.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("paths with mixed separators match", () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: [],
          expected_output: ["src/sub/file.ts"],
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: ["src\\sub\\file.ts"], // Backslash separators
          inputs: [],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.deepEqual(results, [], "Should pass because backslash paths normalize to forward slash");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("checkTaskOrdering with path normalization", () => {
  test("./path in inputs triggers ordering check for path in expected_output", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["./generated.ts"], // Reads with ./
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["generated.ts"], // Creates without ./
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Should detect ordering violation despite ./");
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
  });

  test("path in inputs triggers ordering check for ./path in expected_output", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["generated.ts"], // Reads without ./
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["./generated.ts"], // Creates with ./
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Should detect ordering violation despite ./ on creator");
    assert.ok(results[0].message.includes("sequence violation"));
  });

  test("no false positive when correctly ordered with mixed paths", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["./src/api.ts"],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: ["src/api.ts"], // Same file, different notation
        inputs: [],
        expected_output: [],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, [], "Should pass - T02 reads file that T01 already created");
  });
});

// ─── Task Ordering Tests ─────────────────────────────────────────────────────

describe("checkTaskOrdering", () => {
  test("passes when tasks are correctly ordered", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["api.ts"],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: ["api.ts"],
        inputs: [],
        expected_output: [],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, []);
  });

  test("fails when task inputs reference file created by later task", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["generated.ts"], // Reads file that doesn't exist yet
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["generated.ts"], // Creates the file
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "file");
    assert.equal(results[0].passed, false);
    assert.equal(results[0].blocking, true);
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
    assert.ok(results[0].message.includes("sequence violation"));
  });

  test("detects ordering violation in inputs array", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["schema.json"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["schema.json"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("schema.json"));
  });

  test("handles multiple ordering violations via inputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["a.ts", "b.ts"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["a.ts"],
      }),
      createTask({
        id: "T03",
        sequence: 2,
        files: [],
        inputs: [],
        expected_output: ["b.ts"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 2);
  });

  test("passes when no dependencies between tasks", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: [],
        expected_output: ["a.ts"],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["b.ts"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(results, []);
  });
});

// ─── Interface Contract Tests ────────────────────────────────────────────────

describe("checkInterfaceContracts", () => {
  test("passes when function signatures match", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.deepEqual(results, []);
  });

  test("warns on parameter mismatch (non-blocking)", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function saveUser(name: string): void
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function saveUser(name: string, email: string): void
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "schema");
    assert.equal(results[0].target, "saveUser");
    assert.equal(results[0].passed, true); // Warning, not failure
    assert.equal(results[0].blocking, false);
    assert.ok(results[0].message.includes("different parameters"));
  });

  test("warns on return type mismatch (non-blocking)", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function getData(): string
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function getData(): number
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("different return types"));
  });

  test("handles export function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
export function validate(data: object): boolean
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
export function validate(data: string): boolean
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
    assert.ok(results[0].message.includes("validate"));
  });

  test("handles async function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
export async function fetchData(): Promise<string>
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
export async function fetchData(): Promise<number>
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.equal(results.length, 1);
  });

  test("handles const arrow function syntax", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
const handler = (req: Request): Response =>
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
const handler = (req: Request, res: Response): void =>
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    // Should have 2 results: parameter mismatch AND return type mismatch
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.message.includes("handler")));
    assert.ok(results.some((r) => r.message.includes("parameters")));
    assert.ok(results.some((r) => r.message.includes("return types")));
  });

  test("passes when no code blocks present", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: "Just some text without code blocks",
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    assert.deepEqual(results, []);
  });

  test("handles multiple mismatches for same function", () => {
    const tasks = [
      createTask({
        id: "T01",
        description: `
\`\`\`typescript
function process(a: string): string
\`\`\`
        `,
      }),
      createTask({
        id: "T02",
        description: `
\`\`\`typescript
function process(a: number): number
\`\`\`
        `,
      }),
    ];

    const results = checkInterfaceContracts(tasks, "/tmp");
    // Should have both parameter and return type mismatches
    assert.equal(results.length, 2);
  });
});

// ─── runPreExecutionChecks Integration Tests ─────────────────────────────────

describe("runPreExecutionChecks", () => {
  let tempDir: string;

  test("returns pass status when all checks pass", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["existing.ts"],
          inputs: [],
          expected_output: ["output.ts"],
        }),
        createTask({
          id: "T02",
          files: ["output.ts"],
          inputs: [],
          expected_output: [],
        }),
      ];

      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "pass");
      assert.equal(result.checks.length, 0);
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns fail status when blocking failure exists", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["nonexistent.ts"],
          expected_output: [],
        }),
      ];

      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "fail");
      assert.ok(result.checks.length > 0);
      assert.ok(result.checks.some((c) => c.blocking === true));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns warn status for non-blocking issues", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Create tasks with only interface contract warnings
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: [],
          expected_output: [],
          description: `
\`\`\`typescript
function foo(a: string): void
\`\`\`
          `,
        }),
        createTask({
          id: "T02",
          files: [],
          inputs: [],
          expected_output: [],
          description: `
\`\`\`typescript
function foo(a: number): void
\`\`\`
          `,
        }),
      ];

      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "warn");
      assert.ok(result.checks.some((c) => c.blocking === false));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("combines results from all check types", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: ["will-be-created.ts"], // Ordering violation
          inputs: ["missing.ts"],        // Missing file
          expected_output: [],
          description: `
\`\`\`typescript
function check(a: string): void
\`\`\`
          `,
        }),
        createTask({
          id: "T02",
          sequence: 1,
          files: [],
          inputs: [],
          expected_output: ["will-be-created.ts"],
          description: `
\`\`\`typescript
function check(a: number): void
\`\`\`
          `,
        }),
      ];

      const result = await runPreExecutionChecks(tasks, tempDir);
      assert.equal(result.status, "fail");

      // Should have multiple types of issues
      const categories = new Set(result.checks.map((c) => c.category));
      assert.ok(categories.has("file"));  // From consistency and ordering
      assert.ok(categories.has("schema")); // From interface check
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reports duration in milliseconds", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [createTask({ id: "T01" })];
      const result = await runPreExecutionChecks(tasks, tempDir);

      assert.ok(typeof result.durationMs === "number");
      assert.ok(result.durationMs >= 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("handles empty task array", async () => {
    tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const result = await runPreExecutionChecks([], tempDir);
      assert.equal(result.status, "pass");
      assert.deepEqual(result.checks, []);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Regression Tests: checkTaskOrdering false positive (#3677) ──────────────

describe("checkTaskOrdering false positive regression (#3677)", () => {
  test("task.files should not trigger ordering violation when file is in later expected_output", () => {
    // T01 has files: ["component.tsx"] — this is a file the task will CREATE,
    // not read. Including task.files in the ordering check causes a false positive.
    // After fix (check only task.inputs), this should return 0 results.
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["component.tsx"],
        inputs: [],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["component.tsx"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "task.files should not be checked for ordering violations");
  });

  test("task.files with multiple files should not trigger false positives", () => {
    // T01 lists several files it will touch/create — none should trigger ordering
    // violations just because T02 declares one of them as expected_output.
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["a.ts", "b.ts", "c.ts"],
        inputs: [],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["b.ts"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Multiple task.files should not generate false positive violations");
  });

  test("task.inputs SHOULD still trigger ordering violation", () => {
    // task.inputs represents files a task genuinely needs to READ, so a sequence
    // violation here is a real error and must still be detected.
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["config.json"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["config.json"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "task.inputs ordering violation must still be detected");
    assert.equal(results[0].blocking, true);
    assert.ok(results[0].message.includes("T01"));
    assert.ok(results[0].message.includes("T02"));
    assert.ok(results[0].message.includes("sequence violation"));
  });

  test("mixed files and inputs — only inputs trigger ordering violation", () => {
    // T01 will create "created.ts" (files) and also needs to READ "needed.json" (inputs).
    // T02 creates both. Only the inputs dependency is a real violation.
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["created.ts"],
        inputs: ["needed.json"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["created.ts", "needed.json"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Only the inputs entry should produce a violation, not files");
    assert.ok(results[0].target === "needed.json", "Violation target should be the input, not the file");
  });

  test("task.files with normalized paths should not false-positive", () => {
    // Path normalization (./src/new-file.ts → src/new-file.ts) should not cause
    // task.files to match against expected_output and produce a false positive.
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: ["./src/new-file.ts"],
        inputs: [],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["src/new-file.ts"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Normalized task.files path should not trigger a false positive");
  });

  test("annotated inputs still trigger ordering violations against later plain outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["`later.ts` — needed first"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["later.ts"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 1, "Annotated inputs should still match later plain expected_output entries");
    assert.equal(results[0].target, "`later.ts` — needed first");
    assert.ok(results[0].message.includes("sequence violation"));
  });

  test("existing on-disk files do not trigger ordering violations just because a later task modifies them", () => {
    const tempDir = join(tmpdir(), `pre-exec-ordering-existing-file-${Date.now()}`);
    const existingFile = "frontend/src/__tests__/ProcurementPage29.test.tsx";

    mkdirSync(join(tempDir, "frontend", "src", "__tests__"), { recursive: true });
    writeFileSync(join(tempDir, existingFile), "// existing file");

    try {
      const tasks = [
        createTask({
          id: "T01",
          sequence: 0,
          files: [],
          inputs: ["`frontend/src/__tests__/ProcurementPage29.test.tsx` — contains matchMedia stub to remove"],
          expected_output: [],
        }),
        createTask({
          id: "T03",
          sequence: 2,
          files: [],
          inputs: [],
          expected_output: ["frontend/src/__tests__/ProcurementPage29.test.tsx"],
        }),
      ];

      const results = checkTaskOrdering(tasks, tempDir);
      assert.equal(results.length, 0, "Pre-existing files should not be treated as created by later tasks");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("glob-like inputs do not trigger ordering violations against later concrete outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        files: [],
        inputs: ["Artifacts/pruned_networks/cell_line=*/"],
        expected_output: [],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        files: [],
        inputs: [],
        expected_output: ["Artifacts/pruned_networks/cell_line=HT-29/"],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.equal(results.length, 0, "Glob-pattern inputs should not be treated as literal read-before-create dependencies");
  });
});

// ─── checkFilePathConsistency additional edge cases ──────────────────────────

describe("checkFilePathConsistency additional edge cases", () => {
  test("annotated inputs match files that already exist on disk", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-annotated-input-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "existing.ts"), "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: ["`existing.ts` — file already on disk"],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Annotated inputs should resolve to the on-disk file path");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("plain inputs match prior annotated expected outputs", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: [],
        expected_output: ["`generated.ts` — created earlier"],
      }),
      createTask({
        id: "T02",
        files: [],
        inputs: ["generated.ts"],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Prior annotated expected_output entries should satisfy later plain inputs");
  });

  test("inputs referencing glob-like patterns are skipped by path consistency checks", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: ["src/**/*.ts"],
        expected_output: [],
      }),
    ];

    // Should not throw
    let results: ReturnType<typeof checkFilePathConsistency>;
    assert.doesNotThrow(() => {
      results = checkFilePathConsistency(tasks, "/tmp");
    });
    assert.equal(results!.length, 0, "Glob-pattern inputs should not produce false blocking failures");
  });

  test("multi-word prose inputs are ignored by path consistency checks", () => {
    const tasks = [
      createTask({
        id: "T01",
        files: [],
        inputs: [
          "Current WIZARD_PRODUCTS enum",
          "Existing test patterns in wizard.test.ts",
        ],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Prose planning hints should not be treated as missing file paths");
  });

  test("empty inputs array produces no results", () => {
    // A task with no inputs and only files should produce zero results from
    // consistency check — files are not checked (#3626).
    const tasks = [
      createTask({
        id: "T01",
        files: ["anything.ts"],
        inputs: [],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Empty inputs should produce no consistency check results");
  });

  test("inputs with absolute paths are checked correctly", () => {
    // An absolute path in inputs should resolve to itself and pass when the file exists.
    const tempDir = join(tmpdir(), `pre-exec-test-abs-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const absFilePath = join(tempDir, "real-file.ts");
    writeFileSync(absFilePath, "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: [],
          inputs: [absFilePath],
          expected_output: [],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Absolute path to an existing file should pass consistency check");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Regression tests for issue #4421
  test("backticked path with trailing prose and parens resolves to the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-case1-${Date.now()}`);
    const dirPath = join(tempDir, "assets");
    mkdirSync(dirPath, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: [`\`${dirPath}/\` directory listing (shows the items that will match during the run)`],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Backticked dir path annotated with prose + parens should be recognized");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("backticked URL with paren annotation is skipped (not a filesystem path)", () => {
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["`https://example.com` (live HTTP target)"],
      }),
    ];

    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "Backticked URL should not be validated as a filesystem path");
  });

  test("URL embedded mid-sentence with prefix prose is skipped", () => {
    const tasks = [
      createTask({
        id: "T01",
        inputs: ["Live `https://example.com/docs` pages (reviewer WebFetches these)"],
      }),
    ];

    const results = checkFilePathConsistency(tasks, "/tmp");
    assert.equal(results.length, 0, "URLs cited mid-sentence should not be validated as filesystem paths");
  });

  test("backticked path cited mid-sentence resolves to the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-case4-${Date.now()}`);
    mkdirSync(join(tempDir, ".gsd"), { recursive: true });
    writeFileSync(join(tempDir, ".gsd/REQUIREMENTS.md"), "# Requirements");

    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["R014 verbatim text from `.gsd/REQUIREMENTS.md` (the owned requirement statement)"],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Backticked path cited mid-sentence should be recognized");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("multi-backtick input picks the path-like token over non-path tokens", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-multi-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/a.ts"), "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["`note` use `src/a.ts` for edits"],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Should extract src/a.ts, not the leading `note` token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("multi-backtick input with command-like leading token picks the path", () => {
    const tempDir = join(tmpdir(), `pre-exec-test-4421-cmd-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src/a.ts"), "// content");

    try {
      const tasks = [
        createTask({
          id: "T01",
          inputs: ["Run `npm test` against `src/a.ts`"],
        }),
      ];

      const results = checkFilePathConsistency(tasks, tempDir);
      assert.equal(results.length, 0, "Should extract src/a.ts, not the `npm test` command token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── PreExecutionResult Type Tests ───────────────────────────────────────────

describe("PreExecutionResult type", () => {
  test("status is one of pass, warn, fail", async () => {
    const tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [createTask({ id: "T01" })];
      const result = await runPreExecutionChecks(tasks, tempDir);

      assert.ok(["pass", "warn", "fail"].includes(result.status));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("checks array matches PreExecutionCheckJSON schema", async () => {
    const tempDir = join(tmpdir(), `pre-exec-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const tasks = [
        createTask({
          id: "T01",
          files: ["missing.ts"],
        }),
      ];

      const result = await runPreExecutionChecks(tasks, tempDir);

      for (const check of result.checks) {
        assert.ok(["package", "file", "tool", "endpoint", "schema"].includes(check.category));
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

// ─── Regression Tests: directory inputs and tilde paths (#4446) ──────────────

describe("normalizeFilePath tilde expansion (#4446)", () => {
  test("expands standalone ~ to homedir", () => {
    assert.equal(normalizeFilePath("~"), homedir());
  });

  test("expands ~/ prefixed paths to homedir", () => {
    assert.equal(
      normalizeFilePath("~/.gsd/agent/extensions/gsd/native-git-bridge.js"),
      join(homedir(), ".gsd/agent/extensions/gsd/native-git-bridge.js"),
    );
  });
});

describe("checkFilePathConsistency directory inputs (#4446)", () => {
  test("directory input is satisfied by prior task's output under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-prior-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T01",
        sequence: 0,
        inputs: [],
        expected_output: ["artifacts/M009-S03/summary.json"],
      }),
      createTask({
        id: "T02",
        sequence: 1,
        inputs: ["artifacts/M009-S03/"],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(results, [], "Directory input with prior output beneath it should not be blocking");
  });

  test("directory input is satisfied by same task's output under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-same-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T06",
        sequence: 0,
        inputs: ["artifacts/M009-S03/"],
        expected_output: [
          "artifacts/M009-S03/summary.json",
          "artifacts/M009-S03/VERIFICATION.md",
        ],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "Directory input whose children are produced by the same task should not be blocking (M009-S03/T06 case)",
    );
  });

  test("directory input still fails when nothing creates anything under it", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-dir-missing-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T01",
        inputs: ["artifacts/missing/"],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(results.length, 1, "Unknown directory input must still be reported");
    assert.equal(results[0].blocking, true);
  });

  test("tilde-prefixed input is matched against $HOME, not the project basePath", (t) => {
    const fakeHome = join(tmpdir(), `pre-exec-tilde-home-${Date.now()}`);
    const projectDir = join(tmpdir(), `pre-exec-tilde-proj-${Date.now()}`);
    mkdirSync(join(fakeHome, ".gsd"), { recursive: true });
    writeFileSync(join(fakeHome, ".gsd/tool.js"), "// present");
    mkdirSync(projectDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    t.after(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    });

    const tasks = [
      createTask({
        id: "T01",
        inputs: ["~/.gsd/tool.js"],
        expected_output: [],
      }),
    ];

    const results = checkFilePathConsistency(tasks, projectDir);
    assert.deepEqual(results, [], "~/-prefixed input should resolve against $HOME and pass when present");
  });
});

describe("checkTaskOrdering directory inputs (#4446)", () => {
  test("directory input with a same-task output under it does not produce a sequence violation", () => {
    const tasks = [
      createTask({
        id: "T06",
        sequence: 0,
        inputs: ["artifacts/M009-S03/"],
        expected_output: [
          "artifacts/M009-S03/summary.json",
          "artifacts/M009-S03/VERIFICATION.md",
        ],
      }),
    ];

    const results = checkTaskOrdering(tasks, "/tmp");
    assert.deepEqual(
      results,
      [],
      "Directory reference should not be treated as reading a file created later",
    );
  });
});

describe("checkFilePathConsistency self-referential inputs (#4459)", () => {
  test("input that is also in the same task's expected_output is not blocking when missing on disk", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["src/components/email/SnoozePopover.jsx"],
        expected_output: ["src/components/email/SnoozePopover.jsx"],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "File declared as both input and expected_output of the same task should not block — the task itself produces it",
    );
  });

  test("input missing from disk, missing from prior outputs, and missing from own expected_output still blocks", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-missing-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["src/components/email/SnoozePopover.jsx"],
        expected_output: ["src/other/unrelated.jsx"],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.equal(results.length, 1, "Genuinely missing input should still be reported");
    assert.equal(results[0].blocking, true);
    assert.equal(results[0].target, "src/components/email/SnoozePopover.jsx");
  });

  test("self-output exemption matches across path normalization (./ prefix)", (t) => {
    const tempDir = join(tmpdir(), `pre-exec-self-output-norm-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const tasks = [
      createTask({
        id: "T02",
        sequence: 0,
        inputs: ["./src/generated.ts"],
        expected_output: ["src/generated.ts"],
      }),
    ];

    const results = checkFilePathConsistency(tasks, tempDir);
    assert.deepEqual(
      results,
      [],
      "./src/generated.ts and src/generated.ts should compare equal after normalization",
    );
  });
});
