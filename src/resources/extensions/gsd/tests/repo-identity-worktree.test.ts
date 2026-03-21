import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync, mkdirSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { repoIdentity, externalGsdRoot, ensureGsdSymlink, validateProjectId, readRepoMeta } from "../repo-identity.ts";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

/**
 * Normalize a path for reliable comparison on Windows CI runners.
 * `os.tmpdir()` may return the 8.3 short-path form (e.g. `C:\Users\RUNNER~1`)
 * while `realpathSync` and git resolve to the long form (`C:\Users\runneradmin`).
 * Apply `realpathSync` and lowercase on Windows to eliminate both discrepancies.
 */
function normalizePath(p: string): string {
  const resolved = realpathSync(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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

    console.log("\n=== GSD_PROJECT_ID overrides computed repo hash ===");
    process.env.GSD_PROJECT_ID = "my-project";
    assertEq(repoIdentity(base), "my-project", "repoIdentity returns GSD_PROJECT_ID when set");
    assertEq(externalGsdRoot(base), join(stateDir, "projects", "my-project"), "externalGsdRoot uses GSD_PROJECT_ID");
    delete process.env.GSD_PROJECT_ID;

    console.log("\n=== GSD_PROJECT_ID falls back to hash when unset ===");
    const hashIdentity = repoIdentity(base);
    assertTrue(/^[0-9a-f]{12}$/.test(hashIdentity), "repoIdentity returns 12-char hex hash when GSD_PROJECT_ID is unset");

    console.log("\n=== readRepoMeta returns null for malformed metadata ===");
    {
      const malformedPath = join(stateDir, "projects", "malformed");
      mkdirSync(malformedPath, { recursive: true });
      writeFileSync(join(malformedPath, "repo-meta.json"), JSON.stringify({ version: 1 }) + "\n", "utf-8");
      assertEq(readRepoMeta(malformedPath), null, "malformed repo-meta.json is treated as unknown metadata");
    }

    console.log("\n=== ensureGsdSymlink refreshes repo-meta gitRoot after repo move with fixed project id ===");
    {
      const moveRepo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-repo-identity-move-")));
      run("git init -b main", moveRepo);
      run('git config user.name "Pi Test"', moveRepo);
      run('git config user.email "pi@example.com"', moveRepo);
      writeFileSync(join(moveRepo, "README.md"), "# Move Test Repo\n", "utf-8");
      run("git add README.md", moveRepo);
      run('git commit -m "chore: init move repo"', moveRepo);

      process.env.GSD_PROJECT_ID = "fixed-project";
      const fixedExternal = ensureGsdSymlink(moveRepo);
      const before = readRepoMeta(fixedExternal);
      assertTrue(before !== null, "repo metadata exists before repo move");
      assertEq(normalizePath(before!.gitRoot), normalizePath(moveRepo), "repo metadata tracks current git root before move");

      const movedBaseRaw = join(tmpdir(), `gsd-repo-identity-moved-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      renameSync(moveRepo, movedBaseRaw);
      const movedBase = realpathSync(movedBaseRaw);
      const movedExternal = ensureGsdSymlink(movedBase);
      assertEq(realpathSync(movedExternal), realpathSync(fixedExternal), "fixed project id keeps the same external state dir");

      const after = readRepoMeta(movedExternal);
      assertTrue(after !== null, "repo metadata exists after repo move");
      assertEq(normalizePath(after!.gitRoot), normalizePath(movedBase), "repo metadata gitRoot is refreshed to moved repo path");
      assertEq(after!.createdAt, before!.createdAt, "repo metadata preserves createdAt on refresh");

      rmSync(movedBase, { recursive: true, force: true });
      delete process.env.GSD_PROJECT_ID;
    }

    console.log("\n=== validateProjectId rejects invalid values ===");
    for (const invalid of ["has spaces", "path/traversal", "dot..dot", "back\\slash"]) {
      assertTrue(!validateProjectId(invalid), `validateProjectId rejects invalid value: "${invalid}"`);
    }

    console.log("\n=== validateProjectId accepts valid values ===");
    for (const valid of ["my-project", "foo_bar", "abc123", "A-Z_0-9"]) {
      assertTrue(validateProjectId(valid), `validateProjectId accepts valid value: "${valid}"`);
    }
  } finally {
    delete process.env.GSD_PROJECT_ID;
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
