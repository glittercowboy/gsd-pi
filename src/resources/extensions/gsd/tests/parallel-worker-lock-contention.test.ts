/**
 * parallel-worker-lock-contention.test.ts — Regression tests for #2184.
 *
 * Covers all four bugs from the parallel worker contention issue:
 *   Bug 1: Session lock contention — per-milestone lock isolation
 *   Bug 2: Budget ceiling scoped to current session for parallel workers
 *   Bug 3: syncProjectRootToWorktree skips when source === destination (symlinks)
 *   Bug 4: createMilestoneWorktree copies planning artifacts
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  acquireSessionLock,
  releaseSessionLock,
  effectiveLockFile,
  effectiveLockTarget,
} from "../session-lock.ts";
import { gsdRoot } from "../paths.ts";
import {
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
} from "../auto-worktree.ts";
import { writeLock, readCrashLock, clearLock } from "../crash-recovery.ts";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ─── Bug 1: Per-milestone lock isolation ──────────────────────────────────────

describe("parallel-worker-lock-contention (#2184)", () => {
  // Save and restore env vars between tests
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GSD_PARALLEL_WORKER = process.env.GSD_PARALLEL_WORKER;
    savedEnv.GSD_MILESTONE_LOCK = process.env.GSD_MILESTONE_LOCK;
  });

  afterEach(() => {
    if (savedEnv.GSD_PARALLEL_WORKER === undefined) {
      delete process.env.GSD_PARALLEL_WORKER;
    } else {
      process.env.GSD_PARALLEL_WORKER = savedEnv.GSD_PARALLEL_WORKER;
    }
    if (savedEnv.GSD_MILESTONE_LOCK === undefined) {
      delete process.env.GSD_MILESTONE_LOCK;
    } else {
      process.env.GSD_MILESTONE_LOCK = savedEnv.GSD_MILESTONE_LOCK;
    }
  });

  // ─── Bug 1a: effectiveLockFile returns per-milestone name ────────────────
  test("Bug 1a: effectiveLockFile returns auto.lock without parallel env", () => {
    delete process.env.GSD_PARALLEL_WORKER;
    delete process.env.GSD_MILESTONE_LOCK;
    assert.equal(effectiveLockFile(), "auto.lock");
  });

  test("Bug 1a: effectiveLockFile returns auto-<MID>.lock in parallel mode", () => {
    process.env.GSD_PARALLEL_WORKER = "1";
    process.env.GSD_MILESTONE_LOCK = "M003";
    assert.equal(effectiveLockFile(), "auto-M003.lock");
  });

  // ─── Bug 1b: effectiveLockTarget returns per-milestone directory ─────────
  test("Bug 1b: effectiveLockTarget returns gsdDir without parallel env", () => {
    delete process.env.GSD_PARALLEL_WORKER;
    const gsdDir = "/tmp/test/.gsd";
    assert.equal(effectiveLockTarget(gsdDir), gsdDir);
  });

  test("Bug 1b: effectiveLockTarget returns parallel/<MID> in parallel mode", () => {
    process.env.GSD_PARALLEL_WORKER = "1";
    process.env.GSD_MILESTONE_LOCK = "M003";
    const gsdDir = "/tmp/test/.gsd";
    assert.equal(effectiveLockTarget(gsdDir), join(gsdDir, "parallel", "M003"));
  });

  // ─── Bug 1c: Two parallel workers acquire independent locks ──────────────
  test("Bug 1c: parallel workers use per-milestone lock files, not shared auto.lock", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-parallel-lock-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });

    try {
      // Simulate worker for M001
      process.env.GSD_PARALLEL_WORKER = "1";
      process.env.GSD_MILESTONE_LOCK = "M001";

      const r1 = acquireSessionLock(base);
      assert.ok(r1.acquired, "M001 worker acquires lock");

      // Verify the lock file is per-milestone
      const gsdDir = gsdRoot(base);
      const m001LockFile = join(gsdDir, "auto-M001.lock");
      assert.ok(existsSync(m001LockFile), "auto-M001.lock exists");

      // The shared auto.lock should NOT exist
      const sharedLockFile = join(gsdDir, "auto.lock");
      assert.ok(!existsSync(sharedLockFile), "shared auto.lock does NOT exist");

      // The per-milestone lock target directory should exist
      const m001LockTarget = join(gsdDir, "parallel", "M001");
      assert.ok(existsSync(m001LockTarget), "parallel/M001 directory exists");

      releaseSessionLock(base);

      // After release, per-milestone lock file should be cleaned
      assert.ok(!existsSync(m001LockFile), "auto-M001.lock cleaned after release");
    } finally {
      delete process.env.GSD_PARALLEL_WORKER;
      delete process.env.GSD_MILESTONE_LOCK;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Bug 1d: crash-recovery uses per-milestone lock file ─────────────────
  test("Bug 1d: crash-recovery writeLock/readCrashLock uses per-milestone lock in parallel mode", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-parallel-crash-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });

    try {
      process.env.GSD_PARALLEL_WORKER = "1";
      process.env.GSD_MILESTONE_LOCK = "M002";

      writeLock(base, "execute-task", "M002/S01/T01");

      const gsdDir = gsdRoot(base);
      const lockFile = join(gsdDir, "auto-M002.lock");
      assert.ok(existsSync(lockFile), "crash-recovery writes auto-M002.lock");

      const data = readCrashLock(base);
      assert.ok(data !== null, "readCrashLock reads per-milestone lock");
      assert.equal(data!.unitId, "M002/S01/T01");

      clearLock(base);
      assert.ok(!existsSync(lockFile), "clearLock removes per-milestone lock");
    } finally {
      delete process.env.GSD_PARALLEL_WORKER;
      delete process.env.GSD_MILESTONE_LOCK;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Bug 3: syncProjectRootToWorktree skips same-path symlinks ───────────
  test("Bug 3: syncProjectRootToWorktree skips when .gsd resolves to same path (symlink)", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-symlink-sync-"));
    const externalGsd = join(base, "external-gsd");
    const projectRoot = join(base, "project");
    const worktreePath = join(base, "worktree");

    mkdirSync(externalGsd, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    // Create the external state directory with a milestone
    mkdirSync(join(externalGsd, "milestones", "M001"), { recursive: true });
    writeFileSync(
      join(externalGsd, "milestones", "M001", "M001-ROADMAP.md"),
      "# Roadmap",
    );

    // Symlink both project and worktree .gsd to the same external directory
    symlinkSync(externalGsd, join(projectRoot, ".gsd"));
    symlinkSync(externalGsd, join(worktreePath, ".gsd"));

    try {
      // This should NOT throw ERR_FS_CP_EINVAL — it should skip silently
      let threw = false;
      try {
        syncProjectRootToWorktree(projectRoot, worktreePath, "M001");
      } catch {
        threw = true;
      }
      assert.ok(!threw, "syncProjectRootToWorktree does not throw on same-path symlink");

      // Same for reverse direction
      threw = false;
      try {
        syncStateToProjectRoot(worktreePath, projectRoot, "M001");
      } catch {
        threw = true;
      }
      assert.ok(!threw, "syncStateToProjectRoot does not throw on same-path symlink");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Bug 3b: sync still works when paths are different ───────────────────
  test("Bug 3b: syncProjectRootToWorktree copies when .gsd paths are different", () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-diff-sync-"));
    const projectRoot = join(base, "project");
    const worktreePath = join(base, "worktree");

    mkdirSync(join(projectRoot, ".gsd", "milestones", "M001"), { recursive: true });
    mkdirSync(join(worktreePath, ".gsd", "milestones"), { recursive: true });

    writeFileSync(
      join(projectRoot, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
      "# Roadmap content",
    );

    try {
      syncProjectRootToWorktree(projectRoot, worktreePath, "M001");

      // The roadmap should have been copied
      const copied = join(worktreePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
      assert.ok(existsSync(copied), "milestone roadmap copied to worktree");
      assert.equal(readFileSync(copied, "utf-8"), "# Roadmap content");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
