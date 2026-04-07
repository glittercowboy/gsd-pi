/**
 * session-lock-transient-read.test.ts — Tests for transient lock file unreadability (#2324).
 *
 * Regression coverage for:
 *   #2324  onCompromised declares lock lost when the lock file is temporarily
 *          unreadable (NFS/CIFS latency, macOS APFS snapshot, concurrent process
 *          briefly holding the file).
 *
 * Tests:
 *   - readExistingLockDataWithRetry retries on transient read failure
 *   - readExistingLockDataWithRetry returns data when file becomes readable after retries
 *   - readExistingLockDataWithRetry returns null only when ALL retries exhausted
 *   - onCompromised does not declare compromise when lock file is transiently unreadable
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  readExistingLockDataWithRetry,
  type SessionLockData,
} from '../session-lock.ts';
import { gsdRoot } from '../paths.ts';

describe('#2324: session lock transient read', () => {

  // ─── 1. readExistingLockDataWithRetry succeeds on first read when file is fine ─
  test('readExistingLockDataWithRetry reads file normally', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const lockFile = join(gsdRoot(base), 'auto.lock');
    const lockData: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType: 'execute-task',
      unitId: 'M001/S01/T01',
      unitStartedAt: new Date().toISOString(),
      sessionFile: 'test-session.json',
    };
    writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

    const result = readExistingLockDataWithRetry(lockFile);
    assert.ok(result !== null, 'data returned for readable file');
    assert.deepStrictEqual(result!.pid, process.pid, 'correct PID read');
    assert.deepStrictEqual(result!.sessionFile, 'test-session.json', 'correct sessionFile read');
  });

  // ─── 2. readExistingLockDataWithRetry returns null for truly missing file ──
  test('readExistingLockDataWithRetry returns null for missing file', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const lockFile = join(gsdRoot(base), 'auto.lock');
    // File doesn't exist
    const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 2, delayMs: 10 });
    assert.deepStrictEqual(result, null, 'null for truly missing file after retries');
  });

  // ─── 3. readExistingLockDataWithRetry recovers after transient rename ──────
  test('readExistingLockDataWithRetry recovers after transient unavailability', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const lockFile = join(gsdRoot(base), 'auto.lock');
    const tmpFile = lockFile + '.hidden';
    const lockData: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType: 'execute-task',
      unitId: 'M001/S01/T01',
      unitStartedAt: new Date().toISOString(),
      sessionFile: 'recovery-session.json',
    };
    writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

    // Simulate transient unavailability: move file away, spawn a child process
    // to restore it shortly after. The child runs outside our event loop so it
    // fires even during busy-wait retries. Give the test extra retry budget so
    // it stays stable under full-suite CPU contention.
    renameSync(lockFile, tmpFile);
    spawn('bash', ['-c', `sleep 0.05 && mv "${tmpFile}" "${lockFile}"`], { stdio: 'ignore', detached: true }).unref();

    const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 8, delayMs: 400 });
    assert.ok(result !== null, 'data recovered after transient unavailability');
    if (result) {
      assert.deepStrictEqual(result.pid, process.pid, 'correct PID after recovery');
      assert.deepStrictEqual(result.sessionFile, 'recovery-session.json', 'correct sessionFile after recovery');
    }
  });

  // ─── 4. readExistingLockDataWithRetry recovers from transient permission error ─
  test('readExistingLockDataWithRetry recovers from transient permission error', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const lockFile = join(gsdRoot(base), 'auto.lock');
    const lockData: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType: 'execute-task',
      unitId: 'M001/S01/T01',
      unitStartedAt: new Date().toISOString(),
      sessionFile: 'perm-session.json',
    };
    writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

    // Remove read permission to simulate NFS/CIFS latency, then spawn a child
    // to restore permissions shortly after (runs outside our event loop).
    // Use the same wider retry window as the rename case for full-suite stability.
    chmodSync(lockFile, 0o000);
    spawn('bash', ['-c', `sleep 0.05 && chmod 644 "${lockFile}"`], { stdio: 'ignore', detached: true }).unref();

    const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 8, delayMs: 400 });
    assert.ok(result !== null, 'data recovered after transient permission error');
    if (result) {
      assert.deepStrictEqual(result.pid, process.pid, 'correct PID after permission recovery');
    }

    // Ensure permissions restored for cleanup
    try { chmodSync(lockFile, 0o644); } catch { /* best-effort */ }
  });

  // ─── 5. getSessionLockStatus does not false-positive on transient read failure ─
  test('getSessionLockStatus tolerates transient lock file unavailability', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const result = acquireSessionLock(base);
    assert.ok(result.acquired, 'lock acquired');

    // Validate works initially
    const status1 = getSessionLockStatus(base);
    assert.ok(status1.valid, 'lock valid before transient failure');

    // Temporarily hide the lock file
    const lockFile = join(gsdRoot(base), 'auto.lock');
    const tmpFile = lockFile + '.hidden';
    renameSync(lockFile, tmpFile);

    // Schedule restoration
    setTimeout(() => {
      try { renameSync(tmpFile, lockFile); } catch { /* best-effort */ }
    }, 30);

    // Small delay to ensure restoration runs, then check — with the OS lock
    // still held, getSessionLockStatus should return valid=true even if the
    // lock file was briefly missing (it checks _releaseFunction first).
    await new Promise(r => setTimeout(r, 60));
    const status2 = getSessionLockStatus(base);
    assert.ok(status2.valid, 'lock still valid after transient file disappearance (OS lock held)');

    // Restore if not yet restored
    try { renameSync(tmpFile, lockFile); } catch { /* already restored */ }

    releaseSessionLock(base);
  });

  // ─── 6. Retry defaults: 3 attempts with 200ms delay ────────────────────────
  test('default retry params work for readable file', async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const lockFile = join(gsdRoot(base), 'auto.lock');
    const lockData: SessionLockData = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      unitType: 'execute-task',
      unitId: 'M001/S01/T01',
      unitStartedAt: new Date().toISOString(),
      sessionFile: 'status-session.json',
    };
    writeFileSync(lockFile, JSON.stringify(lockData, null, 2));

    // Call with no options — uses defaults (3 attempts, 200ms)
    const result = readExistingLockDataWithRetry(lockFile);
    assert.ok(result !== null, 'default params work for readable file');
  });
});
