// gsd-tools — Structured LLM tool tests
//
// Tests the three registered tools: gsd_save_decision, gsd_update_requirement, gsd_save_summary.
// Each tool is tested via direct function invocation against an in-memory DB.

import { createTestContext } from './test-helpers.ts';
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
  saveArtifactToDb,
  nextDecisionId,
} from '../db-writer.ts';
import type { Requirement } from '../types.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

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
 * execute logic pattern: check DB → call writer → return result.
 */

// ═══════════════════════════════════════════════════════════════════════════
// gsd_save_decision tool tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── gsd_save_decision ──');

{
  const tmpDir = makeTmpDir();
  try {
    const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
    openDatabase(dbPath);
    assertTrue(isDbAvailable(), 'DB should be available after open');

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

    assertEq(result.id, 'D001', 'First decision should be D001');

    // Verify DB row exists
    const row = getDecisionById('D001');
    assertTrue(row !== null, 'Decision D001 should exist in DB');
    assertEq(row!.scope, 'architecture', 'Decision scope should match');
    assertEq(row!.decision, 'Use SQLite for metadata', 'Decision text should match');
    assertEq(row!.choice, 'SQLite', 'Decision choice should match');

    // Verify DECISIONS.md was generated
    const mdPath = path.join(tmpDir, '.gsd', 'DECISIONS.md');
    assertTrue(fs.existsSync(mdPath), 'DECISIONS.md should be created');
    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    assertTrue(mdContent.includes('D001'), 'DECISIONS.md should contain D001');
    assertTrue(mdContent.includes('SQLite'), 'DECISIONS.md should contain choice');

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
    assertEq(result2.id, 'D002', 'Second decision should be D002');

    const result3 = await saveDecisionToDb(
      {
        scope: 'CI',
        decision: 'CI platform',
        choice: 'GitHub Actions',
        rationale: 'Integrated with repo',
      },
      tmpDir,
    );
    assertEq(result3.id, 'D003', 'Third decision should be D003');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// gsd_update_requirement tool tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── gsd_update_requirement ──');

{
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
    assertTrue(updated !== null, 'R001 should still exist');
    assertEq(updated!.status, 'validated', 'Status should be updated');
    assertEq(updated!.validation, 'Unit tests pass', 'Validation should be updated');
    assertEq(updated!.notes, 'Verified in S06', 'Notes should be updated');
    // Original fields preserved
    assertEq(updated!.description, 'Must support SQLite storage', 'Description should be preserved');
    assertEq(updated!.primary_owner, 'S03', 'Primary owner should be preserved');

    // Verify REQUIREMENTS.md was generated
    const mdPath = path.join(tmpDir, '.gsd', 'REQUIREMENTS.md');
    assertTrue(fs.existsSync(mdPath), 'REQUIREMENTS.md should be created');
    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    assertTrue(mdContent.includes('R001'), 'REQUIREMENTS.md should contain R001');
    assertTrue(mdContent.includes('validated'), 'REQUIREMENTS.md should reflect updated status');

    // Updating non-existent requirement throws
    let threwForMissing = false;
    try {
      await updateRequirementInDb('R999', { status: 'deferred' }, tmpDir);
    } catch (err) {
      threwForMissing = true;
      assertTrue(
        (err as Error).message.includes('R999'),
        'Error should mention the missing requirement ID',
      );
    }
    assertTrue(threwForMissing, 'Should throw for non-existent requirement');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// gsd_save_summary tool tests
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── gsd_save_summary ──');

{
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
    assertTrue(adapter !== null, 'Adapter should be available');
    const rows = adapter!.prepare(
      "SELECT * FROM artifacts WHERE path = 'milestones/M001/slices/S01/S01-SUMMARY.md'",
    ).all();
    assertEq(rows.length, 1, 'Should have 1 artifact row');
    assertEq(rows[0]['artifact_type'] as string, 'SUMMARY', 'Artifact type should be SUMMARY');
    assertEq(rows[0]['milestone_id'] as string, 'M001', 'Milestone ID should match');
    assertEq(rows[0]['slice_id'] as string, 'S01', 'Slice ID should match');

    // Verify file was written to disk
    const filePath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-SUMMARY.md');
    assertTrue(fs.existsSync(filePath), 'Summary file should be written to disk');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    assertTrue(fileContent.includes('S01 Summary'), 'File should contain summary content');

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
    assertTrue(fs.existsSync(mFilePath), 'Milestone-level artifact file should be created');

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
    assertTrue(fs.existsSync(tFilePath), 'Task-level artifact file should be created');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DB unavailable error paths
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── DB unavailable error paths ──');

{
  // (d) All tools return isError when DB unavailable
  // Close any open DB and don't open a new one
  try { closeDatabase(); } catch { /* already closed */ }

  // isDbAvailable() should return false
  assertTrue(!isDbAvailable(), 'DB should be unavailable after close');

  // nextDecisionId degrades gracefully
  const fallbackId = await nextDecisionId();
  assertEq(fallbackId, 'D001', 'nextDecisionId should return D001 when DB unavailable');
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool result format verification
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Tool result format ──');

{
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

    // The saveDecisionToDb returns {id} — the tool wrapping adds the AgentToolResult shape.
    // Verify the raw function returns the expected shape.
    assertTrue(typeof result.id === 'string', 'saveDecisionToDb should return {id: string}');
    assertMatch(result.id, /^D\d{3}$/, 'ID should match DXXX pattern');

    closeDatabase();
  } finally {
    cleanupDir(tmpDir);
  }
}

// ═══════════════════════════════════════════════════════════════════════════

report();
