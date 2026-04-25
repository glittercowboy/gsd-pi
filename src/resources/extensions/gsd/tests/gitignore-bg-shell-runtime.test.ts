/**
 * Runtime regression — `.bg-shell/` baseline pattern (#4902, prior #2655).
 *
 * The deleted `gitignore-bg-shell.test.ts` asserted `.bg-shell/` appeared in
 * the BASELINE_PATTERNS array via source grep. This rewrite drives
 * `ensureGitignore()` against a tmp directory and asserts the written
 * `.gitignore` actually contains the `.bg-shell/` pattern — i.e. tests the
 * behaviour the constant exists to guarantee, not the spelling of the
 * constant.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureGitignore } from '../gitignore.ts';

function makeTmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gitignore-bg-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

describe('ensureGitignore writes .bg-shell/ baseline (#4902)', () => {
  test('appends .bg-shell/ to a fresh project .gitignore', () => {
    const dir = makeTmpRepo();
    try {
      const wrote = ensureGitignore(dir);
      assert.equal(wrote, true, 'ensureGitignore should report it wrote');

      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const lines = new Set(
        ignore.split('\n').map((l) => l.trim()).filter(Boolean),
      );
      assert.ok(
        lines.has('.bg-shell/'),
        `.gitignore should include .bg-shell/. Got:\n${ignore}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('preserves .bg-shell/ when it is already present (idempotent)', () => {
    const dir = makeTmpRepo();
    try {
      fs.writeFileSync(
        path.join(dir, '.gitignore'),
        '.bg-shell/\nnode_modules/\n',
      );
      ensureGitignore(dir); // run once to fill missing baseline
      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const occurrences = ignore.split('\n').filter((l) => l.trim() === '.bg-shell/').length;
      assert.equal(occurrences, 1, 'should not duplicate an existing .bg-shell/ entry');
    } finally {
      cleanup(dir);
    }
  });
});
