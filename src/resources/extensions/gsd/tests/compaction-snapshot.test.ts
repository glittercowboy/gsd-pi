import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSnapshot,
  readCompactionSnapshot,
  writeCompactionSnapshot,
  DEFAULT_SNAPSHOT_BYTES,
} from '../compaction-snapshot.ts';
import { closeDatabase, openDatabase } from '../gsd-db.ts';
import { createMemory } from '../memory-store.ts';
import { executeResume } from '../tools/resume-tool.ts';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-snap-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('buildSnapshot: renders memories, exec history, and active context', () => {
  const snap = buildSnapshot({
    generatedAt: new Date('2026-04-20T12:00:00.000Z'),
    activeContext: 'M001 / S01 / T01 — wire gsd_exec',
    memories: [
      { id: 'MEM001', category: 'gotcha', content: 'FTS5 needs Porter tokenizer', confidence: 0.9,
        source_unit_type: null, source_unit_id: null, created_at: '', updated_at: '',
        superseded_by: null, hit_count: 0, scope: 'project', seq: 1, tags: [], structured_fields: null },
    ],
    execHistory: [
      {
        id: 'abc',
        runtime: 'bash',
        purpose: 'count TODOs',
        started_at: '', finished_at: '', duration_ms: 10,
        exit_code: 0, signal: null, timed_out: false,
        stdout_bytes: 1, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false,
        stdout_path: '/tmp/abc.stdout', stderr_path: '/tmp/abc.stderr', meta_path: '/tmp/abc.meta.json',
      },
    ],
  });
  assert.match(snap, /Active context/);
  assert.match(snap, /M001 \/ S01 \/ T01/);
  assert.match(snap, /FTS5 needs Porter tokenizer/);
  assert.match(snap, /\[abc\] bash exit:0 — count TODOs/);
});

test('buildSnapshot: enforces the byte cap with a truncation marker', () => {
  const longMemories = Array.from({ length: 50 }, (_v, i) => ({
    id: `MEM${String(i).padStart(3, '0')}`,
    category: 'gotcha',
    content: 'x'.repeat(200),
    confidence: 0.8,
    source_unit_type: null,
    source_unit_id: null,
    created_at: '',
    updated_at: '',
    superseded_by: null,
    hit_count: 0,
    scope: 'project',
    seq: i,
    tags: [] as string[],
    structured_fields: null,
  }));
  const snap = buildSnapshot(
    { generatedAt: new Date(), memories: longMemories, execHistory: [] },
    { maxBytes: 512, maxMemories: 50 },
  );
  assert.ok(Buffer.byteLength(snap, 'utf-8') <= 512, 'should respect cap');
  assert.match(snap, /\[truncated\]/, 'should include truncation marker');
});

test('buildSnapshot: handles empty state with an explanatory placeholder', () => {
  const snap = buildSnapshot({ generatedAt: new Date(), memories: [], execHistory: [] });
  assert.match(snap, /_No durable memories/);
  assert.ok(Buffer.byteLength(snap, 'utf-8') <= DEFAULT_SNAPSHOT_BYTES);
});

test('writeCompactionSnapshot + readCompactionSnapshot + executeResume: end-to-end', () => {
  const base = freshBase();
  try {
    openDatabase(':memory:');
    createMemory({ category: 'architecture', content: 'Single-writer DB through gsd-db.ts', confidence: 0.95 });
    createMemory({ category: 'convention', content: 'Prefer typed helpers over raw SQL', confidence: 0.9 });

    const out = writeCompactionSnapshot(base, { activeContext: 'M099 resume check' });
    assert.ok(out.path.endsWith('last-snapshot.md'));
    assert.ok(out.bytes > 0);
    assert.equal(out.memories, 2);

    const contents = readCompactionSnapshot(base);
    assert.ok(contents);
    assert.match(contents!, /Single-writer DB through gsd-db\.ts/);
    assert.match(contents!, /M099 resume check/);

    const tool = executeResume({}, { baseDir: base });
    assert.ok(!tool.isError);
    assert.equal(tool.details.found, true);
    assert.match(tool.content[0].text, /Single-writer DB through gsd-db\.ts/);

    // also verify the file content matches (without trailing newline)
    const raw = readFileSync(out.path, 'utf-8');
    assert.ok(raw.endsWith('\n'));
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test('executeResume: reports friendly empty state when no snapshot exists', () => {
  const base = freshBase();
  try {
    const result = executeResume({}, { baseDir: base });
    assert.equal(result.details.found, false);
    assert.match(result.content[0].text, /No snapshot found/);
  } finally {
    cleanup(base);
  }
});
