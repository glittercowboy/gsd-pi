/**
 * git-self-heal.test.ts — Integration tests for git self-healing utilities.
 *
 * Uses real temporary git repos with deliberately broken state.
 * No mocks — exercises actual git operations.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import {
  abortAndReset,
  formatGitError,
} from "../../git-self-heal.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-self-heal-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email \"test@test.com\"", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name \"Test\"", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# init\n");
  execSync("git add -A && git commit -m \"init\"", { cwd: dir, stdio: "pipe" });
  execSync("git branch -M main", { cwd: dir, stdio: "pipe" });
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── abortAndReset ───────────────────────────────────────────────────

console.log("── abortAndReset ──");

// Test: leftover MERGE_HEAD
{
  const dir = makeTempRepo();
  try {
    // Create a conflicting branch
    execSync("git checkout -b feature", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "file.txt"), "feature content\n");
    execSync("git add -A && git commit -m \"feature\"", { cwd: dir, stdio: "pipe" });
    execSync("git checkout main", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "file.txt"), "main content\n");
    execSync("git add -A && git commit -m \"main change\"", { cwd: dir, stdio: "pipe" });

    // Create a merge conflict → MERGE_HEAD will exist
    try {
      execSync("git merge feature", { cwd: dir, stdio: "pipe" });
    } catch {
      // expected conflict
    }

    assert.ok(existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD should exist before abort");

    const result = abortAndReset(dir);
    assert.ok(result.cleaned.some((s) => s.includes("aborted merge")), "should report aborted merge");
    assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "MERGE_HEAD should be gone after abort");

    console.log("  ✓ cleans up leftover MERGE_HEAD");
  } finally {
    cleanup(dir);
  }
}

// Test: leftover SQUASH_MSG (no MERGE_HEAD)
{
  const dir = makeTempRepo();
  try {
    // Manually create a SQUASH_MSG to simulate leftover state
    writeFileSync(join(dir, ".git", "SQUASH_MSG"), "leftover squash message\n");

    const result = abortAndReset(dir);
    assert.ok(result.cleaned.some((s) => s.includes("SQUASH_MSG")), "should report SQUASH_MSG removal");
    assert.ok(!existsSync(join(dir, ".git", "SQUASH_MSG")), "SQUASH_MSG should be gone");

    console.log("  ✓ cleans up leftover SQUASH_MSG");
  } finally {
    cleanup(dir);
  }
}

// Test: clean state (no-op)
{
  const dir = makeTempRepo();
  try {
    const result = abortAndReset(dir);
    assert.deepStrictEqual(result.cleaned, [], "clean repo should produce empty cleaned array");

    console.log("  ✓ no-op on clean state");
  } finally {
    cleanup(dir);
  }
}

// ─── formatGitError ──────────────────────────────────────────────────

console.log("── formatGitError ──");

{
  const cases: Array<{ input: string; shouldContain: string; label: string }> = [
    { input: "CONFLICT (content): Merge conflict in file.ts", shouldContain: "/gsd doctor", label: "merge conflict" },
    { input: "error: pathspec 'foo' did not match any file(s)", shouldContain: "/gsd doctor", label: "checkout failure" },
    { input: "HEAD detached at abc123", shouldContain: "/gsd doctor", label: "detached HEAD" },
    { input: "Unable to create '/path/.git/index.lock': File exists", shouldContain: "/gsd doctor", label: "lock file" },
    { input: "fatal: not a git repository", shouldContain: "/gsd doctor", label: "not a repo" },
    { input: "some unknown error", shouldContain: "/gsd doctor", label: "unknown error" },
  ];

  for (const { input, shouldContain, label } of cases) {
    const result = formatGitError(input);
    assert.ok(result.includes(shouldContain), `${label}: should suggest /gsd doctor`);
    console.log(`  ✓ ${label} → suggests /gsd doctor`);
  }

  // Test with Error object
  const result = formatGitError(new Error("CONFLICT in merge"));
  assert.ok(result.includes("/gsd doctor"), "should handle Error objects");
  console.log("  ✓ handles Error objects");
}

console.log("\n✅ All git-self-heal tests passed");
