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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
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

import { syncProjectRootToWorktree } from "../auto-worktree.ts";

function createBase(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-wt-1886-${name}-`));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function registerBases(
  t: { after: (fn: () => void) => void },
  ...dirs: string[]
): void {
  t.after(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });
}

test("#1886: worktree VALIDATION.md is not overwritten by project root sync", (t) => {
  const mainBase = createBase("main");
  const wtBase = createBase("wt");
  registerBases(t, mainBase, wtBase);

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
  assert.equal(
    readFileSync(join(wtM004, "M004-VALIDATION.md"), "utf-8"),
    "verdict: pass\nremediation_round: 1",
    "VALIDATION.md content preserved",
  );
  assert.equal(
    readFileSync(join(wtM004, "M004-CONTEXT.md"), "utf-8"),
    "# worktree context",
    "existing worktree CONTEXT.md not overwritten",
  );
});

test("#1886: missing worktree files are still copied from project root", (t) => {
  const mainBase = createBase("main");
  const wtBase = createBase("wt");
  registerBases(t, mainBase, wtBase);

  const prM004 = join(mainBase, ".gsd", "milestones", "M004");
  mkdirSync(prM004, { recursive: true });
  writeFileSync(join(prM004, "M004-CONTEXT.md"), "# from project root");
  writeFileSync(join(prM004, "M004-ROADMAP.md"), "# roadmap");

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

test("#1886: completed-units.json is forward-synced to worktree", (t) => {
  const mainBase = createBase("main");
  const wtBase = createBase("wt");
  registerBases(t, mainBase, wtBase);

  writeFileSync(
    join(mainBase, ".gsd", "completed-units.json"),
    JSON.stringify(["validate-milestone/M004"]),
  );
  writeFileSync(
    join(wtBase, ".gsd", "completed-units.json"),
    JSON.stringify([]),
  );

  syncProjectRootToWorktree(mainBase, wtBase, "M004");

  const wtCompleted = JSON.parse(
    readFileSync(join(wtBase, ".gsd", "completed-units.json"), "utf-8"),
  );
  assert.deepEqual(
    wtCompleted,
    ["validate-milestone/M004"],
    "completed-units.json synced from project root (force:true)",
  );
});

test("#1886: worktree completed-units.json untouched when project root has none", (t) => {
  const mainBase = createBase("main");
  const wtBase = createBase("wt");
  registerBases(t, mainBase, wtBase);

  // Project root milestone dir must exist for sync to run
  const prM004 = join(mainBase, ".gsd", "milestones", "M004");
  mkdirSync(prM004, { recursive: true });

  writeFileSync(
    join(wtBase, ".gsd", "completed-units.json"),
    JSON.stringify(["some-unit/M001"]),
  );

  syncProjectRootToWorktree(mainBase, wtBase, "M004");

  const wtCompleted = JSON.parse(
    readFileSync(join(wtBase, ".gsd", "completed-units.json"), "utf-8"),
  );
  assert.deepEqual(
    wtCompleted,
    ["some-unit/M001"],
    "worktree completed-units.json untouched when project root has none",
  );
});
