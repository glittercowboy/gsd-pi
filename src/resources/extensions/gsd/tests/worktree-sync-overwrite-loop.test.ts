/**
 * worktree-sync-overwrite-loop.test.ts — Regression tests for #1886.
 *
 * Reproduces the infinite validate-milestone loop caused by two bugs
 * in syncProjectRootToWorktree:
 *
 * 1. safeCopyRecursive overwrites worktree-authoritative files (e.g.
 *    VALIDATION.md written by validate-milestone gets clobbered by the
 *    stale project root copy that lacks the file).
 *
 * 2. completed-units.json is not forward-synced from project root to
 *    worktree, so the worktree never learns about already-completed units.
 *
 * Covers:
 *   - syncProjectRootToWorktree does NOT overwrite existing worktree files
 *   - syncProjectRootToWorktree copies files missing from the worktree
 *   - completed-units.json is forward-synced from project root to worktree
 *   - completed-units.json sync uses force:true (project root is authoritative)
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { syncProjectRootToWorktree } from "../auto-worktree.ts";

function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-1886-${name}-`));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

describe("worktree-sync-overwrite-loop (#1886)", () => {
  test("worktree VALIDATION.md preserved (not overwritten)", async (t) => {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    t.after(() => {
      cleanup(mainBase);
      cleanup(wtBase);
    });

    // Project root has an older CONTEXT but no VALIDATION
    const prM004 = join(mainBase, ".gsd", "milestones", "M004");
    mkdirSync(prM004, { recursive: true });
    writeFileSync(join(prM004, "M004-CONTEXT.md"), "# old context");

    // Worktree has CONTEXT + VALIDATION (written by validate-milestone)
    const wtM004 = join(wtBase, ".gsd", "milestones", "M004");
    mkdirSync(wtM004, { recursive: true });
    writeFileSync(join(wtM004, "M004-CONTEXT.md"), "# worktree context");
    writeFileSync(
      join(wtM004, "M004-VALIDATION.md"),
      "verdict: pass\nremediation_round: 1",
    );

    syncProjectRootToWorktree(mainBase, wtBase, "M004");

    assert.ok(
      existsSync(join(wtM004, "M004-VALIDATION.md")),
      "VALIDATION.md still exists after sync",
    );
    assert.deepStrictEqual(
      readFileSync(join(wtM004, "M004-VALIDATION.md"), "utf-8"),
      "verdict: pass\nremediation_round: 1",
      "VALIDATION.md content preserved",
    );
    assert.deepStrictEqual(
      readFileSync(join(wtM004, "M004-CONTEXT.md"), "utf-8"),
      "# worktree context",
      "existing worktree CONTEXT.md not overwritten",
    );
  });

  test("missing worktree files still copied from project root", async (t) => {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    t.after(() => {
      cleanup(mainBase);
      cleanup(wtBase);
    });

    const prM004 = join(mainBase, ".gsd", "milestones", "M004");
    mkdirSync(prM004, { recursive: true });
    writeFileSync(join(prM004, "M004-CONTEXT.md"), "# from project root");
    writeFileSync(join(prM004, "M004-ROADMAP.md"), "# roadmap");

    // Worktree has no M004 directory at all
    syncProjectRootToWorktree(mainBase, wtBase, "M004");

    assert.ok(
      existsSync(join(wtBase, ".gsd", "milestones", "M004", "M004-CONTEXT.md")),
      "missing CONTEXT.md copied from project root",
    );
    assert.ok(
      existsSync(join(wtBase, ".gsd", "milestones", "M004", "M004-ROADMAP.md")),
      "missing ROADMAP.md copied from project root",
    );
  });

  test("completed-units.json forward-synced from project root", async (t) => {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    t.after(() => {
      cleanup(mainBase);
      cleanup(wtBase);
    });

    // Project root has completed units (authoritative after crash recovery)
    writeFileSync(
      join(mainBase, ".gsd", "completed-units.json"),
      JSON.stringify(["validate-milestone/M004"]),
    );

    // Worktree has empty completed-units
    writeFileSync(
      join(wtBase, ".gsd", "completed-units.json"),
      JSON.stringify([]),
    );

    syncProjectRootToWorktree(mainBase, wtBase, "M004");

    const wtCompleted = JSON.parse(
      readFileSync(join(wtBase, ".gsd", "completed-units.json"), "utf-8"),
    );
    assert.deepStrictEqual(
      wtCompleted,
      ["validate-milestone/M004"],
      "completed-units.json synced from project root (force:true)",
    );
  });

  test("completed-units.json no-op when missing in project root", async (t) => {
    const mainBase = createBase("main");
    const wtBase = createBase("wt");
    t.after(() => {
      cleanup(mainBase);
      cleanup(wtBase);
    });

    // Project root milestone dir must exist for sync to run
    const prM004 = join(mainBase, ".gsd", "milestones", "M004");
    mkdirSync(prM004, { recursive: true });

    // No completed-units.json in project root
    // Worktree has its own
    writeFileSync(
      join(wtBase, ".gsd", "completed-units.json"),
      JSON.stringify(["some-unit/M001"]),
    );

    syncProjectRootToWorktree(mainBase, wtBase, "M004");

    const wtCompleted = JSON.parse(
      readFileSync(join(wtBase, ".gsd", "completed-units.json"), "utf-8"),
    );
    assert.deepStrictEqual(
      wtCompleted,
      ["some-unit/M001"],
      "worktree completed-units.json untouched when project root has none",
    );
  });
});
