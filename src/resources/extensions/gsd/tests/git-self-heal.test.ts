/**
 * git-self-heal.test.ts — Integration tests for git self-healing utilities.
 *
 * Uses real temporary git repos with deliberately broken state.
 * No mocks — exercises actual git operations.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import {
  abortAndReset,
  withMergeHeal,
  recoverCheckout,
  formatGitError,
  MergeConflictError,
} from "../git-self-heal.js";

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

// ─── withMergeHeal ───────────────────────────────────────────────────

console.log("── withMergeHeal ──");

// Test: transient failure succeeds on retry
{
  const dir = makeTempRepo();
  try {
    let callCount = 0;
    const result = withMergeHeal(dir, () => {
      callCount++;
      if (callCount === 1) throw new Error("transient git error");
      return "success";
    });

    assert.strictEqual(result, "success", "should return mergeFn result on retry");
    assert.strictEqual(callCount, 2, "should have called mergeFn twice");

    console.log("  ✓ transient failure succeeds on retry");
  } finally {
    cleanup(dir);
  }
}

// Test: real conflict escalates immediately (no retry)
{
  const dir = makeTempRepo();
  try {
    // Set up a real merge conflict
    execSync("git checkout -b conflict-branch", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "conflict.txt"), "branch A\n");
    execSync("git add -A && git commit -m \"branch A\"", { cwd: dir, stdio: "pipe" });
    execSync("git checkout main", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "conflict.txt"), "branch B\n");
    execSync("git add -A && git commit -m \"branch B\"", { cwd: dir, stdio: "pipe" });

    let callCount = 0;
    try {
      withMergeHeal(dir, () => {
        callCount++;
        // Actually perform the conflicting merge
        execSync("git merge conflict-branch", { cwd: dir, stdio: "pipe" });
      });
      assert.fail("should have thrown MergeConflictError");
    } catch (err) {
      assert.ok(err instanceof MergeConflictError, `should throw MergeConflictError, got ${(err as Error).constructor.name}`);
      assert.strictEqual(callCount, 1, "should NOT retry on real conflict");
    }

    console.log("  ✓ real conflict escalates immediately without retry");
  } finally {
    cleanup(dir);
  }
}

// ─── recoverCheckout ─────────────────────────────────────────────────

console.log("── recoverCheckout ──");

// Test: dirty index recovery
{
  const dir = makeTempRepo();
  try {
    // Create a branch to checkout to
    execSync("git checkout -b target-branch", { cwd: dir, stdio: "pipe" });
    execSync("git checkout main", { cwd: dir, stdio: "pipe" });

    // Dirty the index
    writeFileSync(join(dir, "README.md"), "dirty changes\n");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });

    // Normal checkout would complain about dirty index
    recoverCheckout(dir, "target-branch");

    const branch = execSync("git branch --show-current", { cwd: dir, encoding: "utf-8" }).trim();
    assert.strictEqual(branch, "target-branch", "should be on target branch after recovery");

    console.log("  ✓ recovers checkout with dirty index");
  } finally {
    cleanup(dir);
  }
}

// Test: non-existent branch throws with context
{
  const dir = makeTempRepo();
  try {
    try {
      recoverCheckout(dir, "nonexistent-branch");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok((err as Error).message.includes("recoverCheckout failed"), "should include context in error");
      assert.ok((err as Error).message.includes("nonexistent-branch"), "should mention branch name");
    }

    console.log("  ✓ throws with context for non-existent branch");
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
