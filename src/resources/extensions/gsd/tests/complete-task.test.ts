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
  updateTaskStatus,
  getTask,
  getSliceTasks,
  insertVerificationEvidence,
  SCHEMA_VERSION,
} from '../gsd-db.ts';
import { handleCompleteTask } from '../tools/complete-task.ts';

const { assertEq, assertTrue, assertMatch, report } = createTestContext();

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-complete-task-'));
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
 * Create a temp project directory with .gsd structure for handler tests.
 */
function createTempProject(): { basePath: string; planPath: string } {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-handler-'));
  const tasksDir = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const planPath = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
  fs.writeFileSync(planPath, `# S01: Test Slice

## Tasks

- [ ] **T01: Test task** \`est:30m\`
  - Do: Implement the thing
  - Verify: Run tests

- [ ] **T02: Second task** \`est:1h\`
  - Do: Implement more
  - Verify: Run more tests
`);

  return { basePath, planPath };
}

function makeValidParams() {
  return {
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    oneLiner: 'Added test functionality',
    narrative: 'Implemented the test feature with full coverage.',
    verification: 'Ran npm run test:unit — all tests pass.',
    deviations: 'None.',
    knownIssues: 'None.',
    keyFiles: ['src/test.ts', 'src/test.test.ts'],
    keyDecisions: ['D001'],
    blockerDiscovered: false,
    verificationEvidence: [
      {
        command: 'npm run test:unit',
        exitCode: 0,
        verdict: '✅ pass',
        durationMs: 5000,
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Fresh DB is migrated to the current schema version
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: fresh DB migrates to current schema version ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const adapter = _getAdapter()!;

  // Verify schema version matches the current source-of-truth constant.
  // Asserting against SCHEMA_VERSION (not a hardcoded number) keeps this
  // green across migration bumps while still catching a
  // "fresh-DB-was-not-migrated" regression.
  const versionRow = adapter.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assertEq(versionRow?.['v'], SCHEMA_VERSION, 'fresh DB should be migrated to current SCHEMA_VERSION');

  // Verify all 4 new tables exist
  const tables = adapter.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all();
  const tableNames = tables.map(t => t['name'] as string);
  assertTrue(tableNames.includes('milestones'), 'milestones table should exist');
  assertTrue(tableNames.includes('slices'), 'slices table should exist');
  assertTrue(tableNames.includes('tasks'), 'tasks table should exist');
  assertTrue(tableNames.includes('verification_evidence'), 'verification_evidence table should exist');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Accessor CRUD
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: accessor CRUD ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Insert milestone
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  const adapter = _getAdapter()!;
  const mRow = adapter.prepare("SELECT * FROM milestones WHERE id = 'M001'").get();
  assertEq(mRow?.['id'], 'M001', 'milestone id should be M001');
  assertEq(mRow?.['title'], 'Test Milestone', 'milestone title should match');

  // Insert slice
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice', risk: 'high' });
  const sRow = adapter.prepare("SELECT * FROM slices WHERE id = 'S01' AND milestone_id = 'M001'").get();
  assertEq(sRow?.['id'], 'S01', 'slice id should be S01');
  assertEq(sRow?.['risk'], 'high', 'slice risk should be high');

  // Insert task with all fields
  insertTask({
    id: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    title: 'Test Task',
    status: 'complete',
    oneLiner: 'Did the thing',
    narrative: 'Full story here.',
    verificationResult: 'passed',
    duration: '30m',
    blockerDiscovered: false,
    deviations: 'None',
    knownIssues: 'None',
    keyFiles: ['file1.ts', 'file2.ts'],
    keyDecisions: ['D001'],
    fullSummaryMd: '# Summary',
  });

  // getTask verifies all fields
  const task = getTask('M001', 'S01', 'T01');
  assertTrue(task !== null, 'task should not be null');
  assertEq(task!.id, 'T01', 'task id');
  assertEq(task!.slice_id, 'S01', 'task slice_id');
  assertEq(task!.milestone_id, 'M001', 'task milestone_id');
  assertEq(task!.title, 'Test Task', 'task title');
  assertEq(task!.status, 'complete', 'task status');
  assertEq(task!.one_liner, 'Did the thing', 'task one_liner');
  assertEq(task!.narrative, 'Full story here.', 'task narrative');
  assertEq(task!.verification_result, 'passed', 'task verification_result');
  assertEq(task!.blocker_discovered, false, 'task blocker_discovered');
  assertEq(task!.key_files, ['file1.ts', 'file2.ts'], 'task key_files JSON round-trip');
  assertEq(task!.key_decisions, ['D001'], 'task key_decisions JSON round-trip');
  assertEq(task!.full_summary_md, '# Summary', 'task full_summary_md');

  // getTask returns null for non-existent
  const noTask = getTask('M001', 'S01', 'T99');
  assertEq(noTask, null, 'non-existent task should return null');

  // Insert verification evidence
  insertVerificationEvidence({
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    command: 'npm test',
    exitCode: 0,
    verdict: '✅ pass',
    durationMs: 3000,
  });
  const evRows = adapter.prepare(
    "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND slice_id = 'S01' AND milestone_id = 'M001'"
  ).all();
  assertEq(evRows.length, 1, 'should have 1 verification evidence row');
  assertEq(evRows[0]['command'], 'npm test', 'evidence command');
  assertEq(evRows[0]['exit_code'], 0, 'evidence exit_code');
  assertEq(evRows[0]['verdict'], '✅ pass', 'evidence verdict');
  assertEq(evRows[0]['duration_ms'], 3000, 'evidence duration_ms');

  // getSliceTasks returns array
  const sliceTasks = getSliceTasks('M001', 'S01');
  assertEq(sliceTasks.length, 1, 'getSliceTasks should return 1 task');
  assertEq(sliceTasks[0].id, 'T01', 'getSliceTasks first task id');

  // updateTaskStatus changes status
  updateTaskStatus('M001', 'S01', 'T01', 'failed', new Date().toISOString());
  const updatedTask = getTask('M001', 'S01', 'T01');
  assertEq(updatedTask!.status, 'failed', 'task status should be updated to failed');
  assertTrue(updatedTask!.completed_at !== null, 'completed_at should be set after status update');

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Accessor stale-state error
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: accessor stale-state error ===');
{
  // No DB open — accessors should throw GSD_STALE_STATE
  closeDatabase();
  let threw = false;
  try {
    insertMilestone({ id: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'should throw GSD_STALE_STATE when no DB open');
  }
  assertTrue(threw, 'insertMilestone should throw when no DB open');

  threw = false;
  try {
    insertSlice({ id: 'S01', milestoneId: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertSlice should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertSlice should throw when no DB open');

  threw = false;
  try {
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001' });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertTask should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertTask should throw when no DB open');

  threw = false;
  try {
    insertVerificationEvidence({
      taskId: 'T01', sliceId: 'S01', milestoneId: 'M001',
      command: 'test', exitCode: 0, verdict: 'pass', durationMs: 0,
    });
  } catch (err: any) {
    threw = true;
    assertTrue(err.code === 'GSD_STALE_STATE' || err.message.includes('No database open'),
      'insertVerificationEvidence should throw GSD_STALE_STATE');
  }
  assertTrue(threw, 'insertVerificationEvidence should throw when no DB open');
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler happy path
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler happy path ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  // Seed milestone + slice + both tasks so projection renders T01 ([x]) and T02 ([ ])
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });
  insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', status: 'pending', title: 'Second task' });

  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);

  assertTrue(!('error' in result), 'handler should succeed without error');
  if (!('error' in result)) {
    assertEq(result.taskId, 'T01', 'result taskId');
    assertEq(result.sliceId, 'S01', 'result sliceId');
    assertEq(result.milestoneId, 'M001', 'result milestoneId');
    assertTrue(result.summaryPath.endsWith('T01-SUMMARY.md'), 'summaryPath should end with T01-SUMMARY.md');

    // (a) Verify task row in DB with status 'complete'
    const task = getTask('M001', 'S01', 'T01');
    assertTrue(task !== null, 'task should exist in DB after handler');
    assertEq(task!.status, 'complete', 'task status should be complete');
    assertEq(task!.one_liner, 'Added test functionality', 'task one_liner in DB');
    assertEq(task!.key_files, ['src/test.ts', 'src/test.test.ts'], 'task key_files in DB');

    // (b) Verify verification_evidence rows in DB
    const adapter = _getAdapter()!;
    const evRows = adapter.prepare(
      "SELECT * FROM verification_evidence WHERE task_id = 'T01' AND milestone_id = 'M001'"
    ).all();
    assertEq(evRows.length, 1, 'should have 1 verification evidence row after handler');
    assertEq(evRows[0]['command'], 'npm run test:unit', 'evidence command from handler');

    // (c) Verify T01-SUMMARY.md file on disk with correct YAML frontmatter
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should exist on disk');
    const summaryContent = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summaryContent, /^---\n/, 'summary should start with YAML frontmatter');
    assertMatch(summaryContent, /id: T01/, 'summary should contain id: T01');
    assertMatch(summaryContent, /parent: S01/, 'summary should contain parent: S01');
    assertMatch(summaryContent, /milestone: M001/, 'summary should contain milestone: M001');
    assertMatch(summaryContent, /blocker_discovered: false/, 'summary should contain blocker_discovered');
    assertMatch(summaryContent, /# T01:/, 'summary should have H1 with task ID');
    assertMatch(summaryContent, /\*\*Added test functionality\*\*/, 'summary should have one-liner in bold');
    assertMatch(summaryContent, /## What Happened/, 'summary should have What Happened section');
    assertMatch(summaryContent, /## Verification Evidence/, 'summary should have Verification Evidence section');
    assertMatch(summaryContent, /npm run test:unit/, 'summary evidence should contain command');

    // (d) Verify plan checkbox changed to [x]
    const planContent = fs.readFileSync(planPath, 'utf-8');
    assertMatch(planContent, /\[x\]\s+\*\*T01:/, 'T01 should be checked in plan');
    // T02 should still be unchecked
    assertMatch(planContent, /\[ \]\s+\*\*T02:/, 'T02 should still be unchecked in plan');

    // (e) Verify full_summary_md stored in DB for D004 recovery
    const taskAfter = getTask('M001', 'S01', 'T01');
    assertTrue(taskAfter!.full_summary_md.length > 0, 'full_summary_md should be non-empty in DB');
    assertMatch(taskAfter!.full_summary_md, /id: T01/, 'full_summary_md should contain frontmatter');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler validation errors
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler validation errors ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const params = makeValidParams();

  // Empty taskId
  const r1 = await handleCompleteTask({ ...params, taskId: '' }, '/tmp/fake');
  assertTrue('error' in r1, 'should return error for empty taskId');
  if ('error' in r1) {
    assertMatch(r1.error, /taskId/, 'error should mention taskId');
  }

  // Empty milestoneId
  const r2 = await handleCompleteTask({ ...params, milestoneId: '' }, '/tmp/fake');
  assertTrue('error' in r2, 'should return error for empty milestoneId');
  if ('error' in r2) {
    assertMatch(r2.error, /milestoneId/, 'error should mention milestoneId');
  }

  // Empty sliceId
  const r3 = await handleCompleteTask({ ...params, sliceId: '' }, '/tmp/fake');
  assertTrue('error' in r3, 'should return error for empty sliceId');
  if ('error' in r3) {
    assertMatch(r3.error, /sliceId/, 'error should mention sliceId');
  }

  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler idempotency
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler idempotency ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  // Seed milestone + slice so state machine guards pass
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = makeValidParams();

  // First call should succeed
  const r1 = await handleCompleteTask(params, basePath);
  assertTrue(!('error' in r1), 'first call should succeed');

  // Verify only 1 task row
  const tasks = getSliceTasks('M001', 'S01');
  assertEq(tasks.length, 1, 'should have exactly 1 task row after first call');

  // Second call with same params — state machine guard rejects (task is already complete)
  const r2 = await handleCompleteTask(params, basePath);
  assertTrue('error' in r2, 'second call should return error (task already complete)');
  if ('error' in r2) {
    assertMatch(r2.error, /already complete/, 'error should mention already complete');
  }

  // Still only 1 task row (no duplication from rejected second call)
  const tasksAfter = getSliceTasks('M001', 'S01');
  assertEq(tasksAfter.length, 1, 'should still have exactly 1 task row after rejected second call');

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: Handler with missing plan file (graceful)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: handler with missing plan file ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  // Create a temp dir WITHOUT a plan file
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-no-plan-'));
  const tasksDir = path.join(basePath, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  // Seed milestone + slice so state machine guards pass
  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  const params = makeValidParams();
  const result = await handleCompleteTask(params, basePath);

  // Should succeed even without plan file — just skip checkbox toggle
  assertTrue(!('error' in result), 'handler should succeed without plan file');
  if (!('error' in result)) {
    assertTrue(fs.existsSync(result.summaryPath), 'summary should be written even without plan file');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════
// complete-task: minimal params — no optional fields (#2771 regression)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== complete-task: minimal params (no keyFiles, keyDecisions, verificationEvidence, blockerDiscovered) ===');
{
  const dbPath = tempDbPath();
  openDatabase(dbPath);

  const { basePath, planPath } = createTempProject();

  insertMilestone({ id: 'M001', title: 'Test Milestone' });
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Test Slice' });

  // Minimal params — only required fields, all optional enrichment fields omitted
  const minimalParams = {
    taskId: 'T01',
    sliceId: 'S01',
    milestoneId: 'M001',
    oneLiner: 'Basic task',
    narrative: 'Did the work.',
    verification: 'Looks good.',
    // keyFiles, keyDecisions, verificationEvidence, blockerDiscovered intentionally omitted
  };

  const result = await handleCompleteTask(minimalParams as any, basePath);

  assertTrue(!('error' in result), 'handler should not crash with minimal params (no optional fields)');
  if (!('error' in result)) {
    assertTrue(fs.existsSync(result.summaryPath), 'summary file should be written with minimal params');
    const summaryContent = fs.readFileSync(result.summaryPath, 'utf-8');
    assertMatch(summaryContent, /blocker_discovered:\s*false/, 'blocker_discovered should default to false');
    assertMatch(summaryContent, /\(none\)/, 'key_files/key_decisions should show (none) placeholder');
  }

  cleanupDir(basePath);
  cleanup(dbPath);
}

// ═══════════════════════════════════════════════════════════════════════════

report();
