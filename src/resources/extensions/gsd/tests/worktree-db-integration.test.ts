/**
 * worktree-db-integration.test.ts
 *
 * Integration tests for the worktree DB copy and reconcile hooks.
 * Uses real temp git repos and real SQLite databases.
 *
 * Test cases:
 *   1. Copy: createAutoWorktree seeds .gsd/gsd.db into the worktree when main has one
 *   2. Copy-skip: createAutoWorktree silently skips when main has no gsd.db
 *   3. Reconcile: reconcileWorktreeDb merges worktree rows into main DB
 *   4. Reconcile-skip: reconcileWorktreeDb is non-fatal when both paths are nonexistent
 *   5. Failure path: reconcileWorktreeDb emits to stderr on open failure (observable)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { createAutoWorktree } from "../auto-worktree.ts";
import { worktreePath } from "../worktree-manager.ts";
import {
  copyWorktreeDb,
  reconcileWorktreeDb,
  openDatabase,
  closeDatabase,
  upsertDecision,
  getActiveDecisions,
  isDbAvailable,
} from "../gsd-db.ts";

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-db-int-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}

async function main(): Promise<void> {
  const savedCwd = process.cwd();
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-db-int-")));
    tempDirs.push(dir);
    return dir;
  }

  try {

    // ─── Test 1: copy on worktree creation ───────────────────────────
    console.log("\n=== Test 1: copy on worktree creation ===");
    {
      const tempDir = createTempRepo();
      tempDirs.push(tempDir);

      // Seed a gsd.db in the main repo
      const gsdDir = join(tempDir, ".gsd");
      mkdirSync(gsdDir, { recursive: true });
      const mainDbPath = join(gsdDir, "gsd.db");
      openDatabase(mainDbPath);
      closeDatabase();

      // Commit so createAutoWorktree can copy planning artifacts
      run("git add .", tempDir);
      run('git commit -m "add gsd dir"', tempDir);

      // createAutoWorktree should copy the DB into the worktree
      const wtPath = createAutoWorktree(tempDir, "M004");

      const worktreeDbPath = join(worktreePath(tempDir, "M004"), ".gsd", "gsd.db");
      assertTrue(
        existsSync(worktreeDbPath),
        "gsd.db exists in worktree .gsd after createAutoWorktree",
      );

      // Restore cwd for next test
      process.chdir(savedCwd);
    }

    // ─── Test 2: copy skip when no source DB ─────────────────────────
    console.log("\n=== Test 2: copy skip when no source DB ===");
    {
      const tempDir = createTempRepo();
      tempDirs.push(tempDir);

      // No gsd.db — just a bare repo
      let threw = false;
      let wtPath: string | null = null;
      try {
        wtPath = createAutoWorktree(tempDir, "M004");
      } catch (err) {
        threw = true;
        console.error("  Unexpected throw:", err);
      }

      assertTrue(!threw, "createAutoWorktree does not throw when no source DB");

      const worktreeDbPath = join(worktreePath(tempDir, "M004"), ".gsd", "gsd.db");
      assertTrue(
        !existsSync(worktreeDbPath),
        "gsd.db is absent in worktree when source had none",
      );

      process.chdir(savedCwd);
    }

    // ─── Test 3: reconcile inserts worktree rows into main ───────────
    console.log("\n=== Test 3: reconcile merges worktree rows into main ===");
    {
      const mainDbPath = join(makeTempDir(), "main.db");
      const worktreeDbPath = join(makeTempDir(), "wt.db");

      // Seed main DB (empty schema)
      openDatabase(mainDbPath);
      closeDatabase();

      // Seed worktree DB with one decision
      openDatabase(worktreeDbPath);
      upsertDecision({
        id: "D-WT-001",
        when_context: "integration test",
        scope: "test",
        decision: "use reconcile",
        choice: "reconcile on merge",
        rationale: "test coverage",
        revisable: "no",
        superseded_by: null,
      });
      closeDatabase();

      // Reconcile worktree → main
      const result = reconcileWorktreeDb(mainDbPath, worktreeDbPath);
      assertTrue(result.decisions >= 1, "reconcile reports at least 1 decision merged");

      // Open main DB and verify the row is present
      openDatabase(mainDbPath);
      const decisions = getActiveDecisions();
      closeDatabase();

      const found = decisions.some((d) => d.id === "D-WT-001");
      assertTrue(found, "worktree decision D-WT-001 present in main DB after reconcile");
    }

    // ─── Test 4: reconcile non-fatal when both paths nonexistent ─────
    console.log("\n=== Test 4: reconcile non-fatal on nonexistent paths ===");
    {
      let threw = false;
      try {
        reconcileWorktreeDb("/nonexistent/path/gsd.db", "/also/nonexistent/gsd.db");
      } catch {
        threw = true;
      }
      assertTrue(!threw, "reconcileWorktreeDb does not throw when worktree DB is absent");
    }

    // ─── Test 5: failure path observable via stderr (diagnostic) ─────
    // reconcileWorktreeDb emits to stderr on reconciliation failures.
    // We can't easily intercept stderr in this test harness, but we verify
    // that the function returns the zero-result shape (not undefined/throws)
    // when the worktree DB is missing — confirming the failure path is non-fatal
    // and returns a structured result.
    console.log("\n=== Test 5: reconcile returns zero-shape when worktree DB absent ===");
    {
      const mainDbPath = join(makeTempDir(), "main2.db");
      openDatabase(mainDbPath);
      closeDatabase();

      const result = reconcileWorktreeDb(mainDbPath, "/definitely/does/not/exist.db");
      assertEq(result.decisions, 0, "decisions is 0 when worktree DB absent");
      assertEq(result.requirements, 0, "requirements is 0 when worktree DB absent");
      assertEq(result.artifacts, 0, "artifacts is 0 when worktree DB absent");
      assertEq(result.conflicts.length, 0, "conflicts is empty when worktree DB absent");
    }

  } finally {
    // Always restore cwd
    process.chdir(savedCwd);
    // Ensure DB is closed
    if (isDbAvailable()) closeDatabase();
    // Remove all temp dirs
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  report();
}

main();
