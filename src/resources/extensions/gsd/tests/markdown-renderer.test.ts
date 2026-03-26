import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
  getArtifact,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  updateSliceStatus,
  _getAdapter,
} from '../gsd-db.ts';
import {
  renderRoadmapCheckboxes,
  renderPlanCheckboxes,
  renderTaskSummary,
  renderSliceSummary,
  renderAllFromDb,
  renderPlanFromDb,
  renderTaskPlanFromDb,
  detectStaleRenders,
  repairStaleRenders,
} from '../markdown-renderer.ts';
import {
  parseRoadmap,
  parsePlan,
} from '../parsers-legacy.ts';
import {
  parseSummary,
  parseTaskPlanFile,
  clearParseCache,
} from '../files.ts';
import { clearPathCache, _clearGsdRootCache } from '../paths.ts';
import { invalidateStateCache } from '../state.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-renderer-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* swallow */ }
}

function clearAllCaches(): void {
  clearParseCache();
  clearPathCache();
  _clearGsdRootCache();
  invalidateStateCache();
}

/**
 * Create on-disk directory structure for a milestone/slice/task tree
 * so that path resolvers work correctly.
 */
function scaffoldDirs(tmpDir: string, mid: string, sliceIds: string[]): void {
  const msDir = path.join(tmpDir, '.gsd', 'milestones', mid);
  fs.mkdirSync(msDir, { recursive: true });

  for (const sid of sliceIds) {
    const sliceDir = path.join(msDir, 'slices', sid);
    fs.mkdirSync(path.join(sliceDir, 'tasks'), { recursive: true });
  }
}

// ─── Fixture: Roadmap Template ────────────────────────────────────────────

function makeRoadmapContent(slices: Array<{ id: string; title: string; done: boolean }>): string {
  const lines: string[] = [];
  lines.push('# M001 Roadmap');
  lines.push('');
  lines.push('**Vision:** Test milestone');
  lines.push('');
  lines.push('## Slices');
  lines.push('');
  for (const s of slices) {
    const checkbox = s.done ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} **${s.id}: ${s.title}** \`risk:medium\` \`depends:[]\``);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Fixture: Plan Template ───────────────────────────────────────────────

function makePlanContent(
  sliceId: string,
  tasks: Array<{ id: string; title: string; done: boolean }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${sliceId}: Test Slice`);
  lines.push('');
  lines.push('**Goal:** Test slice goal');
  lines.push('**Demo:** Test demo');
  lines.push('');
  lines.push('## Must-Haves');
  lines.push('');
  lines.push('- Everything works');
  lines.push('');
  lines.push('## Tasks');
  lines.push('');
  for (const t of tasks) {
    const checkbox = t.done ? '[x]' : '[ ]';
    lines.push(`- ${checkbox} **${t.id}: ${t.title}** \`est:1h\``);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Fixture: Task Summary Template ───────────────────────────────────────

function makeTaskSummaryContent(taskId: string): string {
  return [
    '---',
    `id: ${taskId}`,
    'parent: S01',
    'milestone: M001',
    'duration: 45m',
    'verification_result: all-pass',
    `completed_at: ${new Date().toISOString()}`,
    'blocker_discovered: false',
    'provides: []',
    'requires: []',
    'affects: []',
    'key_files:',
    '  - src/test.ts',
    'key_decisions: []',
    'patterns_established: []',
    'drill_down_paths: []',
    'observability_surfaces: []',
    '---',
    '',
    `# ${taskId}: Test Task Summary`,
    '',
    '**Implemented test functionality**',
    '',
    '## What Happened',
    '',
    'Built the test feature.',
    '',
    '## Deviations',
    '',
    'None.',
    '',
    '## Files Created/Modified',
    '',
    '- `src/test.ts` — main implementation',
    '',
    '## Verification Evidence',
    '',
    '| Command | Exit | Verdict | Duration |',
    '|---------|------|---------|----------|',
    '| `npm test` | 0 | ✅ pass | 2.1s |',
    '',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// DB Accessor Tests
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: DB accessor basics ──', () => {
  openDatabase(':memory:');

  // getAllMilestones — empty
  const empty = getAllMilestones();
  assert.deepStrictEqual(empty.length, 0, 'getAllMilestones returns empty when no milestones');

  // Insert and retrieve
  insertMilestone({ id: 'M001', title: 'Test MS', status: 'active' });
  insertMilestone({ id: 'M002', title: 'Second MS', status: 'active' });

  const all = getAllMilestones();
  assert.deepStrictEqual(all.length, 2, 'getAllMilestones returns 2 milestones');
  assert.deepStrictEqual(all[0].id, 'M001', 'first milestone is M001');
  assert.deepStrictEqual(all[1].id, 'M002', 'second milestone is M002');
  assert.deepStrictEqual(all[0].title, 'Test MS', 'milestone title correct');
  assert.deepStrictEqual(all[0].status, 'active', 'milestone status correct');

  // getMilestoneSlices — empty
  const noSlices = getMilestoneSlices('M001');
  assert.deepStrictEqual(noSlices.length, 0, 'getMilestoneSlices returns empty when no slices');

  // Insert slices and retrieve
  insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice 1', status: 'complete' });
  insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice 2', status: 'pending' });
  insertSlice({ id: 'S01', milestoneId: 'M002', title: 'M2 Slice', status: 'pending' });

  const m1Slices = getMilestoneSlices('M001');
  assert.deepStrictEqual(m1Slices.length, 2, 'M001 has 2 slices');
  assert.deepStrictEqual(m1Slices[0].id, 'S01', 'first slice is S01');
  assert.deepStrictEqual(m1Slices[0].status, 'complete', 'S01 status is complete');
  assert.deepStrictEqual(m1Slices[1].id, 'S02', 'second slice is S02');
  assert.deepStrictEqual(m1Slices[1].status, 'pending', 'S02 status is pending');

  const m2Slices = getMilestoneSlices('M002');
  assert.deepStrictEqual(m2Slices.length, 1, 'M002 has 1 slice');

  closeDatabase();
});

test('── markdown-renderer: getArtifact accessor ──', () => {
  openDatabase(':memory:');

  // Not found
  const missing = getArtifact('nonexistent/path');
  assert.deepStrictEqual(missing, null, 'getArtifact returns null for missing path');

  // Insert and retrieve
  insertArtifact({
    path: 'milestones/M001/M001-ROADMAP.md',
    artifact_type: 'ROADMAP',
    milestone_id: 'M001',
    slice_id: null,
    task_id: null,
    full_content: '# Roadmap content',
  });

  const found = getArtifact('milestones/M001/M001-ROADMAP.md');
  assert.ok(found !== null, 'getArtifact returns non-null for existing path');
  assert.deepStrictEqual(found!.artifact_type, 'ROADMAP', 'artifact type correct');
  assert.deepStrictEqual(found!.milestone_id, 'M001', 'milestone_id correct');
  assert.deepStrictEqual(found!.full_content, '# Roadmap content', 'content correct');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// Roadmap Checkbox Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderRoadmapCheckboxes round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    // Seed DB with milestone and slices
    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core setup', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Rendering', status: 'pending' });

    // Write a roadmap file on disk with BOTH slices unchecked
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core setup', done: false },
      { id: 'S02', title: 'Rendering', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    // Render — should set S01 [x] and leave S02 [ ]
    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'renderRoadmapCheckboxes returns true');

    // Read rendered file and parse
    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    clearAllCaches();
    const parsed = parseRoadmap(rendered);

    assert.deepStrictEqual(parsed.slices.length, 2, 'roadmap has 2 slices after render');

    const s01 = parsed.slices.find(s => s.id === 'S01');
    const s02 = parsed.slices.find(s => s.id === 'S02');
    assert.ok(!!s01, 'S01 found in parsed roadmap');
    assert.ok(!!s02, 'S02 found in parsed roadmap');
    assert.ok(s01!.done, 'S01 is checked (done) after render');
    assert.ok(!s02!.done, 'S02 is unchecked (pending) after render');

    // Verify artifact stored in DB
    const artifact = getArtifact('milestones/M001/M001-ROADMAP.md');
    assert.ok(artifact !== null, 'roadmap artifact stored in DB after render');
    assert.ok(artifact!.full_content.includes('[x] **S01:'), 'DB artifact has S01 checked');
    assert.ok(artifact!.full_content.includes('[ ] **S02:'), 'DB artifact has S02 unchecked');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderRoadmapCheckboxes bidirectional ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    // S01 is PENDING in DB, but checked on disk — should be unchecked
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core setup', status: 'pending' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Rendering', status: 'complete' });

    // Write roadmap with S01 checked and S02 unchecked (opposite of DB state)
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core setup', done: true },
      { id: 'S02', title: 'Rendering', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'bidirectional render returns true');

    const rendered = fs.readFileSync(roadmapPath, 'utf-8');
    clearAllCaches();
    const parsed = parseRoadmap(rendered);

    const s01 = parsed.slices.find(s => s.id === 'S01');
    const s02 = parsed.slices.find(s => s.id === 'S02');
    assert.ok(!s01!.done, 'S01 unchecked (DB says pending, was checked on disk)');
    assert.ok(s02!.done, 'S02 checked (DB says complete, was unchecked on disk)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Plan Checkbox Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderPlanCheckboxes round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });
    insertTask({ id: 'T03', sliceId: 'S01', milestoneId: 'M001', title: 'Third task', status: 'pending' });

    // Write plan with all tasks unchecked
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: false },
      { id: 'T02', title: 'Second task', done: false },
      { id: 'T03', title: 'Third task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const ok = await renderPlanCheckboxes(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'renderPlanCheckboxes returns true');

    const rendered = fs.readFileSync(planPath, 'utf-8');
    clearAllCaches();
    const parsed = parsePlan(rendered);

    assert.deepStrictEqual(parsed.tasks.length, 3, 'plan has 3 tasks after render');

    const t01 = parsed.tasks.find(t => t.id === 'T01');
    const t02 = parsed.tasks.find(t => t.id === 'T02');
    const t03 = parsed.tasks.find(t => t.id === 'T03');
    assert.ok(t01!.done, 'T01 checked (done in DB)');
    assert.ok(t02!.done, 'T02 checked (done in DB)');
    assert.ok(!t03!.done, 'T03 unchecked (pending in DB)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanCheckboxes bidirectional ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    // T01 pending in DB but checked on disk
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'pending' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: true },   // checked but DB says pending
      { id: 'T02', title: 'Second task', done: false },  // unchecked but DB says done
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const ok = await renderPlanCheckboxes(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'bidirectional plan render returns true');

    const rendered = fs.readFileSync(planPath, 'utf-8');
    clearAllCaches();
    const parsed = parsePlan(rendered);

    const t01 = parsed.tasks.find(t => t.id === 'T01');
    const t02 = parsed.tasks.find(t => t.id === 'T02');
    assert.ok(!t01!.done, 'T01 unchecked (DB says pending, was checked)');
    assert.ok(t02!.done, 'T02 checked (DB says done, was unchecked)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderPlanFromDb creates parse-compatible slice plan + task plan files ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S02']);

    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({
      id: 'S02',
      milestoneId: 'M001',
      title: 'DB-backed planning',
      status: 'pending',
      demo: 'Rendered plans exist on disk.',
      planning: {
        goal: 'Render slice plans from DB state.',
        successCriteria: '- Slice plan stays parse-compatible\n- Task plan files are regenerated',
        proofLevel: 'integration',
        integrationClosure: 'Wires DB planning rows to markdown artifacts.',
        observabilityImpact: '- Run renderer contract tests\n- Inspect stale-render diagnostics on mismatch',
      },
    });
    insertTask({
      id: 'T01',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Render slice plan',
      status: 'pending',
      planning: {
        description: 'Implement the DB-backed slice plan renderer.',
        estimate: '45m',
        files: ['src/resources/extensions/gsd/markdown-renderer.ts'],
        verify: 'node --test markdown-renderer.test.ts',
        inputs: ['src/resources/extensions/gsd/markdown-renderer.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/markdown-renderer.test.ts'],
        observabilityImpact: 'Renderer tests cover stale render failure paths.',
      },
    });
    insertTask({
      id: 'T02',
      sliceId: 'S02',
      milestoneId: 'M001',
      title: 'Render task plan',
      status: 'pending',
      planning: {
        description: 'Emit the task plan file with conservative frontmatter.',
        estimate: '30m',
        files: ['src/resources/extensions/gsd/files.ts'],
        verify: 'node --test auto-recovery.test.ts',
        inputs: ['src/resources/extensions/gsd/files.ts'],
        expectedOutput: ['src/resources/extensions/gsd/tests/auto-recovery.test.ts'],
        observabilityImpact: 'Missing task-plan files fail recovery verification.',
      },
    });

    const rendered = await renderPlanFromDb(tmpDir, 'M001', 'S02');
    assert.ok(fs.existsSync(rendered.planPath), 'slice plan written to disk');
    assert.strictEqual(rendered.taskPlanPaths.length, 2, 'task plan paths returned for each task');
    assert.ok(rendered.taskPlanPaths.every((p) => fs.existsSync(p)), 'all task plan files written to disk');

    const planContent = fs.readFileSync(rendered.planPath, 'utf-8');
    clearAllCaches();
    const parsedPlan = parsePlan(planContent);
    assert.strictEqual(parsedPlan.id, 'S02', 'rendered slice plan parses with correct slice id');
    assert.strictEqual(parsedPlan.goal, 'Render slice plans from DB state.', 'rendered slice plan preserves goal');
    assert.strictEqual(parsedPlan.demo, 'Rendered plans exist on disk.', 'rendered slice plan preserves demo');
    assert.strictEqual(parsedPlan.mustHaves.length, 2, 'rendered slice plan exposes must-haves');
    assert.strictEqual(parsedPlan.tasks.length, 2, 'rendered slice plan exposes all tasks');
    assert.strictEqual(parsedPlan.tasks[0].id, 'T01', 'first task parses correctly');
    assert.ok(parsedPlan.tasks[0].description.includes('DB-backed slice plan renderer'), 'task description preserved in slice plan');
    assert.strictEqual(parsedPlan.tasks[0].files?.[0], 'src/resources/extensions/gsd/markdown-renderer.ts', 'files list preserved in slice plan');
    assert.strictEqual(parsedPlan.tasks[0].verify, 'node --test markdown-renderer.test.ts', 'verify line preserved in slice plan');

    const planArtifact = getArtifact('milestones/M001/slices/S02/S02-PLAN.md');
    assert.ok(planArtifact !== null, 'slice plan artifact stored in DB');
    assert.ok(planArtifact!.full_content.includes('## Tasks'), 'stored plan artifact contains task section');

    const taskPlanPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'tasks', 'T01-PLAN.md');
    const taskPlanContent = fs.readFileSync(taskPlanPath, 'utf-8');
    const taskPlanFile = parseTaskPlanFile(taskPlanContent);
    assert.strictEqual(taskPlanFile.frontmatter.estimated_steps, 1, 'task plan frontmatter exposes estimated_steps');
    assert.strictEqual(taskPlanFile.frontmatter.estimated_files, 1, 'task plan frontmatter exposes estimated_files');
    assert.strictEqual(taskPlanFile.frontmatter.skills_used.length, 0, 'task plan frontmatter uses conservative empty skills list');
    assert.match(taskPlanContent, /^# T01: Render slice plan/m, 'task plan renders task heading');
    assert.match(taskPlanContent, /^## Inputs$/m, 'task plan renders Inputs section');
    assert.match(taskPlanContent, /^## Expected Output$/m, 'task plan renders Expected Output section');
    assert.match(taskPlanContent, /^## Verification$/m, 'task plan renders Verification section');

    const taskArtifact = getArtifact('milestones/M001/slices/S02/tasks/T01-PLAN.md');
    assert.ok(taskArtifact !== null, 'task plan artifact stored in DB');
    assert.ok(taskArtifact!.full_content.includes('skills_used: []'), 'stored task plan artifact preserves conservative skills_used');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskPlanFromDb throws for missing task ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S02']);
    insertMilestone({ id: 'M001', title: 'Milestone', status: 'active' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    let threw = false;
    try {
      await renderTaskPlanFromDb(tmpDir, 'M001', 'S02', 'T99');
    } catch (error) {
      threw = true;
      assert.match(String((error as Error).message), /task M001\/S02\/T99 not found/, 'renderTaskPlanFromDb should fail clearly when task row is missing');
    }
    assert.ok(threw, 'renderTaskPlanFromDb throws when the task row is missing');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// Task Summary Rendering
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderTaskSummary round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Test Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    const ok = await renderTaskSummary(tmpDir, 'M001', 'S01', 'T01');
    assert.ok(ok, 'renderTaskSummary returns true');

    // Verify file exists on disk
    const summaryPath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'T01-SUMMARY.md written to disk');

    // Parse and verify
    const rendered = fs.readFileSync(summaryPath, 'utf-8');
    clearAllCaches();
    const parsed = parseSummary(rendered);
    assert.deepStrictEqual(parsed.frontmatter.id, 'T01', 'parsed summary has correct id');
    assert.deepStrictEqual(parsed.frontmatter.parent, 'S01', 'parsed summary has correct parent');
    assert.deepStrictEqual(parsed.frontmatter.milestone, 'M001', 'parsed summary has correct milestone');
    assert.deepStrictEqual(parsed.frontmatter.duration, '45m', 'parsed summary has correct duration');
    assert.ok(parsed.title.includes('T01'), 'parsed summary title contains task ID');
    assert.ok(parsed.whatHappened.includes('Built the test feature'), 'whatHappened content preserved');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

test('── markdown-renderer: renderTaskSummary skips empty ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task without summary',
      status: 'pending',
      fullSummaryMd: '', // empty summary
    });

    const ok = await renderTaskSummary(tmpDir, 'M001', 'S01', 'T01');
    assert.ok(!ok, 'renderTaskSummary returns false for empty summary');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Slice Summary Rendering
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderSliceSummary round-trip ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'complete' });

    // Update slice with summary and UAT content
    // Since insertSlice uses INSERT OR IGNORE, we need to set the content via raw adapter
    const db = await import('../gsd-db.ts');
    const adapter = db._getAdapter()!;
    adapter.prepare(
      `UPDATE slices SET full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`,
    ).run({
      ':sm': '---\nid: S01\nparent: M001\nmilestone: M001\nduration: 2h\nverification_result: all-pass\ncompleted_at: 2025-01-01\nblocker_discovered: false\nprovides: []\nrequires: []\naffects: []\nkey_files:\n  - src/index.ts\nkey_decisions: []\npatterns_established: []\ndrill_down_paths: []\nobservability_surfaces: []\n---\n\n# S01: Test Slice Summary\n\n**Completed core functionality**\n\n## What Happened\n\nBuilt the slice.\n\n## Deviations\n\nNone.\n',
      ':um': '# S01 UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n\n## Checks\n\n- All tests pass\n',
    });

    const ok = await renderSliceSummary(tmpDir, 'M001', 'S01');
    assert.ok(ok, 'renderSliceSummary returns true');

    // Verify SUMMARY file
    const summaryPath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'S01-SUMMARY.md written to disk');

    const summaryContent = fs.readFileSync(summaryPath, 'utf-8');
    assert.ok(summaryContent.includes('Test Slice Summary'), 'summary content correct');

    // Verify UAT file
    const uatPath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-UAT.md',
    );
    assert.ok(fs.existsSync(uatPath), 'S01-UAT.md written to disk');

    const uatContent = fs.readFileSync(uatPath, 'utf-8');
    assert.ok(uatContent.includes('artifact-driven'), 'UAT content correct');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// renderAllFromDb
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: renderAllFromDb produces all files ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    // Setup: 2 milestones, M001 has 2 slices with tasks, M002 has 1 slice
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);
    scaffoldDirs(tmpDir, 'M002', ['S01']);

    insertMilestone({ id: 'M001', title: 'First', status: 'active' });
    insertMilestone({ id: 'M002', title: 'Second', status: 'active' });

    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });
    insertSlice({ id: 'S01', milestoneId: 'M002', title: 'Future', status: 'pending' });

    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'DB', status: 'done', fullSummaryMd: makeTaskSummaryContent('T01') });
    insertTask({ id: 'T01', sliceId: 'S02', milestoneId: 'M001', title: 'Renderer', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M002', title: 'Future task', status: 'pending' });

    // Write roadmap and plan files on disk
    const roadmap1 = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
      { id: 'S02', title: 'Render', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md'),
      roadmap1,
    );

    const roadmap2 = makeRoadmapContent([
      { id: 'S01', title: 'Future', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M002', 'M002-ROADMAP.md'),
      roadmap2,
    );

    const plan1 = makePlanContent('S01', [
      { id: 'T01', title: 'DB', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md'),
      plan1,
    );

    const plan2 = makePlanContent('S02', [
      { id: 'T01', title: 'Renderer', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S02', 'S02-PLAN.md'),
      plan2,
    );

    const plan3 = makePlanContent('S01', [
      { id: 'T01', title: 'Future task', done: false },
    ]);
    fs.writeFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M002', 'slices', 'S01', 'S01-PLAN.md'),
      plan3,
    );

    clearAllCaches();

    const result = await renderAllFromDb(tmpDir);

    assert.ok(result.rendered > 0, 'renderAllFromDb rendered some files');
    assert.deepStrictEqual(result.errors.length, 0, 'renderAllFromDb had no errors');

    // Verify M001 roadmap has S01 checked
    const m1Roadmap = fs.readFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md'), 'utf-8',
    );
    clearAllCaches();
    const parsed1 = parseRoadmap(m1Roadmap);
    const s01 = parsed1.slices.find(s => s.id === 'S01');
    assert.ok(s01!.done, 'M001 S01 checked after renderAll');

    // Verify M001/S01 plan has T01 checked
    const m1s1Plan = fs.readFileSync(
      path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md'), 'utf-8',
    );
    clearAllCaches();
    const parsedPlan = parsePlan(m1s1Plan);
    assert.ok(parsedPlan.tasks[0].done, 'M001/S01 T01 checked after renderAll');

    // Verify task summary written
    const taskSummaryPath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(taskSummaryPath), 'T01 summary written by renderAll');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Graceful Degradation (Disk Fallback)
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: graceful fallback reads from disk when artifact not in DB ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });

    // Write roadmap to disk but NOT in artifacts DB
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    // Verify no artifact in DB
    const before = getArtifact('milestones/M001/M001-ROADMAP.md');
    assert.deepStrictEqual(before, null, 'artifact not in DB before render');

    // Render — should read from disk, store in DB
    const ok = await renderRoadmapCheckboxes(tmpDir, 'M001');
    assert.ok(ok, 'render succeeds with disk fallback');

    // Verify artifact now in DB (stored after reading from disk)
    const after = getArtifact('milestones/M001/M001-ROADMAP.md');
    assert.ok(after !== null, 'artifact stored in DB after disk fallback render');
    assert.ok(after!.full_content.includes('[x] **S01:'), 'DB artifact reflects rendered state');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// stderr warnings (graceful degradation diagnostics)
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: stderr warning on missing content ──', async () => {
  openDatabase(':memory:');

  // No milestone/slices in DB, no files on disk — should return false and emit stderr
  insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
  // No slices inserted — should warn about no slices

  const ok = await renderRoadmapCheckboxes('/nonexistent/path', 'M001');
  assert.ok(!ok, 'returns false when no slices in DB');

  closeDatabase();
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Plan Checkbox Mismatch
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds plan checkbox mismatch ──', () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // T01 is done, T02 is also done in DB
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    // Write plan with T01 checked but T02 unchecked
    // T01 matches DB (done + checked) but T02 is stale (done but unchecked)
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: true },
      { id: 'T02', title: 'Second task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Render T01 to sync it, but leave T02 out of sync
    // Actually, the plan was written with T01 already checked. 
    // The stale detection should find T02 as stale.
    const stale = detectStaleRenders(tmpDir);

    assert.ok(stale.length > 0, 'detectStaleRenders should find stale entries');
    const t02Stale = stale.find(s => s.reason.includes('T02'));
    assert.ok(!!t02Stale, 'should detect T02 as stale (done in DB, unchecked in plan)');
    assert.ok(t02Stale!.reason.includes('done in DB but unchecked'), 'reason should explain the mismatch');

    // T01 should NOT be stale — it's checked and done
    const t01Stale = stale.find(s => s.reason.includes('T01'));
    assert.deepStrictEqual(t01Stale, undefined, 'T01 should not be stale (done and checked)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Plan Checkbox
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders fixes plan and second detect returns empty ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'First task', status: 'done' });
    insertTask({ id: 'T02', sliceId: 'S01', milestoneId: 'M001', title: 'Second task', status: 'done' });

    // Write plan with both tasks unchecked (both are stale since DB says done)
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'First task', done: false },
      { id: 'T02', title: 'Second task', done: false },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Verify stale before repair
    const staleBefore = detectStaleRenders(tmpDir);
    assert.ok(staleBefore.length > 0, 'should have stale entries before repair');

    // Repair
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, 'repairStaleRenders should repair at least 1 file');

    // After repair, detect again — should be empty
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    assert.deepStrictEqual(staleAfter.length, 0, 'detectStaleRenders should return empty after repair');

    // Verify the plan file was actually updated
    const repairedContent = fs.readFileSync(planPath, 'utf-8');
    assert.ok(repairedContent.includes('[x] **T01:'), 'T01 should be checked after repair');
    assert.ok(repairedContent.includes('[x] **T02:'), 'T02 should be checked after repair');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Roadmap Checkbox Mismatch
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds roadmap checkbox mismatch ──', () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01', 'S02']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Core', status: 'complete' });
    insertSlice({ id: 'S02', milestoneId: 'M001', title: 'Render', status: 'pending' });

    // Write roadmap with both slices unchecked (S01 is stale — complete in DB but unchecked)
    const roadmapContent = makeRoadmapContent([
      { id: 'S01', title: 'Core', done: false },
      { id: 'S02', title: 'Render', done: false },
    ]);
    const roadmapPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, roadmapContent);
    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const s01Stale = stale.find(s => s.reason.includes('S01'));
    assert.ok(!!s01Stale, 'should detect S01 as stale (complete in DB, unchecked in roadmap)');

    const s02Stale = stale.find(s => s.reason.includes('S02'));
    assert.deepStrictEqual(s02Stale, undefined, 'S02 should not be stale (pending and unchecked — matches)');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Missing Task Summary
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds missing task summary ──', () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // Task is done with full_summary_md, but no SUMMARY.md on disk
    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    // Also write a plan so plan detection doesn't trigger (T01 is done but not checked)
    // We need a plan file so task plan detection works — but we specifically want to test
    // the missing summary case, so write plan with T01 checked
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find(s => s.reason.includes('SUMMARY.md missing'));
    assert.ok(!!summaryStale, 'should detect missing T01-SUMMARY.md');
    assert.ok(summaryStale!.reason.includes('T01'), 'reason should mention T01');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Missing Task Summary
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders writes missing task summary ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    const summaryContent = makeTaskSummaryContent('T01');
    insertTask({
      id: 'T01',
      sliceId: 'S01',
      milestoneId: 'M001',
      title: 'Task',
      status: 'done',
      fullSummaryMd: summaryContent,
    });

    // Write plan with T01 checked so plan detection doesn't trigger
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // Repair
    const repaired = await repairStaleRenders(tmpDir);
    assert.ok(repaired > 0, 'should repair missing summary');

    // Verify file written
    const summaryPath = path.join(
      tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks', 'T01-SUMMARY.md',
    );
    assert.ok(fs.existsSync(summaryPath), 'T01-SUMMARY.md should exist after repair');

    // Second detect should be empty
    clearAllCaches();
    const staleAfter = detectStaleRenders(tmpDir);
    const summaryStale = staleAfter.find(s => s.reason.includes('SUMMARY.md missing') && s.reason.includes('T01'));
    assert.deepStrictEqual(summaryStale, undefined, 'missing summary should be fixed after repair');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Repair — Idempotency
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: repairStaleRenders idempotency — fully synced returns 0 ──', async () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });
    insertTask({ id: 'T01', sliceId: 'S01', milestoneId: 'M001', title: 'Task', status: 'done' });

    // Write plan with T01 checked — matches DB
    const planContent = makePlanContent('S01', [
      { id: 'T01', title: 'Task', done: true },
    ]);
    const planPath = path.join(tmpDir, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-PLAN.md');
    fs.writeFileSync(planPath, planContent);
    clearAllCaches();

    // No stale entries when everything is in sync (no summary to check since no fullSummaryMd)
    const repaired = await repairStaleRenders(tmpDir);
    assert.deepStrictEqual(repaired, 0, 'repairStaleRenders should return 0 on fully synced project');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale Detection — Missing Slice Summary + UAT
// ═══════════════════════════════════════════════════════════════════════════

test('── markdown-renderer: detectStaleRenders finds missing slice summary and UAT ──', () => {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, '.gsd', 'gsd.db');
  openDatabase(dbPath);
  clearAllCaches();

  try {
    scaffoldDirs(tmpDir, 'M001', ['S01']);

    insertMilestone({ id: 'M001', title: 'Test', status: 'active' });
    insertSlice({ id: 'S01', milestoneId: 'M001', title: 'Slice', status: 'pending' });

    // Update slice to complete with content via raw adapter
    const adapter = _getAdapter()!;
    adapter.prepare(
      `UPDATE slices SET status = 'complete', full_summary_md = :sm, full_uat_md = :um WHERE milestone_id = 'M001' AND id = 'S01'`,
    ).run({
      ':sm': '---\nid: S01\nparent: M001\nmilestone: M001\n---\n\n# S01: Summary\n\nDone.\n',
      ':um': '# S01 UAT\n\nAll pass.\n',
    });

    clearAllCaches();

    const stale = detectStaleRenders(tmpDir);
    const summaryStale = stale.find(s => s.reason.includes('SUMMARY.md missing') && s.reason.includes('S01'));
    const uatStale = stale.find(s => s.reason.includes('UAT.md missing') && s.reason.includes('S01'));

    assert.ok(!!summaryStale, 'should detect missing S01-SUMMARY.md');
    assert.ok(!!uatStale, 'should detect missing S01-UAT.md');
  } finally {
    closeDatabase();
    cleanupDir(tmpDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════

