import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runGSDDoctor } from "../../doctor.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createRepoWithCompletedMilestone(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-git-symlink-cwd-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  const milestoneDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "ROADMAP.md"), `---
id: M001
title: "Test Milestone"
---

# M001: Test Milestone

## Vision
Test

## Success Criteria
- Done

## Slices
- [x] **S01: Test slice** \`risk:low\` \`depends:[]\`
  > After this: done

## Boundary Map
_None_
`);
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), `---
id: M001
title: "Test Milestone"
status: complete
completed_at: 2026-04-18T00:00:00Z
---

# M001: Test Milestone

Completed.
`);

  run("git add -A", dir);
  run("git commit -m \"add milestone\"", dir);

  return dir;
}

test("doctor removes orphaned milestone worktree when cwd uses a symlink alias", { skip: process.platform === "win32" }, async (t) => {
  const previousCwd = process.cwd();
  const dir = createRepoWithCompletedMilestone();
  const alias = join(tmpdir(), `doc-git-alias-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  t.after(() => {
    try { process.chdir(previousCwd); } catch { process.chdir(tmpdir()); }
    rmSync(alias, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  mkdirSync(join(dir, ".gsd", "worktrees"), { recursive: true });
  run("git worktree add -b milestone/M001 .gsd/worktrees/M001", dir);

  symlinkSync(dir, alias);
  process.chdir(join(alias, ".gsd", "worktrees", "M001"));

  const fixed = await runGSDDoctor(dir, { fix: true, isolationMode: "worktree" });
  assert.ok(
    fixed.fixesApplied.some(f => f.includes("removed orphaned worktree")),
    `removes orphaned worktree even when cwd uses a symlink alias (got: ${JSON.stringify(fixed.fixesApplied)})`,
  );

  const wtList = run("git worktree list", dir);
  assert.ok(!wtList.includes("milestone/M001"), "worktree removed after symlink-cwd fix");
});
