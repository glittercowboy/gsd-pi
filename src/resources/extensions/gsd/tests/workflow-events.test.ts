// GSD Extension — workflow-events unit tests
// Tests appendEvent, readEvents, findForkPoint, compactMilestoneEvents.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendEvent,
  readEvents,
  findForkPoint,
  compactMilestoneEvents,
  type WorkflowEvent,
} from '../workflow-events.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-events-'));
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeEvent(cmd: string, params: Record<string, unknown> = {}): Omit<WorkflowEvent, 'hash' | 'session_id'> {
  return { cmd, params, ts: new Date().toISOString(), actor: 'agent' };
}

// ─── appendEvent ─────────────────────────────────────────────────────────

test('workflow-events: appendEvent creates .gsd dir and event-log.jsonl', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T01' }));
    assert.ok(fs.existsSync(path.join(base, '.gsd', 'event-log.jsonl')));
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: appendEvent writes valid JSON line', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T01' }));
    const content = fs.readFileSync(path.join(base, '.gsd', 'event-log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as WorkflowEvent;
    assert.strictEqual(parsed.cmd, 'complete-task');
    assert.strictEqual(parsed.actor, 'agent');
    assert.strictEqual(typeof parsed.hash, 'string');
    assert.strictEqual(parsed.hash.length, 16);
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: appendEvent appends multiple events', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { taskId: 'T01' }));
    appendEvent(base, makeEvent('complete-slice', { sliceId: 'S01' }));
    const events = readEvents(path.join(base, '.gsd', 'event-log.jsonl'));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.cmd, 'complete-task');
    assert.strictEqual(events[1]!.cmd, 'complete-slice');
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: same cmd+params → same hash (deterministic)', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('plan-task', { milestoneId: 'M001', sliceId: 'S01' }));
    appendEvent(base, makeEvent('plan-task', { milestoneId: 'M001', sliceId: 'S01' }));
    const events = readEvents(path.join(base, '.gsd', 'event-log.jsonl'));
    assert.strictEqual(events[0]!.hash, events[1]!.hash, 'identical cmd+params produce identical hash');
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: different params → different hash', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { taskId: 'T01' }));
    appendEvent(base, makeEvent('complete-task', { taskId: 'T02' }));
    const events = readEvents(path.join(base, '.gsd', 'event-log.jsonl'));
    assert.notStrictEqual(events[0]!.hash, events[1]!.hash, 'different params produce different hash');
  } finally {
    cleanupDir(base);
  }
});

// ─── readEvents ──────────────────────────────────────────────────────────

test('workflow-events: readEvents returns [] for non-existent file', () => {
  const result = readEvents('/nonexistent/path/event-log.jsonl');
  assert.deepStrictEqual(result, []);
});

test('workflow-events: readEvents skips corrupted lines', () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, '.gsd'), { recursive: true });
    const logPath = path.join(base, '.gsd', 'event-log.jsonl');
    // Write a valid line, a corrupted line, and another valid line
    fs.writeFileSync(logPath,
      '{"cmd":"complete-task","params":{},"ts":"2026-01-01T00:00:00Z","hash":"abcd1234abcd1234","actor":"agent"}\n' +
      'NOT VALID JSON {{{{\n' +
      '{"cmd":"plan-task","params":{},"ts":"2026-01-01T00:00:01Z","hash":"1234abcd1234abcd","actor":"system"}\n',
    );
    const events = readEvents(logPath);
    assert.strictEqual(events.length, 2, 'should return 2 valid events, skipping the corrupted line');
    assert.strictEqual(events[0]!.cmd, 'complete-task');
    assert.strictEqual(events[1]!.cmd, 'plan-task');
  } finally {
    cleanupDir(base);
  }
});

// ─── findForkPoint ───────────────────────────────────────────────────────

test('workflow-events: findForkPoint returns -1 for two empty logs', () => {
  assert.strictEqual(findForkPoint([], []), -1);
});

test('workflow-events: findForkPoint returns -1 when first events differ', () => {
  const e1 = { cmd: 'a', params: {}, ts: '', hash: 'hash1', actor: 'agent' } as WorkflowEvent;
  const e2 = { cmd: 'b', params: {}, ts: '', hash: 'hash2', actor: 'agent' } as WorkflowEvent;
  assert.strictEqual(findForkPoint([e1], [e2]), -1);
});

test('workflow-events: findForkPoint returns 0 when only first event is common', () => {
  const common = { cmd: 'a', params: {}, ts: '', hash: 'hash1', actor: 'agent' } as WorkflowEvent;
  const eA = { cmd: 'b', params: {}, ts: '', hash: 'hash2', actor: 'agent' } as WorkflowEvent;
  const eB = { cmd: 'c', params: {}, ts: '', hash: 'hash3', actor: 'agent' } as WorkflowEvent;
  // logA: [common, eA], logB: [common, eB]
  assert.strictEqual(findForkPoint([common, eA], [common, eB]), 0);
});

test('workflow-events: findForkPoint returns last common index for prefix relationship', () => {
  const e1 = { cmd: 'a', params: {}, ts: '', hash: 'h1', actor: 'agent' } as WorkflowEvent;
  const e2 = { cmd: 'b', params: {}, ts: '', hash: 'h2', actor: 'agent' } as WorkflowEvent;
  const e3 = { cmd: 'c', params: {}, ts: '', hash: 'h3', actor: 'agent' } as WorkflowEvent;
  // logA is a prefix of logB → fork point is last index of logA
  assert.strictEqual(findForkPoint([e1, e2], [e1, e2, e3]), 1);
});

test('workflow-events: findForkPoint handles equal logs', () => {
  const e1 = { cmd: 'a', params: {}, ts: '', hash: 'h1', actor: 'agent' } as WorkflowEvent;
  const e2 = { cmd: 'b', params: {}, ts: '', hash: 'h2', actor: 'agent' } as WorkflowEvent;
  assert.strictEqual(findForkPoint([e1, e2], [e1, e2]), 1);
});

// ─── compactMilestoneEvents ──────────────────────────────────────────────

test('workflow-events: compactMilestoneEvents returns { archived: 0 } when no matching events', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M002', taskId: 'T01' }));
    const result = compactMilestoneEvents(base, 'M001');
    assert.strictEqual(result.archived, 0);
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: compactMilestoneEvents archives milestone events', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T01' }));
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T02' }));
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M002', taskId: 'T03' }));

    const result = compactMilestoneEvents(base, 'M001');
    assert.strictEqual(result.archived, 2, 'should archive 2 M001 events');

    // Archive file should exist
    const archivePath = path.join(base, '.gsd', 'event-log-M001.jsonl.archived');
    assert.ok(fs.existsSync(archivePath), 'archive file should exist');
    const archived = readEvents(archivePath);
    assert.strictEqual(archived.length, 2, 'archive file should have 2 events');

    // Active log should retain only M002 event
    const active = readEvents(path.join(base, '.gsd', 'event-log.jsonl'));
    assert.strictEqual(active.length, 1, 'active log should have 1 remaining event');
    assert.strictEqual((active[0]!.params as { milestoneId?: string }).milestoneId, 'M002');
  } finally {
    cleanupDir(base);
  }
});

test('workflow-events: compactMilestoneEvents empties active log when all events are from milestone', () => {
  const base = tempDir();
  try {
    appendEvent(base, makeEvent('complete-task', { milestoneId: 'M001', taskId: 'T01' }));
    compactMilestoneEvents(base, 'M001');
    const active = readEvents(path.join(base, '.gsd', 'event-log.jsonl'));
    assert.strictEqual(active.length, 0, 'active log should be empty after full compact');
  } finally {
    cleanupDir(base);
  }
});
