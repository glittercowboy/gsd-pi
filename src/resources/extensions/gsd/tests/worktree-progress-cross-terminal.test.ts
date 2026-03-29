/**
 * worktree-progress-cross-terminal.test.ts — Regression tests for #2561.
 *
 * Bug: Auto-mode progress stays stale in other terminals when running in a worktree.
 *
 * Three cooperating bugs:
 * 1. resolveProjectRootDbPath does not handle symlink-resolved worktree paths
 *    (/.gsd/projects/<hash>/worktrees/M001) — falls through to worktree-local DB.
 * 2. syncStateToProjectRoot copies metrics and state files but does not reconcile
 *    the worktree-local DB back to the project root DB.
 * 3. dashboard-overlay only calls loadData() when the dashboard identity changes,
 *    which never happens in a passive terminal — so progress stays frozen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { resolveProjectRootDbPath } from "../bootstrap/dynamic-tools.ts";

// ─── Bug 1: resolveProjectRootDbPath must handle symlink-resolved worktree paths ──

test("#2561: resolveProjectRootDbPath handles symlink-resolved worktree layout", () => {
  // Symlink-resolved layout: ~/.gsd/projects/<hash>/worktrees/M001
  // This occurs when .gsd is a symlink to an external directory.
  const symlinkPath = join(
    "/Users/dev/.gsd/projects/abcdef01/worktrees/M001",
  );
  const result = resolveProjectRootDbPath(symlinkPath);

  // The function must detect this as a worktree and resolve to the
  // external project directory's gsd.db, NOT the worktree-local one.
  assert.notEqual(
    result,
    join(symlinkPath, ".gsd", "gsd.db"),
    "symlink-resolved worktree path must NOT resolve to worktree-local DB",
  );
});

test("#2561: resolveProjectRootDbPath handles standard worktree layout (existing)", () => {
  // Standard layout: /project/.gsd/worktrees/M001
  const standardPath = `/project${sep}.gsd${sep}worktrees${sep}M001`;
  const result = resolveProjectRootDbPath(standardPath);
  assert.equal(
    result,
    join("/project", ".gsd", "gsd.db"),
    "standard worktree layout resolves correctly",
  );
});

test("#2561: resolveProjectRootDbPath handles nested symlink worktree subdir", () => {
  const nestedPath = "/home/user/.gsd/projects/abc123/worktrees/M002/src/lib";
  const result = resolveProjectRootDbPath(nestedPath);
  assert.notEqual(
    result,
    join(nestedPath, ".gsd", "gsd.db"),
    "nested symlink worktree path must NOT fall through to default",
  );
});

// ─── Bug 2: syncStateToProjectRoot must reconcile DB ──────────────────────

test("#2561: syncStateToProjectRoot should reconcile worktree DB to project root", () => {
  const syncSrc = readFileSync(
    join(import.meta.dirname, "..", "auto-worktree.ts"),
    "utf-8",
  );

  // Find the syncStateToProjectRoot function body
  const fnIdx = syncSrc.indexOf("export function syncStateToProjectRoot");
  assert.ok(fnIdx !== -1, "syncStateToProjectRoot exists in auto-worktree.ts");

  // Get a generous window of the function body (the function may be large
  // due to inline comments and multiple sync steps)
  const fnBody = syncSrc.slice(fnIdx, fnIdx + 3000);

  // The function should reference DB reconciliation — either calling
  // reconcileWorktreeDb or performing equivalent DB sync.
  const hasDbSync =
    fnBody.includes("reconcileWorktreeDb") ||
    fnBody.includes("gsd.db") ||
    fnBody.includes("reconcileDb") ||
    fnBody.includes("database");

  assert.ok(
    hasDbSync,
    "syncStateToProjectRoot must reconcile worktree DB to project root (#2561)",
  );
});

// ─── Bug 3: dashboard-overlay must refresh on every tick in passive terminals ──

test("#2561: dashboard-overlay must call loadData on every refresh tick", () => {
  const overlaySrc = readFileSync(
    join(import.meta.dirname, "..", "dashboard-overlay.ts"),
    "utf-8",
  );

  // Find the refreshDashboard method
  const refreshIdx = overlaySrc.indexOf("private async refreshDashboard");
  assert.ok(refreshIdx !== -1, "refreshDashboard method exists");

  const refreshBody = overlaySrc.slice(refreshIdx, refreshIdx + 600);

  // The loadData call must NOT be guarded solely by identity change.
  // In a passive terminal, the identity never changes because
  // getAutoDashboardData() returns stale in-memory data.
  // loadData() must run unconditionally on each tick, or the identity
  // must include a monotonic counter / timestamp that always changes.

  // Check that loadData is called outside the identity-change guard,
  // OR that the identity computation includes a time/file-stat component.
  const identityGuardIdx = refreshBody.indexOf("nextIdentity !== this.loadedDashboardIdentity");
  const loadDataIdx = refreshBody.indexOf("this.loadData()");

  if (identityGuardIdx !== -1 && loadDataIdx !== -1) {
    // Find the computeDashboardIdentity method to check if it includes
    // a file-stat or monotonic component
    const identityMethodIdx = overlaySrc.indexOf("private computeDashboardIdentity");
    const identityMethodEnd = identityMethodIdx !== -1
      ? overlaySrc.indexOf("}", overlaySrc.indexOf("return [", identityMethodIdx))
      : -1;
    const identityMethod = identityMethodIdx !== -1 && identityMethodEnd !== -1
      ? overlaySrc.slice(identityMethodIdx, identityMethodEnd + 1)
      : "";

    // Identity must include a file-stat/mtime or monotonic counter
    const hasFileStatInIdentity =
      identityMethod.includes("statSync") ||
      identityMethod.includes("mtimeMs") ||
      identityMethod.includes("Date.now()") ||
      identityMethod.includes("refreshSeq") ||
      identityMethod.includes("tick");

    // Or loadData is called unconditionally (before the identity guard)
    const loadDataBeforeGuard = loadDataIdx < identityGuardIdx;
    // Or the guard is removed entirely and loadData always runs
    const loadDataAlwaysRuns = !refreshBody.includes("nextIdentity !== this.loadedDashboardIdentity");

    assert.ok(
      hasFileStatInIdentity || loadDataBeforeGuard || loadDataAlwaysRuns,
      "dashboard-overlay must refresh state on every tick, not just on identity change (#2561)",
    );
  }
  // If the identity guard is removed entirely, that also fixes the bug
});
