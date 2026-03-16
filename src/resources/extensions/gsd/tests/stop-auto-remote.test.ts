import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { writeFileSync } from "node:fs";
import {
  writeLock,
  readCrashLock,
  clearLock,
  isLockProcessAlive,
} from "../crash-recovery.ts";
import { stopAutoRemote } from "../auto.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
}

function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }

    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(child.exitCode);
    }, timeoutMs);

    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      resolve(code);
    };

    child.once("exit", onExit);
  });
}

// ─── stopAutoRemote ──────────────────────────────────────────────────────

test("stopAutoRemote returns found:false when no lock file exists", () => {
  const base = makeTmpBase();
  try {
    const result = stopAutoRemote(base);
    assert.equal(result.found, false);
    assert.equal(result.pid, undefined);
    assert.equal(result.error, undefined);
  } finally {
    cleanup(base);
  }
});

test("stopAutoRemote cleans up stale lock (dead PID) and returns found:false", () => {
  const base = makeTmpBase();
  try {
    // Write a lock with a PID that doesn't exist
    writeLock(base, "execute-task", "M001/S01/T01", 3);
    // Overwrite PID to a dead one
    const lock = readCrashLock(base)!;
    const staleData = { ...lock, pid: 999999999 };
    writeFileSync(join(base, ".gsd", "auto.lock"), JSON.stringify(staleData, null, 2), "utf-8");

    const result = stopAutoRemote(base);
    assert.equal(result.found, false, "stale lock should not be found as running");

    // Lock should be cleaned up
    assert.equal(readCrashLock(base), null, "stale lock should be removed");
  } finally {
    cleanup(base);
  }
});

test("stopAutoRemote sends SIGTERM to a live process and returns found:true", async () => {
  const base = makeTmpBase();

  // Spawn a child process that sleeps, acting as a fake auto-mode session
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(1), 30000);"],
    { stdio: "ignore", detached: false },
  );

  if (!child.pid) {
    throw new Error("failed to spawn child process for stopAutoRemote test");
  }

  try {
    // Wait for child to be ready
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Write lock with child's PID
    const lockData = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      unitStartedAt: new Date().toISOString(),
      completedUnits: 0,
    };
    writeFileSync(join(base, ".gsd", "auto.lock"), JSON.stringify(lockData, null, 2), "utf-8");

    const exitPromise = waitForChildExit(child);
    const result = stopAutoRemote(base);
    assert.equal(result.found, true, "should find running auto-mode");
    assert.equal(result.pid, child.pid, "should return the PID");

    // Wait for child to exit (it should receive SIGTERM)
    const exitCode = await exitPromise;
    // On Windows, SIGTERM is not interceptable — the process exits with code 1
    // rather than running the handler. Accept either clean exit (0) or forced (1).
    assert.ok(exitCode !== null, "child should have exited after SIGTERM");
    if (process.platform !== "win32") {
      assert.equal(exitCode, 0, "child should have exited cleanly via SIGTERM");
    }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    cleanup(base);
  }
});

// ─── Lock path: original project root vs worktree ────────────────────────

test("lock file should be discoverable at project root, not worktree path", () => {
  const projectRoot = makeTmpBase();
  const worktreePath = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(join(worktreePath, ".gsd"), { recursive: true });

  try {
    // Simulate: auto-mode writes lock to project root (the fix)
    writeLock(projectRoot, "execute-task", "M001/S01/T01", 0);

    // Second terminal checks project root — should find the lock
    const lock = readCrashLock(projectRoot);
    assert.ok(lock, "lock should be found at project root");
    assert.equal(lock!.unitType, "execute-task");

    // Worktree path should NOT have a lock
    const worktreeLock = readCrashLock(worktreePath);
    assert.equal(worktreeLock, null, "lock should NOT exist at worktree path");
  } finally {
    cleanup(projectRoot);
  }
});
