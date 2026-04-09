import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  _getAdapter,
} from '../gsd-db.ts';
import {
  getActiveMemories,
  getActiveMemoriesRanked,
  nextMemoryId,
  createMemory,
  updateMemoryContent,
  reinforceMemory,
  supersedeMemory,
  isUnitProcessed,
  markUnitProcessed,
  decayStaleMemories,
  enforceMemoryCap,
  applyMemoryActions,
  formatMemoriesForPrompt,
} from '../memory-store.ts';
import type { MemoryAction } from '../memory-store.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: fallback when DB not open
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: fallback returns empty when DB not open', () => {
  closeDatabase();
  assert.ok(!isDbAvailable(), 'DB should not be available');

  assert.deepStrictEqual(getActiveMemories(), [], 'getActiveMemories returns [] when DB closed');
  assert.deepStrictEqual(getActiveMemoriesRanked(), [], 'getActiveMemoriesRanked returns [] when DB closed');
  assert.deepStrictEqual(nextMemoryId(), 'MEM001', 'nextMemoryId returns MEM001 when DB closed');
  assert.deepStrictEqual(createMemory({ category: 'test', content: 'test' }), null, 'createMemory returns null when DB closed');
  assert.ok(!reinforceMemory('MEM001'), 'reinforceMemory returns false when DB closed');
  assert.ok(!isUnitProcessed('test/key'), 'isUnitProcessed returns false when DB closed');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: CRUD operations
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: create and query memories', () => {
  openDatabase(':memory:');

  // Create memories
  const id1 = createMemory({ category: 'gotcha', content: 'esbuild drops .node binaries' });
  assert.ok(id1 !== null, 'createMemory should return an ID');
  assert.deepStrictEqual(id1, 'MEM001', 'first memory ID should be MEM001');

  const id2 = createMemory({ category: 'convention', content: 'use :memory: for tests', confidence: 0.9 });
  assert.deepStrictEqual(id2, 'MEM002', 'second memory ID should be MEM002');

  const id3 = createMemory({ category: 'architecture', content: 'extensions discovered from src/resources/' });
  assert.deepStrictEqual(id3, 'MEM003', 'third memory ID should be MEM003');

  // Query all active
  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 3, 'should have 3 active memories');
  assert.deepStrictEqual(active[0].category, 'gotcha', 'first memory category');
  assert.deepStrictEqual(active[0].content, 'esbuild drops .node binaries', 'first memory content');
  assert.deepStrictEqual(active[1].confidence, 0.9, 'second memory confidence');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: update and reinforce
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: update and reinforce', () => {
  openDatabase(':memory:');

  createMemory({ category: 'gotcha', content: 'original content' });

  // Update content
  const updated = updateMemoryContent('MEM001', 'revised content', 0.95);
  assert.ok(updated, 'updateMemoryContent should return true');

  const active = getActiveMemories();
  assert.deepStrictEqual(active[0].content, 'revised content', 'content should be updated');
  assert.deepStrictEqual(active[0].confidence, 0.95, 'confidence should be updated');

  // Reinforce
  const reinforced = reinforceMemory('MEM001');
  assert.ok(reinforced, 'reinforceMemory should return true');

  const after = getActiveMemories();
  assert.deepStrictEqual(after[0].hit_count, 1, 'hit_count should be 1 after reinforce');

  // Reinforce again
  reinforceMemory('MEM001');
  const after2 = getActiveMemories();
  assert.deepStrictEqual(after2[0].hit_count, 2, 'hit_count should be 2 after second reinforce');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: supersede
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: supersede', () => {
  openDatabase(':memory:');

  createMemory({ category: 'convention', content: 'old convention' });
  createMemory({ category: 'convention', content: 'new convention' });

  supersedeMemory('MEM001', 'MEM002');

  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 1, 'should have 1 active memory after supersede');
  assert.deepStrictEqual(active[0].id, 'MEM002', 'active memory should be MEM002');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: ranked query ordering
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: ranked query ordering', () => {
  openDatabase(':memory:');

  // Low confidence, no hits
  createMemory({ category: 'pattern', content: 'low ranking', confidence: 0.5 });
  // High confidence, no hits
  createMemory({ category: 'gotcha', content: 'high confidence', confidence: 0.95 });
  // Medium confidence, many hits
  createMemory({ category: 'convention', content: 'frequently used', confidence: 0.7 });

  // Reinforce MEM003 multiple times to boost its ranking
  for (let i = 0; i < 10; i++) reinforceMemory('MEM003');

  const ranked = getActiveMemoriesRanked(10);
  assert.deepStrictEqual(ranked.length, 3, 'should have 3 ranked memories');
  // MEM003: 0.7 * (1 + 10*0.1) = 0.7 * 2.0 = 1.4
  // MEM002: 0.95 * (1 + 0*0.1) = 0.95
  // MEM001: 0.5 * (1 + 0*0.1) = 0.5
  assert.deepStrictEqual(ranked[0].id, 'MEM003', 'highest ranked should be MEM003 (reinforced)');
  assert.deepStrictEqual(ranked[1].id, 'MEM002', 'second ranked should be MEM002 (high confidence)');
  assert.deepStrictEqual(ranked[2].id, 'MEM001', 'lowest ranked should be MEM001');

  // Test limit
  const limited = getActiveMemoriesRanked(2);
  assert.deepStrictEqual(limited.length, 2, 'limit should cap results');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: processed unit tracking
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: processed unit tracking', () => {
  openDatabase(':memory:');

  assert.ok(!isUnitProcessed('execute-task/M001/S01/T01'), 'should not be processed initially');

  markUnitProcessed('execute-task/M001/S01/T01', '/path/to/activity.jsonl');

  assert.ok(isUnitProcessed('execute-task/M001/S01/T01'), 'should be processed after marking');
  assert.ok(!isUnitProcessed('execute-task/M001/S01/T02'), 'different key should not be processed');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: enforce memory cap
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: enforce memory cap', () => {
  openDatabase(':memory:');

  // Create 5 memories with varying confidence
  createMemory({ category: 'gotcha', content: 'mem 1', confidence: 0.9 });
  createMemory({ category: 'gotcha', content: 'mem 2', confidence: 0.5 });
  createMemory({ category: 'gotcha', content: 'mem 3', confidence: 0.3 });
  createMemory({ category: 'gotcha', content: 'mem 4', confidence: 0.95 });
  createMemory({ category: 'gotcha', content: 'mem 5', confidence: 0.7 });

  // Enforce cap of 3
  enforceMemoryCap(3);

  const active = getActiveMemories();
  assert.deepStrictEqual(active.length, 3, 'should have 3 active memories after cap enforcement');

  // The 2 lowest-ranked (MEM003=0.3 and MEM002=0.5) should be superseded
  const ids = active.map(m => m.id).sort();
  assert.ok(ids.includes('MEM001'), 'MEM001 (0.9) should survive');
  assert.ok(ids.includes('MEM004'), 'MEM004 (0.95) should survive');
  assert.ok(ids.includes('MEM005'), 'MEM005 (0.7) should survive');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: applyMemoryActions transaction
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: applyMemoryActions', () => {
  openDatabase(':memory:');

  const actions: MemoryAction[] = [
    { action: 'CREATE', category: 'gotcha', content: 'first gotcha', confidence: 0.8 },
    { action: 'CREATE', category: 'convention', content: 'first convention', confidence: 0.9 },
  ];

  applyMemoryActions(actions, 'execute-task', 'M001/S01/T01');

  let active = getActiveMemories();
  assert.deepStrictEqual(active.length, 2, 'should have 2 memories after CREATE actions');

  // Now apply UPDATE + REINFORCE
  const updateActions: MemoryAction[] = [
    { action: 'UPDATE', id: 'MEM001', content: 'updated gotcha' },
    { action: 'REINFORCE', id: 'MEM002' },
  ];

  applyMemoryActions(updateActions, 'execute-task', 'M001/S01/T02');

  active = getActiveMemories();
  assert.deepStrictEqual(active.find(m => m.id === 'MEM001')?.content, 'updated gotcha', 'MEM001 should be updated');
  assert.deepStrictEqual(active.find(m => m.id === 'MEM002')?.hit_count, 1, 'MEM002 should be reinforced');

  // SUPERSEDE
  const supersedeActions: MemoryAction[] = [
    { action: 'CREATE', category: 'gotcha', content: 'better gotcha', confidence: 0.95 },
    { action: 'SUPERSEDE', id: 'MEM001', superseded_by: 'MEM003' },
  ];

  applyMemoryActions(supersedeActions, 'execute-task', 'M001/S01/T03');

  active = getActiveMemories();
  assert.deepStrictEqual(active.length, 2, 'should have 2 active after supersede');
  assert.ok(!active.find(m => m.id === 'MEM001'), 'MEM001 should be superseded');
  assert.ok(!!active.find(m => m.id === 'MEM003'), 'MEM003 should be active');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: formatMemoriesForPrompt
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: formatMemoriesForPrompt', () => {
  openDatabase(':memory:');

  createMemory({ category: 'gotcha', content: 'esbuild drops .node binaries' });
  createMemory({ category: 'convention', content: 'use :memory: for tests' });
  createMemory({ category: 'architecture', content: 'extensions in src/resources/' });
  createMemory({ category: 'gotcha', content: 'TypeScript path aliases need .js' });

  const memories = getActiveMemoriesRanked(30);
  const formatted = formatMemoriesForPrompt(memories);

  assert.ok(formatted.includes('## Project Memory (auto-learned)'), 'should have header');
  assert.ok(formatted.includes('### Gotcha'), 'should have gotcha category');
  assert.ok(formatted.includes('### Convention'), 'should have convention category');
  assert.ok(formatted.includes('### Architecture'), 'should have architecture category');
  assert.ok(formatted.includes('- esbuild drops .node binaries'), 'should have gotcha content');
  assert.ok(formatted.includes('- use :memory: for tests'), 'should have convention content');

  // Test empty memories
  closeDatabase();
  openDatabase(':memory:');
  const emptyFormatted = formatMemoriesForPrompt([]);
  assert.deepStrictEqual(emptyFormatted, '', 'empty memories should return empty string');

  // Test token budget truncation
  closeDatabase();
  openDatabase(':memory:');
  for (let i = 0; i < 20; i++) {
    createMemory({ category: 'pattern', content: `A very long memory entry that takes up space #${i}: ${'x'.repeat(200)}` });
  }
  const budgetMemories = getActiveMemoriesRanked(30);
  const truncated = formatMemoriesForPrompt(budgetMemories, 500);
  assert.ok(truncated.length < 2500, `formatted length ${truncated.length} should be under budget`);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: ID generation
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: ID generation', () => {
  openDatabase(':memory:');

  assert.deepStrictEqual(nextMemoryId(), 'MEM001', 'first ID should be MEM001');

  createMemory({ category: 'test', content: 'test' });
  assert.deepStrictEqual(nextMemoryId(), 'MEM002', 'after first create, next should be MEM002');

  // Create several more
  for (let i = 0; i < 98; i++) createMemory({ category: 'test', content: `test ${i}` });
  assert.deepStrictEqual(nextMemoryId(), 'MEM100', 'after 99 creates, next should be MEM100');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-store: schema migration (v2 → v3)
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: schema includes memories table', () => {
  openDatabase(':memory:');

  const adapter = _getAdapter()!;

  // Verify memories table exists
  const memCount = adapter.prepare('SELECT count(*) as cnt FROM memories').get();
  assert.deepStrictEqual(memCount?.['cnt'], 0, 'memories table should exist and be empty');

  // Verify memory_processed_units table exists
  const procCount = adapter.prepare('SELECT count(*) as cnt FROM memory_processed_units').get();
  assert.deepStrictEqual(procCount?.['cnt'], 0, 'memory_processed_units table should exist and be empty');

  // Verify active_memories view exists
  const viewCount = adapter.prepare('SELECT count(*) as cnt FROM active_memories').get();
  assert.deepStrictEqual(viewCount?.['cnt'], 0, 'active_memories view should exist');

  // Verify schema version is 14 (after indexes + slice_dependencies)
  const version = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assert.deepStrictEqual(version?.['v'], 14, 'schema version should be 14');

  closeDatabase();
});

