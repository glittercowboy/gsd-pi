import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase } from '../gsd-db.ts';
import { applyMemoryActions, createMemory, supersedeMemory } from '../memory-store.ts';
import {
  createMemoryRelation,
  isValidRelation,
  listRelationsFor,
  removeMemoryRelationsFor,
  traverseGraph,
  VALID_RELATIONS,
} from '../memory-relations.ts';
import { executeGsdGraph } from '../tools/memory-tools.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

test('memory-relations: isValidRelation recognises the canonical set', () => {
  for (const rel of VALID_RELATIONS) {
    assert.ok(isValidRelation(rel));
  }
  assert.equal(isValidRelation('bogus'), false);
  assert.equal(isValidRelation(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// createMemoryRelation
// ═══════════════════════════════════════════════════════════════════════════

test('memory-relations: createMemoryRelation round-trips', () => {
  openDatabase(':memory:');
  createMemory({ category: 'architecture', content: 'auth lives in src/auth' });
  createMemory({ category: 'pattern', content: 'jwt tokens signed with HS256' });

  const ok = createMemoryRelation('MEM001', 'MEM002', 'elaborates', 0.9);
  assert.equal(ok, true);

  const relations = listRelationsFor('MEM001');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].from, 'MEM001');
  assert.equal(relations[0].to, 'MEM002');
  assert.equal(relations[0].rel, 'elaborates');
  assert.equal(relations[0].confidence, 0.9);

  closeDatabase();
});

test('memory-relations: rejects self-loops and unknown memories', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'only one memory exists' });

  assert.equal(createMemoryRelation('MEM001', 'MEM001', 'related_to'), false);
  assert.equal(createMemoryRelation('MEM001', 'MEM999', 'related_to'), false);
  assert.equal(createMemoryRelation('MEM001', 'MEM002', 'bogus-rel' as never), false);

  closeDatabase();
});

test('memory-relations: duplicate (from, to, rel) upserts instead of erroring', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'A' });
  createMemory({ category: 'pattern', content: 'B' });

  assert.equal(createMemoryRelation('MEM001', 'MEM002', 'related_to', 0.7), true);
  assert.equal(createMemoryRelation('MEM001', 'MEM002', 'related_to', 0.9), true);

  const relations = listRelationsFor('MEM001');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].confidence, 0.9);

  closeDatabase();
});

test('memory-relations: removeMemoryRelationsFor wipes both directions', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'A' });
  createMemory({ category: 'pattern', content: 'B' });
  createMemory({ category: 'pattern', content: 'C' });
  createMemoryRelation('MEM001', 'MEM002', 'related_to');
  createMemoryRelation('MEM003', 'MEM002', 'elaborates');

  removeMemoryRelationsFor('MEM002');

  assert.equal(listRelationsFor('MEM001').length, 0);
  assert.equal(listRelationsFor('MEM002').length, 0);
  assert.equal(listRelationsFor('MEM003').length, 0);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// LINK action via applyMemoryActions
// ═══════════════════════════════════════════════════════════════════════════

test('memory-relations: applyMemoryActions processes LINK actions', () => {
  openDatabase(':memory:');
  createMemory({ category: 'architecture', content: 'core lives in src/core' });
  createMemory({ category: 'pattern', content: 'events flow through EventEmitter' });

  applyMemoryActions([
    { action: 'LINK', from: 'MEM001', to: 'MEM002', rel: 'related_to', confidence: 0.75 },
    // unknown rel type — should be skipped silently
    { action: 'LINK', from: 'MEM001', to: 'MEM002', rel: 'nonsense-rel' as never },
  ]);

  const relations = listRelationsFor('MEM001');
  assert.equal(relations.length, 1);
  assert.equal(relations[0].rel, 'related_to');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// traverseGraph + gsd_graph tool
// ═══════════════════════════════════════════════════════════════════════════

test('memory-relations: traverseGraph walks multi-hop edges', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'A' });
  createMemory({ category: 'pattern', content: 'B' });
  createMemory({ category: 'pattern', content: 'C' });
  createMemoryRelation('MEM001', 'MEM002', 'related_to');
  createMemoryRelation('MEM002', 'MEM003', 'depends_on');

  const hop1 = traverseGraph('MEM001', 1);
  assert.equal(hop1.nodes.length, 2);
  assert.equal(hop1.edges.filter((e) => e.rel !== 'supersedes').length, 1);

  const hop2 = traverseGraph('MEM001', 2);
  assert.equal(hop2.nodes.length, 3);
  assert.equal(hop2.edges.filter((e) => e.rel !== 'supersedes').length, 2);

  closeDatabase();
});

test('memory-relations: traverseGraph still reports supersedes edges', () => {
  openDatabase(':memory:');
  createMemory({ category: 'convention', content: 'old style' });
  createMemory({ category: 'convention', content: 'new style' });
  supersedeMemory('MEM001', 'MEM002');

  const graph = traverseGraph('MEM001', 1);
  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['MEM001', 'MEM002']);
  assert.ok(graph.edges.some((e) => e.rel === 'supersedes' && e.from === 'MEM001' && e.to === 'MEM002'));

  closeDatabase();
});

test('memory-tools: gsd_graph returns LINK edges and filters by rel', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'alpha' });
  createMemory({ category: 'pattern', content: 'beta' });
  createMemory({ category: 'pattern', content: 'gamma' });
  createMemoryRelation('MEM001', 'MEM002', 'related_to');
  createMemoryRelation('MEM001', 'MEM003', 'contradicts');

  const all = executeGsdGraph({ mode: 'query', memoryId: 'MEM001', depth: 1 });
  assert.ok(!all.isError);
  const allEdges = all.details.edges as Array<{ rel: string }>;
  const relTypes = new Set(allEdges.map((e) => e.rel));
  assert.ok(relTypes.has('related_to'));
  assert.ok(relTypes.has('contradicts'));

  const filtered = executeGsdGraph({ mode: 'query', memoryId: 'MEM001', depth: 1, rel: 'related_to' });
  assert.ok(!filtered.isError);
  const fEdges = filtered.details.edges as Array<{ rel: string; to: string }>;
  assert.equal(fEdges.length, 1);
  assert.equal(fEdges[0].rel, 'related_to');
  assert.equal(fEdges[0].to, 'MEM002');

  closeDatabase();
});
