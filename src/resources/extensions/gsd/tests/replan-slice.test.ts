import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { parseSummary } from '../files.ts';
import { deriveState } from '../state.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreePromptsDir = join(__dirname, '..', 'prompts');

/**
 * Load a prompt template from the worktree prompts directory
 * and apply variable substitution (mirrors loadPrompt logic).
 */
function loadPromptFromWorktree(name: string, vars: Record<string, string> = {}): string {
  const path = join(worktreePromptsDir, `${name}.md`);
  let content = readFileSync(path, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content.trim();
}

const { assertEq, assertTrue, report } = createTestContext();
// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-replan-test-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  return base;
}

function writeRoadmap(base: string, mid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-ROADMAP.md`), content);
}

function writePlan(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, `${sid}-PLAN.md`), content);
}

function writeTaskSummary(base: string, mid: string, sid: string, tid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid, 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-SUMMARY.md`), content);
}

function writeReplanFile(base: string, mid: string, sid: string, content: string): void {
  const dir = join(base, '.gsd', 'milestones', mid, 'slices', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-REPLAN.md`), content);
}

/** Standard roadmap with one slice having no dependencies */
const ROADMAP_ONE_SLICE = `# M001: Test Milestone

**Vision:** Test vision.

## Slices

- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: stuff works
`;

/** Plan with T01 done, T02 not done */
function makePlanT01DoneT02Pending(): string {
  return `# S01: Test Slice

**Goal:** Do things.
**Demo:** It works.

## Tasks

- [x] **T01: First task** \`est:15m\`
  First task description.

- [ ] **T02: Second task** \`est:15m\`
  Second task description.
`;
}

/** Plan with T01 and T02 done, T03 not done */
function makePlanT01T02DoneT03Pending(): string {
  return `# S01: Test Slice

**Goal:** Do things.
**Demo:** It works.

## Tasks

- [x] **T01: First task** \`est:15m\`
  First task description.

- [x] **T02: Second task** \`est:15m\`
  Second task description.

- [ ] **T03: Third task** \`est:15m\`
  Third task description.
`;
}

/** Minimal task summary with blocker_discovered flag */
function makeTaskSummary(tid: string, blockerDiscovered: boolean): string {
  return `---
id: ${tid}
parent: S01
milestone: M001
provides: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
duration: 15min
verification_result: passed
completed_at: 2025-03-10T12:00:00Z
blocker_discovered: ${blockerDiscovered}
---

# ${tid}: Test Task

**Did something.**

## What Happened

Work was done.
`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser Extraction: blocker_discovered
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== parseSummary: blocker_discovered true (string) ===');
{
  const content = `---
id: T01
parent: S03
milestone: M002
blocker_discovered: true
completed_at: 2025-03-10T12:00:00Z
---

# T01: Test Task

**One-liner.**

## What Happened

Found a blocker.
`;

  const s = parseSummary(content);
  assertEq(s.frontmatter.blocker_discovered, true, 'blocker_discovered: true (string) extracts as true');
}

console.log('\n=== parseSummary: blocker_discovered false (string) ===');
{
  const content = `---
id: T02
parent: S03
milestone: M002
blocker_discovered: false
completed_at: 2025-03-10T12:00:00Z
---

# T02: Normal Task

**One-liner.**

## What Happened

No blocker.
`;

  const s = parseSummary(content);
  assertEq(s.frontmatter.blocker_discovered, false, 'blocker_discovered: false extracts as false');
}

console.log('\n=== parseSummary: blocker_discovered missing (defaults to false) ===');
{
  const content = `---
id: T03
parent: S03
milestone: M002
completed_at: 2025-03-10T12:00:00Z
---

# T03: No Blocker Field

**One-liner.**

## What Happened

No blocker field at all.
`;

  const s = parseSummary(content);
  assertEq(s.frontmatter.blocker_discovered, false, 'blocker_discovered missing defaults to false');
}

console.log('\n=== parseSummary: blocker_discovered true (boolean from YAML) ===');
{
  // YAML parsers may deliver `true` as a boolean rather than the string "true"
  // We test this via a summary that has blocker_discovered: true with no quotes
  // The YAML parser in parseFrontmatterMap may return boolean true directly
  const content = `---
id: T04
parent: S03
milestone: M002
blocker_discovered: true
completed_at: 2025-03-10T12:00:00Z
---

# T04: Boolean True

**One-liner.**

## What Happened

Blocker as boolean.
`;

  const s = parseSummary(content);
  assertEq(s.frontmatter.blocker_discovered, true, 'blocker_discovered: true (YAML boolean) extracts as true');
}

console.log('\n=== parseSummary: blocker_discovered with full frontmatter ===');
{
  const content = `---
id: T05
parent: S03
milestone: M002
provides:
  - something
requires: []
affects: []
key_files:
  - files.ts
key_decisions: []
patterns_established: []
drill_down_paths: []
observability_surfaces: []
duration: 15min
verification_result: passed
completed_at: 2025-03-10T12:00:00Z
blocker_discovered: true
---

# T05: Full Frontmatter With Blocker

**Found an architectural mismatch.**

## What Happened

The API doesn't support what we assumed.

## Deviations

Major deviation from plan.

## Files Created/Modified

- \`files.ts\` — attempted changes
`;

  const s = parseSummary(content);
  assertEq(s.frontmatter.blocker_discovered, true, 'blocker_discovered true with full frontmatter');
  assertEq(s.frontmatter.id, 'T05', 'other fields still parse correctly alongside blocker_discovered');
  assertEq(s.frontmatter.duration, '15min', 'duration still parsed');
  assertEq(s.frontmatter.provides[0], 'something', 'provides still parsed');
}

// ═══════════════════════════════════════════════════════════════════════════
// State Detection: replanning-slice phase
// ═══════════════════════════════════════════════════════════════════════════

// (a) blocker found + no REPLAN.md → replanning-slice
console.log('\n=== deriveState: blocker found, no REPLAN → replanning-slice ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', true));

  const state = await deriveState(base);
  assertEq(state.phase, 'replanning-slice', 'phase is replanning-slice when blocker found and no REPLAN.md');
  assertTrue(state.nextAction.includes('T01'), 'nextAction mentions blocker task T01');
  assertTrue(state.nextAction.includes('blocker_discovered'), 'nextAction mentions blocker_discovered');
  assertEq(state.activeTask?.id, 'T02', 'activeTask is still T02 (the next incomplete task)');
  assertTrue(state.blockers.length > 0, 'blockers array is non-empty');
  rmSync(base, { recursive: true, force: true });
}

// (b) blocker found + REPLAN.md exists → executing (loop protection)
console.log('\n=== deriveState: blocker found + REPLAN exists → executing (loop protection) ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', true));
  writeReplanFile(base, 'M001', 'S01', '# Replan\n\nAlready replanned.');

  const state = await deriveState(base);
  assertEq(state.phase, 'executing', 'phase is executing when REPLAN.md exists (loop protection)');
  assertEq(state.activeTask?.id, 'T02', 'activeTask is T02');
  rmSync(base, { recursive: true, force: true });
}

// (c) no blocker → executing
console.log('\n=== deriveState: no blocker in completed tasks → executing ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', false));

  const state = await deriveState(base);
  assertEq(state.phase, 'executing', 'phase is executing when no blocker found');
  assertEq(state.activeTask?.id, 'T02', 'activeTask is T02');
  rmSync(base, { recursive: true, force: true });
}

// (d) multiple completed tasks, one with blocker → replanning-slice
console.log('\n=== deriveState: multiple completed tasks, one blocker → replanning-slice ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01T02DoneT03Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', false));
  writeTaskSummary(base, 'M001', 'S01', 'T02', makeTaskSummary('T02', true));

  const state = await deriveState(base);
  assertEq(state.phase, 'replanning-slice', 'phase is replanning-slice when T02 has blocker');
  assertTrue(state.nextAction.includes('T02'), 'nextAction mentions blocker task T02');
  assertEq(state.activeTask?.id, 'T03', 'activeTask is T03 (next incomplete)');
  rmSync(base, { recursive: true, force: true });
}

// (e) completed task with no summary file → executing (gracefully skipped)
console.log('\n=== deriveState: completed task with no summary file → executing ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  // No summary file written for T01

  const state = await deriveState(base);
  assertEq(state.phase, 'executing', 'phase is executing when completed task has no summary');
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt: replan-slice template loading and substitution
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== prompt: replan-slice template loads and substitutes variables ===');
{
  const prompt = loadPromptFromWorktree('replan-slice', {
    workingDirectory: '/tmp/test-project',
    milestoneId: 'M001',
    sliceId: 'S01',
    sliceTitle: 'Test Slice',
    slicePath: '.gsd/milestones/M001/slices/S01',
    planPath: '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    inlinedContext: '## Inlined Context\n\nTest context here.',
  });

  assertTrue(prompt.includes('M001'), 'prompt contains milestoneId');
  assertTrue(prompt.includes('S01'), 'prompt contains sliceId');
  assertTrue(prompt.includes('Test Slice'), 'prompt contains sliceTitle');
  assertTrue(prompt.includes('.gsd/milestones/M001/slices/S01/S01-PLAN.md'), 'prompt contains planPath');
  assertTrue(prompt.includes('Test context here'), 'prompt contains inlined context');
}

console.log('\n=== prompt: replan-slice contains preserve-completed-tasks instruction ===');
{
  const prompt = loadPromptFromWorktree('replan-slice', {
    workingDirectory: '/tmp/test-project',
    milestoneId: 'M001',
    sliceId: 'S01',
    sliceTitle: 'Test Slice',
    slicePath: '.gsd/milestones/M001/slices/S01',
    planPath: '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    blockerTaskId: 'T01',
    replanPath: '.gsd/milestones/M001/slices/S01/S01-REPLAN.md',
    inlinedContext: '',
  });

  assertTrue(prompt.includes('Do NOT renumber or remove completed tasks'), 'prompt contains preserve-completed-tasks instruction');
  assertTrue(prompt.includes('[x]'), 'prompt mentions [x] checkmarks');
  assertTrue(prompt.includes('REPLAN'), 'prompt references replan output path');
  assertTrue(prompt.includes('blocker_discovered'), 'prompt mentions blocker_discovered');
}

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch: diagnoseExpectedArtifact for replan-slice
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== dispatch: diagnoseExpectedArtifact returns REPLAN.md path ===');
{
  // We can't import diagnoseExpectedArtifact directly (it's not exported),
  // but we can verify the prompt template has the right structure and
  // the state machine routes correctly. The diagnose function is integration-tested
  // via the dispatch chain. We verify indirectly via state phase detection.

  // Verify state correctly routes to replanning-slice phase
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', true));

  const state = await deriveState(base);
  assertEq(state.phase, 'replanning-slice', 'dispatch: state routes to replanning-slice when blocker found');
  assertTrue(state.activeSlice?.id === 'S01', 'dispatch: activeSlice is S01');
  rmSync(base, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// Display Functions: unitVerb, unitPhaseLabel, peekNext entries
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== display: replan-slice prompt template has correct unit header ===');
{
  const prompt = loadPromptFromWorktree('replan-slice', {
    workingDirectory: '/tmp/test-project',
    milestoneId: 'M001',
    sliceId: 'S01',
    sliceTitle: 'Test Slice',
    slicePath: '.gsd/milestones/M001/slices/S01',
    planPath: '.gsd/milestones/M001/slices/S01/S01-PLAN.md',
    blockerTaskId: 'T01',
    inlinedContext: '',
  });

  assertTrue(prompt.includes('UNIT: Replan Slice'), 'prompt has Replan Slice unit header');
  assertTrue(prompt.includes('Slice S01 replanned'), 'prompt has completion message');
}

// ═══════════════════════════════════════════════════════════════════════════
// Doctor: blocker_discovered_no_replan diagnostics
// ═══════════════════════════════════════════════════════════════════════════

import { runGSDDoctor } from '../doctor.ts';
import { createTestContext } from './test-helpers.ts';

// (a) blocker + no REPLAN.md → issue emitted
console.log('\n=== doctor: blocker + no REPLAN.md → blocker_discovered_no_replan issue ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', true));

  const report = await runGSDDoctor(base, { fix: false, scope: 'M001/S01' });
  const blockerIssues = report.issues.filter(i => i.code === 'blocker_discovered_no_replan');
  assertTrue(blockerIssues.length > 0, 'doctor emits blocker_discovered_no_replan when blocker + no REPLAN');
  assertTrue(blockerIssues[0]?.message.includes('T01'), 'issue message mentions the blocker task T01');
  assertEq(blockerIssues[0]?.severity, 'warning', 'blocker_discovered_no_replan is warning severity');
  assertEq(blockerIssues[0]?.scope, 'slice', 'blocker_discovered_no_replan has slice scope');
  rmSync(base, { recursive: true, force: true });
}

// (b) blocker + REPLAN.md exists → no issue
console.log('\n=== doctor: blocker + REPLAN.md exists → no blocker_discovered_no_replan issue ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', true));
  writeReplanFile(base, 'M001', 'S01', '# Replan\n\nAlready replanned.');

  const report = await runGSDDoctor(base, { fix: false, scope: 'M001/S01' });
  const blockerIssues = report.issues.filter(i => i.code === 'blocker_discovered_no_replan');
  assertEq(blockerIssues.length, 0, 'no blocker_discovered_no_replan when REPLAN.md exists');
  rmSync(base, { recursive: true, force: true });
}

// (c) no blocker → no issue
console.log('\n=== doctor: no blocker → no blocker_discovered_no_replan issue ===');
{
  const base = createFixtureBase();
  writeRoadmap(base, 'M001', ROADMAP_ONE_SLICE);
  writePlan(base, 'M001', 'S01', makePlanT01DoneT02Pending());
  writeTaskSummary(base, 'M001', 'S01', 'T01', makeTaskSummary('T01', false));

  const report = await runGSDDoctor(base, { fix: false, scope: 'M001/S01' });
  const blockerIssues = report.issues.filter(i => i.code === 'blocker_discovered_no_replan');
  assertEq(blockerIssues.length, 0, 'no blocker_discovered_no_replan when no blocker');
  rmSync(base, { recursive: true, force: true });
}

report();
