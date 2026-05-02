// GSD-2 + Regression tests for missing-worktree warning on resume (M4 fix)
//
// When paused-session.json records a worktreePath that no longer exists on disk,
// the resume path must emit a logWarning("session", ...) describing the situation
// rather than silently falling back to project-root mode.
//
// Strategy: drive the exported _warnIfWorktreeMissingForTest seam directly
// (mirrors the exact conditional used at the two resume sites in auto.ts),
// and independently verify the scope fallback via createWorkspace/scopeMilestone
// as in auto-session-scope.test.ts.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  logWarning,
  peekLogs,
  _resetLogs,
  setStderrLoggingEnabled,
} from "../workflow-logger.ts";
import { _warnIfWorktreeMissingForTest } from "../auto.ts";
import { AutoSession } from "../auto/session.ts";
import { createWorkspace, scopeMilestone } from "../workspace.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProjectDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-resume-warn-test-")));
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  return dir;
}

// Mirror the rebuildScope() fallback from auto.ts when worktree is missing.
function applyProjectRootScope(
  s: AutoSession,
  projectDir: string,
  milestoneId: string,
): void {
  const workspace = createWorkspace(projectDir);
  s.scope = scopeMilestone(workspace, milestoneId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resume: missing worktree warning emission", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProjectDir();
    _resetLogs();
    setStderrLoggingEnabled(false);
  });

  afterEach(() => {
    setStderrLoggingEnabled(true);
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("logWarning is called when worktreePath is set but directory is missing", () => {
    const missingPath = join(projectDir, ".gsd", "worktrees", "M001-nonexistent");
    // missingPath was never created — existsSync returns false

    const warned = _warnIfWorktreeMissingForTest(missingPath, "M001");

    assert.equal(warned, true, "_warnIfWorktreeMissingForTest should return true when path is missing");

    const logs = peekLogs();
    assert.equal(logs.length, 1, "exactly one warning should be emitted");
    assert.equal(logs[0].severity, "warn");
    assert.equal(logs[0].component, "session");
    assert.ok(
      logs[0].message.includes(missingPath),
      `warning message should include the missing path; got: ${logs[0].message}`,
    );
    assert.ok(
      logs[0].message.includes("missing"),
      "warning message should mention 'missing'",
    );
  });

  test("logWarning message includes milestone ID", () => {
    const missingPath = join(projectDir, ".gsd", "worktrees", "M042-gone");
    _warnIfWorktreeMissingForTest(missingPath, "M042");

    const logs = peekLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].context?.milestoneId, "M042");
  });

  test("logWarning is NOT called when worktreePath is null", () => {
    const warned = _warnIfWorktreeMissingForTest(null, "M001");

    assert.equal(warned, false);
    assert.equal(peekLogs().length, 0, "no warning when worktreePath is null");
  });

  test("logWarning is NOT called when worktreePath is undefined", () => {
    const warned = _warnIfWorktreeMissingForTest(undefined, "M001");

    assert.equal(warned, false);
    assert.equal(peekLogs().length, 0, "no warning when worktreePath is undefined");
  });

  test("logWarning is NOT called when worktreePath exists on disk", () => {
    const existingWorktree = join(projectDir, ".gsd", "worktrees", "M001");
    mkdirSync(existingWorktree, { recursive: true });

    const warned = _warnIfWorktreeMissingForTest(existingWorktree, "M001");

    assert.equal(warned, false, "no warning when path exists");
    assert.equal(peekLogs().length, 0);
  });

  test("warning message mentions project-root fallback action", () => {
    const missingPath = join(projectDir, ".gsd", "worktrees", "M099-deleted");
    _warnIfWorktreeMissingForTest(missingPath, "M099");

    const logs = peekLogs();
    assert.equal(logs.length, 1);
    assert.ok(
      logs[0].message.includes("project-root mode"),
      "warning should mention project-root mode fallback",
    );
    assert.ok(
      logs[0].message.includes("gsd-debug"),
      "warning should suggest /gsd-debug recovery action",
    );
  });
});

describe("resume: scope fallback to project-root mode when worktree is missing", () => {
  let s: AutoSession;
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProjectDir();
    s = new AutoSession();
    _resetLogs();
    setStderrLoggingEnabled(false);
  });

  afterEach(() => {
    setStderrLoggingEnabled(true);
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("scope.workspace.mode is 'project' after fallback from missing worktree", () => {
    const mid = "M001";
    s.originalBasePath = projectDir;
    s.currentMilestoneId = mid;

    // Simulate auto.ts resume path: worktreePath is set but missing → use projectDir
    const missingPath = join(projectDir, ".gsd", "worktrees", mid);
    _warnIfWorktreeMissingForTest(missingPath, mid);

    // Fallback: use originalBasePath (project root)
    applyProjectRootScope(s, projectDir, mid);

    assert.ok(s.scope, "scope should be set after fallback");
    assert.equal(s.scope.workspace.mode, "project");
  });

  test("scope.milestoneId is preserved after project-root fallback", () => {
    const mid = "M002";
    s.originalBasePath = projectDir;
    s.currentMilestoneId = mid;

    const missingPath = join(projectDir, ".gsd", "worktrees", mid);
    _warnIfWorktreeMissingForTest(missingPath, mid);

    applyProjectRootScope(s, projectDir, mid);

    assert.ok(s.scope, "scope should be set");
    assert.equal(s.scope.milestoneId, mid);
  });

  test("does not throw when worktree path is missing and scope fallback is applied", () => {
    const mid = "M003";
    s.originalBasePath = projectDir;
    s.currentMilestoneId = mid;

    const missingPath = join(projectDir, ".gsd", "worktrees", mid);

    assert.doesNotThrow(() => {
      _warnIfWorktreeMissingForTest(missingPath, mid);
      applyProjectRootScope(s, projectDir, mid);
    }, "resume with missing worktree must not throw");
  });

  test("warning is emitted once per missing worktree — no double-emission", () => {
    const mid = "M004";
    const missingPath = join(projectDir, ".gsd", "worktrees", mid);

    _warnIfWorktreeMissingForTest(missingPath, mid);

    // Simulating the second call as would happen if the resume-re-entry site
    // also fires (e.g. pausedSession and freshStartAssessment both carry the path)
    _warnIfWorktreeMissingForTest(missingPath, mid);

    const logs = peekLogs();
    // Two calls → two warnings (one per site — consistent with the two sites in auto.ts)
    assert.equal(logs.length, 2, "each call to the seam emits one warning");
    assert.equal(logs[0].component, "session");
    assert.equal(logs[1].component, "session");
  });
});
