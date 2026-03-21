/**
 * windows-path-normalization.test.ts — Verify Windows backslash paths are
 * normalised to forward slashes before embedding in bash command strings.
 *
 * Regression test for #1436: on Windows, `cd C:\Users\user\project` in bash
 * strips backslashes (escape characters), producing `C:Usersuserproject`.
 */

import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

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
assertEq(
  bashPath("C:\\Users\\user\\project"),
  "'C:/Users/user/project'",
  "backslash path normalised to forward slashes in shell-escaped string",
);

// Unix paths pass through unchanged
assertEq(
  bashPath("/home/user/project"),
  "'/home/user/project'",
  "Unix path unchanged",
);

// Mixed separators are normalised
assertEq(
  bashPath("C:\\Users/user\\project/src"),
  "'C:/Users/user/project/src'",
  "mixed separators normalised",
);

// Paths with single quotes are still properly escaped
assertEq(
  bashPath("C:\\Users\\o'brien\\project"),
  "'C:/Users/o'\\''brien/project'",
  "single quote in path is escaped after normalisation",
);

// UNC paths
assertEq(
  bashPath("\\\\server\\share\\dir"),
  "'//server/share/dir'",
  "UNC path normalised",
);

// Empty string
assertEq(
  bashPath(""),
  "''",
  "empty string handled",
);

// ─── cd command construction ───────────────────────────────────────────────

console.log("\n=== cd command construction with normalised paths ===");

const windowsCwd = "C:\\Users\\user\\project\\.gsd\\worktrees\\M001";
const cdCommand = `cd ${bashPath(windowsCwd)}`;
assertEq(
  cdCommand,
  "cd 'C:/Users/user/project/.gsd/worktrees/M001'",
  "cd command uses forward slashes for Windows worktree path",
);

// Verify the mangled form from #1436 is NOT produced
assertTrue(
  !cdCommand.includes("C:Users"),
  "mangled path C:Usersuserproject must not appear",
);

// ─── Worktree teardown orphan detection ────────────────────────────────────

console.log("\n=== teardown orphan warning path formatting ===");

const windowsWtDir = "C:\\Users\\user\\project\\.gsd\\worktrees\\M001";
const helpCommand = `rm -rf "${windowsWtDir.replaceAll("\\", "/")}"`;
assertEq(
  helpCommand,
  'rm -rf "C:/Users/user/project/.gsd/worktrees/M001"',
  "orphan cleanup help command uses forward slashes",
);

report();
