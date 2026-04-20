import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listExecHistory, searchExecHistory } from '../exec-history.ts';
import { executeExecSearch } from '../tools/exec-search-tool.ts';

function freshBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-exec-history-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeRun(base: string, id: string, overrides: Record<string, unknown> = {}): void {
  const dir = join(base, '.gsd', 'exec');
  mkdirSync(dir, { recursive: true });
  const stdoutPath = join(dir, `${id}.stdout`);
  const stderrPath = join(dir, `${id}.stderr`);
  const metaPath = join(dir, `${id}.meta.json`);
  writeFileSync(stdoutPath, (overrides.stdout as string | undefined) ?? `stdout for ${id}\n`);
  writeFileSync(stderrPath, '');
  writeFileSync(
    metaPath,
    JSON.stringify({
      id,
      runtime: 'bash',
      purpose: `purpose for ${id}`,
      started_at: '2026-04-20T12:00:00.000Z',
      finished_at: '2026-04-20T12:00:00.100Z',
      duration_ms: 100,
      exit_code: 0,
      signal: null,
      timed_out: false,
      stdout_bytes: 12,
      stderr_bytes: 0,
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      ...overrides,
    }),
  );
}

test('listExecHistory: returns empty list when .gsd/exec missing', () => {
  const base = freshBase();
  try {
    assert.deepEqual(listExecHistory(base), []);
  } finally {
    cleanup(base);
  }
});

test('listExecHistory: skips malformed meta files', () => {
  const base = freshBase();
  try {
    const dir = join(base, '.gsd', 'exec');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.meta.json'), '{not-json');
    writeRun(base, 'ok-1');
    const list = listExecHistory(base);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'ok-1');
  } finally {
    cleanup(base);
  }
});

test('searchExecHistory: filters by query, runtime, and failing_only', () => {
  const base = freshBase();
  try {
    writeRun(base, 'playwright-run', { purpose: 'playwright snapshot' });
    writeRun(base, 'grep-run', { purpose: 'grep TODOs' });
    writeRun(base, 'failing-run', { exit_code: 1, purpose: 'boom' });
    writeRun(base, 'node-run', { runtime: 'node', purpose: 'dedupe' });

    const playwrightHits = searchExecHistory(base, { query: 'playwright' });
    assert.equal(playwrightHits.length, 1);
    assert.equal(playwrightHits[0]!.entry.id, 'playwright-run');

    const failingHits = searchExecHistory(base, { failing_only: true });
    assert.equal(failingHits.length, 1);
    assert.equal(failingHits[0]!.entry.id, 'failing-run');

    const nodeHits = searchExecHistory(base, { runtime: 'node' });
    assert.equal(nodeHits.length, 1);
    assert.equal(nodeHits[0]!.entry.runtime, 'node');

    const unlimited = searchExecHistory(base, {});
    assert.equal(unlimited.length, 4);
  } finally {
    cleanup(base);
  }
});

test('executeExecSearch: returns helpful empty-state message when no matches', () => {
  const base = freshBase();
  try {
    const result = executeExecSearch({ query: 'missing' }, { baseDir: base });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /No prior gsd_exec runs/);
  } finally {
    cleanup(base);
  }
});

test('executeExecSearch: includes stdout_path and preview in details', () => {
  const base = freshBase();
  try {
    writeRun(base, 'summary-run', { stdout: 'found 42 TODOs\n' });
    const result = executeExecSearch({ query: 'summary' }, { baseDir: base });
    const details = result.details as { results: Array<{ id: string; stdout_path: string }> };
    assert.equal(details.results.length, 1);
    assert.equal(details.results[0]!.id, 'summary-run');
    assert.match(details.results[0]!.stdout_path, /summary-run\.stdout$/);
    assert.match(result.content[0].text, /found 42 TODOs/);
  } finally {
    cleanup(base);
  }
});
