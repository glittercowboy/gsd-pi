// GSD-2 — loadMemoryBlock tests (ADR-013 step 4 auto-injection parity)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closeDatabase, openDatabase } from '../gsd-db.ts';
import { createMemory } from '../memory-store.ts';
import { loadMemoryBlock } from '../bootstrap/system-context.ts';

// ─── Success path: critical memories surface in the labeled block ──────────

test('loadMemoryBlock: renders MEMORY block when critical memories exist', async () => {
  openDatabase(':memory:');
  try {
    const id = createMemory({
      category: 'architecture',
      content: 'Use the memories table as the single source of truth for decisions.',
      confidence: 0.95,
    });
    assert.ok(id, 'createMemory should seed a memory');

    const block = await loadMemoryBlock('');
    assert.ok(block.length > 0, 'block should be non-empty when critical memories exist');
    assert.match(block, /\[MEMORY — Critical and prompt-relevant memories/);
    assert.match(block, /memories table as the single source of truth/);
  } finally {
    closeDatabase();
  }
});

// ─── Failure / degraded path: no DB → returns "" without throwing ───────────

test('loadMemoryBlock: returns empty string when no DB is available', async () => {
  closeDatabase();
  const block = await loadMemoryBlock('anything');
  assert.equal(block, '', 'no DB → empty block (graceful degradation)');
});
