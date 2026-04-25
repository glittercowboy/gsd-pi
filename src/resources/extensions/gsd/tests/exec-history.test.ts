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

// ── Path traversal security tests (issue #4590) ───────────────────────────

test('safeReadMeta: ignores malicious stdout_path in JSON, derives path from meta file location', () => {
  // Arrange: write a .meta.json whose JSON content has a path-traversal value
  // in stdout_path / stderr_path. The read-side must silently discard these
  // and derive sibling paths from the actual .meta.json location instead.
  const base = freshBase();
  try {
    const dir = join(base, '.gsd', 'exec');
    mkdirSync(dir, { recursive: true });
    const id = 'traversal-test-run';
    const metaPath = join(dir, `${id}.meta.json`);
    const stdoutPath = join(dir, `${id}.stdout`);
    const stderrPath = join(dir, `${id}.stderr`);
    // Write real sibling files so digest_preview can succeed.
    writeFileSync(stdoutPath, 'legitimate stdout content\n');
    writeFileSync(stderrPath, '');
    // Write a meta.json that tries to point stdout_path outside the exec dir.
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        runtime: 'bash',
        purpose: 'test run',
        started_at: '2026-04-20T12:00:00.000Z',
        finished_at: '2026-04-20T12:00:00.100Z',
        duration_ms: 100,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 24,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        // These malicious values must NEVER be used as filesystem paths.
        stdout_path: '../../etc/passwd',
        stderr_path: '../../etc/shadow',
      }),
    );

    const entries = listExecHistory(base);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;

    // stdout_path must be derived from the meta file location, not from JSON.
    assert.equal(entry.stdout_path, stdoutPath,
      `stdout_path must be a sibling of the meta file; got: ${entry.stdout_path}`);
    assert.equal(entry.stderr_path, stderrPath,
      `stderr_path must be a sibling of the meta file; got: ${entry.stderr_path}`);

    // Verify neither traversal string leaked into the returned entry.
    assert.ok(!entry.stdout_path.includes('..'),
      `stdout_path must not contain path traversal sequences: ${entry.stdout_path}`);
    assert.ok(!entry.stderr_path.includes('..'),
      `stderr_path must not contain path traversal sequences: ${entry.stderr_path}`);
    assert.ok(!entry.stdout_path.includes('etc/passwd'),
      `stdout_path must not point to /etc/passwd: ${entry.stdout_path}`);
  } finally {
    cleanup(base);
  }
});

test('searchExecHistory: digest_preview is read from derived sibling path, not JSON stdout_path', () => {
  // Arrange: a .meta.json with a malicious stdout_path pointing to /etc/passwd.
  // The digest_preview should be read from the real sibling .stdout file,
  // not from the JSON-supplied path.
  const base = freshBase();
  try {
    const dir = join(base, '.gsd', 'exec');
    mkdirSync(dir, { recursive: true });
    const id = 'preview-traversal-run';
    const metaPath = join(dir, `${id}.meta.json`);
    const stdoutPath = join(dir, `${id}.stdout`);
    writeFileSync(stdoutPath, 'safe-sentinel-content\n');
    writeFileSync(join(dir, `${id}.stderr`), '');
    writeFileSync(
      metaPath,
      JSON.stringify({
        id,
        runtime: 'bash',
        purpose: null,
        started_at: '2026-04-20T12:00:00.000Z',
        finished_at: '2026-04-20T12:00:00.100Z',
        duration_ms: 50,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 21,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        // Attacker-controlled path — must be ignored.
        stdout_path: '/etc/passwd',
        stderr_path: '/etc/shadow',
      }),
    );

    const hits = searchExecHistory(base, {});
    assert.equal(hits.length, 1);
    const hit = hits[0]!;

    // The preview must come from the safe sibling, not /etc/passwd.
    assert.ok(
      hit.digest_preview?.includes('safe-sentinel-content'),
      `digest_preview should contain safe-sentinel-content; got: ${hit.digest_preview}`,
    );
    // Ensure the entry paths are the derived ones.
    assert.equal(hit.entry.stdout_path, stdoutPath);
  } finally {
    cleanup(base);
  }
});
