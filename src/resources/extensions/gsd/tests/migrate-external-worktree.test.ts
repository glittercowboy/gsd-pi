import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { migrateToExternalState } from "../migrate-external.ts";

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

describe("migrate-external worktree guard (#2970)", () => {
  let base: string;
  let stateDir: string;
  let worktreePath: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-wt-")));
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-")));
    process.env.GSD_STATE_DIR = stateDir;

    // Create a git repo with a remote
    run("git init -b main", base);
    run('git config user.name "Test"', base);
    run('git config user.email "test@example.com"', base);
    run('git remote add origin git@github.com:example/repo.git', base);
    writeFileSync(join(base, "README.md"), "# Test\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "init"', base);

    // Create a worktree
    worktreePath = join(base, ".gsd", "worktrees", "M001");
    run(`git worktree add -b milestone/M001 ${worktreePath}`, base);

    // Populate worktree with a .gsd directory (simulating syncGsdStateToWorktree)
    const worktreeGsd = join(worktreePath, ".gsd");
    mkdirSync(worktreeGsd, { recursive: true });
    writeFileSync(join(worktreeGsd, "PREFERENCES.md"), "# prefs\n", "utf-8");
  });

  after(() => {
    delete process.env.GSD_STATE_DIR;
    // Remove worktree before cleaning up
    try { run(`git worktree remove --force ${worktreePath}`, base); } catch { /* ok */ }
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("migrateToExternalState skips when basePath is a git worktree", () => {
    // The worktree has a real .gsd directory — migration would normally run.
    // But since this is a worktree, it should be skipped.
    const result = migrateToExternalState(worktreePath);

    assert.equal(result.migrated, false, "should not migrate inside a worktree");
    assert.equal(result.error, undefined, "should not report an error");

    // .gsd should still exist as a real directory (not renamed/removed)
    assert.ok(
      existsSync(join(worktreePath, ".gsd")),
      ".gsd directory should still exist after skipped migration"
    );

    // .gsd.migrating should NOT exist
    assert.ok(
      !existsSync(join(worktreePath, ".gsd.migrating")),
      ".gsd.migrating should not be created in a worktree"
    );
  });

  test("migrateToExternalState still works on main repo", () => {
    // Create a fresh temp repo to test main repo migration path
    const mainBase = realpathSync(mkdtempSync(join(tmpdir(), "gsd-migrate-main-")));
    try {
      run("git init -b main", mainBase);
      run('git config user.name "Test"', mainBase);
      run('git config user.email "test@example.com"', mainBase);
      run('git remote add origin git@github.com:example/main-repo.git', mainBase);
      writeFileSync(join(mainBase, "README.md"), "# Test\n", "utf-8");
      run("git add README.md", mainBase);
      run('git commit -m "init"', mainBase);

      // Create a .gsd directory with content
      mkdirSync(join(mainBase, ".gsd"), { recursive: true });
      writeFileSync(join(mainBase, ".gsd", "PREFERENCES.md"), "# prefs\n", "utf-8");

      const result = migrateToExternalState(mainBase);
      assert.equal(result.migrated, true, "should migrate on main repo");
    } finally {
      rmSync(mainBase, { recursive: true, force: true });
    }
  });
});
