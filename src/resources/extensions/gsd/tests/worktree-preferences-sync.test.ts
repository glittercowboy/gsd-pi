/**
 * worktree-preferences-sync.test.ts — Regression test for #2684.
 *
 * Verifies that preferences.md is seeded into auto-mode worktrees:
 *
 *   1. copyPlanningArtifacts() copies preferences.md on initial worktree creation
 *   2. syncGsdStateToWorktree() forward-syncs preferences.md (additive only)
 *   3. syncWorktreeStateBack() does NOT overwrite project root preferences.md
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  syncGsdStateToWorktree,
  syncWorktreeStateBack,
} from "../auto-worktree.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gsd-prefs-test-${prefix}-`));
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────

const PREFS_CONTENT = [
  "# Preferences",
  "",
  "post_unit_hooks:",
  "  - npm run lint",
  "",
  "skill_rules:",
  '  - use: "frontend-design"',
].join("\n");

test("#2684: syncGsdStateToWorktree forward-syncs preferences.md when missing from worktree", (t) => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  t.after(() => cleanup(mainBase, wtBase));

  // Project root has preferences.md
  writeFile(mainBase, ".gsd/preferences.md", PREFS_CONTENT);

  // Worktree has .gsd/ but no preferences.md
  mkdirSync(join(wtBase, ".gsd"), { recursive: true });

  const result = syncGsdStateToWorktree(mainBase, wtBase);

  assert.ok(
    existsSync(join(wtBase, ".gsd", "preferences.md")),
    "preferences.md should be copied to worktree",
  );
  assert.equal(
    readFileSync(join(wtBase, ".gsd", "preferences.md"), "utf-8"),
    PREFS_CONTENT,
    "preferences.md content should match source",
  );
  assert.ok(
    result.synced.includes("preferences.md"),
    "preferences.md should appear in synced list",
  );
});

test("#2684: syncGsdStateToWorktree does NOT overwrite existing worktree preferences.md", (t) => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  t.after(() => cleanup(mainBase, wtBase));

  const rootPrefs = "# Root preferences\nold: true";
  const wtPrefs = "# Worktree preferences\nmodified: true";

  writeFile(mainBase, ".gsd/preferences.md", rootPrefs);
  writeFile(wtBase, ".gsd/preferences.md", wtPrefs);

  syncGsdStateToWorktree(mainBase, wtBase);

  assert.equal(
    readFileSync(join(wtBase, ".gsd", "preferences.md"), "utf-8"),
    wtPrefs,
    "existing worktree preferences.md must not be overwritten",
  );
});

test("#2684: syncWorktreeStateBack does NOT overwrite project root preferences.md", (t) => {
  const mainBase = makeTempDir("main");
  const wtBase = makeTempDir("wt");
  const mid = "M001";
  t.after(() => cleanup(mainBase, wtBase));

  const rootPrefs = "# Root preferences\nauthoritative: true";
  const wtPrefs = "# Worktree preferences\nstale-copy: true";

  writeFile(mainBase, ".gsd/preferences.md", rootPrefs);
  writeFile(wtBase, ".gsd/preferences.md", wtPrefs);

  // Worktree needs at least a milestone dir for the function to proceed
  mkdirSync(join(wtBase, ".gsd", "milestones", mid), { recursive: true });
  mkdirSync(join(mainBase, ".gsd", "milestones"), { recursive: true });

  syncWorktreeStateBack(mainBase, wtBase, mid);

  assert.equal(
    readFileSync(join(mainBase, ".gsd", "preferences.md"), "utf-8"),
    rootPrefs,
    "project root preferences.md must NOT be overwritten by worktree copy",
  );
});
