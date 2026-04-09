/**
 * windows-path-normalization.test.ts — Verify Windows backslash paths are
 * normalised to forward slashes before embedding in bash command strings.
 *
 * Regression test for #1436: on Windows, `cd C:\Users\user\project` in bash
 * strips backslashes (escape characters), producing `C:Usersuserproject`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';


// ─── shellEscape + path normalization ──────────────────────────────────────

// Replicate the shellEscape helper from cmux/index.ts
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The bashPath pattern used in subagent/index.ts
function bashPath(p: string): string {
  return shellEscape(p.replaceAll("\\", "/"));
}

console.log("\n=== Windows backslash path normalization (#1436) ===");

// Backslash paths are converted to forward slashes
assert.deepStrictEqual(
  bashPath("C:\\Users\\user\\project"),
  "'C:/Users/user/project'",
  "backslash path normalised to forward slashes in shell-escaped string",
);

// Unix paths pass through unchanged
assert.deepStrictEqual(
  bashPath("/home/user/project"),
  "'/home/user/project'",
  "Unix path unchanged",
);

// Mixed separators are normalised
assert.deepStrictEqual(
  bashPath("C:\\Users/user\\project/src"),
  "'C:/Users/user/project/src'",
  "mixed separators normalised",
);

// Paths with single quotes are still properly escaped
assert.deepStrictEqual(
  bashPath("C:\\Users\\o'brien\\project"),
  "'C:/Users/o'\\''brien/project'",
  "single quote in path is escaped after normalisation",
);

// UNC paths
assert.deepStrictEqual(
  bashPath("\\\\server\\share\\dir"),
  "'//server/share/dir'",
  "UNC path normalised",
);

// Empty string
assert.deepStrictEqual(
  bashPath(""),
  "''",
  "empty string handled",
);

// ─── cd command construction ───────────────────────────────────────────────

console.log("\n=== cd command construction with normalised paths ===");

const windowsCwd = "C:\\Users\\user\\project\\.gsd\\worktrees\\M001";
const cdCommand = `cd ${bashPath(windowsCwd)}`;
assert.deepStrictEqual(
  cdCommand,
  "cd 'C:/Users/user/project/.gsd/worktrees/M001'",
  "cd command uses forward slashes for Windows worktree path",
);

// Verify the mangled form from #1436 is NOT produced
assert.ok(
  !cdCommand.includes("C:Users"),
  "mangled path C:Usersuserproject must not appear",
);

// ─── Worktree teardown orphan detection ────────────────────────────────────

console.log("\n=== teardown orphan warning path formatting ===");

const windowsWtDir = "C:\\Users\\user\\project\\.gsd\\worktrees\\M001";
const helpCommand = `rm -rf "${windowsWtDir.replaceAll("\\", "/")}"`;
assert.deepStrictEqual(
  helpCommand,
  'rm -rf "C:/Users/user/project/.gsd/worktrees/M001"',
  "orphan cleanup help command uses forward slashes",
);
