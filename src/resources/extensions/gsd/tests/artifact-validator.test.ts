/**
 * Tests for artifact-validator.ts — structural contract enforcement on GSD artifacts.
 *
 * Covers all five validators:
 *   - validateTaskSummary: frontmatter, verification_result, provides, key_files
 *   - validateSlicePlan: task entries, Must-Haves section
 *   - validateUatResult: verdict, Checks table
 *   - validateReassessment: meaningful body content
 *   - validateMilestoneSummary: verification_result, provides
 *
 * Includes backward compatibility test against real S01 UAT-RESULT artifact.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateTaskSummary,
  validateSlicePlan,
  validateUatResult,
  validateReassessment,
  validateMilestoneSummary,
} from '../artifact-validator.ts';
import type { ValidationResult } from '../artifact-validator.ts';
import { extractUatType, extractPlanRequirements } from '../files.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dir, '..', '..', '..', '..', '..');

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VALID_TASK_SUMMARY = `---
id: T01
parent: S01
milestone: M001
provides:
  - artifact-validator module with 5 validators
key_files:
  - src/resources/extensions/gsd/artifact-validator.ts
key_decisions:
  - Use synchronous validators
patterns_established:
  - ValidationResult return type
observability_surfaces:
  - none
duration: 45m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Create artifact-validator

**Built 5 artifact validators with comprehensive tests.**

## What Happened

Created the module.

## Verification

All tests pass.
`;

const VALID_SLICE_PLAN = `# S02: Artifact Validation Gates

**Goal:** Pipeline blocks on invalid artifacts.
**Demo:** Missing fields cause validation failure.

## Must-Haves

- Validators return structured errors
- Backward compatible with existing artifacts

## Tasks

- [ ] **T01: Create artifact-validator.ts** \`est:45m\`
  - Build the validators
- [ ] **T02: Wire into pipeline** \`est:30m\`
  - Integrate with verifyExpectedArtifact

## Files Likely Touched

- \`src/resources/extensions/gsd/artifact-validator.ts\`
`;

const VALID_UAT_RESULT = `---
sliceId: S01
uatType: artifact-driven
verdict: PASS
date: 2026-03-20
---

# UAT Result — S01

## Checks

| Check | Mode | Result | Notes |
|-------|------|--------|-------|
| TC1: Tests pass | runtime | PASS | All green |
| TC2: Backward compat | runtime | PASS | S01 validates |
`;

const VALID_REASSESSMENT = `---
milestone: M001
date: 2026-03-20
---

# Reassessment — M001

After completing S01, we discovered that template validation
needs to be tighter. The existing file-existence checks are
insufficient for catching placeholder-only artifacts.

New priorities:
- Add content validators for all artifact types
- Wire validators into the pipeline
- Ensure backward compatibility with existing artifacts
`;

const VALID_MILESTONE_SUMMARY = `---
id: M001
provides:
  - Auto-mode pipeline with artifact validation gates
key_decisions:
  - Synchronous validators for pipeline integration
patterns_established:
  - ValidationResult pattern
observability_surfaces:
  - none
duration: 2h
verification_result: passed
completed_at: 2026-03-20
---

# M001: Pipeline Integrity

**Hardened auto-mode pipeline with structural artifact validation.**

## What Happened

Built and integrated artifact validators.
`;

// ─── validateTaskSummary ───────────────────────────────────────────────────

describe('validateTaskSummary', () => {
  test('valid summary passes', () => {
    const result = validateTaskSummary(VALID_TASK_SUMMARY);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('missing frontmatter fails', () => {
    const content = '# T01: Some task\n\nNo frontmatter here.\n';
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes('frontmatter')));
  });

  test('missing verification_result fails', () => {
    const content = `---
id: T01
parent: S01
milestone: M001
provides:
  - something real
key_files:
  - src/foo.ts
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verification_result')));
  });

  test('empty verification_result fails', () => {
    const content = `---
id: T01
provides:
  - something
key_files:
  - src/foo.ts
verification_result:
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verification_result')));
  });

  test('placeholder-only provides fails', () => {
    const content = `---
id: T01
provides:
  - "{{whatThisTaskProvides}}"
key_files:
  - src/foo.ts
verification_result: passed
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('provides')));
  });

  test('empty key_files fails', () => {
    const content = `---
id: T01
provides:
  - real value
key_files: []
verification_result: passed
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('key_files')));
  });

  test('placeholder-only key_files fails', () => {
    const content = `---
id: T01
provides:
  - real value
key_files:
  - "{{filePath}}"
verification_result: passed
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('key_files')));
  });

  test('verification_result: untested passes (backward compat)', () => {
    const content = `---
id: T01
provides:
  - something real
key_files:
  - src/foo.ts
verification_result: untested
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('multiple errors reported simultaneously', () => {
    const content = `---
id: T01
provides: []
key_files: []
---

# T01: Task
`;
    const result = validateTaskSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3, `Expected at least 3 errors, got ${result.errors.length}: ${result.errors.join('; ')}`);
  });
});

// ─── validateSlicePlan ─────────────────────────────────────────────────────

describe('validateSlicePlan', () => {
  test('valid plan passes', () => {
    const result = validateSlicePlan(VALID_SLICE_PLAN);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('no task entries fails', () => {
    const content = `# S01: Some Slice

**Goal:** Do something.

## Must-Haves

- Real requirement

## Tasks

Nothing here.
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('task entries')));
  });

  test('placeholder-only Must-Haves fails', () => {
    const content = `# S01: Slice

## Must-Haves

- {{mustHave}}
- {{mustHave}}

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Must-Haves') && e.includes('placeholder')));
  });

  test('missing Must-Haves section fails', () => {
    const content = `# S01: Slice

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Must-Haves')));
  });

  test('plan with completed [x] tasks passes', () => {
    const content = `# S01: Slice

## Must-Haves

- Everything works

## Tasks

- [x] **T01: Done task** \`est:30m\`
- [ ] **T02: Pending task** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('plan with only [X] uppercase tasks passes', () => {
    const content = `# S01: Slice

## Must-Haves

- Everything works

## Tasks

- [X] **T01: Done task** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ─── validateUatResult ─────────────────────────────────────────────────────

describe('validateUatResult', () => {
  test('valid UAT passes', () => {
    const result = validateUatResult(VALID_UAT_RESULT);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('missing verdict fails', () => {
    const content = `---
sliceId: S01
uatType: artifact-driven
date: 2026-03-20
---

# UAT Result

## Checks

| Check | Mode | Result |
|-------|------|--------|
| TC1   | rt   | PASS   |
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verdict')));
  });

  test('empty verdict fails', () => {
    const content = `---
sliceId: S01
verdict:
---

# UAT Result

## Checks

| Check | Mode | Result |
|-------|------|--------|
| TC1   | rt   | PASS   |
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verdict')));
  });

  test('empty Checks table fails', () => {
    const content = `---
verdict: PASS
---

# UAT Result

## Checks

| Check | Mode | Result |
|-------|------|--------|
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Checks') && e.includes('no data rows')));
  });

  test('missing Checks section fails', () => {
    const content = `---
verdict: PASS
---

# UAT Result

Some text but no Checks section.
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Checks')));
  });

  test('verdict: FAIL passes (valid verdict)', () => {
    const content = `---
verdict: FAIL
---

# UAT Result

## Checks

| Check | Mode | Result |
|-------|------|--------|
| TC1   | rt   | FAIL   |
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('verdict: PARTIAL passes (valid verdict)', () => {
    const content = `---
verdict: PARTIAL
---

# UAT Result

## Checks

| Check | Mode | Result |
|-------|------|--------|
| TC1   | rt   | PASS   |
| TC2   | rt   | FAIL   |
`;
    const result = validateUatResult(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ─── validateReassessment ──────────────────────────────────────────────────

describe('validateReassessment', () => {
  test('valid reassessment passes', () => {
    const result = validateReassessment(VALID_REASSESSMENT);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('empty body fails', () => {
    const content = `---
milestone: M001
---
`;
    const result = validateReassessment(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('meaningful lines')));
  });

  test('only frontmatter + headings fails', () => {
    const content = `---
milestone: M001
---

# Reassessment

## Section One

## Section Two
`;
    const result = validateReassessment(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('meaningful lines')));
  });

  test('content with only placeholders fails', () => {
    const content = `---
milestone: M001
---

# Reassessment

{{placeholder1}}
{{placeholder2}}
`;
    const result = validateReassessment(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('meaningful lines')));
  });

  test('no frontmatter but real content passes', () => {
    const content = `After reviewing the milestone progress, we found three issues.
The pipeline needs artifact validation to prevent empty summaries.
The existing file-existence checks are not sufficient.
Adding content validators will solve the core problem.
`;
    const result = validateReassessment(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ─── validateMilestoneSummary ──────────────────────────────────────────────

describe('validateMilestoneSummary', () => {
  test('valid summary passes', () => {
    const result = validateMilestoneSummary(VALID_MILESTONE_SUMMARY);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('missing verification_result fails', () => {
    const content = `---
id: M001
provides:
  - something real
---

# M001: Milestone
`;
    const result = validateMilestoneSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('verification_result')));
  });

  test('placeholder-only provides fails', () => {
    const content = `---
id: M001
provides:
  - "{{whatThisMilestoneProvides}}"
verification_result: passed
---

# M001: Milestone
`;
    const result = validateMilestoneSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('provides')));
  });

  test('empty provides fails', () => {
    const content = `---
id: M001
provides: []
verification_result: passed
---

# M001: Milestone
`;
    const result = validateMilestoneSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('provides')));
  });

  test('missing frontmatter fails', () => {
    const content = '# M001: Milestone\n\nNo frontmatter.\n';
    const result = validateMilestoneSummary(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('frontmatter')));
  });
});

// ─── validateSlicePlan — requirements frontmatter ──────────────────────────

describe('validateSlicePlan — requirements frontmatter', () => {
  test('plan with requirements: frontmatter containing real IDs passes', () => {
    const content = `---
requirements:
  - R001
  - R003
---

# S01: Test Slice

**Goal:** Do something.

## Must-Haves

- Real requirement here

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('plan with requirements: containing only placeholders fails', () => {
    const content = `---
requirements:
  - "{{requirementId}}"
---

# S01: Test Slice

**Goal:** Do something.

## Must-Haves

- Real requirement here

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('requirements') && e.includes('placeholder')));
  });

  test('plan with empty requirements: (K004 — parses as []) fails', () => {
    const content = `---
requirements:
---

# S01: Test Slice

**Goal:** Do something.

## Must-Haves

- Real requirement here

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('requirements')));
  });

  test('plan without frontmatter at all (old format) passes — backward compat', () => {
    const content = `# S01: Test Slice

**Goal:** Do something.

## Must-Haves

- Real requirement here

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  test('plan with frontmatter but no requirements field passes', () => {
    const content = `---
some_other_field: value
---

# S01: Test Slice

**Goal:** Do something.

## Must-Haves

- Real requirement here

## Tasks

- [ ] **T01: Do thing** \`est:30m\`
`;
    const result = validateSlicePlan(content);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });
});

// ─── extractPlanRequirements ───────────────────────────────────────────────

describe('extractPlanRequirements', () => {
  test('extracts requirement IDs from frontmatter', () => {
    const content = `---
requirements:
  - R001
  - R003
  - R010
---

# S01: Slice
`;
    const result = extractPlanRequirements(content);
    assert.deepEqual(result, ['R001', 'R003', 'R010']);
  });

  test('filters out placeholders', () => {
    const content = `---
requirements:
  - R001
  - "{{requirementId}}"
---

# S01: Slice
`;
    const result = extractPlanRequirements(content);
    assert.deepEqual(result, ['R001']);
  });

  test('returns [] for no frontmatter', () => {
    const content = `# S01: Slice\n\nNo frontmatter.\n`;
    const result = extractPlanRequirements(content);
    assert.deepEqual(result, []);
  });

  test('returns [] for empty requirements field', () => {
    const content = `---
requirements:
---

# S01: Slice
`;
    const result = extractPlanRequirements(content);
    assert.deepEqual(result, []);
  });

  test('returns [] when requirements field absent', () => {
    const content = `---
other_field: value
---

# S01: Slice
`;
    const result = extractPlanRequirements(content);
    assert.deepEqual(result, []);
  });
});

// ─── extractUatType — frontmatter preference ──────────────────────────────

describe('extractUatType — frontmatter preference', () => {
  test('reads uat_type from frontmatter', () => {
    const content = `---
uat_type: artifact-driven
---

# S01: UAT

## UAT Type

- UAT mode: live-runtime
`;
    const result = extractUatType(content);
    assert.equal(result, 'artifact-driven');
  });

  test('falls back to body ## UAT Type when no frontmatter', () => {
    const content = `# S01: UAT

## UAT Type

- UAT mode: live-runtime
- Why: because
`;
    const result = extractUatType(content);
    assert.equal(result, 'live-runtime');
  });

  test('falls back to body when frontmatter has no uat_type', () => {
    const content = `---
other: value
---

# S01: UAT

## UAT Type

- UAT mode: human-experience
`;
    const result = extractUatType(content);
    assert.equal(result, 'human-experience');
  });

  test('returns mixed from frontmatter', () => {
    const content = `---
uat_type: mixed
---

# S01: UAT
`;
    const result = extractUatType(content);
    assert.equal(result, 'mixed');
  });

  test('returns undefined for unrecognised frontmatter value', () => {
    const content = `---
uat_type: unknown-type
---

# S01: UAT
`;
    const result = extractUatType(content);
    assert.equal(result, undefined);
  });
});

// ─── Backward Compatibility ────────────────────────────────────────────────

describe('backward compatibility', () => {
  test('S01 UAT-RESULT passes validateUatResult()', () => {
    const uatPath = join(projectRoot, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-UAT-RESULT.md');
    const content = readFileSync(uatPath, 'utf-8');
    const result = validateUatResult(content);
    assert.equal(result.valid, true, `S01 UAT-RESULT should validate but got errors: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  });
});
