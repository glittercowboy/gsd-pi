/**
 * session-lock-regression.test.ts — Regression tests for session lock lifecycle.
 *
 * Regression coverage for:
 *   #1257  False-positive "Session lock lost" during auto-mode
 *   #1245  Stranded .gsd.lock/ directory preventing new sessions
 *   #1251  Same root cause as #1245
 *
 * Tests the acquire → validate → release lifecycle and edge cases
 * without requiring concurrent processes.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireSessionLock,
  getSessionLockStatus,
  validateSessionLock,
  releaseSessionLock,
  readSessionLockData,
  updateSessionLock,
  isSessionLockHeld,
} from '../session-lock.ts';
import { gsdRoot } from '../paths.ts';
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
const require = createRequire(import.meta.url);

function hasProperLockfile(): boolean {
  try {
    require("proper-lockfile");
    return true;
  } catch {
    return false;
  }
}

const properLockfileAvailable = hasProperLockfile();

async function main(): Promise<void> {

  // ─── 1. Basic acquire/release lifecycle ───────────────────────────────
  console.log('\n=== 1. acquire → validate → release lifecycle ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const result = acquireSessionLock(base);
      assertTrue(result.acquired, 'lock acquired successfully');

      const valid = validateSessionLock(base);
      assertTrue(valid, 'lock validates after acquisition');

      assertTrue(isSessionLockHeld(base), 'isSessionLockHeld returns true');

      releaseSessionLock(base);

      // After release, the lock file should be cleaned up
      const lockFile = join(gsdRoot(base), 'auto.lock');
      assertTrue(!existsSync(lockFile), 'lock file removed after release');

      // The .gsd.lock/ directory should be cleaned up
      const lockDir = gsdRoot(base) + '.lock';
      assertTrue(!existsSync(lockDir), '.gsd.lock/ directory removed after release (#1245)');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 2. Double release is safe ────────────────────────────────────────
  console.log('\n=== 2. double release does not throw ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);
      releaseSessionLock(base);
      // Second release should not throw
      let threw = false;
      try {
        releaseSessionLock(base);
      } catch {
        threw = true;
      }
      assertTrue(!threw, 'double release does not throw');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 3. updateSessionLock preserves lock data ─────────────────────────
  console.log('\n=== 3. updateSessionLock writes metadata ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);

      updateSessionLock(base, 'execute-task', 'M001/S01/T01', 5, '/tmp/session.json');

      const data = readSessionLockData(base);
      assertTrue(data !== null, 'lock data readable after update');
      if (data) {
        assertEq(data.pid, process.pid, 'lock data has correct PID');
        assertEq(data.unitType, 'execute-task', 'lock data has correct unit type');
        assertEq(data.unitId, 'M001/S01/T01', 'lock data has correct unit ID');
        assertEq(data.completedUnits, 5, 'lock data has correct completed count');
        assertEq(data.sessionFile, '/tmp/session.json', 'lock data has session file');
      }

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 4. Stale lock from dead PID → re-acquirable (#1245) ─────────────
  console.log('\n=== 4. stale lock from dead PID → re-acquirable ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      // Write a lock file with a definitely-dead PID
      const lockFile = join(gsdRoot(base), 'auto.lock');
      const staleLock = {
        pid: 99999999, // extremely unlikely to be alive
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        unitStartedAt: new Date(Date.now() - 3600000).toISOString(),
        completedUnits: 3,
      };
      writeFileSync(lockFile, JSON.stringify(staleLock, null, 2));

      // Should be able to acquire despite the stale lock
      const result = acquireSessionLock(base);
      assertTrue(result.acquired, '#1245: stale lock from dead PID → re-acquirable');

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 5. readSessionLockData with no lock → null ───────────────────────
  console.log('\n=== 5. readSessionLockData with no lock → null ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const data = readSessionLockData(base);
      assertEq(data, null, 'no lock file → null');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 6. validateSessionLock after own acquisition → true ──────────────
  console.log('\n=== 6. validateSessionLock after own acquisition → true ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      acquireSessionLock(base);

      // Multiple validations should all return true (regression for #1257)
      for (let i = 0; i < 5; i++) {
        const valid = validateSessionLock(base);
        assertTrue(valid, `#1257: validation ${i + 1} returns true for own lock`);
      }

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7. readSessionLockData with corrupt JSON → null ──────────────────
  console.log('\n=== 7. corrupt lock file → null ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const lockFile = join(gsdRoot(base), 'auto.lock');
      writeFileSync(lockFile, 'NOT VALID JSON {{{');

      const data = readSessionLockData(base);
      assertEq(data, null, 'corrupt JSON → null');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7b. getSessionLockStatus with missing metadata → reason surfaced ──
  console.log('\n=== 7b. missing lock metadata → structured reason ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const status = getSessionLockStatus(base);
      assertEq(status.valid, false, 'missing lock metadata is invalid');
      assertEq(status.failureReason, 'missing-metadata', 'missing metadata reason is surfaced');
      assertEq(status.expectedPid, process.pid, 'expected PID is included');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 7c. getSessionLockStatus with foreign PID → reason surfaced ───────
  console.log('\n=== 7c. foreign PID in lock file → structured reason ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const foreignPid = process.pid + 1000;
      const lockFile = join(gsdRoot(base), 'auto.lock');
      writeFileSync(lockFile, JSON.stringify({
        pid: foreignPid,
        startedAt: new Date().toISOString(),
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        unitStartedAt: new Date().toISOString(),
        completedUnits: 0,
      }, null, 2));

      const status = getSessionLockStatus(base);
      assertEq(status.valid, false, 'foreign PID lock is invalid');
      assertEq(status.failureReason, 'pid-mismatch', 'PID mismatch reason is surfaced');
      assertEq(status.existingPid, foreignPid, 'existing PID is included');
      assertEq(status.expectedPid, process.pid, 'expected PID is included');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 8. Acquire after release is possible ─────────────────────────────
  console.log('\n=== 8. acquire after release → re-acquirable ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assertTrue(r1.acquired, 'first acquisition');
      releaseSessionLock(base);

      const r2 = acquireSessionLock(base);
      assertTrue(r2.acquired, 're-acquisition after release');
      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 9. Re-entrant acquisition without explicit release ───────────────
  console.log('\n=== 9. re-entrant acquire without explicit release ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assertTrue(r1.acquired, 'first acquisition succeeds');

      const r2 = acquireSessionLock(base);
      assertTrue(r2.acquired, 're-entrant acquisition succeeds');

      const valid = validateSessionLock(base);
      assertTrue(valid, 're-entrant acquisition does not corrupt validation state');

      releaseSessionLock(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ─── 10. Re-entrant acquisition refreshes lock artifacts ──────────────
  console.log('\n=== 10. re-entrant acquire refreshes lock artifacts ===');
  {
    const base = mkdtempSync(join(tmpdir(), 'gsd-session-lock-'));
    mkdirSync(join(base, '.gsd'), { recursive: true });

    try {
      const r1 = acquireSessionLock(base);
      assertTrue(r1.acquired, 'first acquisition succeeds');

      const lockDir = gsdRoot(base) + '.lock';
      if (properLockfileAvailable) {
        assertTrue(existsSync(lockDir), '.gsd.lock/ exists after first acquisition');
      }

      const r2 = acquireSessionLock(base);
      assertTrue(r2.acquired, 'second acquisition succeeds');
      if (properLockfileAvailable) {
        assertTrue(existsSync(lockDir), '.gsd.lock/ exists after re-entrant acquisition');
      }
      assertTrue(validateSessionLock(base), 'lock remains valid after re-entrant acquisition');

      releaseSessionLock(base);
      assertTrue(!existsSync(lockDir), '.gsd.lock/ is removed after release');
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
