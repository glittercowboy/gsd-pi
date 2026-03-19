import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { externalGsdRoot, ensureGsdSymlink } from "../repo-identity.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

async function main(): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-repo-identity-")));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-")));

  try {
    process.env.GSD_STATE_DIR = stateDir;

    run("git init -b main", base);
    run('git config user.name "Pi Test"', base);
    run('git config user.email "pi@example.com"', base);
    run('git remote add origin git@github.com:example/repo.git', base);
    writeFileSync(join(base, "README.md"), "# Test Repo\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "chore: init"', base);

    const worktreePath = join(base, ".gsd", "worktrees", "M001");
    run(`git worktree add -b milestone/M001 ${worktreePath}`, base);

    console.log("\n=== ensureGsdSymlink points worktree at main repo external state dir ===");
    const expectedExternalState = externalGsdRoot(base);
    const mainState = ensureGsdSymlink(base);
    assertEq(mainState, realpathSync(join(base, ".gsd")), "ensureGsdSymlink(base) returns the current main repo .gsd target");
    const worktreeState = ensureGsdSymlink(worktreePath);
    assertEq(worktreeState, expectedExternalState, "worktree symlink target matches main repo external state dir");
    assertTrue(existsSync(join(worktreePath, ".gsd")), "worktree .gsd exists");
    assertTrue(lstatSync(join(worktreePath, ".gsd")).isSymbolicLink(), "worktree .gsd is a symlink");
    assertEq(realpathSync(join(worktreePath, ".gsd")), realpathSync(expectedExternalState), "worktree .gsd symlink resolves to main repo external state dir");

    console.log("\n=== ensureGsdSymlink heals stale worktree symlinks ===");
    const staleState = join(stateDir, "projects", "stale-worktree-state");
    mkdirSync(staleState, { recursive: true });
    rmSync(join(worktreePath, ".gsd"), { recursive: true, force: true });
    symlinkSync(staleState, join(worktreePath, ".gsd"), "junction");
    const healedState = ensureGsdSymlink(worktreePath);
    assertEq(healedState, expectedExternalState, "stale worktree symlink is repaired to canonical external state dir");
    assertEq(realpathSync(join(worktreePath, ".gsd")), realpathSync(expectedExternalState), "healed worktree symlink resolves to canonical external state dir");

    console.log("\n=== ensureGsdSymlink preserves worktree .gsd directories ===");
    rmSync(join(worktreePath, ".gsd"), { recursive: true, force: true });
    mkdirSync(join(worktreePath, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(worktreePath, ".gsd", "milestones", "stale.txt"), "stale\n", "utf-8");
    const preservedDirState = ensureGsdSymlink(worktreePath);
    assertEq(preservedDirState, join(worktreePath, ".gsd"), "worktree .gsd directory is left in place for sync-based refresh");
    assertTrue(lstatSync(join(worktreePath, ".gsd")).isDirectory(), "worktree .gsd directory remains a directory");
    assertTrue(existsSync(join(worktreePath, ".gsd", "milestones", "stale.txt")), "existing worktree .gsd directory contents remain available for sync logic");
  } finally {
    delete process.env.GSD_STATE_DIR;
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    report();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
