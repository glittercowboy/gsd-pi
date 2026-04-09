// Migration command integration test
// Tests the pipeline functions as the command handler uses them:
// path resolution, validation gating, full parse→transform→preview→write→deriveState round-trip.
// Exercises pipeline modules directly — no TUI context dependency.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  validatePlanningDirectory,
  parsePlanningDirectory,
  transformToGSD,
  generatePreview,
  writeGSDDirectory,
} from '../../migrate/index.ts';
import { deriveState } from '../../state.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

const SAMPLE_PROJECT = `# Integration Test Project

A project used for command pipeline integration testing.

## Goals

- Test the full migration pipeline
`;

const SAMPLE_ROADMAP = `# Project Roadmap

## Phases

- [x] 10 — Foundation
- [ ] 20 — Features
`;

const SAMPLE_REQUIREMENTS = `# Requirements

## Active

### R001 — Core Pipeline
- Status: active
- Description: Pipeline must work end-to-end.

## Validated

### R002 — Output Format
- Status: validated
- Description: Output matches GSD format.
`;

const SAMPLE_STATE = `# State

**Current Phase:** 20-features
**Status:** in-progress
`;

const SAMPLE_CONFIG = JSON.stringify({
  projectName: 'pipeline-test',
  version: '1.0',
});

const SAMPLE_PLAN_10_01 = `---
phase: "10-foundation"
plan: "01"
type: "implementation"
wave: 1
depends_on: []
files_modified: [src/core.ts]
autonomous: true
must_haves:
  truths:
    - Core module works
  artifacts:
    - src/core.ts
  key_links: []
---

# 10-01: Build Foundation

<objective>
Set up the project foundation and core module.
</objective>

<tasks>
<task>Create core module</task>
<task>Add configuration loader</task>
</tasks>

<context>
Foundation work needed before features.
</context>

<verification>
- Core module loads
- Config is parsed
</verification>

<success_criteria>
Core is operational.
</success_criteria>
`;

const SAMPLE_SUMMARY_10_01 = `---
phase: "10-foundation"
plan: "01"
subsystem: "core"
tags:
  - foundation
requires: []
provides:
  - core-module
affects:
  - features
tech-stack:
  - typescript
key-files:
  - src/core.ts
key-decisions:
  - Use TypeScript strict mode
patterns-established:
  - Module pattern
duration: "1h"
completed: "2026-01-10"
---

# 10-01: Foundation Summary

Core module built and operational.

## What Happened

Created core module and configuration loader.

## Files Modified

- \`src/core.ts\` — Core module
`;

const SAMPLE_PLAN_20_01 = `---
phase: "20-features"
plan: "01"
type: "implementation"
wave: 1
depends_on: [10-01]
files_modified: []
autonomous: false
---

# 20-01: Build Feature A

<objective>
Implement the first feature.
</objective>

<tasks>
<task>Design feature API</task>
<task>Implement feature logic</task>
</tasks>

<context>
Depends on foundation work.
</context>
`;

function createCompleteFixture(): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-cmd-test-'));
  const planning = join(base, '.planning');
  mkdirSync(planning, { recursive: true });

  writeFileSync(join(planning, 'PROJECT.md'), SAMPLE_PROJECT);
  writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);
  writeFileSync(join(planning, 'REQUIREMENTS.md'), SAMPLE_REQUIREMENTS);
  writeFileSync(join(planning, 'STATE.md'), SAMPLE_STATE);
  writeFileSync(join(planning, 'config.json'), SAMPLE_CONFIG);

  // Phase 10: done — has plan + summary
  const phase10 = join(planning, 'phases', '10-foundation');
  mkdirSync(phase10, { recursive: true });
  writeFileSync(join(phase10, '10-01-PLAN.md'), SAMPLE_PLAN_10_01);
  writeFileSync(join(phase10, '10-01-SUMMARY.md'), SAMPLE_SUMMARY_10_01);

  // Phase 20: in-progress — has plan, no summary
  const phase20 = join(planning, 'phases', '20-features');
  mkdirSync(phase20, { recursive: true });
  writeFileSync(join(phase20, '20-01-PLAN.md'), SAMPLE_PLAN_20_01);

  return base;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

  // ─── Test 1: Path resolution — .planning appended when missing ─────────

test('Path resolution: .planning appended when source path lacks it', () => {
    const base = createCompleteFixture();
    try {
      // Simulate the command's path resolution logic
      let sourcePath = resolve(base); // no .planning suffix
      if (!sourcePath.endsWith('.planning')) {
        sourcePath = join(sourcePath, '.planning');
      }
      assert.ok(sourcePath.endsWith('.planning'), 'path-resolution: .planning appended');
      assert.ok(existsSync(sourcePath), 'path-resolution: appended path exists');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
});

  // ─── Test 2: Path resolution — .planning used as-is ────────────────────

test('Path resolution: .planning used as-is when already present', () => {
    const base = createCompleteFixture();
    try {
      const planningPath = join(base, '.planning');
      let sourcePath = resolve(planningPath);
      if (!sourcePath.endsWith('.planning')) {
        sourcePath = join(sourcePath, '.planning');
      }
      assert.deepStrictEqual(sourcePath, resolve(planningPath), 'path-resolution: .planning not double-appended');
      assert.ok(existsSync(sourcePath), 'path-resolution: direct path exists');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
});

  // ─── Test 3: Validation gating — non-existent path ─────────────────────

test('Validation gating: non-existent path returns invalid', async () => {
    const fakePath = join(tmpdir(), 'gsd-cmd-nonexistent-' + Date.now(), '.planning');
    const result = await validatePlanningDirectory(fakePath);
    assert.deepStrictEqual(result.valid, false, 'validation: non-existent path is invalid');
    assert.ok(result.issues.length > 0, 'validation: has issues for non-existent path');
    const hasFatal = result.issues.some(i => i.severity === 'fatal');
    assert.ok(hasFatal, 'validation: non-existent path has fatal issue');
});

  // ─── Test 4: Validation gating — valid fixture passes ──────────────────

test('Validation gating: valid fixture passes validation', async () => {
    const base = createCompleteFixture();
    try {
      const result = await validatePlanningDirectory(join(base, '.planning'));
      assert.ok(result.valid === true, 'validation: valid fixture passes');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
});

  // ─── Test 5: Full pipeline round-trip ──────────────────────────────────

test('Full pipeline: parse → transform → preview → write → deriveState', async () => {
    const base = createCompleteFixture();
    const writeTarget = mkdtempSync(join(tmpdir(), 'gsd-cmd-write-'));
    try {
      const planningPath = join(base, '.planning');

      // (a) Validate
      const validation = await validatePlanningDirectory(planningPath);
      assert.ok(validation.valid === true, 'pipeline: validation passes');

      // (b) Parse
      const parsed = await parsePlanningDirectory(planningPath);
      assert.ok(parsed.roadmap !== null, 'pipeline: roadmap parsed');
      assert.ok(Object.keys(parsed.phases).length >= 2, 'pipeline: phases parsed');

      // (c) Transform
      const project = transformToGSD(parsed);
      assert.ok(project.milestones.length >= 1, 'pipeline: has milestones');
      assert.ok(project.milestones[0].slices.length >= 1, 'pipeline: has slices');

      // Count totals for preview verification
      let totalTasks = 0;
      let doneTasks = 0;
      let totalSlices = 0;
      let doneSlices = 0;
      for (const m of project.milestones) {
        for (const s of m.slices) {
          totalSlices++;
          if (s.done) doneSlices++;
          for (const t of s.tasks) {
            totalTasks++;
            if (t.done) doneTasks++;
          }
        }
      }

      // (d) Preview — verify counts match project data
      const preview = generatePreview(project);
      assert.deepStrictEqual(preview.milestoneCount, project.milestones.length, 'pipeline: preview milestoneCount');
      assert.deepStrictEqual(preview.totalSlices, totalSlices, 'pipeline: preview totalSlices');
      assert.deepStrictEqual(preview.totalTasks, totalTasks, 'pipeline: preview totalTasks');
      assert.deepStrictEqual(preview.doneSlices, doneSlices, 'pipeline: preview doneSlices');
      assert.deepStrictEqual(preview.doneTasks, doneTasks, 'pipeline: preview doneTasks');

      // Completion percentages
      const expectedSlicePct = totalSlices > 0 ? Math.round((doneSlices / totalSlices) * 100) : 0;
      const expectedTaskPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
      assert.deepStrictEqual(preview.sliceCompletionPct, expectedSlicePct, 'pipeline: preview sliceCompletionPct');
      assert.deepStrictEqual(preview.taskCompletionPct, expectedTaskPct, 'pipeline: preview taskCompletionPct');

      // Requirements in preview
      assert.deepStrictEqual(preview.requirements.active, 1, 'pipeline: preview requirements active');
      assert.deepStrictEqual(preview.requirements.validated, 1, 'pipeline: preview requirements validated');
      assert.deepStrictEqual(preview.requirements.total, 2, 'pipeline: preview requirements total');

      // (e) Write
      const result = await writeGSDDirectory(project, writeTarget);
      assert.ok(result.paths.length > 0, 'pipeline: files written');

      // Key files exist
      const gsd = join(writeTarget, '.gsd');
      assert.ok(existsSync(join(gsd, 'PROJECT.md')), 'pipeline: PROJECT.md written');
      assert.ok(existsSync(join(gsd, 'STATE.md')), 'pipeline: STATE.md written');
      assert.ok(existsSync(join(gsd, 'REQUIREMENTS.md')), 'pipeline: REQUIREMENTS.md written');

      const m001 = join(gsd, 'milestones', 'M001');
      assert.ok(existsSync(join(m001, 'M001-ROADMAP.md')), 'pipeline: M001-ROADMAP.md written');
      assert.ok(existsSync(join(m001, 'M001-CONTEXT.md')), 'pipeline: M001-CONTEXT.md written');

      // At least one slice plan exists
      const s01Plan = join(m001, 'slices', 'S01', 'S01-PLAN.md');
      assert.ok(existsSync(s01Plan), 'pipeline: S01-PLAN.md written');

      // (f) deriveState — coherent state from written output
      console.log('  --- deriveState ---');
      const state = await deriveState(writeTarget);
      assert.ok(state.phase !== undefined, 'pipeline: deriveState returns phase');
      assert.ok(state.activeMilestone !== null, 'pipeline: deriveState has activeMilestone');
      assert.deepStrictEqual(state.activeMilestone!.id, 'M001', 'pipeline: deriveState activeMilestone is M001');
      assert.ok(state.progress!.slices !== undefined, 'pipeline: deriveState has slices progress');
      assert.ok(state.progress!.tasks !== undefined, 'pipeline: deriveState has tasks progress');

    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(writeTarget, { recursive: true, force: true });
    }
});

  // ─── Test 6: .gsd/ exists detection ────────────────────────────────────

test('.gsd/ exists detection', () => {
    const base = mkdtempSync(join(tmpdir(), 'gsd-cmd-exists-'));
    try {
      // No .gsd/ yet
      assert.ok(!existsSync(join(base, '.gsd')), 'exists-detection: .gsd absent initially');

      // Create .gsd/
      mkdirSync(join(base, '.gsd'), { recursive: true });
      assert.ok(existsSync(join(base, '.gsd')), 'exists-detection: .gsd detected after creation');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
});

