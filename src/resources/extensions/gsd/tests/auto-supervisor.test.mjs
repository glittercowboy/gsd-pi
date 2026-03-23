import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoSupervisorConfig } from '../preferences.ts';

test('resolveAutoSupervisorConfig provides safe timeout defaults', () => {
  const supervisor = resolveAutoSupervisorConfig();
  assert.equal(supervisor.soft_timeout_minutes, 20);
  assert.equal(supervisor.idle_timeout_minutes, 10);
  assert.equal(supervisor.hard_timeout_minutes, 30);
});
