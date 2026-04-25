/**
 * pre-execution-pause-wiring.test.ts — Integration tests for pre-execution check → pauseAuto wiring.
 *
 * Tests that verify the control flow from pre-execution checks through to pauseAuto:
 *   1. When runPreExecutionChecks returns status: "fail" with blocking: true, pauseAuto is called
 *   2. When enhanced_verification_strict: true and status: "warn", pauseAuto is also called
 *
 * These are integration-level tests that exercise the actual postUnitPostVerification function
 * with controlled mocks for external dependencies.
 */

import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, _getAdapter } from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;
let originalCwd: string;

/**
 * Create a minimal mock ExtensionContext.
 */
function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {},
      setWidget: () => {},
      setFooter: () => {},
    },
    model: { id: "test-model" },
  } as any;
}

/**
 * Create a minimal mock ExtensionAPI.
 */
function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true),
  } as any;
}

/**
 * Create a minimal AutoSession for testing.
 */
function makeMockSession(basePath: string, currentUnit?: { type: string; id: string }): AutoSession {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  if (currentUnit) {
    s.currentUnit = {
      type: currentUnit.type,
      id: currentUnit.id,
      startedAt: Date.now(),
    };
  }
  return s;
}

/**
 * Create a PostUnitContext with a mockable pauseAuto.
 */
function makePostUnitContext(
  s: AutoSession,
  ctx: ReturnType<typeof makeMockCtx>,
  pi: ReturnType<typeof makeMockPi>,
  pauseAutoMock: ReturnType<typeof mock.fn>,
): PostUnitContext {
  return {
    s,
    ctx,
    pi,
    buildSnapshotOpts: () => ({}),
    lockBase: () => tempDir,
    stopAuto: mock.fn(async () => {}) as unknown as PostUnitContext["stopAuto"],
    pauseAuto: pauseAutoMock as unknown as PostUnitContext["pauseAuto"],
    updateProgressWidget: () => {},
  };
}

/**
 * Set up a temp directory with GSD structure and DB.
 * Also changes cwd so preferences loading finds the right PREFERENCES.md.
 */
function setupTestEnvironment(): void {
  // Save original cwd so we can restore it
  originalCwd = process.cwd();
  
  tempDir = join(tmpdir(), `pre-exec-pause-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  
  // Create .gsd directory structure
  const gsdDir = join(tempDir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  
  // Create milestones directory structure
  const milestonesDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(milestonesDir, { recursive: true });
  
  // Change cwd so loadEffectiveGSDPreferences finds our PREFERENCES.md
  process.chdir(tempDir);
  
  // Clear gsdRoot cache so it finds the new .gsd directory
  _clearGsdRootCache();
  
  // Initialize DB
  dbPath = join(gsdDir, "gsd.db");
  openDatabase(dbPath);
}

/**
 * Clean up test environment.
 */
function cleanupTestEnvironment(): void {
  // Restore original cwd before cleanup
  try {
    process.chdir(originalCwd);
  } catch {
    // Ignore if original cwd doesn't exist
  }
  
  try {
    closeDatabase();
  } catch {
    // Ignore close errors
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a PREFERENCES.md file with specified preferences.
 * Uses YAML frontmatter format (---\nkey: value\n---).
 * Also invalidates caches so the preferences are re-read.
 */
function writePreferences(prefs: Record<string, unknown>): void {
  const yamlLines = Object.entries(prefs).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const prefsContent = `---
${yamlLines.join("\n")}
---

# GSD Preferences
`;
  writeFileSync(join(tempDir, ".gsd", "PREFERENCES.md"), prefsContent);
  // Invalidate caches so the new preferences file is found
  invalidateAllCaches();
  _clearGsdRootCache();
}

/**
 * Create tasks in DB that will cause pre-execution checks to fail.
 * A task that references a non-existent file will produce a blocking failure.
 */
function createFailingTasks(): void {
  // Insert milestone first
  insertMilestone({ id: "M001" });

  // Insert slice
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  // Create a task that references a file that doesn't exist
  // This will cause checkFilePathConsistency to produce a blocking failure
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task with missing file",
    status: "pending",
    planning: {
      description: "This task references a non-existent file",
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: ["nonexistent-file-that-does-not-exist.ts"],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });
}

/**
 * Create tasks in DB that will produce only warnings (non-blocking issues).
 * Interface contract mismatches produce warnings, not blocking failures.
 */
function createWarningOnlyTasks(): void {
  // Insert milestone first
  insertMilestone({ id: "M001" });

  // Insert slice
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Test Slice",
    risk: "low",
  });

  // Create tasks with interface contract mismatch (produces warn, not fail)
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task 1 with function signature",
    status: "pending",
    planning: {
      description: `
\`\`\`typescript
function processData(input: string): boolean
\`\`\`
      `.trim(),
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 0,
  });

  insertTask({
    id: "T02",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Task 2 with mismatched signature",
    status: "pending",
    planning: {
      description: `
\`\`\`typescript
function processData(input: number): string
\`\`\`
      `.trim(),
      estimate: "1h",
      files: [],
      verify: "npm test",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
    sequence: 1,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Pre-execution checks → pauseAuto wiring", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  test("pauseAuto is called when pre-execution checks return status: fail with blocking: true", async () => {
    // Set up tasks that will cause a blocking failure
    createFailingTasks();

    // Create mocks
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    // Call postUnitPostVerification
    const result = await postUnitPostVerification(pctx);

    // Verify pauseAuto was called
    assert.equal(
      pauseAutoMock.mock.callCount(),
      1,
      "pauseAuto should be called exactly once when pre-execution checks fail with blocking issues"
    );

    // Verify return value is "stopped"
    assert.equal(
      result,
      "stopped",
      "postUnitPostVerification should return 'stopped' when pre-execution checks fail"
    );

    // Verify UI was notified of the failure
    const notifyCalls = ctx.ui.notify.mock.calls;
    const errorNotify = notifyCalls.find(
      (call: { arguments: unknown[] }) =>
        call.arguments[1] === "error" &&
        String(call.arguments[0]).includes("Pre-execution checks failed")
    );
    assert.ok(errorNotify, "Should show error notification about pre-execution check failure");
  });

  test("pauseAuto is called when enhanced_verification_strict: true and pre-execution returns warn", async () => {
    // Write preferences with strict mode enabled
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: true,
    });

    // Set up tasks that will produce only warnings (interface contract mismatch)
    createWarningOnlyTasks();

    // Create mocks
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    // Call postUnitPostVerification
    const result = await postUnitPostVerification(pctx);

    // Verify pauseAuto was called (strict mode promotes warnings to blocking)
    assert.equal(
      pauseAutoMock.mock.callCount(),
      1,
      "pauseAuto should be called when strict mode is enabled and pre-execution returns warn"
    );

    // Verify return value is "stopped"
    assert.equal(
      result,
      "stopped",
      "postUnitPostVerification should return 'stopped' when strict mode treats warnings as blocking"
    );

    // Verify UI was notified of the warning
    const notifyCalls = ctx.ui.notify.mock.calls;
    const warnNotify = notifyCalls.find(
      (call: { arguments: unknown[] }) =>
        call.arguments[1] === "warning" &&
        String(call.arguments[0]).includes("Pre-execution checks passed with warnings")
    );
    assert.ok(warnNotify, "Should show warning notification about pre-execution check warnings");
  });

  test("pauseAuto is NOT called when enhanced_verification_strict: false and pre-execution returns warn", async () => {
    // Write preferences with strict mode disabled (default behavior)
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: false,
    });

    // Set up tasks that will produce only warnings
    createWarningOnlyTasks();

    // Create mocks
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    // Call postUnitPostVerification
    const result = await postUnitPostVerification(pctx);

    // Verify pauseAuto was NOT called (warnings don't block in non-strict mode)
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called when strict mode is disabled and only warnings exist"
    );

    // Verify return value is "continue" (not "stopped")
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' when warnings don't block in non-strict mode"
    );
  });

  test("pre-execution checks are skipped when unit type is not plan-slice", async () => {
    // Set up tasks that would fail if checked
    createFailingTasks();

    // Create mocks with execute-task unit (not plan-slice)
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "execute-task", id: "M001/S01/T01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    // Call postUnitPostVerification
    const result = await postUnitPostVerification(pctx);

    // Verify pauseAuto was NOT called (pre-execution checks only run for plan-slice)
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called for non-plan-slice unit types"
    );

    // Verify return value is "continue"
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' for non-plan-slice unit types"
    );
  });

  test("pre-execution checks are skipped when enhanced_verification_pre: false", async () => {
    // Write preferences with pre-execution checks disabled
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: false,
    });

    // Set up tasks that would fail if checked
    createFailingTasks();

    // Create mocks
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    // Call postUnitPostVerification
    const result = await postUnitPostVerification(pctx);

    // Verify pauseAuto was NOT called (pre-execution checks disabled)
    assert.equal(
      pauseAutoMock.mock.callCount(),
      0,
      "pauseAuto should NOT be called when enhanced_verification_pre is disabled"
    );

    // Verify return value is "continue"
    assert.equal(
      result,
      "continue",
      "postUnitPostVerification should return 'continue' when pre-execution checks are disabled"
    );
  });

  test("uok gate runner persists pre-execution gate outcomes when enabled", async () => {
    writePreferences({
      enhanced_verification: true,
      enhanced_verification_pre: true,
      enhanced_verification_strict: true,
      uok: {
        enabled: true,
        gates: { enabled: true },
      },
    });

    createFailingTasks();

    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {});
    const s = makeMockSession(tempDir, { type: "plan-slice", id: "M001/S01" });
    const pctx = makePostUnitContext(s, ctx, pi, pauseAutoMock);

    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "stopped");

    const adapter = _getAdapter();
    const row = adapter
      ?.prepare(
        `SELECT gate_id, outcome, failure_class
         FROM gate_runs
         WHERE gate_id = 'pre-execution-checks'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get() as { gate_id: string; outcome: string; failure_class: string } | undefined;

    assert.ok(row, "pre-execution gate run should be persisted when uok.gates is enabled");
    assert.equal(row?.gate_id, "pre-execution-checks");
    assert.equal(row?.outcome, "fail");
    assert.equal(row?.failure_class, "input");
  });
});
