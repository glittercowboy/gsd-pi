// GSD — unit-ownership tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimUnit,
  releaseUnit,
  getOwner,
  checkOwnership,
  taskUnitKey,
  sliceUnitKey,
  initOwnershipTable,
  closeOwnershipDb,
} from '../unit-ownership.ts';

function makeTmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-ownership-'));
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

// ─── Key builders ────────────────────────────────────────────────────────

test('taskUnitKey: builds correct key', () => {
  assert.equal(taskUnitKey('M001', 'S01', 'T01'), 'M001/S01/T01');
});

test('sliceUnitKey: builds correct key', () => {
  assert.equal(sliceUnitKey('M001', 'S01'), 'M001/S01');
});

// ─── Claim / get / release (SQLite-backed) ──────────────────────────────

test('claimUnit: creates DB and records agent', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    const claimed = claimUnit(base, 'M001/S01/T01', 'executor-01');

    assert.equal(claimed, true, 'first claim should succeed');
    assert.equal(getOwner(base, 'M001/S01/T01'), 'executor-01');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('claimUnit: rejects second claim on same unit (first-writer-wins)', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    const first = claimUnit(base, 'M001/S01/T01', 'executor-01');
    const second = claimUnit(base, 'M001/S01/T01', 'executor-02');

    assert.equal(first, true, 'first claim should succeed');
    assert.equal(second, false, 'second claim should fail (first-writer-wins)');
    assert.equal(getOwner(base, 'M001/S01/T01'), 'executor-01',
      'original owner must be preserved');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('claimUnit: same agent re-claiming same unit succeeds', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    const first = claimUnit(base, 'M001/S01/T01', 'agent-a');
    const second = claimUnit(base, 'M001/S01/T01', 'agent-a');

    assert.equal(first, true);
    assert.equal(second, true, 're-claim by same agent should succeed');
    assert.equal(getOwner(base, 'M001/S01/T01'), 'agent-a');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('claimUnit: multiple units can be claimed independently', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    claimUnit(base, 'M001/S01/T02', 'agent-b');

    assert.equal(getOwner(base, 'M001/S01/T01'), 'agent-a');
    assert.equal(getOwner(base, 'M001/S01/T02'), 'agent-b');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('getOwner: returns null when no DB initialized', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    assert.equal(getOwner(base, 'M001/S01/T01'), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('getOwner: returns null for unclaimed unit', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    assert.equal(getOwner(base, 'M001/S01/T99'), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('releaseUnit: removes claim', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    releaseUnit(base, 'M001/S01/T01');

    assert.equal(getOwner(base, 'M001/S01/T01'), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('releaseUnit: no-op for non-existent claim', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    // Should not throw
    releaseUnit(base, 'M001/S01/T01');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('releaseUnit: allows reclaim after release', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    releaseUnit(base, 'M001/S01/T01');

    const reclaimed = claimUnit(base, 'M001/S01/T01', 'agent-b');
    assert.equal(reclaimed, true, 'reclaim after release should succeed');
    assert.equal(getOwner(base, 'M001/S01/T01'), 'agent-b');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

// ─── checkOwnership ──────────────────────────────────────────────────────

test('checkOwnership: returns null when no actorName provided (opt-in)', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    // No actorName → ownership not enforced
    assert.equal(checkOwnership(base, 'M001/S01/T01', undefined), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('checkOwnership: returns null when unit is unclaimed', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    // Different unit, unclaimed
    assert.equal(checkOwnership(base, 'M001/S01/T99', 'agent-b'), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('checkOwnership: returns null when actor matches owner', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    assert.equal(checkOwnership(base, 'M001/S01/T01', 'agent-a'), null);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

test('checkOwnership: returns error string when actor does not match owner', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    const err = checkOwnership(base, 'M001/S01/T01', 'agent-b');
    assert.ok(err !== null, 'should return error');
    assert.match(err!, /owned by agent-a/);
    assert.match(err!, /not agent-b/);
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});

// ─── Race condition: first-writer-wins atomicity ─────────────────────────

test('claimUnit: concurrent claims — only first writer wins (no lost update)', () => {
  const base = makeTmpBase();
  try {
    initOwnershipTable(base);

    // Simulate the race described in #2728:
    // Two agents both try to claim the same unit.
    // With SQLite INSERT OR IGNORE, only the first succeeds.
    const results: boolean[] = [];
    const agents = ['agent-alpha', 'agent-beta', 'agent-gamma'];
    for (const agent of agents) {
      results.push(claimUnit(base, 'M001/S01/T01', agent));
    }

    // Exactly one agent should have won
    const wins = results.filter(r => r === true);
    assert.equal(wins.length, 1, 'exactly one agent should win the claim');

    // The winner is the first agent (deterministic in single-threaded)
    assert.equal(results[0], true);
    assert.equal(results[1], false);
    assert.equal(results[2], false);

    // The owner must be the first agent
    assert.equal(getOwner(base, 'M001/S01/T01'), 'agent-alpha');
  } finally {
    closeOwnershipDb(base);
    cleanup(base);
  }
});
