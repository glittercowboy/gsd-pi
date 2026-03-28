// GSD Extension — workflow-manifest unit tests
// Tests writeManifest, readManifest, snapshotState, bootstrapFromManifest.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  _getAdapter,
} from '../gsd-db.ts';
import {
  writeManifest,
  readManifest,
  snapshotState,
  bootstrapFromManifest,
} from '../workflow-manifest.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-manifest-'));
}

function tempDbPath(base: string): string {
  return path.join(base, 'test.db');
}

function cleanupDir(dirPath: string): void {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ─── readManifest: no file ────────────────────────────────────────────────

test('workflow-manifest: readManifest returns null when file does not exist', () => {
  const base = tempDir();
  try {
    const result = readManifest(base);
    assert.strictEqual(result, null);
  } finally {
    cleanupDir(base);
  }
});

// ─── writeManifest + readManifest round-trip ─────────────────────────────

test('workflow-manifest: writeManifest creates state-manifest.json with version 1', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    writeManifest(base);
    const manifestPath = path.join(base, '.gsd', 'state-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'state-manifest.json should exist');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.strictEqual(raw.version, 1);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: readManifest parses manifest written by writeManifest', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    writeManifest(base);
    const manifest = readManifest(base);
    assert.ok(manifest !== null);
    assert.strictEqual(manifest!.version, 1);
    assert.ok(typeof manifest!.exported_at === 'string');
    assert.ok(Array.isArray(manifest!.milestones));
    assert.ok(Array.isArray(manifest!.slices));
    assert.ok(Array.isArray(manifest!.tasks));
    assert.ok(Array.isArray(manifest!.decisions));
    assert.ok(Array.isArray(manifest!.verification_evidence));
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── snapshotState: captures DB rows ─────────────────────────────────────

test('workflow-manifest: snapshotState includes inserted milestone', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001', title: 'Auth Milestone' });
    const snap = snapshotState();
    assert.strictEqual(snap.version, 1);
    const m = snap.milestones.find((r) => r.id === 'M001');
    assert.ok(m !== undefined, 'M001 should appear in snapshot');
    assert.strictEqual(m!.title, 'Auth Milestone');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState captures tasks', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Do thing', status: 'complete' });
    const snap = snapshotState();
    const t = snap.tasks.find((r) => r.id === 'T01');
    assert.ok(t !== undefined, 'T01 should appear in snapshot');
    assert.strictEqual(t!.status, 'complete');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── bootstrapFromManifest ────────────────────────────────────────────────

test('workflow-manifest: bootstrapFromManifest returns false when no manifest file', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    const result = bootstrapFromManifest(base);
    assert.strictEqual(result, false);
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: bootstrapFromManifest restores DB from manifest (round-trip)', () => {
  const base = tempDir();
  openDatabase(tempDbPath(base));
  try {
    // Insert data and write manifest
    insertMilestone({ id: 'M001', title: 'Restored Milestone' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Restored Slice' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Restored Task', status: 'complete' });
    writeManifest(base);
    closeDatabase();

    // Open a fresh DB and bootstrap from manifest
    const newDbPath = path.join(base, 'new.db');
    openDatabase(newDbPath);
    const result = bootstrapFromManifest(base);
    assert.strictEqual(result, true, 'bootstrapFromManifest should return true');

    // Verify restored state
    const snap = snapshotState();
    const m = snap.milestones.find((r) => r.id === 'M001');
    assert.ok(m !== undefined, 'M001 should be restored');
    assert.strictEqual(m!.title, 'Restored Milestone');

    const s = snap.slices.find((r) => r.id === 'S01');
    assert.ok(s !== undefined, 'S01 should be restored');

    const t = snap.tasks.find((r) => r.id === 'T01');
    assert.ok(t !== undefined, 'T01 should be restored');
    assert.strictEqual(t!.status, 'complete');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

// ─── readManifest: version check ─────────────────────────────────────────

test('workflow-manifest: readManifest throws on unsupported version', () => {
  const base = tempDir();
  try {
    fs.mkdirSync(path.join(base, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(base, '.gsd', 'state-manifest.json'),
      JSON.stringify({ version: 99, exported_at: '', milestones: [], slices: [], tasks: [], decisions: [], verification_evidence: [] }),
    );
    assert.throws(
      () => readManifest(base),
      /Unsupported manifest version/,
      'should throw on version mismatch',
    );
  } finally {
    cleanupDir(base);
  }
});

// ─── toIntOrNull: string numerics in SQLite columns ───────────────────────
//
// SQLite has dynamic typing. If the LLM passes a string for a numeric column
// (e.g. "-" as a markdown-table placeholder for durationMs), SQLite stores it
// as TEXT. snapshotState() must coerce these back to number|null before
// serializing, so JSON.stringify doesn't emit bare "-" which then breaks
// JSON.parse with "No number after minus sign in JSON at position N".

test('workflow-manifest: snapshotState coerces string "-" in duration_ms to null (prevents JSON parse error)', () => {
  const base = tempDir();
  openDatabase(path.join(base, 'test.db'));
  try {
    // Set up valid FK chain: milestone → slice → task
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Do thing', status: 'complete' });

    // Insert a well-formed evidence row, then corrupt duration_ms to the string
    // "-" via raw SQL — this simulates the LLM passing a markdown placeholder.
    insertVerificationEvidence({
      taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
      command: 'npm test', exitCode: 0, verdict: '✅ pass', durationMs: 4352,
    });
    const db = _getAdapter()!;
    db.prepare("UPDATE verification_evidence SET duration_ms = '-' WHERE task_id = 'T01'").run();

    // snapshotState must NOT throw and duration_ms must come back as null
    let snap: ReturnType<typeof snapshotState>;
    assert.doesNotThrow(() => { snap = snapshotState(); }, 'snapshotState must not throw on string "-"');
    const ev = snap!.verification_evidence[0];
    assert.ok(ev !== undefined, 'evidence row should be present');
    assert.strictEqual(ev.duration_ms, null, 'duration_ms "-" must coerce to null');

    // writeManifest must not produce invalid JSON (the original crash path)
    assert.doesNotThrow(() => writeManifest(base), 'writeManifest must not throw');
    const raw = fs.readFileSync(path.join(base, '.gsd', 'state-manifest.json'), 'utf-8');
    // This was the original failure: "No number after minus sign in JSON at position N"
    assert.doesNotThrow(() => JSON.parse(raw), 'manifest JSON must be parseable after fix');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.verification_evidence[0].duration_ms, null,
      'serialized duration_ms must be null, not the string "-"');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState coerces numeric-string exit_code and duration_ms to numbers', () => {
  const base = tempDir();
  openDatabase(path.join(base, 'test.db'));
  try {
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Do thing', status: 'complete' });
    insertVerificationEvidence({
      taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
      command: 'npm test', exitCode: 0, verdict: '✅ pass', durationMs: 0,
    });

    // Corrupt both numeric columns to their string representations
    const db = _getAdapter()!;
    db.prepare("UPDATE verification_evidence SET exit_code = '0', duration_ms = '4352' WHERE task_id = 'T01'").run();

    const snap = snapshotState();
    const ev = snap.verification_evidence[0];
    assert.ok(ev !== undefined);
    assert.strictEqual(ev.exit_code, 0, 'string "0" exit_code must coerce to number 0');
    assert.strictEqual(ev.duration_ms, 4352, 'string "4352" duration_ms must coerce to number 4352');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});

test('workflow-manifest: snapshotState coerces empty string duration_ms to null', () => {
  const base = tempDir();
  openDatabase(path.join(base, 'test.db'));
  try {
    insertMilestone({ id: 'M001' });
    insertSlice({ id: 'S01', milestoneId: 'M001' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Do thing', status: 'complete' });
    insertVerificationEvidence({
      taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
      command: 'npm test', exitCode: 0, verdict: '✅ pass', durationMs: 0,
    });

    const db = _getAdapter()!;
    db.prepare("UPDATE verification_evidence SET duration_ms = '' WHERE task_id = 'T01'").run();

    const snap = snapshotState();
    const ev = snap.verification_evidence[0];
    assert.ok(ev !== undefined);
    assert.strictEqual(ev.duration_ms, null, 'empty string duration_ms must coerce to null');
  } finally {
    closeDatabase();
    cleanupDir(base);
  }
});
