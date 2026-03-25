// auto-prompts-db: Tests for the DB-aware inline helpers exported from auto-prompts.ts
//
// Exercises:
//   inlineDecisionsFromDb(base, milestoneId?)
//   inlineRequirementsFromDb(base, sliceId?)
//   inlineProjectFromDb(base)
//
// Each function: (a) returns content from the DB when open + populated,
//                (b) returns null/fallback when DB empty,
//                (c) falls back to filesystem when DB is closed.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  inlineDecisionsFromDb,
  inlineRequirementsFromDb,
  inlineProjectFromDb,
} from '../auto-prompts.ts';
import {
  openDatabase,
  closeDatabase,
  insertDecision,
  insertRequirement,
  insertArtifact,
  isDbAvailable,
} from '../gsd-db.ts';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-apdb-'));
  mkdirSync(join(base, '.gsd'), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

function seedDecision(id: string, milestoneId = 'M001'): void {
  insertDecision({
    id,
    when_context: `${milestoneId}/S01`,
    scope: 'architecture',
    decision: `decision text for ${id}`,
    choice: `choice for ${id}`,
    rationale: `rationale for ${id}`,
    revisable: 'yes',
    made_by: 'agent',
    superseded_by: null,
  });
}

function seedRequirement(id: string, primaryOwner = 'S01'): void {
  insertRequirement({
    id,
    class: 'functional',
    status: 'active',
    description: `description for ${id}`,
    why: 'needed',
    source: 'M001',
    primary_owner: primaryOwner,
    supporting_slices: '',
    validation: 'test',
    notes: '',
    full_content: '',
    superseded_by: null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// inlineDecisionsFromDb
// ═══════════════════════════════════════════════════════════════════════════

describe('inlineDecisionsFromDb', () => {
  describe('DB closed — falls back to filesystem', () => {
    let base: string;

    before(() => {
      closeDatabase();
      base = makeTmpBase();
    });

    after(() => {
      cleanup(base);
    });

    test('returns null when no decisions.md on filesystem', async () => {
      assert.ok(!isDbAvailable(), 'pre: DB must be closed');
      const result = await inlineDecisionsFromDb(base);
      assert.strictEqual(result, null, 'should return null when DB closed and no file');
    });

    test('returns filesystem content when decisions.md exists', async () => {
      writeFileSync(join(base, '.gsd', 'DECISIONS.md'), '# Decisions\n\nD001 | some decision\n');
      const result = await inlineDecisionsFromDb(base);
      assert.ok(result !== null, 'should return content from filesystem');
      assert.match(result!, /D001/, 'content should include decision text from file');
    });
  });

  describe('DB open, no decisions — returns null (falls back)', () => {
    let base: string;

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns null when DB empty and no filesystem file', async () => {
      assert.ok(isDbAvailable(), 'pre: DB must be open');
      const result = await inlineDecisionsFromDb(base);
      // DB has no decisions → falls through to filesystem, no file → null
      assert.strictEqual(result, null, 'should return null when DB empty and no file');
    });
  });

  describe('DB open, decisions exist — returns formatted content', () => {
    let base: string;

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
      seedDecision('D001', 'M001');
      seedDecision('D002', 'M001');
      seedDecision('D003', 'M002');
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns string with ### Decisions header', async () => {
      const result = await inlineDecisionsFromDb(base);
      assert.ok(result !== null, 'should return content when decisions exist');
      assert.match(result!, /^### Decisions/, 'result starts with ### Decisions');
    });

    test('result contains source path reference', async () => {
      const result = await inlineDecisionsFromDb(base);
      assert.match(result!, /DECISIONS\.md/, 'result references DECISIONS.md');
    });

    test('result contains decision text', async () => {
      const result = await inlineDecisionsFromDb(base);
      assert.match(result!, /D001/, 'result includes decision D001 content');
    });

    test('milestone scoping filters to relevant decisions', async () => {
      const all = await inlineDecisionsFromDb(base);
      const scoped = await inlineDecisionsFromDb(base, 'M001');
      assert.ok(all !== null, 'unscoped: should have content');
      assert.ok(scoped !== null, 'scoped: should have content');
      // M001 has 2 decisions, M002 has 1 — scoped output should be shorter
      assert.ok(
        scoped!.length < all!.length,
        `M001-scoped (${scoped!.length}) should be shorter than unscoped (${all!.length})`,
      );
    });

    test('scoped result does not contain decisions from other milestones', async () => {
      const scoped = await inlineDecisionsFromDb(base, 'M001');
      // D003 is in M002/S01 — its when_context won't appear scoped to M001
      assert.doesNotMatch(scoped!, /M002/, 'M001-scoped result should not reference M002');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inlineRequirementsFromDb
// ═══════════════════════════════════════════════════════════════════════════

describe('inlineRequirementsFromDb', () => {
  describe('DB closed — falls back to filesystem', () => {
    let base: string;

    before(() => {
      closeDatabase();
      base = makeTmpBase();
    });

    after(() => {
      cleanup(base);
    });

    test('returns null when no requirements.md on filesystem', async () => {
      assert.ok(!isDbAvailable(), 'pre: DB must be closed');
      const result = await inlineRequirementsFromDb(base);
      assert.strictEqual(result, null, 'should return null when DB closed and no file');
    });

    test('returns filesystem content when requirements.md exists', async () => {
      writeFileSync(join(base, '.gsd', 'REQUIREMENTS.md'), '# Requirements\n\nR001 | must do X\n');
      const result = await inlineRequirementsFromDb(base);
      assert.ok(result !== null, 'should return content from filesystem');
      assert.match(result!, /R001/, 'content should include requirement text from file');
    });
  });

  describe('DB open, no requirements — returns null (falls back)', () => {
    let base: string;

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns null when DB empty and no filesystem file', async () => {
      assert.ok(isDbAvailable(), 'pre: DB must be open');
      const result = await inlineRequirementsFromDb(base);
      assert.strictEqual(result, null, 'should return null when DB empty and no file');
    });
  });

  describe('DB open, requirements exist — returns formatted content', () => {
    let base: string;

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
      seedRequirement('R001', 'S01');
      seedRequirement('R002', 'S01');
      seedRequirement('R003', 'S02');
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns string with ### Requirements header', async () => {
      const result = await inlineRequirementsFromDb(base);
      assert.ok(result !== null, 'should return content when requirements exist');
      assert.match(result!, /^### Requirements/, 'result starts with ### Requirements');
    });

    test('result contains source path reference', async () => {
      const result = await inlineRequirementsFromDb(base);
      assert.match(result!, /REQUIREMENTS\.md/, 'result references REQUIREMENTS.md');
    });

    test('result contains requirement text', async () => {
      const result = await inlineRequirementsFromDb(base);
      assert.match(result!, /R001/, 'result includes requirement R001 content');
    });

    test('slice scoping filters to relevant requirements', async () => {
      const all = await inlineRequirementsFromDb(base);
      const scoped = await inlineRequirementsFromDb(base, 'S01');
      assert.ok(all !== null, 'unscoped: should have content');
      assert.ok(scoped !== null, 'scoped: should have content');
      // S01 owns R001/R002, S02 owns R003 — scoped should be shorter
      assert.ok(
        scoped!.length < all!.length,
        `S01-scoped (${scoped!.length}) should be shorter than unscoped (${all!.length})`,
      );
    });

    test('scoped result excludes requirements from other slices', async () => {
      const scoped = await inlineRequirementsFromDb(base, 'S01');
      assert.doesNotMatch(scoped!, /R003/, 'S01-scoped result should not include R003 (owned by S02)');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inlineProjectFromDb
// ═══════════════════════════════════════════════════════════════════════════

describe('inlineProjectFromDb', () => {
  describe('DB closed — falls back to filesystem', () => {
    let base: string;

    before(() => {
      closeDatabase();
      base = makeTmpBase();
    });

    after(() => {
      cleanup(base);
    });

    test('returns null when no project.md on filesystem', async () => {
      assert.ok(!isDbAvailable(), 'pre: DB must be closed');
      const result = await inlineProjectFromDb(base);
      assert.strictEqual(result, null, 'should return null when DB closed and no file');
    });

    test('returns filesystem content when project.md exists', async () => {
      writeFileSync(join(base, '.gsd', 'PROJECT.md'), '# My Project\n\nA test project.\n');
      const result = await inlineProjectFromDb(base);
      assert.ok(result !== null, 'should return content from filesystem');
      assert.match(result!, /My Project/, 'content should include project text from file');
    });
  });

  describe('DB open, no project artifact — returns null (falls back)', () => {
    let base: string;

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns null when DB empty and no filesystem file', async () => {
      assert.ok(isDbAvailable(), 'pre: DB must be open');
      const result = await inlineProjectFromDb(base);
      assert.strictEqual(result, null, 'should return null when DB has no project and no file');
    });
  });

  describe('DB open, project artifact exists — returns formatted content', () => {
    let base: string;
    const projectContent = '# Acme Service\n\nCore payments platform.';

    before(() => {
      base = makeTmpBase();
      openDatabase(':memory:');
      insertArtifact({
        path: 'PROJECT.md',
        artifact_type: 'project',
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: projectContent,
      });
    });

    after(() => {
      closeDatabase();
      cleanup(base);
    });

    test('returns string with ### Project header', async () => {
      const result = await inlineProjectFromDb(base);
      assert.ok(result !== null, 'should return content when project artifact exists');
      assert.match(result!, /^### Project/, 'result starts with ### Project');
    });

    test('result contains source path reference', async () => {
      const result = await inlineProjectFromDb(base);
      assert.match(result!, /PROJECT\.md/, 'result references PROJECT.md');
    });

    test('result contains project content', async () => {
      const result = await inlineProjectFromDb(base);
      assert.match(result!, /Acme Service/, 'result includes project title');
      assert.match(result!, /payments platform/, 'result includes project description');
    });
  });
});
