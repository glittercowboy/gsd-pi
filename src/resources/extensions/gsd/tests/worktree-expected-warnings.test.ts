/**
 * worktree-expected-warnings.test.ts — #3665
 *
 * Verify that auto-worktree.ts and worktree-manager.ts suppress expected
 * ENOENT and EISDIR conditions instead of logging misleading warnings.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoWorktreeFile = join(__dirname, "..", "auto-worktree.ts");
const worktreeManagerFile = join(__dirname, "..", "worktree-manager.ts");

describe("worktree expected-condition warning suppression (#3665)", () => {
  const autoSource = readFileSync(autoWorktreeFile, "utf-8");

  test("auto-worktree.ts checks for ENOENT before logging unlink warning", () => {
    assert.match(autoSource, /code\s*!==\s*["']ENOENT["']/);
  });

  test("auto-worktree.ts checks for EISDIR before logging unlink warning", () => {
    assert.match(autoSource, /code\s*!==\s*["']EISDIR["']/);
  });

  test("auto-worktree.ts references issue #3597", () => {
    assert.match(autoSource, /#3597/);
  });

  const managerSource = readFileSync(worktreeManagerFile, "utf-8");

  test("worktree-manager.ts checks isDirectory() before reading .git file", () => {
    assert.match(managerSource, /lstatSync\(gitPath\)\.isDirectory\(\)/);
  });
});
