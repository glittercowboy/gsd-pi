import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _getAdapter, closeDatabase, openDatabase } from '../gsd-db.ts';
import {
  createMemorySource,
  deleteMemorySource,
  getMemorySource,
  hashContent,
  listMemorySources,
} from '../memory-source-store.ts';
import { ingestFile, ingestNote, summarizeIngest } from '../memory-ingest.ts';

// ═══════════════════════════════════════════════════════════════════════════
// memory-source-store
// ═══════════════════════════════════════════════════════════════════════════

test('memory-sources: content_hash is stable', () => {
  const a = hashContent('hello');
  const b = hashContent('hello');
  assert.equal(a, b);
  assert.notEqual(a, hashContent('world'));
});

test('memory-sources: createMemorySource is idempotent on content_hash', () => {
  openDatabase(':memory:');

  const first = createMemorySource({
    kind: 'note',
    content: 'sql.js FTS5 triggers must be kept in sync with the base table',
    tags: ['db', 'fts'],
  });
  assert.ok(first);
  assert.equal(first!.duplicate, false);

  const second = createMemorySource({
    kind: 'note',
    content: 'sql.js FTS5 triggers must be kept in sync with the base table',
    tags: ['db', 'fts'],
  });
  assert.ok(second);
  assert.equal(second!.duplicate, true);
  assert.equal(second!.id, first!.id);

  const sources = listMemorySources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, 'note');
  assert.deepEqual(sources[0].tags, ['db', 'fts']);

  closeDatabase();
});

test('memory-sources: getMemorySource and deleteMemorySource round-trip', () => {
  openDatabase(':memory:');

  const created = createMemorySource({ kind: 'note', content: 'note to delete' });
  assert.ok(created);
  const fetched = getMemorySource(created!.id);
  assert.ok(fetched);
  assert.equal(fetched!.content, 'note to delete');

  const removed = deleteMemorySource(created!.id);
  assert.ok(removed);
  assert.equal(getMemorySource(created!.id), null);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// memory-ingest
// ═══════════════════════════════════════════════════════════════════════════

test('memory-ingest: ingestNote persists a note source', async () => {
  openDatabase(':memory:');

  const result = await ingestNote('The CAPTURES.md pipeline runs on triage, not dispatch.', null, {
    tags: ['captures'],
    scope: 'project',
    extract: false,
  });

  assert.ok(result.sourceId.startsWith('SRC-'));
  assert.equal(result.duplicate, false);
  assert.equal(result.kind, 'note');
  assert.equal(result.extracted.length, 0);
  assert.match(summarizeIngest(result), /no memories extracted/);

  closeDatabase();
});

test('memory-ingest: ingestNote rejects empty input', async () => {
  openDatabase(':memory:');

  const result = await ingestNote('   ', null, { extract: false });
  assert.equal(result.sourceId, '');

  closeDatabase();
});

test('memory-ingest: ingestNote marks duplicates on replay', async () => {
  openDatabase(':memory:');

  const first = await ingestNote('same note body', null, { extract: false });
  const second = await ingestNote('same note body', null, { extract: false });
  assert.equal(first.sourceId, second.sourceId);
  assert.equal(second.duplicate, true);

  closeDatabase();
});

test('memory-ingest: ingestFile persists a file source', async () => {
  openDatabase(':memory:');

  const dir = mkdtempSync(join(tmpdir(), 'gsd-memory-ingest-'));
  const file = join(dir, 'sample.md');
  writeFileSync(file, '# Architecture\n\nWe use SQLite with WAL journaling.', 'utf-8');

  try {
    const result = await ingestFile(file, null, { tags: ['arch'], extract: false });
    assert.ok(result.sourceId.startsWith('SRC-'));
    assert.equal(result.kind, 'file');
    assert.equal(result.title, 'sample.md');
    assert.equal(result.uri, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    closeDatabase();
  }
});

test('memory-ingest: ingestFile rejects missing paths', async () => {
  openDatabase(':memory:');

  await assert.rejects(() => ingestFile('/no/such/file/exists.md', null, { extract: false }), /File not found/);

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// schema migration + scope/tags columns on memories
// ═══════════════════════════════════════════════════════════════════════════

test('memory-store schema: scope and tags columns exist on memories', () => {
  openDatabase(':memory:');
  const adapter = _getAdapter();
  const info = adapter!.prepare('PRAGMA table_info(memories)').all();
  const names = info.map((row: Record<string, unknown>) => row.name);
  assert.ok(names.includes('scope'));
  assert.ok(names.includes('tags'));
  closeDatabase();
});
