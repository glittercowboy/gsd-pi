import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase } from '../gsd-db.ts';
import { createMemory, supersedeMemory } from '../memory-store.ts';
import {
  executeGsdGraph,
  executeMemoryCapture,
  executeMemoryQuery,
} from '../tools/memory-tools.ts';

// ═══════════════════════════════════════════════════════════════════════════
// capture_thought
// ═══════════════════════════════════════════════════════════════════════════

test('memory-tools: capture_thought creates a memory with a MEM id', () => {
  openDatabase(':memory:');

  const result = executeMemoryCapture({
    category: 'gotcha',
    content: 'sql.js FTS5 virtual tables need explicit triggers.',
  });

  assert.ok(!result.isError, 'capture should not error');
  assert.equal(result.details.operation, 'memory_capture');
  assert.equal(result.details.id, 'MEM001');
  assert.equal(result.details.category, 'gotcha');
  assert.equal(result.details.confidence, 0.8);

  closeDatabase();
});

test('memory-tools: capture_thought rejects invalid category', () => {
  openDatabase(':memory:');

  const result = executeMemoryCapture({
    category: 'opinion', // not in the allow-list
    content: 'some content',
  });

  assert.ok(result.isError, 'invalid category should error');
  assert.equal(result.details.error, 'invalid_category');

  closeDatabase();
});

test('memory-tools: capture_thought rejects missing fields', () => {
  openDatabase(':memory:');

  const empty = executeMemoryCapture({ category: '', content: '' });
  assert.ok(empty.isError, 'missing fields should error');
  assert.equal(empty.details.error, 'missing_fields');

  closeDatabase();
});

test('memory-tools: capture_thought clamps confidence to the 0.1–0.99 range', () => {
  openDatabase(':memory:');

  const hi = executeMemoryCapture({
    category: 'convention',
    content: 'clamp test high',
    confidence: 42,
  });
  assert.ok(!hi.isError);
  assert.equal(hi.details.confidence, 0.99);

  const lo = executeMemoryCapture({
    category: 'convention',
    content: 'clamp test low',
    confidence: -5,
  });
  assert.ok(!lo.isError);
  assert.equal(lo.details.confidence, 0.1);

  closeDatabase();
});

test('memory-tools: capture_thought fails gracefully when DB is closed', () => {
  closeDatabase();

  const result = executeMemoryCapture({
    category: 'gotcha',
    content: 'db closed',
  });

  assert.ok(result.isError, 'db-closed capture should error');
  assert.equal(result.details.error, 'db_unavailable');
});

// ═══════════════════════════════════════════════════════════════════════════
// memory_query
// ═══════════════════════════════════════════════════════════════════════════

test('memory-tools: memory_query keyword-matches and ranks by confidence × hits', () => {
  openDatabase(':memory:');

  createMemory({ category: 'gotcha', content: 'sql.js FTS5 triggers must mirror insert/update/delete', confidence: 0.9 });
  createMemory({ category: 'pattern', content: 'use prepared statements for hot paths', confidence: 0.7 });
  createMemory({ category: 'convention', content: 'prefer async iterators for streaming', confidence: 0.8 });

  const result = executeMemoryQuery({ query: 'sql triggers', k: 5 });
  assert.ok(!result.isError);
  const hits = result.details.hits as Array<{ id: string; content: string; reason: string }>;
  assert.ok(hits.length >= 1, 'should return at least one keyword hit');
  assert.equal(hits[0].id, 'MEM001', 'most-relevant memory should rank first');
  assert.equal(hits[0].reason, 'keyword');

  closeDatabase();
});

test('memory-tools: memory_query returns empty list when no keywords match', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'unrelated content' });

  const result = executeMemoryQuery({ query: 'totally different phrase', k: 5 });
  assert.ok(!result.isError);
  const hits = result.details.hits as unknown[];
  assert.equal(hits.length, 0);
  assert.equal(result.content[0].text, 'No matching memories.');

  closeDatabase();
});

test('memory-tools: memory_query with empty query returns ranked memories', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'first', confidence: 0.95 });
  createMemory({ category: 'pattern', content: 'second', confidence: 0.5 });

  const result = executeMemoryQuery({ query: '   ' });
  assert.ok(!result.isError);
  const hits = result.details.hits as Array<{ id: string; reason: string }>;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'MEM001', 'higher-confidence memory ranks first under empty query');
  assert.equal(hits[0].reason, 'ranked');

  closeDatabase();
});

test('memory-tools: memory_query filters by category', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'db pragma needed' });
  createMemory({ category: 'pattern', content: 'db pragma needed' });

  const result = executeMemoryQuery({ query: 'db pragma', category: 'gotcha' });
  assert.ok(!result.isError);
  const hits = result.details.hits as Array<{ id: string; category: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].category, 'gotcha');

  closeDatabase();
});

test('memory-tools: memory_query filters by scope and tag', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'shared fact', scope: 'project', tags: ['db', 'sqlite'] });
  createMemory({ category: 'gotcha', content: 'global fact', scope: 'global', tags: ['db'] });
  createMemory({ category: 'gotcha', content: 'other scope', scope: 'project', tags: ['net'] });

  const projectScoped = executeMemoryQuery({ query: 'fact', scope: 'project' });
  assert.ok(!projectScoped.isError);
  const projectHits = projectScoped.details.hits as Array<{ id: string }>;
  assert.equal(projectHits.length, 1);
  assert.equal(projectHits[0].id, 'MEM001');

  const tagged = executeMemoryQuery({ query: 'fact', tag: 'sqlite' });
  assert.ok(!tagged.isError);
  const taggedHits = tagged.details.hits as Array<{ id: string }>;
  assert.equal(taggedHits.length, 1);
  assert.equal(taggedHits[0].id, 'MEM001');

  closeDatabase();
});

test('memory-tools: capture_thought stores scope and tags', () => {
  openDatabase(':memory:');
  const result = executeMemoryCapture({
    category: 'architecture',
    content: 'use WAL journaling by default',
    scope: 'global',
    tags: ['sqlite', 'wal'],
  });
  assert.ok(!result.isError);
  assert.equal(result.details.scope, 'global');
  assert.deepEqual(result.details.tags, ['sqlite', 'wal']);

  const lookup = executeMemoryQuery({ query: 'WAL', scope: 'global', tag: 'wal' });
  const hits = lookup.details.hits as Array<{ id: string }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'MEM001');

  closeDatabase();
});

test('memory-tools: memory_query clamps k to the 1–50 range', () => {
  openDatabase(':memory:');
  for (let i = 0; i < 10; i++) {
    createMemory({ category: 'pattern', content: `pattern ${i}` });
  }

  const tooLow = executeMemoryQuery({ query: 'pattern', k: 0 });
  assert.ok(!tooLow.isError);
  assert.equal((tooLow.details.hits as unknown[]).length, 1);

  const sane = executeMemoryQuery({ query: 'pattern', k: 999 });
  assert.ok(!sane.isError);
  assert.equal((sane.details.hits as unknown[]).length, 10);

  closeDatabase();
});

test('memory-tools: memory_query can reinforce returned hits', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'needs reinforcement' });

  executeMemoryQuery({ query: 'reinforcement', reinforce_hits: true });
  const follow = executeMemoryQuery({ query: 'reinforcement' });
  const hits = follow.details.hits as Array<{ hit_count: number }>;
  assert.equal(hits.length, 1);
  assert.ok(hits[0].hit_count >= 1, 'hit_count should increment on reinforce');

  closeDatabase();
});

test('memory-tools: memory_query ignores superseded memories by default', () => {
  openDatabase(':memory:');
  createMemory({ category: 'convention', content: 'old way of doing X' });
  createMemory({ category: 'convention', content: 'new way of doing X' });
  supersedeMemory('MEM001', 'MEM002');

  const active = executeMemoryQuery({ query: 'doing' });
  const activeHits = active.details.hits as Array<{ id: string }>;
  assert.equal(activeHits.length, 1);
  assert.equal(activeHits[0].id, 'MEM002');

  const withSuperseded = executeMemoryQuery({ query: 'doing', include_superseded: true });
  const allHits = withSuperseded.details.hits as Array<{ id: string }>;
  assert.equal(allHits.length, 2);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// gsd_graph
// ═══════════════════════════════════════════════════════════════════════════

test('memory-tools: gsd_graph build acknowledges request', () => {
  openDatabase(':memory:');
  const result = executeGsdGraph({ mode: 'build' });
  assert.ok(!result.isError);
  assert.equal(result.details.operation, 'gsd_graph');
  assert.equal(result.details.mode, 'build');
  closeDatabase();
});

test('memory-tools: gsd_graph query rejects missing memoryId', () => {
  openDatabase(':memory:');
  const result = executeGsdGraph({ mode: 'query' });
  assert.ok(result.isError);
  assert.equal(result.details.error, 'missing_memory_id');
  closeDatabase();
});

test('memory-tools: gsd_graph query returns node + supersedes edge', () => {
  openDatabase(':memory:');
  createMemory({ category: 'convention', content: 'first' });
  createMemory({ category: 'convention', content: 'second' });
  supersedeMemory('MEM001', 'MEM002');

  const result = executeGsdGraph({ mode: 'query', memoryId: 'MEM001', depth: 1 });
  assert.ok(!result.isError);
  const nodes = result.details.nodes as Array<{ id: string }>;
  const edges = result.details.edges as Array<{ from: string; to: string; rel: string }>;

  const nodeIds = nodes.map((n) => n.id).sort();
  assert.deepEqual(nodeIds, ['MEM001', 'MEM002']);
  assert.ok(edges.some((e) => e.from === 'MEM001' && e.to === 'MEM002' && e.rel === 'supersedes'));

  closeDatabase();
});

test('memory-tools: gsd_graph query returns empty when memoryId does not exist', () => {
  openDatabase(':memory:');
  const result = executeGsdGraph({ mode: 'query', memoryId: 'MEM999' });
  assert.ok(!result.isError, 'missing memory is not an error, just empty');
  assert.equal((result.details.nodes as unknown[]).length, 0);
  closeDatabase();
});

test('memory-tools: gsd_graph errors when DB is closed', () => {
  closeDatabase();
  const result = executeGsdGraph({ mode: 'query', memoryId: 'MEM001' });
  assert.ok(result.isError);
  assert.equal(result.details.error, 'db_unavailable');
});
