import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  diffWorktreeGSD,
  getWorktreeGSDDiff,
  getWorktreeLog,
  worktreeBranchName,
  worktreePath,
} from "../worktree-manager.ts";

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function makeBaseRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-wt-test-"));
  run("git init -b main", base);
  run('git config user.name "Test User"', base);
  run('git config user.email "test@example.com"', base);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, "README.md"), "# Test Project\n", "utf-8");
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Demo\n\n## Slices\n- [ ] **S01: First** `risk:low` `depends:[]`\n  > After this: it works\n",
    "utf-8",
  );
  run("git add .", base);
  run('git commit -m "chore: init"', base);
  return base;
}

function makeRepoWithWorktree(worktreeName: string): { base: string; wtPath: string } {
  const base = makeBaseRepo();
  createWorktree(base, worktreeName);
  return { base, wtPath: worktreePath(base, worktreeName) };
}

function makeRepoWithChanges(worktreeName: string): { base: string; wtPath: string } {
  const { base, wtPath } = makeRepoWithWorktree(worktreeName);
  mkdirSync(join(wtPath, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(
    join(wtPath, ".gsd", "milestones", "M002", "M002-ROADMAP.md"),
    "# M002: New Feature\n\n## Slices\n- [ ] **S01: Setup** `risk:low` `depends:[]`\n  > After this: new feature ready\n",
    "utf-8",
  );
  writeFileSync(
    join(wtPath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    "# M001: Demo (updated)\n\n## Slices\n- [x] **S01: First** `risk:low` `depends:[]`\n  > Done\n",
    "utf-8",
  );
  run("git add .", wtPath);
  run('git commit -m "feat: add M002 and update M001"', wtPath);
  return { base, wtPath };
}

// ─── worktreeBranchName ───────────────────────────────────────────────────────

test("worktreeBranchName formats branch name", () => {
  assert.strictEqual(
    worktreeBranchName("feature-x"),
    "worktree/feature-x",
    "should prefix with worktree/",
  );
});

// ─── createWorktree ───────────────────────────────────────────────────────────

describe("createWorktree", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("creates worktree with correct metadata", () => {
    const info = createWorktree(base, "feature-x");
    assert.strictEqual(info.name, "feature-x", "name should match");
    assert.strictEqual(info.branch, "worktree/feature-x", "branch should be prefixed");
    assert.ok(info.exists, "exists flag should be true");
    assert.ok(existsSync(info.path), "worktree path should exist on disk");
    assert.ok(existsSync(join(info.path, "README.md")), "README.md should be in worktree");
    assert.ok(
      existsSync(join(info.path, ".gsd", "milestones", "M001", "M001-ROADMAP.md")),
      ".gsd files should be in worktree",
    );
    const branches = run("git branch", base);
    assert.ok(branches.includes("worktree/feature-x"), "branch should be created in base repo");
  });

  test("rejects invalid name", () => {
    assert.throws(
      () => createWorktree(base, "bad name!"),
      (err: Error) => {
        assert.ok(
          err.message.includes("Invalid worktree name"),
          `expected "Invalid worktree name" in error, got: ${err.message}`,
        );
        return true;
      },
      "should throw on invalid worktree name",
    );
  });
});

describe("createWorktree — duplicate rejection", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("rejects duplicate name", () => {
    assert.throws(
      () => createWorktree(base, "feature-x"),
      (err: Error) => {
        assert.ok(
          err.message.includes("already exists"),
          `expected "already exists" in error, got: ${err.message}`,
        );
        return true;
      },
      "should throw on duplicate worktree name",
    );
  });
});

// ─── listWorktrees ────────────────────────────────────────────────────────────

describe("listWorktrees", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("returns active worktrees", () => {
    const list = listWorktrees(base);
    assert.strictEqual(list.length, 1, "should list exactly one worktree");
    assert.strictEqual(list[0]!.name, "feature-x", "name should match");
    assert.strictEqual(list[0]!.branch, "worktree/feature-x", "branch should match");
    assert.ok(list[0]!.exists, "exists flag should be true");
  });

  test("returns empty after removal", () => {
    removeWorktree(base, "feature-x");
    const list = listWorktrees(base);
    assert.strictEqual(list.length, 0, "should have no worktrees after removal");
  });
});

// ─── diffWorktreeGSD ─────────────────────────────────────────────────────────

describe("diffWorktreeGSD and getWorktreeGSDDiff", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithChanges("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("detects added and modified GSD files", () => {
    const diff = diffWorktreeGSD(base, "feature-x");
    assert.ok(diff.added.length > 0, "should have added files");
    assert.ok(
      diff.added.some((f) => f.includes("M002")),
      "M002 roadmap should be in added files",
    );
    assert.ok(diff.modified.length > 0, "should have modified files");
    assert.ok(
      diff.modified.some((f) => f.includes("M001")),
      "M001 roadmap should be in modified files",
    );
    assert.strictEqual(diff.removed.length, 0, "should have no removed files");
  });

  test("returns patch content", () => {
    const fullDiff = getWorktreeGSDDiff(base, "feature-x");
    assert.ok(fullDiff.includes("M002"), "diff should mention M002");
    assert.ok(fullDiff.includes("updated"), "diff should mention the update");
  });
});

// ─── getWorktreeLog ───────────────────────────────────────────────────────────

describe("getWorktreeLog", () => {
  let base: string;
  beforeEach(() => {
    const repo = makeRepoWithChanges("feature-x");
    base = repo.base;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("shows commits", () => {
    const log = getWorktreeLog(base, "feature-x");
    assert.ok(log.includes("add M002"), "log should include the commit message");
  });
});

// ─── removeWorktree ───────────────────────────────────────────────────────────

describe("removeWorktree", () => {
  let base: string;
  let wtPath: string;
  beforeEach(() => {
    const repo = makeRepoWithWorktree("feature-x");
    base = repo.base;
    wtPath = repo.wtPath;
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("removes directory and branch", () => {
    removeWorktree(base, "feature-x", { deleteBranch: true });
    assert.ok(!existsSync(wtPath), "worktree directory should be gone");
    const branches = run("git branch", base);
    assert.ok(!branches.includes("worktree/feature-x"), "branch should be deleted");
  });
});

describe("removeWorktree — missing worktree", () => {
  let base: string;
  beforeEach(() => { base = makeBaseRepo(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  test("on missing worktree does not throw", () => {
    assert.doesNotThrow(
      () => removeWorktree(base, "nonexistent"),
      "should not throw when worktree does not exist",
    );
  });
});
