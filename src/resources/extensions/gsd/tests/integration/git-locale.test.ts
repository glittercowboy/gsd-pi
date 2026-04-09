import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * Regression tests for #1997: git locale not forced to C.
 *
 * Validates that GIT_NO_PROMPT_ENV includes LC_ALL=C so git always produces
 * English output, and that nativeMergeSquash passes the env to execFileSync.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { GIT_NO_PROMPT_ENV } from "../../git-constants.ts";
import { nativeAddAllWithExclusions } from "../../native-git-bridge.ts";
import { RUNTIME_EXCLUSION_PATHS } from "../../git-service.ts";
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-locale-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  // Initial commit so HEAD exists
  writeFileSync(join(dir, "init.txt"), "init");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

function createFile(base: string, relPath: string, content: string): void {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe('git-locale', async () => {
  // ─── GIT_NO_PROMPT_ENV includes LC_ALL=C ─────────────────────────────


  assert.deepStrictEqual(
    GIT_NO_PROMPT_ENV.LC_ALL,
    "C",
    "GIT_NO_PROMPT_ENV must set LC_ALL to 'C' to force English git output"
  );

  assert.ok(
    "GIT_TERMINAL_PROMPT" in GIT_NO_PROMPT_ENV,
    "GIT_NO_PROMPT_ENV still contains GIT_TERMINAL_PROMPT"
  );

  // ─── nativeAddAllWithExclusions: non-English locale does not throw ───

  test('nativeAddAllWithExclusions: non-English locale does not throw', () => {
    // Simulate what happens on a German system: .gsd is gitignored,
    // exclusion pathspecs trigger an advisory warning exit code 1.
    // With LC_ALL=C the English stderr guard should match and suppress.
    const repo = initTempRepo();

    writeFileSync(join(repo, ".gitignore"), ".gsd\n");
    createFile(repo, ".gsd/STATE.md", "# State");
    createFile(repo, "src/app.ts", "export const x = 1;");

    // Save original LC_ALL / LANG and force German locale env
    const origLcAll = process.env.LC_ALL;
    const origLang = process.env.LANG;
    process.env.LANG = "de_DE.UTF-8";
    delete process.env.LC_ALL;

    let threw = false;
    try {
      nativeAddAllWithExclusions(repo, RUNTIME_EXCLUSION_PATHS);
    } catch (e) {
      threw = true;
      console.error("  unexpected error:", e);
    }

    // Restore
    if (origLcAll !== undefined) process.env.LC_ALL = origLcAll;
    else delete process.env.LC_ALL;
    if (origLang !== undefined) process.env.LANG = origLang;
    else delete process.env.LANG;

    assert.ok(
      !threw,
      "nativeAddAllWithExclusions must not throw on non-English locale when .gsd is gitignored (#1997)"
    );

    const staged = git(repo, "diff", "--cached", "--name-only");
    assert.ok(staged.includes("src/app.ts"), "real file staged despite German locale");

    rmSync(repo, { recursive: true, force: true });
  });

  // ─── nativeMergeSquash: env is passed (merge-squash stderr is English) ─

  test('nativeMergeSquash fallback uses GIT_NO_PROMPT_ENV', () => {
    // We verify indirectly: the source code must pass env: GIT_NO_PROMPT_ENV.
    // Read the source and check for the pattern. This is a static check.
    const src = readFileSync(
      join(import.meta.dirname, "../..", "native-git-bridge.ts"),
      "utf-8"
    );

    // Find the nativeMergeSquash function and check it uses GIT_NO_PROMPT_ENV
    const fnStart = src.indexOf("export function nativeMergeSquash");
    assert.ok(fnStart !== -1, "nativeMergeSquash function exists in source");

    const fnBody = src.slice(fnStart, src.indexOf("\nexport function", fnStart + 1));
    const hasEnv = fnBody.includes("env: GIT_NO_PROMPT_ENV");
    assert.ok(
      hasEnv,
      "nativeMergeSquash fallback must pass env: GIT_NO_PROMPT_ENV to execFileSync (#1997)"
    );
  });
});
