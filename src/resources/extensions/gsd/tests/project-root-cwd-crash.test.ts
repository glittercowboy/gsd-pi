/**
 * Regression test for #3598 — projectRoot ENOENT crash on deleted cwd
 *
 * When the working directory is deleted (e.g. worktree teardown), process.cwd()
 * throws ENOENT. The fix wraps process.cwd() in a try/catch and falls back to
 * process.env.HOME.
 *
 * Also verifies #3589 — nativeBranchExists validation for prefs.main_branch
 * in auto-worktree.ts to prevent merge failures with stale preferences.
 *
 * Structural verification test — reads source to confirm the guards exist.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const contextSource = readFileSync(join(__dirname, '..', 'commands', 'context.ts'), 'utf-8');
const worktreeSource = readFileSync(join(__dirname, '..', 'auto-worktree.ts'), 'utf-8');

describe('projectRoot cwd crash guard (#3598)', () => {
  test('projectRoot wraps process.cwd() in try/catch', () => {
    assert.match(contextSource, /try\s*\{[\s\S]*?process\.cwd\(\)/,
      'process.cwd() should be inside a try block');
  });

  test('catch block falls back to process.env.HOME', () => {
    assert.match(contextSource, /catch[\s\S]*?process\.env\.HOME/,
      'catch block should fall back to process.env.HOME');
  });

  test('projectRoot function is exported', () => {
    assert.match(contextSource, /export function projectRoot\(\)/,
      'projectRoot should be an exported function');
  });
});

describe('main_branch nativeBranchExists validation (#3589)', () => {
  test('prefs.main_branch is validated with nativeBranchExists', () => {
    assert.match(worktreeSource, /nativeBranchExists\(.*prefs\.main_branch\)/,
      'nativeBranchExists should validate prefs.main_branch');
  });

  test('validatedPrefBranch falls back to undefined when branch missing', () => {
    assert.match(worktreeSource, /validatedPrefBranch[\s\S]*?:\s*undefined/,
      'validatedPrefBranch should fall back to undefined');
  });
});
