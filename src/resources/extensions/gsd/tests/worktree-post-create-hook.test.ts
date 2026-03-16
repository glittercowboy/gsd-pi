/**
 * worktree-post-create-hook.test.ts — Tests for #597 worktree post-create hook.
 *
 * Verifies that runWorktreePostCreateHook correctly executes user scripts
 * with SOURCE_DIR and WORKTREE_DIR environment variables.
 *
 * Uses Node.js scripts instead of bash for Windows compatibility.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runWorktreePostCreateHook } from "../auto-worktree.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-wt-hook-test-"));
}

const isWin = process.platform === "win32";

/** Return the platform-appropriate hook file path (adds .bat on Windows). */
function hookPath(base: string): string {
  return isWin ? `${base}.bat` : base;
}

/** Create a cross-platform Node.js hook script. */
function writeNodeHookScript(filePath: string, code: string): void {
  if (isWin) {
    // Write the JS code to a companion .js file and have the .bat invoke it.
    // node -e with multi-line code breaks on Windows because cmd.exe splits on newlines.
    const jsPath = filePath.replace(/\.bat$/, ".js");
    writeFileSync(jsPath, code);
    writeFileSync(filePath, `@echo off\nnode "%~dp0${jsPath.split("\\").pop()}" %*\n`);
  } else {
    writeFileSync(filePath, `#!/usr/bin/env node\n${code}\n`);
    chmodSync(filePath, 0o755);
  }
}

// ─── runWorktreePostCreateHook ──────────────────────────────────────────────

test("returns null when no hook path is provided", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const result = runWorktreePostCreateHook(src, wt, undefined);
    assert.equal(result, null);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("returns error when hook script does not exist", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const result = runWorktreePostCreateHook(src, wt, ".gsd/hooks/nonexistent");
    assert.ok(result !== null, "should return error string");
    assert.ok(result!.includes("not found"), "error should mention 'not found'");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("executes hook script with correct SOURCE_DIR and WORKTREE_DIR env vars", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hooksDir = join(src, ".gsd", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = hookPath(join(hooksDir, "post-create"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `const out = path.join(process.env.WORKTREE_DIR, "hook-output.txt");`,
      `fs.writeFileSync(out, "SOURCE=" + process.env.SOURCE_DIR + "\\n" + "WORKTREE=" + process.env.WORKTREE_DIR + "\\n");`,
    ].join("\n");
    writeNodeHookScript(hookFile, code);

    const result = runWorktreePostCreateHook(src, wt, hookPath(".gsd/hooks/post-create"));
    assert.equal(result, null, "should succeed");

    const outputFile = join(wt, "hook-output.txt");
    assert.ok(existsSync(outputFile), "hook should have created output file");

    const output = readFileSync(outputFile, "utf-8");
    assert.ok(output.includes(`SOURCE=${src}`), "SOURCE_DIR should match source dir");
    assert.ok(output.includes(`WORKTREE=${wt}`), "WORKTREE_DIR should match worktree dir");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("returns error message when hook script fails", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hooksDir = join(src, ".gsd", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookFile = hookPath(join(hooksDir, "failing-hook"));
    writeNodeHookScript(hookFile, `process.exit(1);`);

    const result = runWorktreePostCreateHook(src, wt, hookPath(".gsd/hooks/failing-hook"));
    assert.ok(result !== null, "should return error string");
    assert.ok(result!.includes("hook failed"), "error should mention 'hook failed'");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("supports absolute hook paths", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    const hookFile = hookPath(join(src, "absolute-hook"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `fs.writeFileSync(path.join(process.env.WORKTREE_DIR, "absolute-hook-ran"), "");`,
    ].join("\n");
    writeNodeHookScript(hookFile, code);

    const result = runWorktreePostCreateHook(src, wt, hookFile);
    assert.equal(result, null, "absolute path hook should succeed");
    assert.ok(existsSync(join(wt, "absolute-hook-ran")), "hook should have run");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test("hook can copy files from source to worktree", () => {
  const src = makeTmpDir();
  const wt = makeTmpDir();
  try {
    writeFileSync(join(src, ".env"), "DB_HOST=localhost\nAPI_KEY=secret123\n");

    const hookFile = hookPath(join(src, "setup-hook"));
    const code = [
      `const fs = require("fs");`,
      `const path = require("path");`,
      `const envSrc = path.join(process.env.SOURCE_DIR, ".env");`,
      `const envDst = path.join(process.env.WORKTREE_DIR, ".env");`,
      `fs.copyFileSync(envSrc, envDst);`,
    ].join("\n");
    writeNodeHookScript(hookFile, code);

    const result = runWorktreePostCreateHook(src, wt, hookFile);
    assert.equal(result, null, "hook should succeed");

    assert.ok(existsSync(join(wt, ".env")), ".env should be copied to worktree");
    const envContent = readFileSync(join(wt, ".env"), "utf-8");
    assert.ok(envContent.includes("API_KEY=secret123"), ".env content should match");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});
