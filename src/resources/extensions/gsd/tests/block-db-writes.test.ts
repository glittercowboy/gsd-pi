/**
 * Regression test for #3674 — block direct writes to gsd.db
 *
 * When gsd_complete_task was unavailable, agents fell back to shell-based
 * sqlite3 writes, corrupting the WAL-backed database. The fix extends
 * write-intercept to block file writes and bash commands targeting gsd.db.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedStateFile, isBashWriteToStateFile } from '../write-intercept.ts';

describe('isBlockedStateFile blocks gsd.db paths (#3674)', () => {
  test('blocks .gsd/gsd.db', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db'));
  });

  test('blocks .gsd/gsd.db-wal', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db-wal'));
  });

  test('blocks .gsd/gsd.db-shm', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/gsd.db-shm'));
  });

  test('blocks resolved symlink path under .gsd/projects/', () => {
    assert.ok(isBlockedStateFile('/home/user/.gsd/projects/myproj/gsd.db'));
  });

  test('still blocks STATE.md', () => {
    assert.ok(isBlockedStateFile('/project/.gsd/STATE.md'));
  });

  test('does not block other .gsd files', () => {
    assert.ok(!isBlockedStateFile('/project/.gsd/DECISIONS.md'));
  });
});

describe('isBashWriteToStateFile blocks DB shell commands (#3674)', () => {
  test('blocks sqlite3 targeting gsd.db', () => {
    assert.ok(isBashWriteToStateFile('sqlite3 .gsd/gsd.db "INSERT INTO ..."'));
  });

  test('blocks better-sqlite3 targeting gsd.db', () => {
    assert.ok(isBashWriteToStateFile('node -e "require(\'better-sqlite3\')(\'.gsd/gsd.db\')"'));
  });

  test('blocks shell redirect to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('echo data > .gsd/gsd.db'));
  });

  test('blocks cp to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('cp backup.db .gsd/gsd.db'));
  });

  test('blocks mv to gsd.db', () => {
    assert.ok(isBashWriteToStateFile('mv temp.db .gsd/gsd.db'));
  });

  test('does not block reading gsd.db with cat', () => {
    assert.ok(!isBashWriteToStateFile('cat .gsd/gsd.db'));
  });
});
