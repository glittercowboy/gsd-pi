import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// gsd-tools — Structured LLM tool tests
//
// Tests the three registered tools: gsd_decision_save, gsd_requirement_update, gsd_summary_save.
// Each tool is tested via direct function invocation against an in-memory DB.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  isDbAvailable,
  upsertRequirement,
  getRequirementById,
  getDecisionById,
  _getAdapter,
  insertArtifact,
} from '../gsd-db.ts';
import {
  saveDecisionToDb,
  updateRequirementInDb,
  saveRequirementToDb,
  saveArtifactToDb,
  nextDecisionId,
  nextRequirementId,
} from '../db-writer.ts';
import type { Requirement } from '../types.ts';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tools-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

/**
 * Simulate tool execute by calling the underlying DB functions directly.
 * The actual tool registration happens in index.ts; here we test the
 * execute logic pattern: check DB -> call writer -> return result.
 */

describe('gsd-tools', () => {
  test('gsd_decision_save', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);
      assert.ok(isDbAvailable(), 'DB should be available after open');

      // (a) Decision tool creates DB row + returns new ID
      const result = await saveDecisionToDb(
        {
          scope: 'architecture',
          decision: 'Use SQLite for metadata',
          choice: 'SQLite',
          rationale: 'Sync API fits the CLI model',
          revisable: 'Yes',
          when_context: 'M001',
        },
        tmpDir,
      );

      assert.deepStrictEqual(result.id, 'D001', 'First decision should be D001');

      // Verify DB row exists
      const row = getDecisionById('D001');
      assert.ok(row !== null, 'Decision D001 should exist in DB');
      assert.deepStrictEqual(row!.scope, 'architecture', 'Decision scope should match');
      assert.deepStrictEqual(row!.decision, 'Use SQLite for metadata', 'Decision text should match');
      assert.deepStrictEqual(row!.choice, 'SQLite', 'Decision choice should match');

      // Verify DECISIONS.md was generated
      const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
      assert.ok(fs.existsSync(mdPath), 'DECISIONS.md should be created');
      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(mdContent.includes('D001'), 'DECISIONS.md should contain D001');
      assert.ok(mdContent.includes('SQLite'), 'DECISIONS.md should contain choice');

      // (e) Decision tool auto-assigns correct next ID
      const result2 = await saveDecisionToDb(
        {
          scope: 'testing',
          decision: 'Test runner',
          choice: 'vitest',
          rationale: 'Fast and ESM-native',
        },
        tmpDir,
      );
      assert.deepStrictEqual(result2.id, 'D002', 'Second decision should be D002');

      const result3 = await saveDecisionToDb(
        {
          scope: 'CI',
          decision: 'CI platform',
          choice: 'GitHub Actions',
          rationale: 'Integrated with repo',
        },
        tmpDir,
      );
      assert.deepStrictEqual(result3.id, 'D003', 'Third decision should be D003');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('gsd_requirement_update', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // Seed a requirement
      const seedReq: Requirement = {
        id: 'R001',
        class: 'functional',
        status: 'active',
        description: 'Must support SQLite storage',
        why: 'Structured data needs',
        source: 'design',
        primary_owner: 'S03',
        supporting_slices: '',
        validation: '',
        notes: '',
        full_content: '',
        superseded_by: null,
      };
      upsertRequirement(seedReq);

      // (b) Requirement update tool modifies existing requirement
      await updateRequirementInDb(
        'R001',
        { status: 'validated', validation: 'Unit tests pass', notes: 'Verified in S06' },
        tmpDir,
      );

      const updated = getRequirementById('R001');
      assert.ok(updated !== null, 'R001 should still exist');
      assert.deepStrictEqual(updated!.status, 'validated', 'Status should be updated');
      assert.deepStrictEqual(updated!.validation, 'Unit tests pass', 'Validation should be updated');
      assert.deepStrictEqual(updated!.notes, 'Verified in S06', 'Notes should be updated');
      // Original fields preserved
      assert.deepStrictEqual(updated!.description, 'Must support SQLite storage', 'Description should be preserved');
      assert.deepStrictEqual(updated!.primary_owner, 'S03', 'Primary owner should be preserved');

      // Verify REQUIREMENTS.md was generated
      const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
      assert.ok(fs.existsSync(mdPath), 'REQUIREMENTS.md should be created');
      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(mdContent.includes('R001'), 'REQUIREMENTS.md should contain R001');
      assert.ok(mdContent.includes('validated'), 'REQUIREMENTS.md should reflect updated status');

      // Updating non-existent requirement upserts (creates it) — see #2919
      await updateRequirementInDb('R999', { status: 'deferred' }, tmpDir);
      const upserted = getRequirementById('R999');
      assert.ok(upserted !== null, 'R999 should be created by upsert');
      assert.deepStrictEqual(upserted!.status, 'deferred', 'Upserted requirement should have the updated status');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('gsd_summary_save', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // (c) Summary tool creates artifact row
      await saveArtifactToDb(
        {
          path: 'milestones/M001/slices/S01/S01-SUMMARY.md',
          artifact_type: 'SUMMARY',
          content: '# S01 Summary\n\nThis is a test summary.',
          milestone_id: 'M001',
          slice_id: 'S01',
        },
        tmpDir,
      );

      // Verify artifact in DB
      const adapter = _getAdapter();
      assert.ok(adapter !== null, 'Adapter should be available');
      const rows = adapter!.prepare(
        "SELECT * FROM artifacts WHERE path = 'milestones/M001/slices/S01/S01-SUMMARY.md'",
      ).all();
      assert.deepStrictEqual(rows.length, 1, 'Should have 1 artifact row');
      assert.deepStrictEqual(rows[0]['artifact_type'] as string, 'SUMMARY', 'Artifact type should be SUMMARY');
      assert.deepStrictEqual(rows[0]['milestone_id'] as string, 'M001', 'Milestone ID should match');
      assert.deepStrictEqual(rows[0]['slice_id'] as string, 'S01', 'Slice ID should match');

      // Verify file was written to disk
      const filePath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-SUMMARY.md');
      assert.ok(fs.existsSync(filePath), 'Summary file should be written to disk');
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      assert.ok(fileContent.includes('S01 Summary'), 'File should contain summary content');

      // Test milestone-level artifact (no slice_id)
      await saveArtifactToDb(
        {
          path: 'milestones/M001/M001-CONTEXT.md',
          artifact_type: 'CONTEXT',
          content: '# M001 Context\n\nContext notes.',
          milestone_id: 'M001',
        },
        tmpDir,
      );

      const mFilePath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-CONTEXT.md');
      assert.ok(fs.existsSync(mFilePath), 'Milestone-level artifact file should be created');

      // Test task-level artifact
      await saveArtifactToDb(
        {
          path: 'milestones/M001/slices/S01/tasks/T01-SUMMARY.md',
          artifact_type: 'SUMMARY',
          content: '# T01 Summary\n\nTask summary.',
          milestone_id: 'M001',
          slice_id: 'S01',
          task_id: 'T01',
        },
        tmpDir,
      );

      const tFilePath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01-SUMMARY.md');
      assert.ok(fs.existsSync(tFilePath), 'Task-level artifact file should be created');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('DB unavailable error paths', async () => {
    // (d) All tools return isError when DB unavailable
    // Close any open DB and don't open a new one
    try { closeDatabase(); } catch { /* already closed */ }

    // isDbAvailable() should return false
    assert.ok(!isDbAvailable(), 'DB should be unavailable after close');

    // nextDecisionId degrades gracefully
    const fallbackId = await nextDecisionId();
    assert.deepStrictEqual(fallbackId, 'D001', 'nextDecisionId should return D001 when DB unavailable');
  });

  test('gsd_requirement_save creates new requirement', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // (a) saveRequirementToDb creates a new requirement with auto-assigned ID
      const result = await saveRequirementToDb(
        {
          class: 'functional',
          status: 'active',
          description: 'Must support dark mode',
          why: 'Accessibility requirement',
          source: 'user-research',
        },
        tmpDir,
      );

      assert.deepStrictEqual(result.id, 'R001', 'First requirement should be R001');

      // Verify DB row exists
      const row = getRequirementById('R001');
      assert.ok(row !== null, 'Requirement R001 should exist in DB');
      assert.deepStrictEqual(row!.class, 'functional', 'Class should match');
      assert.deepStrictEqual(row!.description, 'Must support dark mode', 'Description should match');
      assert.deepStrictEqual(row!.status, 'active', 'Status should match');

      // Verify REQUIREMENTS.md was generated
      const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
      assert.ok(fs.existsSync(mdPath), 'REQUIREMENTS.md should be created');
      const mdContent = fs.readFileSync(mdPath, 'utf-8');
      assert.ok(mdContent.includes('R001'), 'REQUIREMENTS.md should contain R001');
      assert.ok(mdContent.includes('dark mode'), 'REQUIREMENTS.md should contain description');

      // (b) Auto-assigns correct next ID
      const result2 = await saveRequirementToDb(
        {
          class: 'non-functional',
          status: 'active',
          description: 'Must load in under 2 seconds',
          why: 'Performance SLA',
          source: 'design',
        },
        tmpDir,
      );
      assert.deepStrictEqual(result2.id, 'R002', 'Second requirement should be R002');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('nextRequirementId computes correct next ID', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // No requirements yet
      const id1 = await nextRequirementId();
      assert.deepStrictEqual(id1, 'R001', 'Should return R001 when no requirements exist');

      // Add one requirement
      upsertRequirement({
        id: 'R001',
        class: 'functional',
        status: 'active',
        description: 'Test',
        why: '',
        source: '',
        primary_owner: '',
        supporting_slices: '',
        validation: '',
        notes: '',
        full_content: '',
        superseded_by: null,
      });

      const id2 = await nextRequirementId();
      assert.deepStrictEqual(id2, 'R002', 'Should return R002 after R001 exists');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('gsd_requirement_update upserts when requirement not in DB', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // Requirement R025 does NOT exist in DB — simulates the bug scenario
      // where requirements exist in REQUIREMENTS.md but were never imported.
      // updateRequirementInDb should create the row instead of throwing.
      await updateRequirementInDb(
        'R025',
        { status: 'validated', validation: 'Integration tests pass' },
        tmpDir,
      );

      const created = getRequirementById('R025');
      assert.ok(created !== null, 'R025 should be created by upsert');
      assert.deepStrictEqual(created!.status, 'validated', 'Status should be set');
      assert.deepStrictEqual(created!.validation, 'Integration tests pass', 'Validation should be set');

      // Verify REQUIREMENTS.md was generated
      const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
      assert.ok(fs.existsSync(mdPath), 'REQUIREMENTS.md should be created');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('Tool result format', async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
      openDatabase(dbPath);

      // Verify result follows AgentToolResult interface: {content: [{type: "text", text}], details}
      const result = await saveDecisionToDb(
        {
          scope: 'format-test',
          decision: 'Test format',
          choice: 'TypeBox',
          rationale: 'Schema validation',
        },
        tmpDir,
      );

      // The saveDecisionToDb returns {id} - the tool wrapping adds the AgentToolResult shape.
      // Verify the raw function returns the expected shape.
      assert.ok(typeof result.id === 'string', 'saveDecisionToDb should return {id: string}');
      assert.match(result.id, /^D\d{3}$/, 'ID should match DXXX pattern');

      closeDatabase();
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
