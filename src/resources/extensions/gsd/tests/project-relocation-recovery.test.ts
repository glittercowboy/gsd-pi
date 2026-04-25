/**
 * Project Relocation Recovery Tests (#2750)
 *
 * Verifies that moving/renaming a GSD project directory does not cause
 * silent data loss. When a repo has a remote URL, the identity hash
 * should be based solely on the remote — making moves transparent.
 *
 * For local-only repos (no remote), ensureGsdSymlink should detect
 * orphaned state directories with a matching .gsd-id marker and
 * recover them automatically.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  repoIdentity,
  externalGsdRoot,
  ensureGsdSymlink,
  readRepoMeta,
  externalProjectsRoot,
} from "../repo-identity.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function normalizePath(p: string): string {
  const resolved =
    process.platform === "win32" ? realpathSync.native(p) : realpathSync(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function initRepo(dir: string, remote?: string): void {
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  if (remote) {
    git(["remote", "add", "origin", remote], dir);
  }
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf-8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "init"], dir);
}

describe("project-relocation-recovery (#2750)", () => {
  let stateDir: string;
  let savedStateDir: string | undefined;

  before(() => {
    savedStateDir = process.env.GSD_STATE_DIR;
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-state-")));
    process.env.GSD_STATE_DIR = stateDir;
  });

  after(() => {
    if (savedStateDir !== undefined) {
      process.env.GSD_STATE_DIR = savedStateDir;
    } else {
      delete process.env.GSD_STATE_DIR;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Remote repos: identity should be path-independent ─────────────────

  test("repoIdentity is stable across moves for repos with a remote URL", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-a-")));
    initRepo(repoA, "https://github.com/example/myrepo.git");

    const identityBefore = repoIdentity(repoA);

    // Move the repo to a new location
    const repoB = join(
      tmpdir(),
      `gsd-reloc-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    renameSync(repoA, repoB);

    const identityAfter = repoIdentity(repoB);

    assert.strictEqual(
      identityAfter,
      identityBefore,
      "identity hash must be stable when a remote-enabled repo is moved",
    );

    rmSync(repoB, { recursive: true, force: true });
  });

  test("ensureGsdSymlink reuses the same external dir after repo move (remote repo)", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-reuse-a-")));
    initRepo(repoA, "https://github.com/example/reloc-reuse.git");

    // Initialize GSD state with some planning data
    const externalA = ensureGsdSymlink(repoA);
    const milestonesPath = join(externalA, "milestones");
    mkdirSync(milestonesPath, { recursive: true });
    writeFileSync(
      join(milestonesPath, "M001.md"),
      "# Milestone 1\nImportant planning data\n",
      "utf-8",
    );

    // Move the repo
    const repoB = join(
      tmpdir(),
      `gsd-reloc-reuse-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    renameSync(repoA, repoB);

    // ensureGsdSymlink at the new location should find the same external dir
    const externalB = ensureGsdSymlink(repoB);

    assert.strictEqual(
      normalizePath(externalB),
      normalizePath(externalA),
      "external state dir must be the same after move",
    );

    // Planning data must survive the move
    assert.ok(
      existsSync(join(externalB, "milestones", "M001.md")),
      "milestone data must survive project relocation",
    );

    const content = readFileSync(
      join(externalB, "milestones", "M001.md"),
      "utf-8",
    );
    assert.ok(
      content.includes("Important planning data"),
      "milestone content must be preserved",
    );

    rmSync(repoB, { recursive: true, force: true });
  });

  test("repo-meta.json gitRoot is updated after move (remote repo)", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-meta-a-")));
    initRepo(repoA, "https://github.com/example/reloc-meta.git");

    const externalA = ensureGsdSymlink(repoA);
    const metaBefore = readRepoMeta(externalA);
    assert.ok(metaBefore !== null, "metadata should exist before move");

    // Move the repo
    const repoB = join(
      tmpdir(),
      `gsd-reloc-meta-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    renameSync(repoA, repoB);

    const externalB = ensureGsdSymlink(repoB);
    const metaAfter = readRepoMeta(externalB);
    assert.ok(metaAfter !== null, "metadata should exist after move");
    assert.strictEqual(
      normalizePath(metaAfter!.gitRoot),
      normalizePath(repoB),
      "repo-meta.json gitRoot must be updated to new location",
    );
    assert.strictEqual(
      metaAfter!.createdAt,
      metaBefore!.createdAt,
      "createdAt must be preserved across moves",
    );

    rmSync(repoB, { recursive: true, force: true });
  });

  // ── Local-only repos: .gsd-id marker provides recovery ────────────────

  test("ensureGsdSymlink writes a .gsd-id marker in the project root", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-marker-")));
    initRepo(repo);

    ensureGsdSymlink(repo);

    const markerPath = join(repo, ".gsd-id");
    assert.ok(existsSync(markerPath), ".gsd-id marker must be written by ensureGsdSymlink");

    const markerId = readFileSync(markerPath, "utf-8").trim();
    const computedId = repoIdentity(repo);
    assert.strictEqual(markerId, computedId, ".gsd-id must contain the repo identity hash");

    rmSync(repo, { recursive: true, force: true });
  });

  test("local-only repo recovers state via .gsd-id marker after move", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-local-a-")));
    initRepo(repoA);
    // No remote — identity includes gitRoot

    // Initialize GSD state
    const externalA = ensureGsdSymlink(repoA);
    mkdirSync(join(externalA, "milestones"), { recursive: true });
    writeFileSync(
      join(externalA, "milestones", "M001.md"),
      "# Local Milestone\n",
      "utf-8",
    );

    const identityBefore = repoIdentity(repoA);

    // Move the repo
    const repoB = join(
      tmpdir(),
      `gsd-reloc-local-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    renameSync(repoA, repoB);

    // The identity WILL change (no remote, gitRoot changed)
    const identityAfter = repoIdentity(repoB);
    assert.notStrictEqual(
      identityAfter,
      identityBefore,
      "local-only repo identity changes with move (expected)",
    );

    // But ensureGsdSymlink should detect .gsd-id marker and recover
    const externalB = ensureGsdSymlink(repoB);
    assert.ok(
      existsSync(join(externalB, "milestones", "M001.md")),
      "local-only repo must recover state via .gsd-id marker after move",
    );

    rmSync(repoB, { recursive: true, force: true });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  test("identity remains different for repos with different remotes", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-diff-a-")));
    initRepo(repoA, "https://github.com/example/repo-alpha.git");

    const repoB = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-diff-b-")));
    initRepo(repoB, "https://github.com/example/repo-beta.git");

    assert.notStrictEqual(
      repoIdentity(repoA),
      repoIdentity(repoB),
      "repos with different remotes must have different identities",
    );

    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  test("no orphaned state dir created when remote repo is moved", () => {
    const repoA = realpathSync(mkdtempSync(join(tmpdir(), "gsd-reloc-orphan-a-")));
    initRepo(repoA, "https://github.com/example/no-orphan.git");

    ensureGsdSymlink(repoA);

    // Count project dirs before move
    const projectsDir = externalProjectsRoot();
    const countBefore = existsSync(projectsDir)
      ? readdirSync(projectsDir).length
      : 0;

    // Move the repo
    const repoB = join(
      tmpdir(),
      `gsd-reloc-orphan-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    renameSync(repoA, repoB);

    ensureGsdSymlink(repoB);

    const countAfter = readdirSync(projectsDir).length;
    assert.strictEqual(
      countAfter,
      countBefore,
      "moving a remote repo must not create a new orphaned state directory",
    );

    rmSync(repoB, { recursive: true, force: true });
  });
});
