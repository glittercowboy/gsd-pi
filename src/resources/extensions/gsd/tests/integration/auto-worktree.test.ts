/**
 * auto-worktree.test.ts — Tests for auto-worktree lifecycle.
 *
 * Covers: create → detect → teardown, re-entry, path helpers.
 * Runs in a real temp git repo.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  enterAutoWorktree,
  getAutoWorktreeOriginalBase,
  getActiveAutoWorktreeContext,
  syncGsdStateToWorktree,
} from "../../auto-worktree.ts";

// Note: execSync is used intentionally in tests for git operations with
// controlled, hardcoded inputs (no user input). This is safe and matches
// the pattern used by the original test file.
function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auto-wt-test-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  // Create initial commit on main
  writeFileSync(join(dir, "README.md"), "# test\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  // Ensure branch is called main
  run("git branch -M main", dir);
  return dir;
}

describe("auto-worktree lifecycle", () => {
  const savedCwd = process.cwd();
  let tempDir = "";

  afterEach(() => {
    process.chdir(savedCwd);
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
  });

  test("create → detect → teardown", () => {
    tempDir = createTempRepo();

    // Create .gsd/milestones/M003 with a dummy file (simulates planning artifacts)
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // ─── createAutoWorktree ──────────────────────────────────────────
    const wtPath = createAutoWorktree(tempDir, "M003");

    assert.ok(existsSync(wtPath), "worktree directory exists after create");
    assert.strictEqual(process.cwd(), wtPath, "process.cwd() is worktree path after create");

    const branch = run("git branch --show-current", wtPath);
    assert.strictEqual(branch, "milestone/M003", "git branch is milestone/M003");

    assert.ok(
      existsSync(join(wtPath, ".gsd", "milestones", "M003", "CONTEXT.md")),
      "planning files inherited in worktree",
    );

    // ─── isInAutoWorktree ────────────────────────────────────────────
    assert.ok(isInAutoWorktree(tempDir), "isInAutoWorktree returns true when inside");

    // ─── getAutoWorktreeOriginalBase ─────────────────────────────────
    assert.strictEqual(getAutoWorktreeOriginalBase(), tempDir, "originalBase returns temp dir");
    assert.deepStrictEqual(
      getActiveAutoWorktreeContext(),
      {
        originalBase: tempDir,
        worktreeName: "M003",
        branch: "milestone/M003",
      },
      "active auto-worktree context reflects the worktree cwd",
    );

    // ─── getAutoWorktreePath ─────────────────────────────────────────
    assert.strictEqual(getAutoWorktreePath(tempDir, "M003"), wtPath, "getAutoWorktreePath returns correct path");
    assert.strictEqual(getAutoWorktreePath(tempDir, "M999"), null, "getAutoWorktreePath returns null for nonexistent");

    // ─── teardownAutoWorktree ────────────────────────────────────────
    teardownAutoWorktree(tempDir, "M003");

    assert.strictEqual(process.cwd(), tempDir, "process.cwd() back to original after teardown");
    assert.ok(!existsSync(wtPath), "worktree directory removed after teardown");
    assert.ok(!isInAutoWorktree(tempDir), "isInAutoWorktree returns false after teardown");
    assert.strictEqual(getAutoWorktreeOriginalBase(), null, "originalBase is null after teardown");
    assert.strictEqual(getActiveAutoWorktreeContext(), null, "active auto-worktree context clears after teardown");
  });

  test("re-entry: create again, exit without teardown, re-enter", () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    const wtPath2 = createAutoWorktree(tempDir, "M003");
    assert.ok(existsSync(wtPath2), "worktree re-created");

    // Manually chdir out (simulates pause/crash)
    process.chdir(tempDir);

    // enterAutoWorktree should re-enter
    const entered = enterAutoWorktree(tempDir, "M003");
    assert.strictEqual(process.cwd(), entered, "re-entered worktree via enterAutoWorktree");
    assert.strictEqual(getAutoWorktreeOriginalBase(), tempDir, "originalBase restored on re-entry");
    assert.ok(isInAutoWorktree(tempDir), "isInAutoWorktree true after re-entry");
    assert.deepStrictEqual(
      getActiveAutoWorktreeContext(),
      {
        originalBase: tempDir,
        worktreeName: "M003",
        branch: "milestone/M003",
      },
      "active auto-worktree context is restored on re-entry",
    );

    // Cleanup
    teardownAutoWorktree(tempDir, "M003");
  });

  test("coexistence with manual worktree", async () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // Import createWorktree directly for manual worktree
    const { createWorktree } = await import("../../worktree-manager.ts");

    // Create manual worktree (uses worktree/<name> branch)
    const manualWt = createWorktree(tempDir, "feature-x");
    assert.ok(existsSync(manualWt.path), "manual worktree exists");
    assert.strictEqual(manualWt.branch, "worktree/feature-x", "manual worktree uses worktree/ prefix");

    // Create auto-worktree alongside
    const autoWtPath = createAutoWorktree(tempDir, "M003");
    assert.ok(existsSync(autoWtPath), "auto-worktree coexists with manual");
    assert.ok(existsSync(manualWt.path), "manual worktree still exists");

    // Cleanup both
    teardownAutoWorktree(tempDir, "M003");
    const { removeWorktree } = await import("../../worktree-manager.ts");
    removeWorktree(tempDir, "feature-x");
  });

  test("split-brain prevention: originalBase cleared after teardown", () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    createAutoWorktree(tempDir, "M003");
    teardownAutoWorktree(tempDir, "M003");

    assert.strictEqual(getAutoWorktreeOriginalBase(), null, "no split-brain: originalBase cleared");
  });

  test("#1526: getMainBranch returns milestone/<MID> in auto-worktree", async () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M005");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M005 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    const { GitServiceImpl } = await import("../../git-service.ts");

    // Create worktree
    const wtPath = createAutoWorktree(tempDir, "M005");
    // Don't set main_branch pref so getMainBranch falls through to worktree detection
    const gitService = new GitServiceImpl(wtPath);
    gitService.setMilestoneId("M005");

    // Verify getMainBranch returns the milestone branch
    const mainBranch = gitService.getMainBranch();
    assert.strictEqual(mainBranch, "milestone/M005", "getMainBranch returns milestone/<MID> in auto-worktree");

    // Cleanup
    teardownAutoWorktree(tempDir, "M005");
  });

  test("#1713: stale worktree directory without .git file", async () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M010");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M010 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // Simulate a crash leaving a stale directory with no .git file.
    const { worktreePath } = await import("../../worktree-manager.ts");
    const staleDir = worktreePath(tempDir, "M010");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "orphan.txt"), "stale leftover\n");
    assert.ok(existsSync(staleDir), "stale directory exists before recovery");
    assert.ok(!existsSync(join(staleDir, ".git")), "stale directory has no .git file");

    // createAutoWorktree should remove the stale dir and create a real worktree
    const recoveredPath = createAutoWorktree(tempDir, "M010");
    assert.ok(existsSync(recoveredPath), "worktree created after stale dir recovery");
    assert.ok(existsSync(join(recoveredPath, ".git")), "recovered worktree has .git file");
    assert.ok(!existsSync(join(recoveredPath, "orphan.txt")), "stale file removed by recovery");

    teardownAutoWorktree(tempDir, "M010");
  });

  test("#778: reconcile plan checkboxes on re-attach", async () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    const planRelPath = join(".gsd", "milestones", "M004", "slices", "S01", "S01-PLAN.md");
    const planDir = join(tempDir, ".gsd", "milestones", "M004", "slices", "S01");
    const { mkdirSync: mkdir, writeFileSync: write, readFileSync: read } = await import("node:fs");

    // Plan on integration branch (project root): T01 [x], T02 [x]
    mkdir(planDir, { recursive: true });
    write(
      join(tempDir, planRelPath),
      "# S01 Plan\n- [x] **T01:** task one\n- [x] **T02:** task two\n- [ ] **T03:** task three\n",
    );

    run(`git add .`, tempDir);
    run(`git commit -m "add plan with T01 and T02 checked" --allow-empty`, tempDir);

    // Create milestone branch with only T01 [x] (simulating crash before T02 commit)
    const milestoneBranch = "milestone/M004";
    run(`git checkout -b ${milestoneBranch}`, tempDir);
    mkdir(planDir, { recursive: true });
    write(
      join(tempDir, planRelPath),
      "# S01 Plan\n- [x] **T01:** task one\n- [ ] **T02:** task two\n- [ ] **T03:** task three\n",
    );
    run(`git add .`, tempDir);
    run(`git commit -m "milestone: only T01 checked"`, tempDir);
    run(`git checkout main`, tempDir);

    // Restore project root plan (T01+T02 [x])
    write(
      join(tempDir, planRelPath),
      "# S01 Plan\n- [x] **T01:** task one\n- [x] **T02:** task two\n- [ ] **T03:** task three\n",
    );

    // Create worktree re-attached to existing milestone branch (T02 still [ ] in branch)
    const wtPath = createAutoWorktree(tempDir, "M004");

    try {
      const wtPlanPath = join(wtPath, planRelPath);
      assert.ok(existsSync(wtPlanPath), "plan file exists in worktree after re-attach");

      const wtPlan = read(wtPlanPath, "utf-8");
      assert.ok(wtPlan.includes("- [x] **T02:"), "T02 should be [x] after reconciliation (was [ ] on branch)");
      assert.ok(wtPlan.includes("- [x] **T01:"), "T01 stays [x]");
      assert.ok(wtPlan.includes("- [ ] **T03:"), "T03 stays [ ] (not in root either)");
    } finally {
      teardownAutoWorktree(tempDir, "M004");
    }
  });

  test("#2791: mcp.json copied into worktree via copyPlanningArtifacts", () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // Create mcp.json in .gsd/ AFTER the commit (untracked, like real usage).
    // copyPlanningArtifacts should copy it into the worktree's .gsd/.
    writeFileSync(
      join(tempDir, ".gsd", "mcp.json"),
      JSON.stringify({ servers: { test: { command: "echo" } } }),
    );

    const wtPath = createAutoWorktree(tempDir, "M003");

    try {
      assert.ok(
        existsSync(join(wtPath, ".gsd", "mcp.json")),
        "mcp.json should be copied into worktree .gsd/ on creation",
      );
    } finally {
      teardownAutoWorktree(tempDir, "M003");
    }
  });

  test("#2791: mcp.json synced via syncGsdStateToWorktree (ROOT_STATE_FILES)", () => {
    tempDir = createTempRepo();
    const msDir = join(tempDir, ".gsd", "milestones", "M003");
    mkdirSync(msDir, { recursive: true });
    writeFileSync(join(msDir, "CONTEXT.md"), "# M003 Context\n");
    run("git add .", tempDir);
    run("git commit -m \"add milestone\"", tempDir);

    // Create worktree first (no mcp.json yet)
    const wtPath = createAutoWorktree(tempDir, "M003");

    try {
      // Now add mcp.json to the main .gsd/ after worktree was created
      writeFileSync(
        join(tempDir, ".gsd", "mcp.json"),
        JSON.stringify({ servers: { test: { command: "echo" } } }),
      );

      // Sync should pick up the new mcp.json
      const { synced } = syncGsdStateToWorktree(tempDir, wtPath);

      assert.ok(synced.includes("mcp.json"), "mcp.json should be in the synced list");
      assert.ok(
        existsSync(join(wtPath, ".gsd", "mcp.json")),
        "mcp.json should exist in worktree after sync",
      );
    } finally {
      teardownAutoWorktree(tempDir, "M003");
    }
  });
});
