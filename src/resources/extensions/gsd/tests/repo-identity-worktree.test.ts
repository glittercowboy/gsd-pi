import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, realpathSync, mkdirSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { repoIdentity, externalGsdRoot, ensureGsdSymlink, validateProjectId, readRepoMeta, isInheritedRepo } from "../repo-identity.ts";
/**
 * Normalize a path for reliable comparison on Windows CI runners.
 * `os.tmpdir()` may return the 8.3 short-path form (e.g. `C:\Users\RUNNER~1`)
 * while `realpathSync` and git resolve to the long form (`C:\Users\runneradmin`).
 * Apply `realpathSync` and lowercase on Windows to eliminate both discrepancies.
 */
function normalizePath(p: string): string {
  const resolved = process.platform === "win32" ? realpathSync.native(p) : realpathSync(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

describe('repo-identity-worktree', () => {
  let base: string;
  let stateDir: string;
  let worktreePath: string;
  let expectedExternalState: string;

  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-repo-identity-")));
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-")));
    process.env.GSD_STATE_DIR = stateDir;

    run("git init -b main", base);
    run('git config user.name "Pi Test"', base);
    run('git config user.email "pi@example.com"', base);
    run('git remote add origin git@github.com:example/repo.git', base);
    writeFileSync(join(base, "README.md"), "# Test Repo\n", "utf-8");
    run("git add README.md", base);
    run('git commit -m "chore: init"', base);

    worktreePath = join(base, ".gsd", "worktrees", "M001");
    run(`git worktree add -b milestone/M001 ${worktreePath}`, base);

    expectedExternalState = externalGsdRoot(base);
  });

  after(() => {
    delete process.env.GSD_PROJECT_ID;
    delete process.env.GSD_STATE_DIR;
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

test('ensureGsdSymlink points worktree at main repo external state dir', () => {
    const mainState = ensureGsdSymlink(base);
    assert.deepStrictEqual(mainState, realpathSync(join(base, ".gsd")), "ensureGsdSymlink(base) returns the current main repo .gsd target");
    const worktreeState = ensureGsdSymlink(worktreePath);
    assert.deepStrictEqual(worktreeState, expectedExternalState, "worktree symlink target matches main repo external state dir");
    assert.ok(existsSync(join(worktreePath, ".gsd")), "worktree .gsd exists");
    assert.ok(lstatSync(join(worktreePath, ".gsd")).isSymbolicLink(), "worktree .gsd is a symlink");
    assert.deepStrictEqual(realpathSync(join(worktreePath, ".gsd")), realpathSync(expectedExternalState), "worktree .gsd symlink resolves to main repo external state dir");
});

test('ensureGsdSymlink heals stale worktree symlinks', () => {
    const staleState = join(stateDir, "projects", "stale-worktree-state");
    mkdirSync(staleState, { recursive: true });
    rmSync(join(worktreePath, ".gsd"), { recursive: true, force: true });
    symlinkSync(staleState, join(worktreePath, ".gsd"), "junction");
    const healedState = ensureGsdSymlink(worktreePath);
    assert.deepStrictEqual(healedState, expectedExternalState, "stale worktree symlink is repaired to canonical external state dir");
    assert.deepStrictEqual(realpathSync(join(worktreePath, ".gsd")), realpathSync(expectedExternalState), "healed worktree symlink resolves to canonical external state dir");
});

test('ensureGsdSymlink preserves worktree .gsd directories', () => {
    rmSync(join(worktreePath, ".gsd"), { recursive: true, force: true });
    mkdirSync(join(worktreePath, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(worktreePath, ".gsd", "milestones", "stale.txt"), "stale\n", "utf-8");
    const preservedDirState = ensureGsdSymlink(worktreePath);
    assert.deepStrictEqual(preservedDirState, join(worktreePath, ".gsd"), "worktree .gsd directory is left in place for sync-based refresh");
    assert.ok(lstatSync(join(worktreePath, ".gsd")).isDirectory(), "worktree .gsd directory remains a directory");
    assert.ok(existsSync(join(worktreePath, ".gsd", "milestones", "stale.txt")), "existing worktree .gsd directory contents remain available for sync logic");
});

test('GSD_PROJECT_ID overrides computed repo hash', () => {
    process.env.GSD_PROJECT_ID = "my-project";
    assert.deepStrictEqual(repoIdentity(base), "my-project", "repoIdentity returns GSD_PROJECT_ID when set");
    assert.deepStrictEqual(externalGsdRoot(base), join(stateDir, "projects", "my-project"), "externalGsdRoot uses GSD_PROJECT_ID");
    delete process.env.GSD_PROJECT_ID;
});

test('GSD_PROJECT_ID falls back to hash when unset', () => {
    const hashIdentity = repoIdentity(base);
    assert.ok(/^[0-9a-f]{12}$/.test(hashIdentity), "repoIdentity returns 12-char hex hash when GSD_PROJECT_ID is unset");
});

test('readRepoMeta returns null for malformed metadata', () => {
      const malformedPath = join(stateDir, "projects", "malformed");
      mkdirSync(malformedPath, { recursive: true });
      writeFileSync(join(malformedPath, "repo-meta.json"), JSON.stringify({ version: 1 }) + "\n", "utf-8");
      assert.deepStrictEqual(readRepoMeta(malformedPath), null, "malformed repo-meta.json is treated as unknown metadata");
});

test('ensureGsdSymlink refreshes repo-meta gitRoot after repo move with fixed project id', () => {
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
      assert.ok(before !== null, "repo metadata exists before repo move");
      assert.deepStrictEqual(normalizePath(before!.gitRoot), normalizePath(moveRepo), "repo metadata tracks current git root before move");

      const movedBaseRaw = join(tmpdir(), `gsd-repo-identity-moved-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      renameSync(moveRepo, movedBaseRaw);
      const movedBase = realpathSync(movedBaseRaw);
      const movedExternal = ensureGsdSymlink(movedBase);
      assert.deepStrictEqual(realpathSync(movedExternal), realpathSync(fixedExternal), "fixed project id keeps the same external state dir");

      const after = readRepoMeta(movedExternal);
      assert.ok(after !== null, "repo metadata exists after repo move");
      assert.deepStrictEqual(normalizePath(after!.gitRoot), normalizePath(movedBase), "repo metadata gitRoot is refreshed to moved repo path");
      assert.deepStrictEqual(after!.createdAt, before!.createdAt, "repo metadata preserves createdAt on refresh");

      rmSync(movedBase, { recursive: true, force: true });
      delete process.env.GSD_PROJECT_ID;
});

test('isInheritedRepo detects subdirectory of parent repo without .gsd (#1639)', () => {
      const parentRepo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-inherited-parent-")));
      run("git init -b main", parentRepo);
      run('git config user.name "Pi Test"', parentRepo);
      run('git config user.email "pi@example.com"', parentRepo);
      writeFileSync(join(parentRepo, "README.md"), "# Parent\n", "utf-8");
      run("git add README.md", parentRepo);
      run('git commit -m "init"', parentRepo);

      const subdir = join(parentRepo, "newproject");
      mkdirSync(subdir, { recursive: true });
      assert.ok(isInheritedRepo(subdir), "subdirectory of parent repo without .gsd is inherited");

      mkdirSync(join(parentRepo, ".gsd"), { recursive: true });
      assert.ok(!isInheritedRepo(subdir), "subdirectory of parent repo WITH .gsd is NOT inherited");

      assert.ok(!isInheritedRepo(parentRepo), "git root is not inherited");

      const standaloneRepo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-inherited-standalone-")));
      run("git init -b main", standaloneRepo);
      run('git config user.name "Pi Test"', standaloneRepo);
      run('git config user.email "pi@example.com"', standaloneRepo);
      assert.ok(!isInheritedRepo(standaloneRepo), "standalone repo is not inherited");

      rmSync(parentRepo, { recursive: true, force: true });
      rmSync(standaloneRepo, { recursive: true, force: true });
});

test('subdirectory of parent repo gets unique identity after git init (#1639)', () => {
      const parentRepo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-identity-parent-")));
      run("git init -b main", parentRepo);
      run('git config user.name "Pi Test"', parentRepo);
      run('git config user.email "pi@example.com"', parentRepo);
      run('git remote add origin git@github.com:example/parent-project.git', parentRepo);
      writeFileSync(join(parentRepo, "README.md"), "# Parent\n", "utf-8");
      run("git add README.md", parentRepo);
      run('git commit -m "init"', parentRepo);

      const subdir = join(parentRepo, "childproject");
      mkdirSync(subdir, { recursive: true });

      const parentIdentity = repoIdentity(parentRepo);
      const subdirIdentityBefore = repoIdentity(subdir);
      assert.deepStrictEqual(subdirIdentityBefore, parentIdentity, "subdirectory shares parent identity before its own git init");

      run("git init -b main", subdir);
      const subdirIdentityAfter = repoIdentity(subdir);
      assert.ok(subdirIdentityAfter !== parentIdentity, "subdirectory gets unique identity after git init");

      rmSync(parentRepo, { recursive: true, force: true });
});

test('ensureGsdSymlink from subdirectory does not create .gsd in subdir when git-root .gsd exists (#2380)', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-subdir-symlink-")));
    run("git init -b main", repo);
    run('git config user.name "Pi Test"', repo);
    run('git config user.email "pi@example.com"', repo);
    run('git remote add origin git@github.com:example/subdir-test.git', repo);
    writeFileSync(join(repo, "README.md"), "# Subdir Test\n", "utf-8");
    run("git add README.md", repo);
    run('git commit -m "init"', repo);

    // Set up .gsd symlink at the git root (normal project initialisation)
    ensureGsdSymlink(repo);
    assert.ok(existsSync(join(repo, ".gsd")), "root .gsd exists after ensureGsdSymlink");
    assert.ok(lstatSync(join(repo, ".gsd")).isSymbolicLink(), "root .gsd is a symlink");

    // Create a subdirectory and call ensureGsdSymlink from there
    const subdir = join(repo, "src", "lib");
    mkdirSync(subdir, { recursive: true });
    ensureGsdSymlink(subdir);

    // ensureGsdSymlink should NOT create a .gsd in the subdirectory
    // because the git root already has a valid .gsd symlink.
    assert.ok(!existsSync(join(subdir, ".gsd")), "no .gsd created in subdirectory when git-root .gsd exists (#2380)");
    assert.ok(!existsSync(join(repo, "src", ".gsd")), "no .gsd created in intermediate directory");

    // The root .gsd should still be intact
    assert.ok(existsSync(join(repo, ".gsd")), "root .gsd still exists");
    assert.ok(lstatSync(join(repo, ".gsd")).isSymbolicLink(), "root .gsd is still a symlink");

    rmSync(repo, { recursive: true, force: true });
});

test('validateProjectId rejects invalid values', () => {
    for (const invalid of ["has spaces", "path/traversal", "dot..dot", "back\\slash"]) {
      assert.ok(!validateProjectId(invalid), `validateProjectId rejects invalid value: "${invalid}"`);
    }
});

test('validateProjectId accepts valid values', () => {
    for (const valid of ["my-project", "foo_bar", "abc123", "A-Z_0-9"]) {
      assert.ok(validateProjectId(valid), `validateProjectId accepts valid value: "${valid}"`);
    }
});

});
