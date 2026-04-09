// GSD2 — Tests for auditOrphanedMilestoneBranches bootstrap audit
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { auditOrphanedMilestoneBranches } from "../auto-start.ts";
import { openDatabase, closeDatabase, insertMilestone, updateMilestoneStatus } from "../gsd-db.ts";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

/** Create a temp git repo with .gsd structure and DB. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orphan-audit-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);

  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);

  // Create .gsd structure on disk (not tracked in git)
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });

  return dir;
}

describe("auditOrphanedMilestoneBranches", () => {
  let dir: string;

  beforeEach(() => {
    dir = createRepo();
    openDatabase(join(dir, ".gsd", "gsd.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no milestone branches → no-op", () => {
    const result = auditOrphanedMilestoneBranches(dir, "worktree");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
  });

  test("skips in none isolation mode", () => {
    // Create a milestone branch that would otherwise be detected
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "none");
    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);

    // Branch should still exist
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "branch should be preserved in none mode");
  });

  test("deletes merged branch for completed milestone", () => {
    // Create milestone branch from main (so it's already merged)
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some(r => r.includes("Deleted merged branch milestone/M001")),
      "should report branch deletion",
    );
    assert.deepStrictEqual(result.warnings, []);

    // Branch should be gone
    const branches = run("git branch --list milestone/M001", dir);
    assert.deepStrictEqual(branches, "", "branch should be deleted");
  });

  test("warns about unmerged branch for completed milestone", () => {
    // Create milestone branch with divergent commits (not merged into main)
    run("git checkout -b milestone/M001", dir);
    writeFileSync(join(dir, "feature.txt"), "new feature\n");
    run("git add feature.txt", dir);
    run("git commit -m \"add feature on milestone branch\"", dir);
    run("git checkout main", dir);

    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, [], "should not delete unmerged branch");
    assert.ok(result.warnings.length > 0, "should have warnings");
    assert.ok(
      result.warnings.some(w => w.includes("NOT merged")),
      "should warn about unmerged branch",
    );

    // Branch should still exist (data safety)
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "unmerged branch must be preserved");
  });

  test("skips active (non-complete) milestone branches", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);

    // Branch should still exist
    const branches = run("git branch --list milestone/M001", dir);
    assert.ok(branches.includes("milestone/M001"), "active milestone branch should be preserved");
  });

  test("cleans up orphaned worktree directory for merged milestone", () => {
    // Create milestone branch (merged — same as main)
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    // Create orphaned worktree directory
    const wtDir = join(dir, ".gsd", "worktrees", "M001");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "leftover.txt"), "orphaned file\n");

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.ok(result.recovered.length > 0, "should have recovered actions");
    assert.ok(
      result.recovered.some(r => r.includes("worktree directory")),
      "should report worktree cleanup",
    );

    // Worktree directory should be cleaned up
    assert.ok(!existsSync(wtDir), "orphaned worktree directory should be removed");
  });

  test("handles multiple milestones with mixed states", () => {
    // M001: complete, branch merged → should clean up
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "First", status: "complete" });

    // M002: active, branch exists → should skip
    run("git branch milestone/M002", dir);
    insertMilestone({ id: "M002", title: "Second", status: "active" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    // M001 should be cleaned up
    assert.ok(
      result.recovered.some(r => r.includes("M001")),
      "should clean up completed M001",
    );

    // M002 should not be touched
    const branches = run("git branch --list milestone/M002", dir);
    assert.ok(branches.includes("milestone/M002"), "active M002 branch should be preserved");
  });

  test("works in branch isolation mode", () => {
    run("git branch milestone/M001", dir);
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "branch");

    assert.ok(result.recovered.length > 0, "should work in branch mode too");
    assert.ok(
      result.recovered.some(r => r.includes("Deleted merged branch")),
      "should delete branch in branch mode",
    );
  });

  test("handles milestone in DB but no branch (no-op)", () => {
    insertMilestone({ id: "M001", title: "Test", status: "complete" });

    const result = auditOrphanedMilestoneBranches(dir, "worktree");

    assert.deepStrictEqual(result.recovered, []);
    assert.deepStrictEqual(result.warnings, []);
  });
});
