/**
 * auto-pr-bugs.test.ts — Regression tests for #2302.
 *
 * Three interacting bugs prevented auto_pr from ever creating a PR:
 * 1. auto_pr was gated on `pushed` (which requires auto_push)
 * 2. Milestone branch was not pushed to remote before PR creation
 * 3. createDraftPR in git-service.ts lacked --head/--base parameters
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Bug 1: auto_pr should not depend on auto_push / pushed flag ────────────

const autoWorktreeSrcPath = join(import.meta.dirname, "..", "auto-worktree.ts");
const autoWorktreeSrc = readFileSync(autoWorktreeSrcPath, "utf-8");

test("#2302 bug 1: auto_pr condition should not require pushed flag", () => {
  // Find the auto_pr block in mergeMilestoneToMain
  const autoPrIdx = autoWorktreeSrc.indexOf("auto_pr");
  assert.ok(autoPrIdx !== -1, "auto_pr reference exists in auto-worktree.ts");

  // Get context around the auto_pr check
  const lineStart = autoWorktreeSrc.lastIndexOf("\n", autoPrIdx) + 1;
  const lineEnd = autoWorktreeSrc.indexOf("\n", autoPrIdx);
  const autoPrLine = autoWorktreeSrc.slice(lineStart, lineEnd);

  // The condition should NOT include `&& pushed`
  assert.ok(
    !autoPrLine.includes("&& pushed"),
    "auto_pr condition should not be gated on pushed flag (auto_push dependency)",
  );
});

// ─── Bug 2: phases.ts should not duplicate PR creation ──────────────────────

const phasesSrcPath = join(import.meta.dirname, "..", "auto", "phases.ts");
const phasesSrc = readFileSync(phasesSrcPath, "utf-8");

test("#2302 bug 2: phases.ts should not call createDraftPR (handled by mergeMilestoneToMain)", () => {
  // After fix, phases.ts should not import or call createDraftPR because
  // PR creation is handled inside mergeMilestoneToMain in auto-worktree.ts
  const createDraftPRCalls = phasesSrc.match(/createDraftPR\(/g) || [];

  assert.equal(
    createDraftPRCalls.length,
    0,
    "phases.ts should not call createDraftPR — it's handled by mergeMilestoneToMain",
  );
});

// ─── Bug 3: createDraftPR should accept head and base branch parameters ─────

const gitServiceSrcPath = join(import.meta.dirname, "..", "git-service.ts");
const gitServiceSrc = readFileSync(gitServiceSrcPath, "utf-8");

test("#2302 bug 3: createDraftPR should accept head and base branch parameters", () => {
  // Find the createDraftPR function signature
  const fnIdx = gitServiceSrc.indexOf("function createDraftPR");
  assert.ok(fnIdx !== -1, "createDraftPR function exists");

  // Get the function signature (up to the closing paren)
  const sigEnd = gitServiceSrc.indexOf(")", fnIdx);
  const signature = gitServiceSrc.slice(fnIdx, sigEnd);

  // Should have head and base parameters
  assert.ok(
    signature.includes("head") || signature.includes("branch"),
    "createDraftPR should accept a head/branch parameter",
  );
});

test("#2302 bug 3: createDraftPR should pass --head and --base to gh pr create", () => {
  const fnIdx = gitServiceSrc.indexOf("function createDraftPR");
  const fnEnd = gitServiceSrc.indexOf("\n}", fnIdx);
  const fnBody = gitServiceSrc.slice(fnIdx, fnEnd);

  assert.ok(
    fnBody.includes("--head"),
    "createDraftPR should pass --head to gh pr create",
  );
  assert.ok(
    fnBody.includes("--base"),
    "createDraftPR should pass --base to gh pr create",
  );
});
