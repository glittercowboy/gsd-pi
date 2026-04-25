/**
 * gitignore-staging-2570.test.ts — Regression tests for #2570.
 *
 * Verifies that:
 * 1. isGsdGitignored() detects when .gsd is covered by .gitignore
 * 2. The rethink prompt uses {{commitInstruction}} instead of hardcoded git add .gsd/
 * 3. rethink.ts passes the correct commitInstruction based on gitignore state
 *
 * Uses real temporary git repos — no mocks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Dynamic import — isGsdGitignored is the function under test (may not exist yet during TDD red phase)
const { isGsdGitignored } = await import("../../gitignore.ts");

// ─── Helpers ─────────────────────────────────────────────────────────

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" }).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-staging-2570-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── isGsdGitignored ─────────────────────────────────────────────────

test("isGsdGitignored returns true when .gsd is in .gitignore (#2570)", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  writeFileSync(join(dir, ".gitignore"), ".gsd\n");
  assert.equal(isGsdGitignored(dir), true);
});

test("isGsdGitignored returns true when .gsd/ (with slash) is in .gitignore", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  writeFileSync(join(dir, ".gitignore"), ".gsd/\n");
  // Create .gsd directory so git check-ignore can match the directory-only pattern
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(isGsdGitignored(dir), true);
});

test("isGsdGitignored returns false when .gsd is NOT in .gitignore", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  assert.equal(isGsdGitignored(dir), false);
});

test("isGsdGitignored returns false when no .gitignore exists", (t) => {
  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  // No .gitignore — default
  assert.equal(isGsdGitignored(dir), false);
});

// ─── rethink.md prompt template ─────────────────────────────────────

test("rethink.md prompt uses {{commitInstruction}} not hardcoded git add .gsd/ (#2570)", () => {
  const promptPath = join(
    import.meta.dirname!,
    "..",
    "..",
    "prompts",
    "rethink.md",
  );
  const content = readFileSync(promptPath, "utf-8");

  // Must NOT contain hardcoded `git add .gsd/`
  assert.ok(
    !content.includes("git add .gsd/"),
    `rethink.md must not contain hardcoded "git add .gsd/" — use {{commitInstruction}} instead.\nFound: ${content.match(/.*git add .gsd\/.*/)?.[0]}`,
  );

  // Must contain the {{commitInstruction}} placeholder
  assert.ok(
    content.includes("{{commitInstruction}}"),
    "rethink.md must use {{commitInstruction}} template variable for commit step",
  );
});

// ─── smartStage respects .gitignore for .gsd/ (#2570) ───────────────

test("smartStage does not stage .gsd/ files when .gsd is gitignored (#2570)", async (t) => {
  // This imports GitServiceImpl to test through the public commit() method
  // which calls smartStage() internally.
  const { GitServiceImpl } = await import("../../git-service.ts");

  const dir = makeTempRepo();
  t.after(() => { cleanup(dir); });

  // Add .gsd to .gitignore
  writeFileSync(join(dir, ".gitignore"), ".gsd\nnode_modules/\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-m", "add gitignore with .gsd");

  // Create .gsd/ milestone artifacts (NOT tracked, NOT symlinked)
  mkdirSync(join(dir, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), "# Plan");
  writeFileSync(join(dir, ".gsd", "DECISIONS.md"), "# Decisions");

  // Create a normal source file
  writeFileSync(join(dir, "src.ts"), "export const x = 1;");

  // Commit through GitServiceImpl (uses smartStage internally)
  const svc = new GitServiceImpl(dir);
  const msg = svc.commit({ message: "test: should not include .gsd files" });
  assert.ok(msg !== null, "commit should succeed");

  // Check what was committed
  const committed = git(dir, "show", "--name-only", "HEAD");
  assert.ok(committed.includes("src.ts"), "source files ARE committed");
  assert.ok(
    !committed.includes(".gsd/"),
    `gitignored .gsd/ files must NOT be staged by smartStage.\nCommitted files: ${committed}`,
  );
});
