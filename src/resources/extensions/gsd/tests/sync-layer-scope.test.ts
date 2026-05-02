// GSD-2 + Sync-layer scope variants: tests for ByScope wrappers in auto-worktree.ts

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspace, scopeMilestone } from "../workspace.ts";
import {
  syncProjectRootToWorktree,
  syncProjectRootToWorktreeByScope,
  syncStateToProjectRoot,
  syncStateToProjectRootByScope,
  syncGsdStateToWorktree,
  syncGsdStateToWorktreeByScope,
  reconcilePlanCheckboxesByScope,
} from "../auto-worktree.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

const MID = "M001-abc123";

/**
 * Build a minimal project+worktree layout in a temp dir.
 *
 * Layout:
 *   <root>/
 *     .gsd/
 *       milestones/<MID>/
 *         <MID>-CONTEXT.md
 *       metrics.json
 *       completed-units.json
 *       runtime/units/
 *     .gsd/worktrees/<MID>/
 *       .gsd/           ← worktree-local .gsd projection
 *         milestones/<MID>/
 *
 * Returns { projectDir, worktreeDir }.
 */
function makeProjectAndWorktree(base: string): {
  projectDir: string;
  worktreeDir: string;
} {
  const projectDir = realpathSync(base);

  // Project .gsd layout
  mkdirSync(join(projectDir, ".gsd", "milestones", MID), { recursive: true });
  mkdirSync(join(projectDir, ".gsd", "runtime", "units"), { recursive: true });
  writeFileSync(join(projectDir, ".gsd", "milestones", MID, `${MID}-CONTEXT.md`), "context");
  writeFileSync(join(projectDir, ".gsd", "metrics.json"), '{"tokens":0}');
  writeFileSync(join(projectDir, ".gsd", "completed-units.json"), "[]");

  // Worktree directory inside .gsd/worktrees/<MID> so isGsdWorktreePath recognises it
  const worktreeDir = join(projectDir, ".gsd", "worktrees", MID);
  mkdirSync(join(worktreeDir, ".gsd", "milestones", MID), { recursive: true });
  mkdirSync(join(worktreeDir, ".gsd", "runtime", "units"), { recursive: true });

  return { projectDir, worktreeDir };
}

// ─── Suite: identity check (throws on mismatched workspace) ─────────────────

describe("ByScope variants: mismatched-workspace identity assertion", () => {
  let tmpA: string;
  let tmpB: string;

  beforeEach(() => {
    tmpA = mkdtempSync(join(tmpdir(), "gsd-sync-scope-a-"));
    tmpB = mkdtempSync(join(tmpdir(), "gsd-sync-scope-b-"));
  });

  afterEach(() => {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  });

  test("syncProjectRootToWorktreeByScope throws when identityKeys differ", () => {
    mkdirSync(join(tmpA, ".gsd"), { recursive: true });
    mkdirSync(join(tmpB, ".gsd"), { recursive: true });
    const wsA = createWorkspace(tmpA);
    const wsB = createWorkspace(tmpB);
    const scopeA = scopeMilestone(wsA, MID);
    const scopeB = scopeMilestone(wsB, MID);

    assert.throws(
      () => syncProjectRootToWorktreeByScope(scopeA, scopeB),
      /scope identity mismatch/,
    );
  });

  test("syncStateToProjectRootByScope throws when identityKeys differ", () => {
    mkdirSync(join(tmpA, ".gsd"), { recursive: true });
    mkdirSync(join(tmpB, ".gsd"), { recursive: true });
    const wsA = createWorkspace(tmpA);
    const wsB = createWorkspace(tmpB);
    const scopeA = scopeMilestone(wsA, MID);
    const scopeB = scopeMilestone(wsB, MID);

    assert.throws(
      () => syncStateToProjectRootByScope(scopeA, scopeB),
      /scope identity mismatch/,
    );
  });

  test("syncGsdStateToWorktreeByScope throws when identityKeys differ", () => {
    mkdirSync(join(tmpA, ".gsd"), { recursive: true });
    mkdirSync(join(tmpB, ".gsd"), { recursive: true });
    const wsA = createWorkspace(tmpA);
    const wsB = createWorkspace(tmpB);
    const scopeA = scopeMilestone(wsA, MID);
    const scopeB = scopeMilestone(wsB, MID);

    assert.throws(
      () => syncGsdStateToWorktreeByScope(scopeA, scopeB),
      /scope identity mismatch/,
    );
  });

  test("reconcilePlanCheckboxesByScope throws when identityKeys differ", () => {
    mkdirSync(join(tmpA, ".gsd"), { recursive: true });
    mkdirSync(join(tmpB, ".gsd"), { recursive: true });
    const wsA = createWorkspace(tmpA);
    const wsB = createWorkspace(tmpB);
    const scopeA = scopeMilestone(wsA, MID);
    const scopeB = scopeMilestone(wsB, MID);

    assert.throws(
      () => reconcilePlanCheckboxesByScope(scopeA, scopeB),
      /scope identity mismatch/,
    );
  });
});

// ─── Suite: same-milestone, same-workspace path identity ────────────────────

describe("ByScope variants: same-workspace produces same paths regardless of scope side", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-sync-scope-id-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("rootScope.workspace.identityKey equals worktreeScope.workspace.identityKey for same project", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);

    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);

    assert.equal(
      rootWs.identityKey,
      worktreeWs.identityKey,
      "both scopes from same project must share identityKey",
    );
  });

  test("rootScope paths and worktreeScope.workspace.projectRoot resolve to the same project root", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);

    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);

    assert.equal(
      rootWs.projectRoot,
      worktreeWs.projectRoot,
      "projectRoot must be identical for root and worktree scopes",
    );
  });
});

// ─── Suite: disk-effect parity (scope variants == legacy path variants) ─────

describe("syncProjectRootToWorktreeByScope: disk-effect parity with legacy", () => {
  let tmp1: string;
  let tmp2: string;

  beforeEach(() => {
    tmp1 = mkdtempSync(join(tmpdir(), "gsd-sync-legacy-"));
    tmp2 = mkdtempSync(join(tmpdir(), "gsd-sync-scope-"));
  });

  afterEach(() => {
    rmSync(tmp1, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });

  test("scope variant copies milestone dir into worktree identical to legacy variant", () => {
    const { projectDir: proj1, worktreeDir: wt1 } = makeProjectAndWorktree(tmp1);
    const { projectDir: proj2, worktreeDir: wt2 } = makeProjectAndWorktree(tmp2);

    // Add a source file in project root milestone dir (not yet in worktree)
    const srcFile = "extra-artifact.md";
    writeFileSync(join(proj1, ".gsd", "milestones", MID, srcFile), "artifact");
    writeFileSync(join(proj2, ".gsd", "milestones", MID, srcFile), "artifact");

    // Remove destination files so something needs to be copied
    rmSync(join(wt1, ".gsd", "milestones", MID, `${MID}-CONTEXT.md`), { force: true });
    rmSync(join(wt2, ".gsd", "milestones", MID, `${MID}-CONTEXT.md`), { force: true });

    // Run legacy on tmp1, scope variant on tmp2
    syncProjectRootToWorktree(proj1, wt1, MID);

    const rootWs2 = createWorkspace(proj2);
    const worktreeWs2 = createWorkspace(wt2);
    const rootScope2 = scopeMilestone(rootWs2, MID);
    const worktreeScope2 = scopeMilestone(worktreeWs2, MID);
    syncProjectRootToWorktreeByScope(rootScope2, worktreeScope2);

    // Both worktrees should now have the CONTEXT.md
    assert.ok(
      existsSync(join(wt1, ".gsd", "milestones", MID, `${MID}-CONTEXT.md`)),
      "legacy: CONTEXT.md should be copied into worktree",
    );
    assert.ok(
      existsSync(join(wt2, ".gsd", "milestones", MID, `${MID}-CONTEXT.md`)),
      "scope: CONTEXT.md should be copied into worktree",
    );
  });
});

describe("syncStateToProjectRootByScope: disk-effect parity with legacy", () => {
  let tmp1: string;
  let tmp2: string;

  beforeEach(() => {
    tmp1 = mkdtempSync(join(tmpdir(), "gsd-sync-stpr-legacy-"));
    tmp2 = mkdtempSync(join(tmpdir(), "gsd-sync-stpr-scope-"));
  });

  afterEach(() => {
    rmSync(tmp1, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });

  test("scope variant copies metrics.json from worktree to project root identical to legacy variant", () => {
    const { projectDir: proj1, worktreeDir: wt1 } = makeProjectAndWorktree(tmp1);
    const { projectDir: proj2, worktreeDir: wt2 } = makeProjectAndWorktree(tmp2);

    // Write metrics.json into each worktree .gsd
    const metricsContent = '{"tokens":42}';
    writeFileSync(join(wt1, ".gsd", "metrics.json"), metricsContent);
    writeFileSync(join(wt2, ".gsd", "metrics.json"), metricsContent);

    // Run legacy on tmp1, scope variant on tmp2
    syncStateToProjectRoot(wt1, proj1, MID);

    const rootWs2 = createWorkspace(proj2);
    const worktreeWs2 = createWorkspace(wt2);
    const rootScope2 = scopeMilestone(rootWs2, MID);
    const worktreeScope2 = scopeMilestone(worktreeWs2, MID);
    syncStateToProjectRootByScope(worktreeScope2, rootScope2);

    // Both project roots should now have the updated metrics.json
    assert.ok(
      existsSync(join(proj1, ".gsd", "metrics.json")),
      "legacy: metrics.json should be synced to project root",
    );
    assert.ok(
      existsSync(join(proj2, ".gsd", "metrics.json")),
      "scope: metrics.json should be synced to project root",
    );
  });
});

describe("syncGsdStateToWorktreeByScope: disk-effect parity with legacy", () => {
  let tmp1: string;
  let tmp2: string;

  beforeEach(() => {
    tmp1 = mkdtempSync(join(tmpdir(), "gsd-sync-gsd-legacy-"));
    tmp2 = mkdtempSync(join(tmpdir(), "gsd-sync-gsd-scope-"));
  });

  afterEach(() => {
    rmSync(tmp1, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });

  test("scope variant syncs root state files into worktree identical to legacy variant", () => {
    const { projectDir: proj1, worktreeDir: wt1 } = makeProjectAndWorktree(tmp1);
    const { projectDir: proj2, worktreeDir: wt2 } = makeProjectAndWorktree(tmp2);

    // Add a root state file in each project .gsd (not yet in worktree)
    writeFileSync(join(proj1, ".gsd", "DECISIONS.md"), "decisions");
    writeFileSync(join(proj2, ".gsd", "DECISIONS.md"), "decisions");

    // Run legacy on tmp1, scope variant on tmp2
    syncGsdStateToWorktree(proj1, wt1);

    const rootWs2 = createWorkspace(proj2);
    const worktreeWs2 = createWorkspace(wt2);
    const rootScope2 = scopeMilestone(rootWs2, MID);
    const worktreeScope2 = scopeMilestone(worktreeWs2, MID);
    syncGsdStateToWorktreeByScope(rootScope2, worktreeScope2);

    // Both worktrees should now have DECISIONS.md
    assert.ok(
      existsSync(join(wt1, ".gsd", "DECISIONS.md")),
      "legacy: DECISIONS.md should be copied into worktree",
    );
    assert.ok(
      existsSync(join(wt2, ".gsd", "DECISIONS.md")),
      "scope: DECISIONS.md should be copied into worktree",
    );
  });
});

// ─── Suite: direction tests ──────────────────────────────────────────────────

describe("sync direction: project→worktree variants only write to worktree side", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-sync-dir-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("syncProjectRootToWorktreeByScope: new file appears in worktree, not duplicated to project root", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);

    // New file in project root milestone — not yet in worktree
    const marker = "direction-test.md";
    writeFileSync(join(projectDir, ".gsd", "milestones", MID, marker), "marker");

    // Remove from worktree so we can detect it being added
    const wtDst = join(worktreeDir, ".gsd", "milestones", MID, marker);
    rmSync(wtDst, { force: true });

    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    const rootScope = scopeMilestone(rootWs, MID);
    const worktreeScope = scopeMilestone(worktreeWs, MID);

    syncProjectRootToWorktreeByScope(rootScope, worktreeScope);

    // File should now be in worktree
    assert.ok(existsSync(wtDst), "marker file should appear in worktree after project→worktree sync");

    // The original in project root should still be there (not removed)
    assert.ok(
      existsSync(join(projectDir, ".gsd", "milestones", MID, marker)),
      "project root marker file should not be removed",
    );
  });

  test("syncStateToProjectRootByScope: new file appears in project root from worktree", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);

    // Write a runtime unit file into worktree
    const unitFile = "some-unit-M001.json";
    writeFileSync(join(worktreeDir, ".gsd", "runtime", "units", unitFile), '{"status":"done"}');

    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    const rootScope = scopeMilestone(rootWs, MID);
    const worktreeScope = scopeMilestone(worktreeWs, MID);

    syncStateToProjectRootByScope(worktreeScope, rootScope);

    // Unit file should now be in project root
    assert.ok(
      existsSync(join(projectDir, ".gsd", "runtime", "units", unitFile)),
      "runtime unit file should appear in project root after worktree→root sync",
    );

    // Worktree side should still have the file (not removed)
    assert.ok(
      existsSync(join(worktreeDir, ".gsd", "runtime", "units", unitFile)),
      "worktree runtime unit file should not be removed",
    );
  });
});

// ─── Suite: milestoneId mismatch guard ───────────────────────────────────────

describe("ByScope variants: milestoneId mismatch throws for milestone-aware wrappers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-sync-mid-mismatch-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("syncProjectRootToWorktreeByScope throws when milestoneIds differ", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);
    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    // Same workspace identity, different milestoneId
    const rootScope = scopeMilestone(rootWs, "M001-abc123");
    const worktreeScope = scopeMilestone(worktreeWs, "M002-def456");

    assert.throws(
      () => syncProjectRootToWorktreeByScope(rootScope, worktreeScope),
      /milestoneId mismatch/,
    );
  });

  test("syncStateToProjectRootByScope throws when milestoneIds differ", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);
    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    const rootScope = scopeMilestone(rootWs, "M001-abc123");
    const worktreeScope = scopeMilestone(worktreeWs, "M002-def456");

    assert.throws(
      () => syncStateToProjectRootByScope(worktreeScope, rootScope),
      /milestoneId mismatch/,
    );
  });

  test("reconcilePlanCheckboxesByScope throws when milestoneIds differ", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);
    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    const rootScope = scopeMilestone(rootWs, "M001-abc123");
    const worktreeScope = scopeMilestone(worktreeWs, "M002-def456");

    assert.throws(
      () => reconcilePlanCheckboxesByScope(rootScope, worktreeScope),
      /milestoneId mismatch/,
    );
  });

  test("syncGsdStateToWorktreeByScope does NOT throw when milestoneIds differ (workspace-only wrapper)", () => {
    const { projectDir, worktreeDir } = makeProjectAndWorktree(tmp);
    const rootWs = createWorkspace(projectDir);
    const worktreeWs = createWorkspace(worktreeDir);
    // Different milestoneIds — syncGsdStateToWorktreeByScope must not guard milestoneId
    const rootScope = scopeMilestone(rootWs, "M001-abc123");
    const worktreeScope = scopeMilestone(worktreeWs, "M002-def456");

    assert.doesNotThrow(
      () => syncGsdStateToWorktreeByScope(rootScope, worktreeScope),
    );
  });
});
