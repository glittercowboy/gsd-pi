// native-git-bridge-exec-fallback.test.ts — regression for #4180
//
// nativeCommit, nativeIsRepo, and nativeResetHard used execSync() (string
// command) in their fallback paths. On Windows, execSync spawns cmd.exe which
// cannot resolve git when Git for Windows is installed via MSYS2/bash but not
// in cmd.exe's PATH. All other fallback paths in this file use execFileSync()
// which invokes the binary directly — these three must do the same.
//
// Static-analysis tests fail before the fix (source still has execSync calls)
// and pass after (replaced with execFileSync). Integration tests verify the
// fallback functions behave correctly on all platforms.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { nativeIsRepo, nativeCommit, nativeResetHard } from "../native-git-bridge.js";

// ─── Static analysis ──────────────────────────────────────────────────────
// Verify the fallback paths of the three affected functions do not call the
// raw execSync() string-command variant. Replacing all execFileSync( tokens
// first ensures we match only the bare execSync( form.

const SRC_PATH = join(import.meta.dirname, "..", "native-git-bridge.ts");

function extractFunctionBody(src: string, fnName: string): string {
  const idx = src.indexOf(`export function ${fnName}`);
  if (idx === -1) throw new Error(`${fnName} not found in source`);
  return src.slice(idx, idx + 1500);
}

function hasRawExecSync(body: string): boolean {
  const withoutFileSync = body.replace(/execFileSync\(/g, "__FILESYNC__");
  return withoutFileSync.includes("execSync(");
}

describe("native-git-bridge #4180: fallback paths use execFileSync not execSync", () => {
  const src = readFileSync(SRC_PATH, "utf-8");

  test("nativeIsRepo fallback does not use raw execSync", () => {
    const body = extractFunctionBody(src, "nativeIsRepo");
    assert.equal(
      hasRawExecSync(body),
      false,
      "nativeIsRepo fallback must use execFileSync to avoid cmd.exe PATH failures on Windows",
    );
  });

  test("nativeCommit fallback does not use raw execSync", () => {
    const body = extractFunctionBody(src, "nativeCommit");
    assert.equal(
      hasRawExecSync(body),
      false,
      "nativeCommit fallback must use execFileSync to avoid cmd.exe PATH failures on Windows",
    );
  });

  test("nativeResetHard fallback does not use raw execSync", () => {
    const body = extractFunctionBody(src, "nativeResetHard");
    assert.equal(
      hasRawExecSync(body),
      false,
      "nativeResetHard fallback must use execFileSync to avoid cmd.exe PATH failures on Windows",
    );
  });
});

// ─── Integration tests ────────────────────────────────────────────────────
// Verify correct runtime behaviour through the fallback path (native module
// is disabled by default in tests — GSD_ENABLE_NATIVE_GSD_GIT is not set).

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

describe("native-git-bridge #4180: fallback runtime behaviour", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ngb4180-"));
    git(["init"], repo);
    git(["config", "user.email", "test@test.com"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFileSync(join(repo, "file.txt"), "initial\n");
    git(["add", "."], repo);
    git(["commit", "-m", "init"], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("nativeIsRepo returns true for a valid git repository", () => {
    assert.equal(nativeIsRepo(repo), true);
  });

  test("nativeIsRepo returns false for a plain directory", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ngb4180-notrepo-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(nativeIsRepo(dir), false);
  });

  test("nativeCommit commits staged changes and returns non-null output", () => {
    writeFileSync(join(repo, "file.txt"), "modified\n");
    git(["add", "."], repo);

    const result = nativeCommit(repo, "test: regression commit #4180");
    assert.ok(result !== null, "should return output string for a successful commit");

    const subject = git(["log", "-1", "--format=%s"], repo);
    assert.equal(subject, "test: regression commit #4180");
  });

  test("nativeCommit returns null when nothing is staged", () => {
    const result = nativeCommit(repo, "test: nothing staged");
    assert.equal(result, null);
  });

  test("nativeCommit respects the allowEmpty option", () => {
    const result = nativeCommit(repo, "test: empty commit #4180", { allowEmpty: true });
    assert.ok(result !== null, "allow-empty commit should return output");

    const subject = git(["log", "-1", "--format=%s"], repo);
    assert.equal(subject, "test: empty commit #4180");
  });

  test("nativeResetHard discards unstaged working tree changes", () => {
    writeFileSync(join(repo, "file.txt"), "dirty content\n");

    const statusBefore = git(["status", "--short"], repo);
    assert.ok(statusBefore.length > 0, "repo should be dirty before reset");

    nativeResetHard(repo);

    const content = readFileSync(join(repo, "file.txt"), "utf-8");
    assert.equal(content, "initial\n", "file should be restored to HEAD content after hard reset");
  });
});
