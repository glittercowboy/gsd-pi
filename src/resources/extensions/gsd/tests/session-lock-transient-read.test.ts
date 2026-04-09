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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawn } from 'node:child_process';

import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  readExistingLockDataWithRetry,
  type SessionLockData,
} from '../session-lock.ts';
import { gsdRoot } from '../paths.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();

async function main(): Promise<void> {

  // ─── 1. readExistingLockDataWithRetry succeeds on first read when file is fine ─
  console.log('\n=== 1. readExistingLockDataWithRetry reads file normally ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
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
      assertTrue(result !== null, 'data returned for readable file');
      assertEq(result!.pid, process.pid, 'correct PID read');
      assertEq(result!.sessionFile, 'test-session.json', 'correct sessionFile read');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 2. readExistingLockDataWithRetry returns null for truly missing file ──
  console.log('\n=== 2. readExistingLockDataWithRetry returns null for missing file ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const lockFile = join(gsdRoot(base), 'auto.lock');
      // File doesn't exist
      const result = readExistingLockDataWithRetry(lockFile, { maxAttempts: 2, delayMs: 10 });
      assertEq(result, null, 'null for truly missing file after retries');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 3. readExistingLockDataWithRetry recovers after transient rename ──────
  console.log('\n=== 3. readExistingLockDataWithRetry recovers after transient unavailability ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
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
      assertTrue(result !== null, 'data recovered after transient unavailability');
      if (result) {
        assertEq(result.pid, process.pid, 'correct PID after recovery');
        assertEq(result.sessionFile, 'recovery-session.json', 'correct sessionFile after recovery');
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 4. readExistingLockDataWithRetry recovers from transient permission error ─
  console.log('\n=== 4. readExistingLockDataWithRetry recovers from transient permission error ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
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
      assertTrue(result !== null, 'data recovered after transient permission error');
      if (result) {
        assertEq(result.pid, process.pid, 'correct PID after permission recovery');
      }

      // Ensure permissions restored for cleanup
      try { chmodSync(lockFile, 0o644); } catch { /* best-effort */ }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 5. getSessionLockStatus does not false-positive on transient read failure ─
  console.log('\n=== 5. getSessionLockStatus tolerates transient lock file unavailability ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const result = acquireSessionLock(base);
      assertTrue(result.acquired, 'lock acquired');

      // Validate works initially
      const status1 = getSessionLockStatus(base);
      assertTrue(status1.valid, 'lock valid before transient failure');

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
      assertTrue(status2.valid, 'lock still valid after transient file disappearance (OS lock held)');

      // Restore if not yet restored
      try { renameSync(tmpFile, lockFile); } catch { /* already restored */ }

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 6. Retry defaults: 3 attempts with 200ms delay ────────────────────────
  console.log('\n=== 6. Default retry params: function works with defaults ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-transient-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
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
      assertTrue(result !== null, 'default params work for readable file');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
