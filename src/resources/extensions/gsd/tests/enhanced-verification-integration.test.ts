/**
 * enhanced-verification-integration.test.ts — Integration tests for enhanced verification.
 *
 * Exercises all 7 enhanced verification checks against GSD-2's actual source files.
 * This proves:
 *   - R012: No false positives on production code
 *   - R013: Speed targets met (<2000ms pre-execution, <1000ms post-execution per task)
 *
 * The test constructs realistic TaskRow fixtures that reference real GSD source files,
 * then runs both pre-execution and post-execution checks against them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runPreExecutionChecks,
  type PreExecutionResult,
} from "../pre-execution-checks.ts";
import {
  runPostExecutionChecks,
  type PostExecutionResult,
} from "../post-execution-checks.ts";
import type { TaskRow } from "../gsd-db.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the GSD extension source directory (relative to test file)
const GSD_SRC_DIR = join(__dirname, "..");

// Speed targets from R013
const PRE_EXECUTION_TIMEOUT_MS = 2000;
const POST_EXECUTION_TIMEOUT_MS = 1000;

// ─── Test Fixtures ───────────────────────────────────────────────────────────

/**
 * Create a minimal TaskRow for testing.
 */
function createTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    milestone_id: "M001",
    slice_id: "S01",
    id: overrides.id ?? "T01",
    title: overrides.title ?? "Test Task",
    status: overrides.status ?? "pending",
    one_liner: "",
    narrative: "",
    verification_result: "",
    duration: "",
    completed_at: overrides.status === "complete" ? new Date().toISOString() : null,
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

// ─── Real GSD Source Files for Testing ───────────────────────────────────────

// These are actual GSD extension source files that exist in the codebase
const REAL_GSD_FILES = [
  "gsd-db.ts",
  "auto-verification.ts",
  "pre-execution-checks.ts",
  "post-execution-checks.ts",
  "state.ts",
  "errors.ts",
  "types.ts",
  "cache.ts",
  "atomic-write.ts",
];

// Verify the test fixture files actually exist
function verifyTestFixturesExist(): void {
  for (const file of REAL_GSD_FILES) {
    const fullPath = join(GSD_SRC_DIR, file);
    if (!existsSync(fullPath)) {
      throw new Error(`Test fixture file does not exist: ${fullPath}`);
    }
  }
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("Enhanced Verification Integration Tests", () => {
  // Verify fixtures before running tests
  test("test fixture files exist", () => {
    verifyTestFixturesExist();
  });

  describe("Pre-Execution Checks on Real GSD Code", () => {
    test("runs pre-execution checks on realistic tasks referencing real files", async () => {
      // Simulate tasks that reference real GSD source files
      const tasks: TaskRow[] = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Add validation to gsd-db",
          description: `
## Steps
1. Update src/resources/extensions/gsd/gsd-db.ts to add validation
2. Read from src/resources/extensions/gsd/types.ts for type definitions
3. Update src/resources/extensions/gsd/errors.ts with new error types
4. Run tests to verify changes
          `.trim(),
          files: REAL_GSD_FILES.slice(0, 4).map((f) => join(GSD_SRC_DIR, f)),
          inputs: [
            join(GSD_SRC_DIR, "types.ts"),
            join(GSD_SRC_DIR, "errors.ts"),
          ],
          expected_output: [
            join(GSD_SRC_DIR, "gsd-db.ts"),
          ],
        }),
      ];

      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;

      // R012: No blocking failures (false positives) on production code
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Expected zero blocking failures, got: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Overall status should not be fail
      assert.notEqual(result.status, "fail", "Pre-execution checks should not fail on real GSD code");

      // R013: Speed target met
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("handles task with code block references to real packages", async () => {
      // Task description with realistic code blocks using actual Node.js built-ins
      const tasks: TaskRow[] = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Implement file watcher",
          description: `
## Implementation

\`\`\`typescript
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// Use existing GSD types
import type { TaskRow } from "./gsd-db.ts";
\`\`\`

Update the file watcher to use these imports.
          `.trim(),
          files: [join(GSD_SRC_DIR, "auto-verification.ts")],
        }),
      ];

      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Speed target met
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("handles multi-task sequence with file dependencies", async () => {
      // Simulate a realistic task sequence where T02 depends on T01's output
      const tasks: TaskRow[] = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Create types file",
          status: "complete",
          expected_output: [join(GSD_SRC_DIR, "types.ts")],
        }),
        createTask({
          id: "T02",
          sequence: 1,
          title: "Use types in implementation",
          description: `
Read the types from src/resources/extensions/gsd/types.ts and use them.
          `.trim(),
          inputs: [join(GSD_SRC_DIR, "types.ts")],
          files: [join(GSD_SRC_DIR, "gsd-db.ts")],
        }),
      ];

      const start = performance.now();
      const result = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Speed target met
      assert.ok(
        duration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution checks took ${duration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );
    });
  });

  describe("Post-Execution Checks on Real GSD Code", () => {
    test("runs post-execution checks on real GSD source files", () => {
      // Simulate a completed task that modified real files
      const completedTask = createTask({
        id: "T01",
        title: "Update gsd-db validation",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "gsd-db.ts"),
          join(GSD_SRC_DIR, "types.ts"),
        ],
      });

      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;

      // R012: No blocking failures (false positives) on production code
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Expected zero blocking failures, got: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Overall status should not be fail
      assert.notEqual(result.status, "fail", "Post-execution checks should not fail on real GSD code");

      // R013: Speed target met
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("analyzes imports in real TypeScript files", () => {
      // Use auto-verification.ts which imports from multiple other GSD files
      const completedTask = createTask({
        id: "T02",
        title: "Verify auto-verification imports",
        status: "complete",
        key_files: [join(GSD_SRC_DIR, "auto-verification.ts")],
      });

      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Speed target met
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("handles multi-file task with cross-file dependencies", () => {
      // Task that touched multiple related files
      const completedTask = createTask({
        id: "T03",
        title: "Refactor state management",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "state.ts"),
          join(GSD_SRC_DIR, "gsd-db.ts"),
          join(GSD_SRC_DIR, "cache.ts"),
        ],
      });

      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Speed target met
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("handles task sequence with signature analysis", () => {
      // Simulate checking for signature consistency across tasks
      const priorTasks: TaskRow[] = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Define TaskRow interface",
          status: "complete",
          key_files: [join(GSD_SRC_DIR, "gsd-db.ts")],
        }),
      ];

      const completedTask = createTask({
        id: "T02",
        sequence: 1,
        title: "Use TaskRow in state module",
        status: "complete",
        key_files: [join(GSD_SRC_DIR, "state.ts")],
      });

      const start = performance.now();
      const result = runPostExecutionChecks(completedTask, priorTasks, GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Speed target met
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution checks took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });
  });

  describe("Combined Pre and Post Execution Flow", () => {
    test("full verification flow on realistic task lifecycle", async () => {
      // Simulate a complete task lifecycle
      const tasks: TaskRow[] = [
        createTask({
          id: "T01",
          sequence: 0,
          title: "Implement enhanced verification",
          status: "pending",
          description: `
## Steps
1. Update pre-execution-checks.ts with new validation
2. Update post-execution-checks.ts with signature analysis
3. Add integration tests

\`\`\`typescript
import { runPreExecutionChecks } from "./pre-execution-checks.ts";
import { runPostExecutionChecks } from "./post-execution-checks.ts";
\`\`\`
          `.trim(),
          files: [
            join(GSD_SRC_DIR, "pre-execution-checks.ts"),
            join(GSD_SRC_DIR, "post-execution-checks.ts"),
          ],
          inputs: [
            join(GSD_SRC_DIR, "types.ts"),
            join(GSD_SRC_DIR, "gsd-db.ts"),
          ],
          expected_output: [
            join(GSD_SRC_DIR, "tests/enhanced-verification-integration.test.ts"),
          ],
        }),
      ];

      // Run pre-execution checks
      const preStart = performance.now();
      const preResult = await runPreExecutionChecks(tasks, GSD_SRC_DIR);
      const preDuration = performance.now() - preStart;

      // Verify pre-execution results
      const preBlockingFailures = preResult.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        preBlockingFailures.length,
        0,
        `Pre-execution had blocking failures: ${JSON.stringify(preBlockingFailures, null, 2)}`
      );
      assert.ok(
        preDuration < PRE_EXECUTION_TIMEOUT_MS,
        `Pre-execution took ${preDuration.toFixed(0)}ms, expected <${PRE_EXECUTION_TIMEOUT_MS}ms`
      );

      // Task after execution (simulated completion)
      const completedTask = createTask({
        ...tasks[0],
        status: "complete",
        key_files: tasks[0].files,
      });

      // Run post-execution checks
      const postStart = performance.now();
      const postResult = runPostExecutionChecks(completedTask, [], GSD_SRC_DIR);
      const postDuration = performance.now() - postStart;

      // Verify post-execution results
      const postBlockingFailures = postResult.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        postBlockingFailures.length,
        0,
        `Post-execution had blocking failures: ${JSON.stringify(postBlockingFailures, null, 2)}`
      );
      assert.ok(
        postDuration < POST_EXECUTION_TIMEOUT_MS,
        `Post-execution took ${postDuration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS}ms`
      );
    });

    test("handles large number of files without timeout", () => {
      // Use all available GSD source files to stress test
      const allGsdFiles = REAL_GSD_FILES.map((f) => join(GSD_SRC_DIR, f));

      const task = createTask({
        id: "T01",
        title: "Large refactor touching many files",
        status: "complete",
        key_files: allGsdFiles,
        files: allGsdFiles,
      });

      const start = performance.now();
      const result = runPostExecutionChecks(task, [], GSD_SRC_DIR);
      const duration = performance.now() - start;

      // No blocking failures
      const blockingFailures = result.checks.filter((c) => !c.passed && c.blocking);
      assert.equal(
        blockingFailures.length,
        0,
        `Unexpected blocking failures: ${JSON.stringify(blockingFailures, null, 2)}`
      );

      // Should still be fast even with many files
      // Allow slightly more time for multi-file analysis but still within target
      assert.ok(
        duration < POST_EXECUTION_TIMEOUT_MS * 2, // Allow 2x for stress test
        `Multi-file post-execution took ${duration.toFixed(0)}ms, expected <${POST_EXECUTION_TIMEOUT_MS * 2}ms`
      );
    });
  });

  describe("Warning Quality", () => {
    test("warnings on real code are actionable, not spurious", () => {
      // Run checks on well-formed production code
      const task = createTask({
        id: "T01",
        title: "Review code quality",
        status: "complete",
        key_files: [
          join(GSD_SRC_DIR, "pre-execution-checks.ts"),
          join(GSD_SRC_DIR, "post-execution-checks.ts"),
        ],
      });

      const result = runPostExecutionChecks(task, [], GSD_SRC_DIR);

      // Extract warnings (either non-passed non-blocking, or passed with warning messages)
      const warnings = result.checks.filter(
        (c) => (!c.passed && !c.blocking) || (c.passed && c.message?.startsWith("Warning:"))
      );

      // Warnings are acceptable but should be few on well-maintained code
      // If we get many warnings, it suggests the checks are too aggressive
      assert.ok(
        warnings.length <= 10,
        `Too many warnings (${warnings.length}) suggests overly aggressive checks: ${JSON.stringify(warnings, null, 2)}`
      );

      // Each warning should have a clear message
      for (const warning of warnings) {
        assert.ok(warning.category, "Warning missing category");
        assert.ok(warning.message, "Warning missing message");
        assert.ok(
          warning.message.length > 10,
          `Warning message too short to be actionable: "${warning.message}"`
        );
      }
    });
  });
});
