// GSD Extension — post-mutation hook regression tests
// Verifies that after a successful handleCompleteTask call, the post-mutation
// hook fires: event-log.jsonl and state-manifest.json are both written.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDatabase, closeDatabase } from '../gsd-db.ts';
import { handleCompleteTask } from '../tools/complete-task.ts';
import { readEvents } from '../workflow-events.ts';
import { readManifest } from '../workflow-manifest.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-post-hook-'));
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Create a minimal project directory with a PLAN.md for complete-task to find. */
function createProject(basePath: string): void {
  const sliceDir = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01');
  const tasksDir = path.join(sliceDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(sliceDir, 'S01-PLAN.md'), `# S01: Test Slice

## Tasks

- [ ] **T01: Test task** \`est:30m\`
  - Do: Implement the thing
  - Verify: Run tests

- [ ] **T02: Second task** \`est:1h\`
  - Do: Implement more
  - Verify: Run more tests
`);
}

function makeCompleteTaskParams() {
  return {
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    oneLiner: 'Implemented auth middleware',
    narrative: 'Added JWT validation middleware with proper error handling.',
    verification: 'Ran npm test — all tests pass.',
    deviations: 'None.',
    knownIssues: 'None.',
    keyFiles: ['src/middleware/auth.ts'],
    keyDecisions: [],
    blockerDiscovered: false,
    verificationEvidence: [
      { command: 'npm test', exitCode: 0, verdict: '✅ pass', durationMs: 2500 },
    ],
  };
}

// ─── Post-mutation hook: event log ───────────────────────────────────────

test('post-mutation-hook: event-log.jsonl exists after handleCompleteTask', async () => {
  const base = tempDir();
  const dbPath = path.join(base, 'test.db');
  openDatabase(dbPath);
  createProject(base);

  try {
    const result = await handleCompleteTask(makeCompleteTaskParams(), base);
    assert.ok(!('error' in result), `handler should succeed, got: ${JSON.stringify(result)}`);

    const logPath = path.join(base, '.gsd', 'event-log.jsonl');
    assert.ok(fs.existsSync(logPath), 'event-log.jsonl should exist after handler completes');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('post-mutation-hook: event log contains complete-task event with correct params', async () => {
  const base = tempDir();
  const dbPath = path.join(base, 'test.db');
  openDatabase(dbPath);
  createProject(base);

  try {
    await handleCompleteTask(makeCompleteTaskParams(), base);

    const logPath = path.join(base, '.gsd', 'event-log.jsonl');
    const events = readEvents(logPath);
    assert.ok(events.length > 0, 'event log should have at least one event');

    const ev = events.find((e) => e.cmd === 'complete-task');
    assert.ok(ev !== undefined, 'should have a complete-task event');
    assert.strictEqual((ev!.params as { milestoneId?: string }).milestoneId, 'M001');
    assert.strictEqual((ev!.params as { sliceId?: string }).sliceId, 'S01');
    assert.strictEqual((ev!.params as { taskId?: string }).taskId, 'T01');
    assert.strictEqual(ev!.actor, 'agent');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── Post-mutation hook: manifest ────────────────────────────────────────

test('post-mutation-hook: state-manifest.json exists after handleCompleteTask', async () => {
  const base = tempDir();
  const dbPath = path.join(base, 'test.db');
  openDatabase(dbPath);
  createProject(base);

  try {
    const result = await handleCompleteTask(makeCompleteTaskParams(), base);
    assert.ok(!('error' in result), `handler should succeed, got: ${JSON.stringify(result)}`);

    const manifestPath = path.join(base, '.gsd', 'state-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'state-manifest.json should exist after handler completes');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('post-mutation-hook: manifest has version 1 and includes completed task', async () => {
  const base = tempDir();
  const dbPath = path.join(base, 'test.db');
  openDatabase(dbPath);
  createProject(base);

  try {
    await handleCompleteTask(makeCompleteTaskParams(), base);

    const manifest = readManifest(base);
    assert.ok(manifest !== null, 'manifest should be readable');
    assert.strictEqual(manifest!.version, 1);

    const task = manifest!.tasks.find((t) => t.id === 'T01');
    assert.ok(task !== undefined, 'T01 should appear in manifest');
    assert.strictEqual(task!.status, 'complete');
    assert.strictEqual(task!.milestone_id, 'M001');
    assert.strictEqual(task!.slice_id, 'S01');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── Post-mutation hook: non-fatal on hook failure ───────────────────────

test('post-mutation-hook: handler still returns success even if projections dir is missing', async () => {
  // basePath with NO .gsd directory — projections will fail to find milestones
  // but handler should still return a result (not throw)
  const base = tempDir();
  const dbPath = path.join(base, 'test.db');
  openDatabase(dbPath);

  // Create tasks dir but NO plan file (projections will soft-fail)
  const tasksDir = path.join(base, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  try {
    const result = await handleCompleteTask(makeCompleteTaskParams(), base);
    // Handler should succeed (post-hook failures are non-fatal)
    assert.ok(!('error' in result), `handler should not propagate hook errors, got: ${JSON.stringify(result)}`);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});
