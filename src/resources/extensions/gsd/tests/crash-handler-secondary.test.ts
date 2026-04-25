/**
 * Regression tests for #3348 secondary issues — crash handler gaps surfaced after #3696
 *
 * 1. register-extension.ts: writeCrashLog writes to ~/.gsd/crash/ directory
 * 2. register-extension.ts: _gsdRejectionGuard registered for unhandledRejection
 * 3. register-extension.ts: _gsdEpipeGuard exits with code 1 for unrecoverable errors (no log-and-continue)
 * 4. crash-recovery.ts: emitCrashRecoveredUnitEnd closes open unit-start journal entries
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-test-${randomUUID()}`);
  mkdirSync(join(base, '.gsd'), { recursive: true });
  return base;
}

// ─── register-extension source assertions ────────────────────────────────────

const registerExtSrc = readFileSync(
  join(__dirname, '..', 'bootstrap', 'register-extension.ts'),
  'utf-8',
);

describe('register-extension crash handler secondary fixes (#3348)', () => {
  test('writeCrashLog is exported and writes a file to the crash directory', async () => {
    // Dynamic import so GSD_HOME can be pointed at a temp dir without polluting ~/.gsd
    const tmpHome = join(tmpdir(), `gsd-crash-test-${randomUUID()}`);
    const origHome = process.env.GSD_HOME;
    process.env.GSD_HOME = tmpHome;
    try {
      const { writeCrashLog } = await import('../bootstrap/crash-log.ts');
      const err = new Error('test crash from secondary regression test');
      writeCrashLog(err, 'uncaughtException');

      const crashDir = join(tmpHome, 'crash');
      assert.ok(existsSync(crashDir), 'crash directory should be created');

      const logs = readdirSync(crashDir).filter((f) => f.endsWith('.log'));
      assert.equal(logs.length, 1, 'exactly one crash log should be written');

      const content = readFileSync(join(crashDir, logs[0]), 'utf-8');
      assert.ok(content.includes('test crash from secondary regression test'), 'log should contain error message');
      assert.ok(content.includes('uncaughtException'), 'log should identify the source');
      assert.ok(content.includes('pid:'), 'log should include process pid');
    } finally {
      process.env.GSD_HOME = origHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('_gsdRejectionGuard is registered for unhandledRejection', () => {
    assert.match(
      registerExtSrc,
      /_gsdRejectionGuard/,
      '_gsdRejectionGuard handler should be defined',
    );
    assert.match(
      registerExtSrc,
      /unhandledRejection/,
      'installEpipeGuard should register an unhandledRejection handler',
    );
  });

  test('_gsdEpipeGuard calls process.exit(1) for unrecoverable errors, not log-and-continue', () => {
    // The original #3696 fix replaced "throw err" with a log-and-continue.
    // The secondary fix replaces that with writeCrashLog + process.exit(1).
    assert.ok(
      !registerExtSrc.includes('process.stderr.write(`[gsd] uncaught extension error (non-fatal)'),
      '_gsdEpipeGuard should NOT log errors as non-fatal and continue',
    );
    assert.match(
      registerExtSrc,
      /process\.exit\(1\)/,
      '_gsdEpipeGuard should call process.exit(1) for unrecoverable errors',
    );
  });

  test('writeCrashLog never throws even when directory is unwritable', async () => {
    const { writeCrashLog } = await import('../bootstrap/crash-log.ts');
    const origHome = process.env.GSD_HOME;
    // Point at a path that will fail to mkdir (e.g. a file that exists as non-dir)
    const tmpFile = join(tmpdir(), `gsd-not-a-dir-${randomUUID()}`);
    // Don't create it — mkdirSync with bad path should be caught internally
    process.env.GSD_HOME = join(tmpFile, 'nested', 'deeply');
    try {
      // Should not throw
      assert.doesNotThrow(() => {
        writeCrashLog(new Error('should not throw'), 'test');
      });
    } finally {
      process.env.GSD_HOME = origHome;
    }
  });
});

// ─── emitCrashRecoveredUnitEnd ────────────────────────────────────────────────

describe('emitCrashRecoveredUnitEnd (#3348)', () => {
  test('emits synthetic unit-end when unit-start has no matching unit-end', async () => {
    const base = makeTmpBase();
    try {
      const { emitJournalEvent, queryJournal } = await import('../journal.ts');
      const { emitCrashRecoveredUnitEnd } = await import('../crash-recovery.ts');

      const flowId = randomUUID();
      const unitStartSeq = 5;

      // Emit a unit-start with no corresponding unit-end (simulating a crash)
      emitJournalEvent(base, {
        ts: new Date().toISOString(),
        flowId,
        seq: unitStartSeq,
        eventType: 'unit-start',
        data: { unitType: 'execute-task', unitId: 'M001/S01/T01' },
      });

      const lock = {
        pid: 99999,
        startedAt: new Date().toISOString(),
        unitType: 'execute-task',
        unitId: 'M001/S01/T01',
        unitStartedAt: new Date().toISOString(),
      };

      emitCrashRecoveredUnitEnd(base, lock);

      const events = queryJournal(base);
      const ends = events.filter((e) => e.eventType === 'unit-end');
      assert.equal(ends.length, 1, 'should emit exactly one unit-end');
      assert.equal(ends[0].data?.unitId, 'M001/S01/T01');
      assert.equal(ends[0].data?.status, 'crash-recovered');
      assert.equal(ends[0].causedBy?.flowId, flowId);
      assert.equal(ends[0].causedBy?.seq, unitStartSeq);
      assert.ok(ends[0].seq > unitStartSeq, 'unit-end seq must be higher than unit-start seq');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('is a no-op when unit-end was already emitted (e.g. hard timeout fired)', async () => {
    const base = makeTmpBase();
    try {
      const { emitJournalEvent, queryJournal } = await import('../journal.ts');
      const { emitCrashRecoveredUnitEnd } = await import('../crash-recovery.ts');

      const flowId = randomUUID();
      emitJournalEvent(base, {
        ts: new Date().toISOString(),
        flowId,
        seq: 3,
        eventType: 'unit-start',
        data: { unitType: 'plan-slice', unitId: 'M001/S02' },
      });
      // Hard timeout already emitted a unit-end
      emitJournalEvent(base, {
        ts: new Date().toISOString(),
        flowId,
        seq: 4,
        eventType: 'unit-end',
        data: { unitType: 'plan-slice', unitId: 'M001/S02', status: 'cancelled' },
        causedBy: { flowId, seq: 3 },
      });

      const lock = {
        pid: 99999,
        startedAt: new Date().toISOString(),
        unitType: 'plan-slice',
        unitId: 'M001/S02',
        unitStartedAt: new Date().toISOString(),
      };
      emitCrashRecoveredUnitEnd(base, lock);

      const ends = queryJournal(base).filter((e) => e.eventType === 'unit-end');
      assert.equal(ends.length, 1, 'should not emit a duplicate unit-end');
      assert.equal(ends[0].data?.status, 'cancelled', 'original unit-end should be preserved');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('is a no-op for "starting" pseudo-units (bootstrap crash)', async () => {
    const base = makeTmpBase();
    try {
      const { queryJournal } = await import('../journal.ts');
      const { emitCrashRecoveredUnitEnd } = await import('../crash-recovery.ts');

      const lock = {
        pid: 99999,
        startedAt: new Date().toISOString(),
        unitType: 'starting',
        unitId: 'bootstrap',
        unitStartedAt: new Date().toISOString(),
      };
      emitCrashRecoveredUnitEnd(base, lock);

      const events = queryJournal(base);
      assert.equal(events.length, 0, 'should emit nothing for starting/bootstrap pseudo-units');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('is a no-op when no unit-start exists in the journal', async () => {
    const base = makeTmpBase();
    try {
      const { queryJournal } = await import('../journal.ts');
      const { emitCrashRecoveredUnitEnd } = await import('../crash-recovery.ts');

      const lock = {
        pid: 99999,
        startedAt: new Date().toISOString(),
        unitType: 'execute-task',
        unitId: 'M002/S01/T03',
        unitStartedAt: new Date().toISOString(),
      };
      emitCrashRecoveredUnitEnd(base, lock);

      const events = queryJournal(base);
      assert.equal(events.length, 0, 'should emit nothing when there is no journal entry to close');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
