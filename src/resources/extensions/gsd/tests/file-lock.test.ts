import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { withFileLock, withFileLockSync } from "../file-lock.ts";

const require = createRequire(import.meta.url);

function hasProperLockfile(): boolean {
  try {
    require("proper-lockfile");
    return true;
  } catch {
    return false;
  }
}

test("withFileLockSync: executes callback when file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  try {
    const missingPath = join(dir, "missing.txt");
    let called = 0;
    const result = withFileLockSync(missingPath, () => {
      called++;
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(called, 1, "callback should execute exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock: executes callback when file does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  try {
    const missingPath = join(dir, "missing.txt");
    let called = 0;
    const result = await withFileLock(missingPath, async () => {
      called++;
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(called, 1, "callback should execute exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLockSync: throws ELOCKED by default (no silent fallback)", () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }

  const lockfile = require("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");

  const release = lockfile.lockSync(filePath, { retries: 0, stale: 10000 });
  try {
    let called = 0;
    assert.throws(
      () => {
        withFileLockSync(
          filePath,
          () => {
            called++;
            return "should-not-return";
          },
          { retries: 0 },
        );
      },
      (err: any) => err?.code === "ELOCKED",
    );
    assert.equal(called, 0, "callback must not run when lock cannot be acquired");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLockSync: onLocked=\"skip\" runs callback unlocked on ELOCKED", () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }

  const lockfile = require("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");

  const release = lockfile.lockSync(filePath, { retries: 0, stale: 10000 });
  try {
    let called = 0;
    const result = withFileLockSync(
      filePath,
      () => {
        called++;
        return "fallback-ok";
      },
      { retries: 0, onLocked: "skip" },
    );
    assert.equal(result, "fallback-ok");
    assert.equal(called, 1, "callback should run when onLocked is skip");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock: throws ELOCKED by default (no silent fallback)", async () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }

  const lockfile = require("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");

  const release = await lockfile.lock(filePath, { retries: 0, stale: 10000 });
  try {
    let called = 0;
    await assert.rejects(
      async () => {
        await withFileLock(
          filePath,
          async () => {
            called++;
            return "should-not-return";
          },
          { retries: 0 },
        );
      },
      (err: any) => err?.code === "ELOCKED",
    );
    assert.equal(called, 0, "callback must not run when lock cannot be acquired");
  } finally {
    await release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock: onLocked=\"skip\" runs callback unlocked on ELOCKED", async () => {
  if (!hasProperLockfile() || process.platform === "win32") {
    return;
  }

  const lockfile = require("proper-lockfile");
  const dir = mkdtempSync(join(tmpdir(), "gsd-file-lock-test-"));
  const filePath = join(dir, "locked.jsonl");
  writeFileSync(filePath, "{}\n", "utf-8");

  const release = await lockfile.lock(filePath, { retries: 0, stale: 10000 });
  try {
    let called = 0;
    const result = await withFileLock(
      filePath,
      async () => {
        called++;
        return "fallback-ok";
      },
      { retries: 0, onLocked: "skip" },
    );
    assert.equal(result, "fallback-ok");
    assert.equal(called, 1, "callback should run when onLocked is skip");
  } finally {
    await release();
    rmSync(dir, { recursive: true, force: true });
  }
});
