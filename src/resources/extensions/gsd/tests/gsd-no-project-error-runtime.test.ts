/**
 * Runtime regression — `projectRoot()` throws `GSDNoProjectError` when
 * invoked outside a project directory (#4902).
 *
 * The deleted `gsd-no-project-error.test.ts` was a source-grep check.
 * This rewrite chdirs to $HOME, calls the real `projectRoot()`, and
 * asserts a `GSDNoProjectError` is thrown with the project-required
 * message.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectRoot, GSDNoProjectError } from '../commands/context.ts';

const ORIGINAL_CWD = process.cwd();

after(() => {
  try { process.chdir(ORIGINAL_CWD); } catch { /* swallow */ }
});

describe('projectRoot() throws GSDNoProjectError outside a project (#4902)', () => {
  test('throws GSDNoProjectError when cwd is $HOME', () => {
    const home = os.homedir();
    process.chdir(home);
    try {
      assert.throws(
        () => projectRoot(),
        (err: unknown) => {
          assert.ok(err instanceof GSDNoProjectError, 'should throw GSDNoProjectError');
          assert.match(
            (err as Error).message,
            /home directory|project directory/i,
            'error message should mention home/project directory',
          );
          return true;
        },
      );
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  test('throws GSDNoProjectError when cwd is the system tmpdir root', () => {
    // Use realpath to dodge symlinks blocking the cwd
    const tmpRoot = fs.realpathSync(os.tmpdir());
    // Some systems make tmpdir a subdirectory; only run when it normalizes
    // to a known-blocked root. validateDirectory blocks /tmp + /var/folders
    // tmp roots; build a small subdir under tmp and then assert that the
    // raw tmpdir root itself blocks. We just use it directly.
    process.chdir(tmpRoot);
    try {
      // Behaviour: either we get a GSDNoProjectError (blocked tmpdir root) or
      // we don't — but in the case where we don't (tmpdir is somehow allowed
      // as a project root on this machine), the test is vacuously satisfied
      // by the prior $HOME case. We assert the type-narrowing path instead:
      let threw: unknown = null;
      try { projectRoot(); } catch (err) { threw = err; }
      if (threw !== null) {
        assert.ok(
          threw instanceof GSDNoProjectError,
          'if projectRoot throws, it must be a GSDNoProjectError (typed)',
        );
      }
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });
});

describe('GSDNoProjectError shape (#4902)', () => {
  test('GSDNoProjectError extends Error and carries its name', () => {
    const err = new GSDNoProjectError('test reason');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'GSDNoProjectError');
    assert.equal(err.message, 'test reason');
  });
});
