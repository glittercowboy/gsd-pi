/**
 * parallel-commit-scope.test.ts — Regression test for #1991.
 *
 * Parallel workers must only commit files belonging to their locked milestone.
 * When GSD_MILESTONE_LOCK is set, smartStage() must exclude .gsd/milestones/<M>/
 * directories for milestones other than the locked one.
 *
 * Without the fix, a worker for M033 can stage and commit fabricated artifacts
 * under .gsd/milestones/M032/, causing cross-milestone pollution.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  GitServiceImpl,
} from "../git-service.ts";

function run(command: string, cwd: string): string {
  const [cmd, ...args] = command.split(" ");
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function gitRun(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createFile(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-parallel-scope-"));
  gitRun(["init", "-b", "main"], dir);
  gitRun(["config", "user.name", "Test"], dir);
  gitRun(["config", "user.email", "test@test.com"], dir);
  createFile(dir, ".gitkeep", "");
  gitRun(["add", "-A"], dir);
  gitRun(["commit", "-m", "init"], dir);
  return dir;
}

describe("parallel commit scope (#1991)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.GSD_MILESTONE_LOCK = process.env.GSD_MILESTONE_LOCK;
    savedEnv.GSD_PARALLEL_WORKER = process.env.GSD_PARALLEL_WORKER;
  });

  afterEach(() => {
    for (const key of ["GSD_MILESTONE_LOCK", "GSD_PARALLEL_WORKER"] as const) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("autoCommit excludes other milestone directories when GSD_MILESTONE_LOCK is set", () => {
    const repo = initTempRepo();

    // Set up parallel worker environment for M033
    process.env.GSD_MILESTONE_LOCK = "M033";
    process.env.GSD_PARALLEL_WORKER = "1";

    // Create dirty files in BOTH milestones (simulates cross-milestone pollution)
    createFile(repo, ".gsd/milestones/M032/M032-SUMMARY.md", "# M032 Summary\nFabricated by M033 worker");
    createFile(repo, ".gsd/milestones/M032/M032-VALIDATION.md", "# M032 Validation\nFabricated");
    createFile(repo, ".gsd/milestones/M032/slices/S01/S01-SUMMARY.md", "Fabricated S01 summary");
    createFile(repo, ".gsd/milestones/M033/slices/S01/tasks/T01-SUMMARY.md", "Legit T01 summary");
    createFile(repo, "src/feature.ts", "export const x = 1;");

    const svc = new GitServiceImpl(repo);
    const msg = svc.autoCommit("complete-milestone", "M033/complete");
    assert.ok(msg !== null, "autoCommit should produce a commit");

    const committed = gitRun(["show", "--name-only", "HEAD"], repo);

    // Source files and own milestone files SHOULD be committed
    assert.ok(committed.includes("src/feature.ts"), "source files are committed");
    assert.ok(committed.includes(".gsd/milestones/M033/"), "own milestone files are committed");

    // Other milestone files MUST NOT be committed
    assert.ok(!committed.includes(".gsd/milestones/M032/"),
      "M032 files must NOT be committed by M033 worker — cross-milestone pollution (#1991)");

    // Verify M032 files are still dirty (unstaged) in the working tree
    const status = gitRun(["status", "--porcelain"], repo);
    assert.ok(status.includes("M032"), "M032 files remain as untracked/dirty in working tree");

    rmSync(repo, { recursive: true, force: true });
  });

  test("autoCommit stages all milestones when GSD_MILESTONE_LOCK is NOT set (solo mode)", () => {
    const repo = initTempRepo();

    // No milestone lock — solo worker mode
    delete process.env.GSD_MILESTONE_LOCK;
    delete process.env.GSD_PARALLEL_WORKER;

    createFile(repo, ".gsd/milestones/M032/M032-SUMMARY.md", "# M032 Summary");
    createFile(repo, ".gsd/milestones/M033/slices/S01/tasks/T01-SUMMARY.md", "T01 summary");
    createFile(repo, "src/feature.ts", "export const x = 1;");

    const svc = new GitServiceImpl(repo);
    const msg = svc.autoCommit("complete-milestone", "M032/complete");
    assert.ok(msg !== null, "autoCommit should produce a commit");

    const committed = gitRun(["show", "--name-only", "HEAD"], repo);

    // In solo mode, ALL milestone files should be committed
    assert.ok(committed.includes(".gsd/milestones/M032/"), "M032 files committed in solo mode");
    assert.ok(committed.includes(".gsd/milestones/M033/"), "M033 files committed in solo mode");
    assert.ok(committed.includes("src/feature.ts"), "source files committed in solo mode");

    rmSync(repo, { recursive: true, force: true });
  });

  test("autoCommit scopes to locked milestone even with multiple foreign milestones", () => {
    const repo = initTempRepo();

    process.env.GSD_MILESTONE_LOCK = "M035";
    process.env.GSD_PARALLEL_WORKER = "1";

    // Create files across many milestones
    createFile(repo, ".gsd/milestones/M032/M032-SUMMARY.md", "foreign");
    createFile(repo, ".gsd/milestones/M033/M033-SUMMARY.md", "foreign");
    createFile(repo, ".gsd/milestones/M034/M034-SUMMARY.md", "foreign");
    createFile(repo, ".gsd/milestones/M035/slices/S01/tasks/T01-SUMMARY.md", "own work");
    createFile(repo, "src/app.ts", "export const app = {};");

    const svc = new GitServiceImpl(repo);
    const msg = svc.autoCommit("execute-task", "M035/S01/T01");
    assert.ok(msg !== null, "autoCommit should produce a commit");

    const committed = gitRun(["show", "--name-only", "HEAD"], repo);

    assert.ok(committed.includes(".gsd/milestones/M035/"), "own milestone committed");
    assert.ok(committed.includes("src/app.ts"), "source files committed");
    assert.ok(!committed.includes(".gsd/milestones/M032/"), "M032 excluded");
    assert.ok(!committed.includes(".gsd/milestones/M033/"), "M033 excluded");
    assert.ok(!committed.includes(".gsd/milestones/M034/"), "M034 excluded");

    rmSync(repo, { recursive: true, force: true });
  });
});
