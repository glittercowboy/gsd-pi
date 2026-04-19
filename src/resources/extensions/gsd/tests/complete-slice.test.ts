import { createTestContext } from './test-helpers.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openDatabase,
  closeDatabase,
  transaction,
  _getAdapter,
  insertMilestone,
  insertSlice,
  insertTask,
  getSlice,
  updateSliceStatus,
  getSliceTasks,
} from '../gsd-db.ts';
import { handleCompleteSlice } from '../tools/complete-slice.ts';
import type { CompleteSliceParams } from '../types.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-complete-slice-'));
  return path.join(dir, 'test.db');
}

function cleanup(dbPath: string): void {
  closeDatabase();
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch {
    // best effort
  }
}

function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Create a temp project directory with .gsd structure and roadmap for handler tests.
 */
function createTempProject(): { basePath: string; roadmapPath: string } {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-slice-handler-'));
  const sliceDir = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01');
  const tasksDir = path.join(sliceDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const roadmapPath = path.join(basePath, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
  fs.writeFileSync(roadmapPath, `# M001: Test Milestone

## Slices

- [ ] **S01: Test Slice** \`risk:medium\` \`depends:[]\`
  - After this: basic functionality works

- [ ] **S02: Second Slice** \`risk:low\` \`depends:[S01]\`
  - After this: advanced stuff
`);

  return { basePath, roadmapPath };
}

function makeValidSliceParams(): CompleteSliceParams {
  return {
    sliceId: 'S01',
    milestoneId: 'M001',
    sliceTitle: 'Test Slice',
    oneLiner: 'Implemented test slice with full coverage',
    narrative: 'Built the handler, registered the tool, and wrote comprehensive tests.',
    verification: 'All 8 test sections pass with 0 failures.',
    deviations: 'None.',
    knownLimitations: 'None.',
    followUps: 'None.',
    keyFiles: ['src/tools/complete-slice.ts', 'src/bootstrap/db-tools.ts'],
    keyDecisions: ['D001'],
    patternsEstablished: ['SliceRow/rowToSlice follows same pattern as TaskRow/rowToTask'],
    observabilitySurfaces: ['SELECT status FROM slices shows completion state'],
    provides: ['complete_slice handler', 'gsd_slice_complete tool'],
    requirementsSurfaced: [],
    drillDownPaths: ['milestones/M001/slices/S01/tasks/T01-SUMMARY.md'],
    affects: ['S02'],
    requirementsAdvanced: [{ id: 'R001', how: 'Handler validates task completion' }],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [
      { path: 'src/tools/complete-slice.ts', description: 'Handler implementation' },
      { path: 'src/bootstrap/db-tools.ts', description: 'Tool registration' },
    ],
    requires: [],
    uatContent: `## Smoke Test

Run the test suite and verify all assertions pass.

## Test Cases

### 1. Handler happy path

1. Insert complete tasks in DB
2. Call handleCompleteSlice()
3. **Expected:** SUMMARY.md + UAT.md written, roadmap checkbox toggled, DB updated`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Schema v6 migration
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: schema v6 migration ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const adapter = _getAdapter()!;

  // Verify schema version is current (v17 with ADR-011 P2 escalation columns)
  const versionRow = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assertEq(versionRow?.['v'], 17, 'schema version should be 17');

  // Verify slices table has full_summary_md and full_uat_md columns
  const cols = adapter.prepare("PRAGMA table_info(slices)").all();
  const colNames = cols.map(c => c['name'] as string);
  assertTrue(colNames.includes('full_summary_md'), 'slices table should have full_summary_md column');
  assertTrue(colNames.includes('full_uat_md'), 'slices table should have full_uat_md column');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: getSlice/updateSliceStatus accessors
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: getSlice/updateSliceStatus accessors ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Insert milestone and slice
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high' });

  // getSlice returns correct row
  const slice = getSlice('M001', 'S01');
  assertTrue(slice !== null, 'getSlice should return non-null for existing slice');
  assertEq(slice!.id, 'S01', 'slice id');
  assertEq(slice!.milestone_id, 'M001', 'slice milestone_id');
  assertEq(slice!.title, 'Test Slice', 'slice title');
  assertEq(slice!.risk, 'high', 'slice risk');
  assertEq(slice!.status, 'pending', 'slice default status should be pending');
  assertEq(slice!.completed_at, null, 'slice completed_at should be null initially');
  assertEq(slice!.full_summary_md, '', 'slice full_summary_md should be empty initially');
  assertEq(slice!.full_uat_md, '', 'slice full_uat_md should be empty initially');

  // getSlice returns null for non-existent
  const noSlice = getSlice('M001', 'S99');
  assertEq(noSlice, null, 'non-existent slice should return null');

  // updateSliceStatus changes status and completed_at
  const now = new Date().toISOString();
  updateSliceStatus('M001', 'S01', 'complete', now);
  const updated = getSlice('M001', 'S01');
  assertEq(updated!.status, 'complete', 'slice status should be updated to complete');
  assertEq(updated!.completed_at, now, 'slice completed_at should be set');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler happy path
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler happy path ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, roadmapPath } = createTempProject();

  // Set up DB state: milestone, slices (S01 + S02), 2 complete tasks
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Second Slice' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Task 1' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Task 2' });

  const params = makeValidSliceParams();
  const result = await handleCompleteSlice(params, basePath);

  assertTrue(!('error' in result), 'handler should succeed without error');
  if (!('error' in result)) {
    assertEq(result.sliceId, 'S01', 'result sliceId');
    assertEq(result.milestoneId, 'M001', 'result milestoneId');
    assertTrue(result.summaryPath.endsWith('S01-SUMMARY.md'), 'summaryPath should end with S01-SUMMARY.md');
    assertTrue(result.uatPath.endsWith('S01-UAT.md'), 'uatPath should end with S01-UAT.md');

    // (a) Verify SUMMARY.md exists on disk with correct YAML frontmatter
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should exist on disk');
    const summaryContent = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summaryContent, /^---\n/, 'summary should start with YAML frontmatter');
    assertMatch(summaryContent, /id: S01/, 'summary should contain id: S01');
    assertMatch(summaryContent, /parent: M001/, 'summary should contain parent: M001');
    assertMatch(summaryContent, /milestone: M001/, 'summary should contain milestone: M001');
    assertMatch(summaryContent, /blocker_discovered: false/, 'summary should contain blocker_discovered');
    assertMatch(summaryContent, /verification_result: passed/, 'summary should contain verification_result');
    assertMatch(summaryContent, /key_files:/, 'summary should contain key_files');
    assertMatch(summaryContent, /patterns_established:/, 'summary should contain patterns_established');
    assertMatch(summaryContent, /observability_surfaces:/, 'summary should contain observability_surfaces');
    assertMatch(summaryContent, /provides:/, 'summary should contain provides');
    assertMatch(summaryContent, /# S01: Test Slice/, 'summary should have H1 with slice ID and title');
    assertMatch(summaryContent, /\*\*Implemented test slice with full coverage\*\*/, 'summary should have one-liner in bold');
    assertMatch(summaryContent, /## What Happened/, 'summary should have What Happened section');
    assertMatch(summaryContent, /## Verification/, 'summary should have Verification section');
    assertMatch(summaryContent, /## Requirements Advanced/, 'summary should have Requirements Advanced section');

    // (b) Verify UAT.md exists on disk
    assertTrue(fs.existsSync(result.uatPath), 'UAT file should exist on disk');
    const uatContent = fs.readFileSync(result.uatPath, 'utf-8');
    assertMatch(uatContent, /# S01: Test Slice — UAT/, 'UAT should have correct title');
    assertMatch(uatContent, /Milestone:\*\* M001/, 'UAT should reference milestone');
    assertMatch(uatContent, /Smoke Test/, 'UAT should contain smoke test from params');

    // (c) Verify roadmap shows S01 complete ([x]) and S02 pending ([ ]) in checkbox list.
    // Authoritative renderer (renderRoadmapFromDb) emits a checkbox list (#4402).
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    assertMatch(roadmapContent, /- \[x\] \*\*S01:/, 'completed S01 should be a checked checkbox list item');
    assertMatch(roadmapContent, /- \[ \] \*\*S02:/, 'pending S02 should be an unchecked checkbox list item');

    // (d) Verify full_summary_md and full_uat_md stored in DB for D004 recovery
    const sliceAfter = getSlice('M001', 'S01');
    assertTrue(sliceAfter !== null, 'slice should exist in DB after handler');
    assertTrue(sliceAfter!.full_summary_md.length > 0, 'full_summary_md should be non-empty in DB');
    assertMatch(sliceAfter!.full_summary_md, /id: S01/, 'full_summary_md should contain frontmatter');
    assertTrue(sliceAfter!.full_uat_md.length > 0, 'full_uat_md should be non-empty in DB');
    assertMatch(sliceAfter!.full_uat_md, /S01: Test Slice — UAT/, 'full_uat_md should contain UAT title');

    // (e) Verify slice status is complete in DB
    assertEq(sliceAfter!.status, 'complete', 'slice status should be complete in DB');
    assertTrue(sliceAfter!.completed_at !== null, 'completed_at should be set in DB');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler rejects incomplete tasks
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler rejects incomplete tasks ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Insert milestone, slice, 2 tasks — one complete, one pending
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Task 1' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'pending', title: 'Task 2' });

  const params = makeValidSliceParams();
  const result = await handleCompleteSlice(params, '/tmp/fake');

  assertTrue('error' in result, 'should return error when tasks are incomplete');
  if ('error' in result) {
    assertMatch(result.error, /incomplete tasks/, 'error should mention incomplete tasks');
    assertMatch(result.error, /T02/, 'error should mention the specific incomplete task ID');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler rejects no tasks
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler rejects no tasks ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Insert milestone and slice but NO tasks
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001' });

  const params = makeValidSliceParams();
  const result = await handleCompleteSlice(params, '/tmp/fake');

  assertTrue('error' in result, 'should return error when no tasks exist');
  if ('error' in result) {
    assertMatch(result.error, /no tasks found/, 'error should say no tasks found');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler validation errors
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler validation errors ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const params = makeValidSliceParams();

  // Empty sliceId
  const r1 = await handleCompleteSlice({ ...params, sliceId: '' }, '/tmp/fake');
  assertTrue('error' in r1, 'should return error for empty sliceId');
  if ('error' in r1) {
    assertMatch(r1.error, /sliceId/, 'error should mention sliceId');
  }

  // Empty milestoneId
  const r2 = await handleCompleteSlice({ ...params, milestoneId: '' }, '/tmp/fake');
  assertTrue('error' in r2, 'should return error for empty milestoneId');
  if ('error' in r2) {
    assertMatch(r2.error, /milestoneId/, 'error should mention milestoneId');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler idempotency
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler idempotency ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, roadmapPath } = createTempProject();

  // Set up DB state
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Task 1' });

  const params = makeValidSliceParams();

  // First call
  const r1 = await handleCompleteSlice(params, basePath);
  assertTrue(!('error' in r1), 'first call should succeed');

  // Second call — state machine guard rejects (slice is already complete)
  const r2 = await handleCompleteSlice(params, basePath);
  assertTrue('error' in r2, 'second call should return error (slice already complete)');
  if ('error' in r2) {
    assertMatch(r2.error, /already complete/, 'error should mention already complete');
  }

  // Verify only 1 slice row (not duplicated)
  const adapter = _getAdapter()!;
  const sliceRows = adapter.prepare("SELECT * FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").all();
  assertEq(sliceRows.length, 1, 'should have exactly 1 slice row after calls');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: Handler with missing roadmap (graceful)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: handler with missing roadmap ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Create a temp dir WITHOUT a roadmap file
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-roadmap-'));
  const sliceDir = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01');
  fs.mkdirSync(sliceDir, { recursive: true });

  // Set up DB state
  insertMilestone({ id: 'M001' });
  insertSlice({ id: 'S01', milestoneId: 'M001' });
  insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', status: 'complete', title: 'Task 1' });

  const params = makeValidSliceParams();
  const result = await handleCompleteSlice(params, basePath);

  // Should succeed even without roadmap file — just skip checkbox toggle
  assertTrue(!('error' in result), 'handler should succeed without roadmap file');
  if (!('error' in result)) {
    assertTrue(fs.existsSync(result.summaryPath), 'summary should be written even without roadmap');
    assertTrue(fs.existsSync(result.uatPath), 'UAT should be written even without roadmap');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-slice: step 13 specifies write tool for PROJECT.md (#2946)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-slice: step 13 specifies write tool for PROJECT.md (#2946) ===');
{
  const promptPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..', 'prompts', 'complete-slice.md',
  );
  const prompt = fs.readFileSync(promptPath, 'utf-8');

  // Step 13 must explicitly name the `write` tool so the LLM doesn't
  // confuse it with `edit` (which requires path + oldText + newText).
  // See: https://github.com/gsd-build/gsd-2/issues/2946
  const mentionsWriteTool =
    /PROJECT\.md.*\bwrite\b/i.test(prompt) ||
    /\bwrite\b.*PROJECT\.md/i.test(prompt);
  assertTrue(mentionsWriteTool, 'step 13 must name the `write` tool when updating PROJECT.md');
}

// ═══════════════════════════════════════════════════════════════════════════

report();
