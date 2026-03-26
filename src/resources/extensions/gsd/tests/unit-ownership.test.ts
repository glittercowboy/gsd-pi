// GSD — unit-ownership tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimUnit,
  releaseUnit,
  getOwner,
  checkOwnership,
  taskUnitKey,
  sliceUnitKey,
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

// ─── Claim / get / release ───────────────────────────────────────────────

test('claimUnit: creates claim file and records agent', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'executor-01');

    assert.ok(existsSync(join(base, '.gsd', 'unit-claims.json')), 'claim file should exist');
    assert.equal(getOwner(base, 'M001/S01/T01'), 'executor-01');
  } finally {
    cleanup(base);
  }
});

test('claimUnit: overwrites existing claim (last writer wins)', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'executor-01');
    claimUnit(base, 'M001/S01/T01', 'executor-02');

    assert.equal(getOwner(base, 'M001/S01/T01'), 'executor-02');
  } finally {
    cleanup(base);
  }
});

test('claimUnit: multiple units can be claimed independently', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    claimUnit(base, 'M001/S01/T02', 'agent-b');

    assert.equal(getOwner(base, 'M001/S01/T01'), 'agent-a');
    assert.equal(getOwner(base, 'M001/S01/T02'), 'agent-b');
  } finally {
    cleanup(base);
  }
});

test('getOwner: returns null when no claim file exists', () => {
  const base = makeTmpBase();
  try {
    assert.equal(getOwner(base, 'M001/S01/T01'), null);
  } finally {
    cleanup(base);
  }
});

test('getOwner: returns null for unclaimed unit', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    assert.equal(getOwner(base, 'M001/S01/T99'), null);
  } finally {
    cleanup(base);
  }
});

test('releaseUnit: removes claim', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');
    releaseUnit(base, 'M001/S01/T01');

    assert.equal(getOwner(base, 'M001/S01/T01'), null);
  } finally {
    cleanup(base);
  }
});

test('releaseUnit: no-op for non-existent claim', () => {
  const base = makeTmpBase();
  try {
    // Should not throw
    releaseUnit(base, 'M001/S01/T01');
  } finally {
    cleanup(base);
  }
});

// ─── checkOwnership ──────────────────────────────────────────────────────

test('checkOwnership: returns null when no actorName provided (opt-in)', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    // No actorName → ownership not enforced
    assert.equal(checkOwnership(base, 'M001/S01/T01', undefined), null);
  } finally {
    cleanup(base);
  }
});

test('checkOwnership: returns null when no claim file exists', () => {
  const base = makeTmpBase();
  try {
    assert.equal(checkOwnership(base, 'M001/S01/T01', 'agent-a'), null);
  } finally {
    cleanup(base);
  }
});

test('checkOwnership: returns null when unit is unclaimed', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    // Different unit, unclaimed
    assert.equal(checkOwnership(base, 'M001/S01/T99', 'agent-b'), null);
  } finally {
    cleanup(base);
  }
});

test('checkOwnership: returns null when actor matches owner', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    assert.equal(checkOwnership(base, 'M001/S01/T01', 'agent-a'), null);
  } finally {
    cleanup(base);
  }
});

test('checkOwnership: returns error string when actor does not match owner', () => {
  const base = makeTmpBase();
  try {
    claimUnit(base, 'M001/S01/T01', 'agent-a');

    const err = checkOwnership(base, 'M001/S01/T01', 'agent-b');
    assert.ok(err !== null, 'should return error');
    assert.match(err!, /owned by agent-a/);
    assert.match(err!, /not agent-b/);
  } finally {
    cleanup(base);
  }
});
