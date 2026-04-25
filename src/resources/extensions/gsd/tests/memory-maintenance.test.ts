import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _getAdapter, closeDatabase, openDatabase } from '../gsd-db.ts';
import {
  createMemory,
  decayStaleMemories,
  enforceMemoryCap,
  markUnitProcessed,
} from '../memory-store.ts';
import { createMemoryRelation, listRelationsFor } from '../memory-relations.ts';
import { saveEmbedding, getEmbeddingForMemory } from '../memory-embeddings.ts';

// ═══════════════════════════════════════════════════════════════════════════
// enforceMemoryCap — cascade cleanup of embeddings and relations
// ═══════════════════════════════════════════════════════════════════════════

test('memory-cap: supersedes lowest-ranked memories and cascades cleanup', () => {
  openDatabase(':memory:');

  // Create 6 memories with descending confidence so the first is lowest.
  createMemory({ category: 'pattern', content: 'weakest', confidence: 0.2 });
  createMemory({ category: 'pattern', content: 'mid-1', confidence: 0.5 });
  createMemory({ category: 'pattern', content: 'mid-2', confidence: 0.6 });
  createMemory({ category: 'pattern', content: 'strong-1', confidence: 0.9 });
  createMemory({ category: 'pattern', content: 'strong-2', confidence: 0.92 });
  createMemory({ category: 'pattern', content: 'strongest', confidence: 0.95 });

  saveEmbedding('MEM001', new Float32Array([1, 0, 0]), 'm');
  saveEmbedding('MEM006', new Float32Array([0, 1, 0]), 'm');
  createMemoryRelation('MEM001', 'MEM002', 'related_to');

  // Cap at 5 — MEM001 should be superseded and its embedding + relations purged.
  enforceMemoryCap(5);

  const adapter = _getAdapter();
  const row = adapter!
    .prepare("SELECT superseded_by FROM memories WHERE id = 'MEM001'")
    .get();
  assert.equal(row?.['superseded_by'], 'CAP_EXCEEDED');
  assert.equal(getEmbeddingForMemory('MEM001'), null);
  assert.equal(listRelationsFor('MEM001').length, 0);

  // MEM006 was not victimised — its embedding should still exist.
  assert.ok(getEmbeddingForMemory('MEM006'));

  closeDatabase();
});

test('memory-cap: is a no-op when count is already under the cap', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'one' });
  createMemory({ category: 'pattern', content: 'two' });

  enforceMemoryCap(10);

  const adapter = _getAdapter();
  const count = adapter!
    .prepare("SELECT count(*) as cnt FROM memories WHERE superseded_by IS NULL")
    .get();
  assert.equal(count?.['cnt'], 2);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// decayStaleMemories — returns list of decayed IDs
// ═══════════════════════════════════════════════════════════════════════════

test('memory-decay: returns decayed memory IDs', () => {
  openDatabase(':memory:');

  // Insert processed units — decayStaleMemories needs at least N rows.
  const now = Date.now();
  for (let i = 0; i < 21; i++) {
    markUnitProcessed(`unit/${i}`, `file-${i}`);
    // small spacing to create deterministic ordering
    const row = _getAdapter()!
      .prepare('UPDATE memory_processed_units SET processed_at = :ts WHERE unit_key = :key');
    row.run({ ':ts': new Date(now + i * 1000).toISOString(), ':key': `unit/${i}` });
  }

  // Create memory with updated_at in the distant past
  createMemory({ category: 'pattern', content: 'stale entry', confidence: 0.9 });
  _getAdapter()!
    .prepare("UPDATE memories SET updated_at = '2000-01-01T00:00:00Z' WHERE id = 'MEM001'")
    .run({});

  const decayed = decayStaleMemories(20);
  assert.ok(decayed.includes('MEM001'));

  // Confidence should have dropped.
  const row = _getAdapter()!
    .prepare("SELECT confidence FROM memories WHERE id = 'MEM001'")
    .get();
  assert.ok((row?.['confidence'] as number) < 0.9);

  closeDatabase();
});

test('memory-decay: returns empty when there are fewer processed units than the threshold', () => {
  openDatabase(':memory:');
  createMemory({ category: 'pattern', content: 'fresh' });
  const decayed = decayStaleMemories(20);
  assert.deepEqual(decayed, []);
  closeDatabase();
});
