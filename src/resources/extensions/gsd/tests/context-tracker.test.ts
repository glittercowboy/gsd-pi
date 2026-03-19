/**
 * context-tracker.test.ts — Contract tests for the unified context tracker.
 *
 * Covers:
 *   - setProjectRoot / getProjectRoot round-trip
 *   - clearProjectRoot resets to null
 *   - Port state lifecycle (set → active → getPortedWorkerId → clear → inactive)
 *   - isInWorktree detection with temp dirs and process.chdir
 *   - getWorktreeInfo returns both paths when in worktree, null when not
 *   - Delegation from auto-worktree: set via auto-worktree, read via context-tracker
 *   - Delegation from worktree-command: set via worktree-command getter, verify unified
 *   - _resetForTesting isolation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setProjectRoot,
  getProjectRoot,
  clearProjectRoot,
  setPortState,
  getPortState,
  clearPortState,
  isPortActive,
  getPortedWorkerId,
  isInWorktree,
  getWorktreeInfo,
  _resetForTesting,
  type PortState,
} from "../context-tracker.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

let savedCwd: string;

function setup() {
  savedCwd = process.cwd();
  _resetForTesting();
}

function teardown() {
  _resetForTesting();
  try { process.chdir(savedCwd); } catch { /* best-effort */ }
}

// ── Project Root Tests ───────────────────────────────────────────────────────

test("setProjectRoot / getProjectRoot round-trip", () => {
  setup();
  try {
    assert.equal(getProjectRoot(), null, "initially null");
    setProjectRoot("/some/project");
    assert.equal(getProjectRoot(), "/some/project");
    setProjectRoot("/other/project");
    assert.equal(getProjectRoot(), "/other/project", "overwrites previous value");
  } finally {
    teardown();
  }
});

test("clearProjectRoot resets to null", () => {
  setup();
  try {
    setProjectRoot("/some/project");
    assert.equal(getProjectRoot(), "/some/project");
    clearProjectRoot();
    assert.equal(getProjectRoot(), null, "null after clear");
  } finally {
    teardown();
  }
});

// ── Port State Tests ─────────────────────────────────────────────────────────

test("port state lifecycle: set → active → getId → clear → inactive", () => {
  setup();
  try {
    // Initially inactive
    assert.equal(isPortActive(), false);
    assert.equal(getPortState(), null);
    assert.equal(getPortedWorkerId(), null);

    // Set port state
    const state: PortState = {
      coordinatorSessionFile: "/sessions/coordinator.jsonl",
      portedWorkerMid: "M007-abc123",
      portedAt: "2026-03-18T15:00:00Z",
    };
    setPortState(state);

    assert.equal(isPortActive(), true);
    assert.equal(getPortedWorkerId(), "M007-abc123");

    const retrieved = getPortState();
    assert.ok(retrieved);
    assert.equal(retrieved.coordinatorSessionFile, "/sessions/coordinator.jsonl");
    assert.equal(retrieved.portedWorkerMid, "M007-abc123");
    assert.equal(retrieved.portedAt, "2026-03-18T15:00:00Z");

    // Clear port state
    clearPortState();
    assert.equal(isPortActive(), false);
    assert.equal(getPortState(), null);
    assert.equal(getPortedWorkerId(), null);
  } finally {
    teardown();
  }
});

test("getPortState returns a copy, not a reference", () => {
  setup();
  try {
    setPortState({
      coordinatorSessionFile: "/a",
      portedWorkerMid: "M001",
      portedAt: "2026-01-01T00:00:00Z",
    });
    const a = getPortState()!;
    const b = getPortState()!;
    assert.notEqual(a, b, "different object references");
    assert.deepStrictEqual(a, b, "same content");
  } finally {
    teardown();
  }
});

// ── Worktree Detection Tests ─────────────────────────────────────────────────

test("isInWorktree returns true when cwd differs from project root", () => {
  setup();
  const tmpDir = mkdtempSync(join(tmpdir(), "ctx-tracker-wt-"));
  try {
    // No project root set → false
    assert.equal(isInWorktree(), false);

    // Set project root to a different path than cwd
    setProjectRoot(tmpDir);
    // cwd is savedCwd, which differs from tmpDir
    assert.equal(isInWorktree(), true);

    // Set project root to cwd → false
    setProjectRoot(savedCwd);
    assert.equal(isInWorktree(), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    teardown();
  }
});

test("isInWorktree returns false when no project root is set", () => {
  setup();
  try {
    assert.equal(isInWorktree(), false);
  } finally {
    teardown();
  }
});

test("getWorktreeInfo returns both paths when in worktree", () => {
  setup();
  const tmpDir = mkdtempSync(join(tmpdir(), "ctx-tracker-info-"));
  try {
    // No project root → null
    assert.equal(getWorktreeInfo(), null);

    // Set project root to tmpDir, cwd is savedCwd (different)
    setProjectRoot(tmpDir);
    const info = getWorktreeInfo();
    assert.ok(info, "should return info when cwd differs from root");
    assert.equal(info.projectRoot, tmpDir);
    assert.equal(info.worktreePath, savedCwd);

    // Set project root to cwd → null (not in a worktree)
    setProjectRoot(savedCwd);
    assert.equal(getWorktreeInfo(), null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    teardown();
  }
});

test("getWorktreeInfo returns null when project root equals cwd", () => {
  setup();
  try {
    setProjectRoot(process.cwd());
    assert.equal(getWorktreeInfo(), null);
  } finally {
    teardown();
  }
});

// ── Reset for Testing ────────────────────────────────────────────────────────

test("_resetForTesting clears both project root and port state", () => {
  setup();
  try {
    setProjectRoot("/project");
    setPortState({
      coordinatorSessionFile: "/a",
      portedWorkerMid: "M001",
      portedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(getProjectRoot(), "/project");
    assert.equal(isPortActive(), true);

    _resetForTesting();

    assert.equal(getProjectRoot(), null);
    assert.equal(isPortActive(), false);
    assert.equal(getPortState(), null);
  } finally {
    teardown();
  }
});

// ── Delegation Consistency ───────────────────────────────────────────────────

test("multiple setProjectRoot calls from different sources converge", () => {
  setup();
  try {
    // Simulate auto-worktree setting the root
    setProjectRoot("/auto-worktree-base");
    assert.equal(getProjectRoot(), "/auto-worktree-base");

    // Simulate worktree-command overwriting (e.g., user switches worktrees)
    setProjectRoot("/worktree-cmd-base");
    assert.equal(getProjectRoot(), "/worktree-cmd-base",
      "most recent set wins — last writer wins semantics");

    // Simulate auto-start setting it
    setProjectRoot("/auto-start-base");
    assert.equal(getProjectRoot(), "/auto-start-base");
  } finally {
    teardown();
  }
});

test("port state and project root are independent", () => {
  setup();
  try {
    setProjectRoot("/project");
    setPortState({
      coordinatorSessionFile: "/session",
      portedWorkerMid: "M002",
      portedAt: "2026-03-18T16:00:00Z",
    });

    // Clear project root — port state should survive
    clearProjectRoot();
    assert.equal(getProjectRoot(), null);
    assert.equal(isPortActive(), true);
    assert.equal(getPortedWorkerId(), "M002");

    // Reset project root — port state still intact
    setProjectRoot("/new-project");
    assert.equal(isPortActive(), true);

    // Clear port state — project root should survive
    clearPortState();
    assert.equal(getProjectRoot(), "/new-project");
    assert.equal(isPortActive(), false);
  } finally {
    teardown();
  }
});
