import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadQueueOrder,
  saveQueueOrder,
  sortByQueueOrder,
  pruneQueueOrder,
  validateQueueOrder,
} from '../queue-order.ts';
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-queue-order-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// sortByQueueOrder
// ═══════════════════════════════════════════════════════════════════════════


describe('queue-order', () => {
test('sortByQueueOrder', () => {
// Null order → default milestoneIdSort
  const result = sortByQueueOrder(['M003', 'M001', 'M002'], null);
  assert.deepStrictEqual(result, ['M001', 'M002', 'M003'], 'null order falls back to numeric sort');
});

// Custom order → exact sequence
test('test block at line 39', () => {
  const result = sortByQueueOrder(['M001', 'M002', 'M003'], ['M003', 'M001', 'M002']);
  assert.deepStrictEqual(result, ['M003', 'M001', 'M002'], 'custom order produces exact sequence');
});

// Custom order with new IDs → appended at end in numeric order
test('test block at line 45', () => {
  const result = sortByQueueOrder(['M001', 'M002', 'M003', 'M004'], ['M003', 'M001']);
  assert.deepStrictEqual(result, ['M003', 'M001', 'M002', 'M004'], 'new IDs appended in numeric order');
});

// Custom order with deleted IDs → silently skipped
test('test block at line 51', () => {
  const result = sortByQueueOrder(['M001', 'M003'], ['M003', 'M002', 'M001']);
  assert.deepStrictEqual(result, ['M003', 'M001'], 'deleted IDs in order are skipped');
});

// Empty custom order → all IDs in numeric order
test('test block at line 57', () => {
  const result = sortByQueueOrder(['M002', 'M001'], []);
  assert.deepStrictEqual(result, ['M001', 'M002'], 'empty custom order falls back to numeric sort');
});

// ═══════════════════════════════════════════════════════════════════════════
// loadQueueOrder / saveQueueOrder
// ═══════════════════════════════════════════════════════════════════════════
test('loadQueueOrder / saveQueueOrder', () => {
// Load returns null when file doesn't exist
  const base = createFixtureBase();
  assert.deepStrictEqual(loadQueueOrder(base), null, 'returns null when file missing');
  cleanup(base);
});

// Save then load round-trip
test('test block at line 76', () => {
  const base = createFixtureBase();
  saveQueueOrder(base, ['M003', 'M001', 'M002']);
  const loaded = loadQueueOrder(base);
  assert.deepStrictEqual(loaded, ['M003', 'M001', 'M002'], 'round-trip preserves order');

  // Verify file contains updatedAt
  const raw = JSON.parse(readFileSync(join(base, '.gsd', 'QUEUE-ORDER.json'), 'utf-8'));
  assert.ok(typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0, 'file contains updatedAt');

  cleanup(base);
});

// Load returns null on corrupt JSON
test('test block at line 90', () => {
  const base = createFixtureBase();
  writeFileSync(join(base, '.gsd', 'QUEUE-ORDER.json'), 'not json');
  assert.deepStrictEqual(loadQueueOrder(base), null, 'returns null on corrupt JSON');
  cleanup(base);
});

// Load returns null when order field is not an array
test('test block at line 98', () => {
  const base = createFixtureBase();
  writeFileSync(join(base, '.gsd', 'QUEUE-ORDER.json'), '{"order": "invalid"}');
  assert.deepStrictEqual(loadQueueOrder(base), null, 'returns null when order is not array');
  cleanup(base);
});

// ═══════════════════════════════════════════════════════════════════════════
// pruneQueueOrder
// ═══════════════════════════════════════════════════════════════════════════
test('pruneQueueOrder', () => {
// Prune removes invalid IDs
  const base = createFixtureBase();
  saveQueueOrder(base, ['M001', 'M002', 'M003']);
  pruneQueueOrder(base, ['M001', 'M003']);
  assert.deepStrictEqual(loadQueueOrder(base), ['M001', 'M003'], 'prune removes invalid IDs');
  cleanup(base);
});

// Prune no-ops when file doesn't exist
test('test block at line 121', () => {
  const base = createFixtureBase();
  pruneQueueOrder(base, ['M001']); // should not throw
  assert.ok(!existsSync(join(base, '.gsd', 'QUEUE-ORDER.json')), 'prune does not create file');
  cleanup(base);
});

// Prune no-ops when all IDs are valid
test('test block at line 129', () => {
  const base = createFixtureBase();
  saveQueueOrder(base, ['M001', 'M002']);
  pruneQueueOrder(base, ['M001', 'M002', 'M003']);
  assert.deepStrictEqual(loadQueueOrder(base), ['M001', 'M002'], 'prune is no-op when all valid');
  cleanup(base);
});

// ═══════════════════════════════════════════════════════════════════════════
// validateQueueOrder
// ═══════════════════════════════════════════════════════════════════════════
test('validateQueueOrder', () => {
// Valid order with no dependencies
  const depsMap = new Map<string, string[]>();
  const result = validateQueueOrder(['M001', 'M002'], depsMap, new Set());
  assert.ok(result.valid, 'valid when no dependencies');
  assert.deepStrictEqual(result.violations.length, 0, 'no violations');
  assert.deepStrictEqual(result.redundant.length, 0, 'no redundancies');
});

// Dependency violation: M002 before M001, but M002 depends on M001
test('test block at line 153', () => {
  const depsMap = new Map<string, string[]>([['M002', ['M001']]]);
  const result = validateQueueOrder(['M002', 'M001'], depsMap, new Set());
  assert.ok(!result.valid, 'invalid when dep violated');
  assert.deepStrictEqual(result.violations.length, 1, 'one violation');
  assert.deepStrictEqual(result.violations[0].type, 'would_block', 'violation type is would_block');
  assert.deepStrictEqual(result.violations[0].milestone, 'M002', 'violation milestone is M002');
  assert.deepStrictEqual(result.violations[0].dependsOn, 'M001', 'violation dep is M001');
});

// Redundant dependency: M002 depends on M001, M001 comes first in order
test('test block at line 164', () => {
  const depsMap = new Map<string, string[]>([['M002', ['M001']]]);
  const result = validateQueueOrder(['M001', 'M002'], depsMap, new Set());
  assert.ok(result.valid, 'valid when dep satisfied by position');
  assert.deepStrictEqual(result.redundant.length, 1, 'one redundancy');
  assert.deepStrictEqual(result.redundant[0].milestone, 'M002', 'redundant milestone is M002');
});

// Completed dep is always satisfied
test('test block at line 173', () => {
  const depsMap = new Map<string, string[]>([['M002', ['M001']]]);
  const result = validateQueueOrder(['M002'], depsMap, new Set(['M001']));
  assert.ok(result.valid, 'valid when dep is already completed');
  assert.deepStrictEqual(result.violations.length, 0, 'no violations for completed dep');
});

// Missing dependency
test('test block at line 181', () => {
  const depsMap = new Map<string, string[]>([['M002', ['M099']]]);
  const result = validateQueueOrder(['M001', 'M002'], depsMap, new Set());
  assert.ok(!result.valid, 'invalid when dep does not exist');
  assert.deepStrictEqual(result.violations[0].type, 'missing_dep', 'violation type is missing_dep');
});

// Circular dependency
test('test block at line 189', () => {
  const depsMap = new Map<string, string[]>([
    ['M001', ['M002']],
    ['M002', ['M001']],
  ]);
  const result = validateQueueOrder(['M001', 'M002'], depsMap, new Set());
  assert.ok(!result.valid, 'invalid on circular dependency');
  const circularViolation = result.violations.find(v => v.type === 'circular');
  assert.ok(!!circularViolation, 'circular violation detected');
});

// ═══════════════════════════════════════════════════════════════════════════
});
