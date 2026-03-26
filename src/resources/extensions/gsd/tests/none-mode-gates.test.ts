/**
 * none-mode-gates.test.ts — Tests for isolation-mode gate functions.
 *
 * Verifies that shouldUseWorktreeIsolation(), getIsolationMode(), and
 * getActiveAutoWorktreeContext() behave correctly across all three
 * isolation modes (none, branch, worktree) and at baseline (no prefs).
 *
 * Uses the writeRunnerPreferences pattern from doctor-git.test.ts:
 * PROJECT_PREFERENCES_PATH is a module-level constant frozen at import
 * time, so process.chdir() won't redirect preference loading. We write
 * prefs to the runner's cwd .gsd/PREFERENCES.md and clean up in finally.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { shouldUseWorktreeIsolation } from "../auto.ts";
import { getIsolationMode } from "../preferences.ts";
import { getActiveAutoWorktreeContext } from "../auto-worktree.ts";
import { invalidateAllCaches } from "../cache.ts";
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Preferences helpers (same pattern as doctor-git.test.ts K001) ---

const RUNNER_PREFS_PATH = join(process.cwd(), ".gsd", "PREFERENCES.md");

function writeRunnerPreferences(isolation: "none" | "worktree" | "branch"): void {
  mkdirSync(join(process.cwd(), ".gsd"), { recursive: true });
  writeFileSync(RUNNER_PREFS_PATH, `---\ngit:\n  isolation: "${isolation}"\n---\n`);
}

function removeRunnerPreferences(): void {
  try { rmSync(RUNNER_PREFS_PATH); } catch { /* ignore if already gone */ }
}

// --- Tests ---

test('shouldUseWorktreeIsolation returns false for none', () => {
try {
  writeRunnerPreferences("none");
  invalidateAllCaches();
  assert.deepStrictEqual(shouldUseWorktreeIsolation(), false, "shouldUseWorktreeIsolation() with none prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

test('shouldUseWorktreeIsolation returns false for branch', () => {
try {
  writeRunnerPreferences("branch");
  invalidateAllCaches();
  assert.deepStrictEqual(shouldUseWorktreeIsolation(), false, "shouldUseWorktreeIsolation() with branch prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

test('shouldUseWorktreeIsolation returns true for worktree', () => {
try {
  writeRunnerPreferences("worktree");
  invalidateAllCaches();
  assert.deepStrictEqual(shouldUseWorktreeIsolation(), true, "shouldUseWorktreeIsolation() with worktree prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

// Test 4: shouldUseWorktreeIsolation returns false for no prefs (default: none)
// Worktree isolation requires explicit opt-in — default is "none" so GSD
// works out of the box without PREFERENCES.md (#2480).
// Skip if global prefs exist — they override the default and this test
// cannot control ~/.gsd/PREFERENCES.md.

test('shouldUseWorktreeIsolation returns false for no prefs (default: none)', () => {
  const globalPrefsExist = existsSync(join(homedir(), ".gsd", "PREFERENCES.md"))
    || existsSync(join(homedir(), ".gsd", "PREFERENCES.md"));
  if (!globalPrefsExist) {
    try {
      removeRunnerPreferences(); // ensure no prefs file
      invalidateAllCaches();
      assert.deepStrictEqual(shouldUseWorktreeIsolation(), false, "shouldUseWorktreeIsolation() with no prefs (default none)");
    } finally {
      invalidateAllCaches();
    }
  } else {
  }
});

// Test 5: getIsolationMode returns "none" when no PREFERENCES.md exists (#2480)
test('getIsolationMode returns "none" with no prefs (default)', () => {
  const globalPrefsExist = existsSync(join(homedir(), ".gsd", "PREFERENCES.md"))
    || existsSync(join(homedir(), ".gsd", "PREFERENCES.md"));
  if (!globalPrefsExist) {
    try {
      removeRunnerPreferences();
      invalidateAllCaches();
      assert.deepStrictEqual(getIsolationMode(), "none", "getIsolationMode() with no prefs defaults to none");
    } finally {
      invalidateAllCaches();
    }
  }
});

test('getIsolationMode returns "none" with none prefs', () => {
try {
  writeRunnerPreferences("none");
  invalidateAllCaches();
  assert.deepStrictEqual(getIsolationMode(), "none", "getIsolationMode() with none prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

test('getIsolationMode returns "worktree" with worktree prefs', () => {
try {
  writeRunnerPreferences("worktree");
  invalidateAllCaches();
  assert.deepStrictEqual(getIsolationMode(), "worktree", "getIsolationMode() with worktree prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

test('getIsolationMode returns "branch" with branch prefs', () => {
try {
  writeRunnerPreferences("branch");
  invalidateAllCaches();
  assert.deepStrictEqual(getIsolationMode(), "branch", "getIsolationMode() with branch prefs");
} finally {
  removeRunnerPreferences();
  invalidateAllCaches();
}
});

test('getActiveAutoWorktreeContext returns null at baseline', () => {
assert.deepStrictEqual(getActiveAutoWorktreeContext(), null, "getActiveAutoWorktreeContext() returns null without enterAutoWorktree()");
});

// Test 7: System prompt worktree block absent without active worktree

test('Test 7: System prompt worktree block absent without active worktree', () => {
  const ctx = getActiveAutoWorktreeContext();
  assert.ok(ctx === null, "getActiveAutoWorktreeContext() null confirms system prompt worktree block will not be injected");
});

