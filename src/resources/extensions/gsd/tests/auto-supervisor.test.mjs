import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeUnitRuntimeRecord, readUnitRuntimeRecord } from '../unit-runtime.ts';
import { resolveAutoSupervisorConfig } from '../preferences.ts';

test('resolveAutoSupervisorConfig provides safe timeout defaults', () => {
  // Isolate from user's real ~/.gsd/preferences.md by pointing GSD_HOME to a temp dir
  const savedGsdHome = process.env.GSD_HOME;
  const savedHome = process.env.HOME;
  try {
    process.env.GSD_HOME = '/tmp/gsd-no-such-home-for-test-supervisor';
    process.env.HOME = '/tmp/gsd-no-such-home-for-test-supervisor';
    const supervisor = resolveAutoSupervisorConfig();
    assert.equal(supervisor.soft_timeout_minutes, 20);
    assert.equal(supervisor.idle_timeout_minutes, 10);
    assert.equal(supervisor.hard_timeout_minutes, 30);
  } finally {
    if (savedGsdHome !== undefined) process.env.GSD_HOME = savedGsdHome;
    else delete process.env.GSD_HOME;
    process.env.HOME = savedHome;
  }
});

test('writeUnitRuntimeRecord persists progress and recovery metadata defaults', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-auto-supervisor-'));
  const startedAt = 1234567890;

  writeUnitRuntimeRecord(base, 'plan-milestone', 'M010', startedAt, {
    phase: 'dispatched',
    lastProgressAt: startedAt,
    progressCount: 1,
    lastProgressKind: 'dispatch',
  });

  const runtime = readUnitRuntimeRecord(base, 'plan-milestone', 'M010');
  assert.ok(runtime);
  assert.equal(runtime.phase, 'dispatched');
  assert.equal(runtime.lastProgressAt, startedAt);
  assert.equal(runtime.progressCount, 1);
  assert.equal(runtime.lastProgressKind, 'dispatch');
  assert.equal(runtime.recoveryAttempts, 0);
});

test('writeUnitRuntimeRecord keeps explicit recovery attempt fields', () => {
  const base = mkdtempSync(join(tmpdir(), 'gsd-auto-supervisor-'));
  const startedAt = 2234567890;

  writeUnitRuntimeRecord(base, 'research-milestone', 'M011', startedAt, {
    phase: 'timeout',
    recoveryAttempts: 2,
    lastRecoveryReason: 'idle',
    lastProgressAt: startedAt + 50,
    progressCount: 3,
    lastProgressKind: 'recovery-retry',
  });

  const runtime = JSON.parse(readFileSync(join(base, '.gsd/runtime/units/research-milestone-M011.json'), 'utf8'));
  assert.equal(runtime.recoveryAttempts, 2);
  assert.equal(runtime.lastRecoveryReason, 'idle');
  assert.equal(runtime.lastProgressKind, 'recovery-retry');
});
