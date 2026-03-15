/**
 * isolation-resolver.test.ts -- Tests for shouldUseWorktreeIsolation resolver.
 *
 * Tests three resolution paths:
 *  1. Explicit git.isolation preference overrides everything
 *  2. Legacy detection: existing gsd/*\/* branches = branch mode
 *  3. Default: new project = worktree mode
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { shouldUseWorktreeIsolation } from "../auto-worktree.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iso-resolver-test-")));
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

  console.log("\n=== shouldUseWorktreeIsolation ===");

  // Test 1: New project with no gsd branches → defaults to worktree (true)
  {
    const dir = createTempRepo();
    try {
      const result = shouldUseWorktreeIsolation(dir);
      assertEq(result, true, "new project defaults to worktree isolation");
    } finally {
      process.chdir(savedCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test 2: Legacy project with gsd/*/* branches → returns false (branch mode)
  {
    const dir = createTempRepo();
    try {
      // Create a legacy gsd/*/* branch
      run("git checkout -b gsd/M001/S01", dir);
      writeFileSync(join(dir, "slice.md"), "# S01\n");
      run("git add .", dir);
      run("git commit -m \"slice work\"", dir);
      run("git checkout main", dir);

      const result = shouldUseWorktreeIsolation(dir);
      assertEq(result, false, "legacy project with gsd branches → branch mode");
    } finally {
      process.chdir(savedCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test 3: Explicit preference override -- isolation: "worktree"
  {
    const dir = createTempRepo();
    try {
      // Create legacy branches that would normally trigger branch mode
      run("git checkout -b gsd/M001/S01", dir);
      writeFileSync(join(dir, "slice.md"), "# S01\n");
      run("git add .", dir);
      run("git commit -m \"slice work\"", dir);
      run("git checkout main", dir);

      const result = shouldUseWorktreeIsolation(dir, { isolation: "worktree" });
      assertEq(result, true, "explicit isolation: worktree overrides legacy detection");
    } finally {
      process.chdir(savedCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Test 4: Explicit preference override -- isolation: "branch"
  {
    const dir = createTempRepo();
    try {
      // No legacy branches -- would normally default to worktree
      const result = shouldUseWorktreeIsolation(dir, { isolation: "branch" });
      assertEq(result, false, "explicit isolation: branch overrides default");
    } finally {
      process.chdir(savedCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  report();
}

main();
