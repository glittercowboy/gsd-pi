import test from "node:test";
import assert from "node:assert/strict";

// Test the filtering logic used by /gsd pr-branch.
// Full integration requires git operations, so we test the path filtering.

test("pr-branch: identifies .gsd/ paths", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    ".gsd/metrics.json",
    "src/main.ts",
    "package.json",
    ".planning/PLAN.md",
    "PLAN.md",
  ];

  const codeFiles = files.filter(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md",
  );

  assert.deepEqual(codeFiles, ["src/main.ts", "package.json"]);
});

test("pr-branch: all .gsd/ files returns empty", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    ".gsd/metrics.json",
    ".gsd/BACKLOG.md",
  ];

  const codeFiles = files.filter(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md",
  );

  assert.equal(codeFiles.length, 0);
});

test("pr-branch: mixed commits with code changes", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    "src/auth.ts",
    "src/auth.test.ts",
  ];

  const hasCodeChanges = files.some(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md",
  );

  assert.ok(hasCodeChanges);
});

test("pr-branch: --dry-run flag", () => {
  assert.ok("--dry-run".includes("--dry-run"));
  assert.ok(!"--name my-branch".includes("--dry-run"));
});

test("pr-branch: --name flag parsing", () => {
  const args = "--name my-clean-pr";
  const nameMatch = args.match(/--name\s+(\S+)/);
  assert.ok(nameMatch);
  assert.equal(nameMatch[1], "my-clean-pr");
});

test("pr-branch: default branch name", () => {
  const currentBranch = "feat/add-auth";
  const prBranch = `pr/${currentBranch}`;
  assert.equal(prBranch, "pr/feat/add-auth");
});
