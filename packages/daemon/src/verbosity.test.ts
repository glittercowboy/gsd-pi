import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VerbosityManager, shouldShowAtLevel } from './verbosity.js';

// ---------------------------------------------------------------------------
// VerbosityManager
// ---------------------------------------------------------------------------

describe('VerbosityManager', () => {
  let vm: VerbosityManager;

  beforeEach(() => {
    vm = new VerbosityManager();
  });

  it('returns default level for unknown channel', () => {
    assert.equal(vm.getLevel('chan-1'), 'default');
  });

  it('set/get round-trips', () => {
    vm.setLevel('chan-1', 'quiet');
    assert.equal(vm.getLevel('chan-1'), 'quiet');
    vm.setLevel('chan-1', 'verbose');
    assert.equal(vm.getLevel('chan-1'), 'verbose');
  });

  it('different channels are independent', () => {
    vm.setLevel('chan-a', 'quiet');
    vm.setLevel('chan-b', 'verbose');
    assert.equal(vm.getLevel('chan-a'), 'quiet');
    assert.equal(vm.getLevel('chan-b'), 'verbose');
    assert.equal(vm.getLevel('chan-c'), 'default');
  });

  it('shouldShow delegates to the level-based filter', () => {
    vm.setLevel('chan-q', 'quiet');
    assert.equal(vm.shouldShow('chan-q', 'tool_execution_start'), false);
    assert.equal(vm.shouldShow('chan-q', 'extension_ui_request'), true);
  });
});

// ---------------------------------------------------------------------------
// shouldShowAtLevel — quiet
// ---------------------------------------------------------------------------

describe('shouldShowAtLevel — quiet', () => {
  const level = 'quiet' as const;

  it('shows blockers', () => {
    assert.equal(shouldShowAtLevel(level, 'extension_ui_request'), true);
  });

  it('shows execution_complete', () => {
    assert.equal(shouldShowAtLevel(level, 'execution_complete'), true);
  });

  it('shows error', () => {
    assert.equal(shouldShowAtLevel(level, 'error'), true);
  });

  it('shows session_error', () => {
    assert.equal(shouldShowAtLevel(level, 'session_error'), true);
  });

  it('hides tool calls', () => {
    assert.equal(shouldShowAtLevel(level, 'tool_execution_start'), false);
    assert.equal(shouldShowAtLevel(level, 'tool_execution_end'), false);
  });

  it('hides messages', () => {
    assert.equal(shouldShowAtLevel(level, 'message_start'), false);
    assert.equal(shouldShowAtLevel(level, 'message'), false);
  });

  it('hides cost_update', () => {
    assert.equal(shouldShowAtLevel(level, 'cost_update'), false);
  });

  it('hides task_transition', () => {
    assert.equal(shouldShowAtLevel(level, 'task_transition'), false);
  });

  it('hides unknown events', () => {
    assert.equal(shouldShowAtLevel(level, 'totally_random'), false);
  });
});

// ---------------------------------------------------------------------------
// shouldShowAtLevel — default
// ---------------------------------------------------------------------------

describe('shouldShowAtLevel — default', () => {
  const level = 'default' as const;

  it('shows blockers', () => {
    assert.equal(shouldShowAtLevel(level, 'extension_ui_request'), true);
  });

  it('shows execution_complete', () => {
    assert.equal(shouldShowAtLevel(level, 'execution_complete'), true);
  });

  it('shows error', () => {
    assert.equal(shouldShowAtLevel(level, 'error'), true);
  });

  it('shows tool calls', () => {
    assert.equal(shouldShowAtLevel(level, 'tool_execution_start'), true);
    assert.equal(shouldShowAtLevel(level, 'tool_execution_end'), true);
  });

  it('shows messages', () => {
    assert.equal(shouldShowAtLevel(level, 'message_start'), true);
    assert.equal(shouldShowAtLevel(level, 'message_end'), true);
    assert.equal(shouldShowAtLevel(level, 'message'), true);
  });

  it('shows task_transition', () => {
    assert.equal(shouldShowAtLevel(level, 'task_transition'), true);
  });

  it('shows session_started', () => {
    assert.equal(shouldShowAtLevel(level, 'session_started'), true);
  });

  it('hides cost_update', () => {
    assert.equal(shouldShowAtLevel(level, 'cost_update'), false);
  });

  it('hides status events', () => {
    assert.equal(shouldShowAtLevel(level, 'state_update'), false);
    assert.equal(shouldShowAtLevel(level, 'status'), false);
  });

  it('hides unknown events', () => {
    assert.equal(shouldShowAtLevel(level, 'something_weird'), false);
  });
});

// ---------------------------------------------------------------------------
// shouldShowAtLevel — verbose
// ---------------------------------------------------------------------------

describe('shouldShowAtLevel — verbose', () => {
  const level = 'verbose' as const;

  it('shows everything that quiet/default show', () => {
    const events = [
      'extension_ui_request', 'execution_complete', 'error', 'session_error',
      'tool_execution_start', 'tool_execution_end', 'message_start', 'message_end',
      'message', 'task_transition', 'session_started',
    ];
    for (const e of events) {
      assert.equal(shouldShowAtLevel(level, e), true, `Expected verbose to show ${e}`);
    }
  });

  it('shows cost_update', () => {
    assert.equal(shouldShowAtLevel(level, 'cost_update'), true);
  });

  it('shows status events', () => {
    assert.equal(shouldShowAtLevel(level, 'state_update'), true);
    assert.equal(shouldShowAtLevel(level, 'status'), true);
    assert.equal(shouldShowAtLevel(level, 'set_status'), true);
  });

  it('shows unknown/arbitrary events', () => {
    assert.equal(shouldShowAtLevel(level, 'something_arbitrary'), true);
  });
});
