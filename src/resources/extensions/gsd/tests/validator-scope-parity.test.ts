// GSD-2 + Tests verifying writer/validator path parity via MilestoneScope (C3)
//
// Critical invariant: a writer that constructs paths via scope.contextFile() /
// scope.roadmapFile() and a validator that resolves paths via the scope-based
// wrappers in guided-flow.ts must produce IDENTICAL absolute paths for the same
// logical inputs.  If they diverge, writes go to a different location than the
// validator checks, causing silent failures.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWorkspace, scopeMilestone } from "../workspace.ts";
import {
  verifyExpectedArtifactForScope,
  resolveExpectedArtifactPathForScope,
  isGhostMilestoneByScope,
} from "../guided-flow.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProjectDir(label = "gsd-vsp-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), label)));
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  return dir;
}

// ─── Suite: writer/validator path parity ─────────────────────────────────────

describe("validator-scope-parity: writer and validator produce identical paths", () => {
  let base: string;

  beforeEach(() => {
    base = makeProjectDir();
  });

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("resolveExpectedArtifactPathForScope('discuss-milestone') matches scope.contextFile()", () => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    // Writer path: what the discuss/plan agent writes to
    const writerPath = scope.contextFile();

    // Validator path: what the validator checks
    const validatorPath = resolveExpectedArtifactPathForScope(scope, "discuss-milestone", "M001");

    assert.equal(
      validatorPath,
      writerPath,
      "discuss-milestone artifact path must match scope.contextFile()",
    );
  });

  test("resolveExpectedArtifactPathForScope('plan-milestone') matches scope.roadmapFile()", () => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    const writerPath = scope.roadmapFile();
    const validatorPath = resolveExpectedArtifactPathForScope(scope, "plan-milestone", "M001");

    assert.equal(
      validatorPath,
      writerPath,
      "plan-milestone artifact path must match scope.roadmapFile()",
    );
  });

  test("resolveExpectedArtifactPathForScope returns an absolute path", () => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    const path = resolveExpectedArtifactPathForScope(scope, "discuss-milestone", "M001");
    assert.ok(path, "path must be non-null for a milestone unit");
    assert.ok(path!.startsWith("/"), "path must be absolute");
  });
});

// ─── Suite: cwd-drift immunity ────────────────────────────────────────────────

describe("validator-scope-parity: scope-based validators are immune to cwd-drift", () => {
  let base: string;

  beforeEach(() => {
    base = makeProjectDir();
  });

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("resolveExpectedArtifactPathForScope path is unchanged after process.chdir", (t) => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    const pathBefore = resolveExpectedArtifactPathForScope(scope, "plan-milestone", "M001");

    const originalCwd = process.cwd();
    const altDir = mkdtempSync(join(tmpdir(), "gsd-cwd-alt-"));
    t.after(() => {
      process.chdir(originalCwd);
      rmSync(altDir, { recursive: true, force: true });
    });

    process.chdir(altDir);

    const pathAfter = resolveExpectedArtifactPathForScope(scope, "plan-milestone", "M001");

    assert.equal(
      pathAfter,
      pathBefore,
      "artifact path must not change after cwd drift",
    );
  });

  test("isGhostMilestoneByScope result is consistent before and after process.chdir", (t) => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    // No DB, no content files — should be ghost
    const resultBefore = isGhostMilestoneByScope(scope);

    const originalCwd = process.cwd();
    const altDir = mkdtempSync(join(tmpdir(), "gsd-cwd-alt2-"));
    t.after(() => {
      process.chdir(originalCwd);
      rmSync(altDir, { recursive: true, force: true });
    });

    process.chdir(altDir);

    const resultAfter = isGhostMilestoneByScope(scope);

    assert.equal(
      resultAfter,
      resultBefore,
      "isGhostMilestoneByScope result must be consistent across cwd change",
    );
  });
});

// ─── Suite: isGhostMilestoneByScope behavior ─────────────────────────────────

describe("validator-scope-parity: isGhostMilestoneByScope correctness", () => {
  let base: string;

  beforeEach(() => {
    base = makeProjectDir();
  });

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("isGhostMilestoneByScope returns true for milestone dir with no content files", () => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    // M001 dir exists (created in beforeEach) but has no CONTEXT/ROADMAP/SUMMARY
    assert.equal(
      isGhostMilestoneByScope(scope),
      true,
      "empty milestone dir with no content files should be ghost",
    );
  });

  test("isGhostMilestoneByScope returns false when CONTEXT.md exists", (t) => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    // Write CONTEXT.md so the milestone is no longer a ghost
    writeFileSync(scope.contextFile(), "# M001: Test\n\nContext.\n");
    t.after(() => {
      try { unlinkSync(scope.contextFile()); } catch {}
    });

    assert.equal(
      isGhostMilestoneByScope(scope),
      false,
      "milestone with CONTEXT.md should not be ghost",
    );
  });
});

// ─── Suite: worktree path resolves to canonical project root ─────────────────

describe("validator-scope-parity: scope uses canonical projectRoot not worktree path", () => {
  let base: string;

  beforeEach(() => {
    base = makeProjectDir("gsd-wt-parity-");
  });

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("scope.workspace.projectRoot equals the input base for a non-worktree project", () => {
    const ws = createWorkspace(base);
    // For a plain project (not a worktree), projectRoot should be the realpath of base
    assert.equal(
      ws.projectRoot,
      realpathSync(base),
      "projectRoot must be realpath of the input base for a non-worktree project",
    );
  });

  test("validator wrapper paths are rooted at scope.workspace.projectRoot, not at a worktree dir", () => {
    // Simulate calling with a workspace that has projectRoot set.
    // The validator should use projectRoot, not a different runtime path.
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    const artifactPath = resolveExpectedArtifactPathForScope(scope, "plan-milestone", "M001");

    assert.ok(
      artifactPath!.startsWith(scope.workspace.projectRoot),
      `artifact path '${artifactPath}' must be rooted at projectRoot '${scope.workspace.projectRoot}'`,
    );
  });

  test("verifyExpectedArtifactForScope uses projectRoot: returns false for non-existent artifact", () => {
    const ws = createWorkspace(base);
    const scope = scopeMilestone(ws, "M001");

    // The artifact does not exist on disk yet
    const ready = verifyExpectedArtifactForScope(scope, "plan-milestone", "M001");
    assert.equal(
      ready,
      false,
      "verifyExpectedArtifactForScope should return false when artifact is absent",
    );
  });
});
