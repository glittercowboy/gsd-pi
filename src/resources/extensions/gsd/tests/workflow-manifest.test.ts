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
