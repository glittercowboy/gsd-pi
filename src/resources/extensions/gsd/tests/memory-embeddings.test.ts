import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _getAdapter, closeDatabase, openDatabase } from '../gsd-db.ts';
import { createMemory, queryMemoriesRanked, supersedeMemory } from '../memory-store.ts';
import {
  cosineSimilarity,
  embedMemories,
  getEmbeddingForMemory,
  loadAllEmbeddings,
  packFloat32,
  removeEmbedding,
  saveEmbedding,
  unpackFloat32,
} from '../memory-embeddings.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Float32 packing + cosine math
// ═══════════════════════════════════════════════════════════════════════════

test('memory-embeddings: packFloat32 / unpackFloat32 round-trip', () => {
  const vec = new Float32Array([0.1, -0.5, 0.25, 0.75]);
  const packed = packFloat32(vec);
  const restored = unpackFloat32(packed);
  assert.ok(restored);
  assert.equal(restored!.length, vec.length);
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Math.abs(restored![i] - vec[i]) < 1e-6);
  }
});

test('memory-embeddings: cosineSimilarity identities', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const c = new Float32Array([0, 1, 0]);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(a, c)) < 1e-6);
  assert.equal(cosineSimilarity(new Float32Array([]), new Float32Array([])), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// memory_embeddings table round-trip
// ═══════════════════════════════════════════════════════════════════════════

test('memory-embeddings: saveEmbedding then getEmbeddingForMemory', () => {
  openDatabase(':memory:');
  const id = createMemory({ category: 'pattern', content: 'embedding persistence test' });
  assert.ok(id);

  const vec = new Float32Array([0.1, 0.2, 0.3]);
  assert.ok(saveEmbedding(id!, vec, 'test-model'));

  const row = getEmbeddingForMemory(id!);
  assert.ok(row);
  assert.equal(row!.model, 'test-model');
  assert.equal(row!.dim, 3);
  assert.equal(row!.vector.length, 3);

  assert.ok(removeEmbedding(id!));
  assert.equal(getEmbeddingForMemory(id!), null);

  closeDatabase();
});

test('memory-embeddings: loadAllEmbeddings skips superseded memories', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'mem A' });
  createMemory({ category: 'pattern', content: 'mem B' });
  saveEmbedding('MEM001', new Float32Array([1, 0, 0]), 'm');
  saveEmbedding('MEM002', new Float32Array([0, 1, 0]), 'm');

  const all = loadAllEmbeddings();
  assert.equal(all.length, 2);

  // supersede MEM001
  supersedeMemory('MEM001', 'MEM002');

  const remaining = loadAllEmbeddings();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].memoryId, 'MEM002');

  closeDatabase();
});

test('memory-embeddings: embedMemories returns 0 when embedFn is null', async () => {
  const n = await embedMemories([{ id: 'MEM001', content: 'x' }], null, 'none');
  assert.equal(n, 0);
});

test('memory-embeddings: embedMemories persists fetched vectors', async () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'first' });
  createMemory({ category: 'pattern', content: 'second' });

  const fn = async (texts: string[]): Promise<Float32Array[]> =>
    texts.map((_, i) => new Float32Array([i, i + 1, i + 2]));

  const count = await embedMemories(
    [
      { id: 'MEM001', content: 'first' },
      { id: 'MEM002', content: 'second' },
    ],
    fn,
    'mock-embedder',
  );
  assert.equal(count, 2);

  const first = getEmbeddingForMemory('MEM001');
  assert.ok(first);
  assert.equal(first!.model, 'mock-embedder');
  assert.equal(first!.vector.length, 3);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// queryMemoriesRanked + FTS5 keyword path
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store: queryMemoriesRanked returns keyword hits', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'sql.js FTS5 virtual tables need triggers' });
  createMemory({ category: 'pattern', content: 'prefer prepared statements for hot paths' });
  createMemory({ category: 'convention', content: 'atomic writes use tmp + rename' });

  const ranked = queryMemoriesRanked({ query: 'sql triggers', k: 5 });
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].memory.id, 'MEM001');
  assert.ok(ranked[0].keywordRank !== null);
  assert.equal(ranked[0].reason, 'keyword');

  closeDatabase();
});

test('memory-store: queryMemoriesRanked respects scope + tag filters', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'scoped fact one', scope: 'project', tags: ['a'] });
  createMemory({ category: 'gotcha', content: 'scoped fact two', scope: 'global', tags: ['a', 'b'] });

  const projectOnly = queryMemoriesRanked({ query: 'scoped fact', scope: 'project' });
  assert.equal(projectOnly.length, 1);
  assert.equal(projectOnly[0].memory.scope, 'project');

  const tagged = queryMemoriesRanked({ query: 'scoped fact', tag: 'b' });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].memory.id, 'MEM002');

  closeDatabase();
});

test('memory-store: queryMemoriesRanked fuses keyword + semantic hits', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'foo bar baz' });
  createMemory({ category: 'pattern', content: 'completely unrelated' });

  // Embed memory 2 so semantic scoring picks it up even though the keyword
  // "foo" does not appear in its content.
  saveEmbedding('MEM001', new Float32Array([1, 0, 0, 0]), 'mock');
  saveEmbedding('MEM002', new Float32Array([0.9, 0.1, 0, 0]), 'mock');

  const queryVec = new Float32Array([0.95, 0.05, 0, 0]);
  const ranked = queryMemoriesRanked({ query: 'foo', queryVector: queryVec, k: 5 });
  const reasons = ranked.map((r) => r.reason);
  assert.ok(reasons.includes('both') || reasons.includes('keyword'));
  const ids = ranked.map((r) => r.memory.id);
  assert.ok(ids.includes('MEM002'), 'semantic-only hit should surface even without keyword match');

  closeDatabase();
});

test('memory-store: queryMemoriesRanked falls back to ranked listing when query is empty', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'first', confidence: 0.9 });
  createMemory({ category: 'pattern', content: 'second', confidence: 0.5 });

  const ranked = queryMemoriesRanked({ query: '   ' });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].memory.id, 'MEM001');
  assert.equal(ranked[0].reason, 'ranked');

  closeDatabase();
});

test('memory-store: queryMemoriesRanked excludes superseded by default', () => {
  openDatabase(':memory:');
  createMemory({ category: 'gotcha', content: 'stale insight' });
  createMemory({ category: 'gotcha', content: 'fresh insight' });

  supersedeMemory('MEM001', 'MEM002');

  const active = queryMemoriesRanked({ query: 'insight' });
  assert.ok(active.every((r) => r.memory.superseded_by == null));
});

// ═══════════════════════════════════════════════════════════════════════════
// FTS5 triggers keep memories_fts in sync with memories
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store schema: memories_fts stays in sync with memories', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'alpha beta gamma' });
  const adapter = _getAdapter();
  assert.ok(adapter);
  const fts = adapter!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
  if (!fts) {
    // Build without FTS5 — skip.
    closeDatabase();
    return;
  }
  const rows = adapter!.prepare(`SELECT content FROM memories_fts WHERE memories_fts MATCH 'beta'`).all();
  assert.ok(rows.some((row) => (row['content'] as string).includes('alpha beta gamma')));
  closeDatabase();
});
