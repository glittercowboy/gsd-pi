/**
 * migrate-external-ebusy.test.ts — Regression tests for #3147.
 *
 * Verifies that migrateToExternalState() handles EBUSY/EPERM errors
 * gracefully during the copy+delete fallback, and guards against
 * migrating the user-level ~/.gsd directory.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  migrateToExternalState,
  recoverFailedMigration,
  _isGlobalGsdHome,
  _isTransientLockError,
} from "../migrate-external.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" }).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-ebusy-test-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── isGlobalGsdHome guard ──────────────────────────────────────────

describe("isGlobalGsdHome", () => {
  test("detects default ~/.gsd as global home", () => {
    const gsdHome = join(homedir(), ".gsd");
    assert.equal(_isGlobalGsdHome(gsdHome), true);
  });

  test("detects GSD_HOME override as global home", (t) => {
    const tmpHome = mkdtempSync(join(tmpdir(), "gsd-home-test-"));
    t.after(() => cleanup(tmpHome));

    const origGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      if (origGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = origGsdHome;
    });

    assert.equal(_isGlobalGsdHome(tmpHome), true);
  });

  test("returns false for project .gsd directories", () => {
    assert.equal(_isGlobalGsdHome("/some/project/.gsd"), false);
  });
});

// ─── isTransientLockError ───────────────────────────────────────────

describe("isTransientLockError", () => {
  test("identifies EBUSY errors", () => {
    const err = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    assert.equal(_isTransientLockError(err), true);
  });

  test("identifies EPERM errors", () => {
    const err = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    assert.equal(_isTransientLockError(err), true);
  });

  test("rejects non-transient errors", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    assert.equal(_isTransientLockError(err), false);
  });

  test("rejects non-error values", () => {
    assert.equal(_isTransientLockError(null), false);
    assert.equal(_isTransientLockError("EBUSY"), false);
    assert.equal(_isTransientLockError(42), false);
  });
});

// ─── migrateToExternalState — home dir guard (#3147) ────────────────

describe("migrateToExternalState — home directory guard", () => {
  test("skips migration when .gsd is the global GSD home (#3147)", (t) => {
    // Simulate: user's home dir is a git repo, so basePath = ~ and
    // .gsd = ~/.gsd (the global state dir, not a project .gsd).
    const tmpHome = makeTempRepo();
    t.after(() => cleanup(tmpHome));

    const gsdDir = join(tmpHome, ".gsd");
    mkdirSync(gsdDir, { recursive: true });
    writeFileSync(join(gsdDir, "PROJECT.md"), "# Should not migrate\n");

    const origGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdDir;
    t.after(() => {
      if (origGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = origGsdHome;
    });

    const result = migrateToExternalState(tmpHome);
    assert.equal(result.migrated, false);
    assert.equal(result.error, undefined, "Should silently skip, not report an error");
    assert.ok(existsSync(join(gsdDir, "PROJECT.md")), ".gsd/ should remain untouched");
  });
});

// ─── migrateToExternalState — skip conditions ───────────────────────

describe("migrateToExternalState — skip conditions", () => {
  test("skips when .gsd does not exist", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, false);
    assert.equal(result.error, undefined);
  });

  test("skips when .gsd is already a symlink", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    const target = mkdtempSync(join(tmpdir(), "gsd-symlink-target-"));
    t.after(() => cleanup(target));

    symlinkSync(target, join(dir, ".gsd"));
    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, false);
    assert.equal(result.error, undefined);
  });

  test("skips when .gsd/worktrees/ has active subdirectories", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    mkdirSync(join(dir, ".gsd", "worktrees", "some-worktree"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# test\n");

    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, false);
    assert.equal(result.error, undefined);
    assert.ok(existsSync(join(dir, ".gsd", "PROJECT.md")), ".gsd/ should remain");
  });
});

// ─── recoverFailedMigration ─────────────────────────────────────────

describe("recoverFailedMigration", () => {
  test("recovers .gsd.migrating back to .gsd when .gsd is absent", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    mkdirSync(join(dir, ".gsd.migrating"), { recursive: true });
    writeFileSync(join(dir, ".gsd.migrating", "PROJECT.md"), "# recovered\n");

    const recovered = recoverFailedMigration(dir);
    assert.equal(recovered, true);
    assert.ok(existsSync(join(dir, ".gsd", "PROJECT.md")), ".gsd should be restored");
    assert.ok(!existsSync(join(dir, ".gsd.migrating")), ".gsd.migrating should be gone");
  });

  test("does not touch anything when both .gsd and .gsd.migrating exist", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    mkdirSync(join(dir, ".gsd"), { recursive: true });
    mkdirSync(join(dir, ".gsd.migrating"), { recursive: true });

    const recovered = recoverFailedMigration(dir);
    assert.equal(recovered, false);
    assert.ok(existsSync(join(dir, ".gsd")), ".gsd should remain");
    assert.ok(existsSync(join(dir, ".gsd.migrating")), ".gsd.migrating should remain");
  });

  test("returns false when .gsd.migrating does not exist", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    const recovered = recoverFailedMigration(dir);
    assert.equal(recovered, false);
  });
});

// ─── migrateToExternalState — happy path ────────────────────────────

describe("migrateToExternalState — happy path", () => {
  test("migrates .gsd to external state and creates symlink", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    // Set up external state dir in a temp location
    const externalBase = mkdtempSync(join(tmpdir(), "gsd-external-"));
    t.after(() => cleanup(externalBase));

    const origStateDir = process.env.GSD_STATE_DIR;
    process.env.GSD_STATE_DIR = externalBase;
    t.after(() => {
      if (origStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = origStateDir;
    });

    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test Project\n");
    writeFileSync(join(dir, ".gsd", "STATE.md"), "state\n");

    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, true, `Migration should succeed: ${result.error}`);

    // .gsd should now be a symlink
    const stat = lstatSync(join(dir, ".gsd"));
    assert.ok(stat.isSymbolicLink(), ".gsd should be a symlink after migration");

    // Content should be accessible through the symlink
    assert.ok(existsSync(join(dir, ".gsd", "PROJECT.md")), "PROJECT.md accessible through symlink");

    // .gsd.migrating should be cleaned up
    assert.ok(!existsSync(join(dir, ".gsd.migrating")), ".gsd.migrating should be removed");
  });

  test("skips worktrees/ directory during content copy", (t) => {
    const dir = makeTempRepo();
    t.after(() => cleanup(dir));

    const externalBase = mkdtempSync(join(tmpdir(), "gsd-external-"));
    t.after(() => cleanup(externalBase));

    const origStateDir = process.env.GSD_STATE_DIR;
    process.env.GSD_STATE_DIR = externalBase;
    t.after(() => {
      if (origStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = origStateDir;
    });

    mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
    // Empty worktrees dir (no subdirs) — migration should proceed but skip it
    writeFileSync(join(dir, ".gsd", "PROJECT.md"), "# Test\n");

    const result = migrateToExternalState(dir);
    assert.equal(result.migrated, true, `Migration should succeed: ${result.error}`);

    // worktrees/ should NOT exist in the external dir
    const externalProjects = readdirSync(join(externalBase, "projects"));
    assert.ok(externalProjects.length === 1, "Should have one project dir");
    const projectDir = join(externalBase, "projects", externalProjects[0]);
    assert.ok(!existsSync(join(projectDir, "worktrees")), "worktrees/ should not be in external state");
  });
});
