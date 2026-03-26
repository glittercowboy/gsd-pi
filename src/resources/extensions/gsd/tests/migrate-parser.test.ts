// Migration parser test suite
// Tests for parsing old .planning directories into typed PlanningProject structures.
// Uses synthetic fixture directories — no real .planning dirs needed.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parsePlanningDirectory } from '../migrate/parser.ts';
import { validatePlanningDirectory } from '../migrate/validator.ts';

import type { PlanningProject, ValidationResult } from '../migrate/types.ts';
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  return mkdtempSync(join(tmpdir(), 'gsd-migrate-test-'));
}

function createPlanningDir(base: string): string {
  const dir = join(base, '.planning');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, ...pathParts: string[]): (content: string) => void {
  return (content: string) => {
    const filePath = join(dir, ...pathParts);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content);
  };
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── Sample Fixtures ───────────────────────────────────────────────────────

const SAMPLE_ROADMAP = `# Project Roadmap

## Phases

- [x] 29 — Auth System
- [ ] 30 — Dashboard
- [ ] 31 — Notifications
`;

const SAMPLE_PROJECT = `# My Project

A sample project for testing the migration parser.

## Goals

- Build a thing
- Ship it
`;

const SAMPLE_REQUIREMENTS = `# Requirements

## Active

### R001 — User Authentication
- Status: active
- Description: Users must be able to log in.

### R002 — Dashboard View
- Status: active
- Description: Main dashboard page.

## Validated

### R003 — Session Management
- Status: validated
- Description: Sessions expire after 24h.

## Deferred

### R004 — OAuth Support
- Status: deferred
- Description: Third-party login.
`;

const SAMPLE_STATE = `# State

**Current Phase:** 30-dashboard
**Status:** in-progress
`;

const SAMPLE_CONFIG = JSON.stringify({
  projectName: 'test-project',
  version: '1.0',
});

const SAMPLE_PLAN_XML = `---
phase: "29-auth-system"
plan: "01"
type: "implementation"
wave: 1
depends_on: []
files_modified: [src/auth.ts, src/login.ts]
autonomous: true
must_haves:
  truths:
    - Users can log in
  artifacts:
    - src/auth.ts
  key_links: []
---

# 29-01: Implement Auth

<objective>
Build the authentication system with JWT tokens and session management.
</objective>

<tasks>
<task>Create auth middleware</task>
<task>Add login endpoint</task>
<task>Add logout endpoint</task>
</tasks>

<context>
The project needs authentication before any other features can be built.
Auth tokens use JWT with RS256 signing.
</context>

<verification>
- Login returns valid JWT
- Middleware rejects invalid tokens
- Logout invalidates session
</verification>

<success_criteria>
All auth endpoints respond correctly and tokens are validated.
</success_criteria>
`;

const SAMPLE_SUMMARY = `---
phase: "29-auth-system"
plan: "01"
subsystem: "auth"
tags:
  - authentication
  - security
requires: []
provides:
  - auth-middleware
  - jwt-validation
affects:
  - api-routes
tech-stack:
  - jsonwebtoken
  - express
key-files:
  - src/auth.ts
  - src/middleware/auth.ts
key-decisions:
  - Use RS256 for JWT signing
  - Store refresh tokens in DB
patterns-established:
  - Middleware-based auth
duration: "2h"
completed: "2026-01-15"
---

# 29-01: Auth Implementation Summary

Authentication system implemented with JWT tokens.

## What Happened

Built the auth middleware and login/logout endpoints.

## Files Modified

- \`src/auth.ts\` — Core auth logic
- \`src/middleware/auth.ts\` — Express middleware
`;

const SAMPLE_RESEARCH = `# Auth Research

## JWT vs Session Tokens

JWT tokens are stateless and work well for microservices.
Session tokens require server-side storage but are easier to revoke.

## Decision

Use JWT with short expiry + refresh tokens.
`;

const SAMPLE_MILESTONE_ROADMAP = `# Milestone v2.2 Roadmap

## Phases

- [x] 29 — Auth System
- [x] 30 — Dashboard
`;

const SAMPLE_MILESTONE_SECTIONED_ROADMAP = `# Project Roadmap

## v2.0 — Foundation

<details>
<summary>Completed</summary>

- [x] 01 — Project Setup
- [x] 02 — Database Schema

</details>

## v2.5 — Features

- [x] 29 — Auth System
- [ ] 30 — Dashboard
- [ ] 31 — Notifications
`;

const SAMPLE_QUICK_PLAN = `# 001: Fix Login Bug

## Description

Fix the login button not responding on mobile.

## Steps

1. Debug click handler
2. Fix event propagation
3. Test on mobile
`;

const SAMPLE_QUICK_SUMMARY = `# 001: Fix Login Bug — Summary

Fixed the login button by correcting the touch event handler.
`;

// ═══════════════════════════════════════════════════════════════════════════
// Test Groups
// ═══════════════════════════════════════════════════════════════════════════

  // ─── Test 1: Complete .planning directory ──────────────────────────────

test('Complete .planning directory with all file types', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);

      // Root files
      writeFileSync(join(planning, 'PROJECT.md'), SAMPLE_PROJECT);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);
      writeFileSync(join(planning, 'REQUIREMENTS.md'), SAMPLE_REQUIREMENTS);
      writeFileSync(join(planning, 'STATE.md'), SAMPLE_STATE);
      writeFileSync(join(planning, 'config.json'), SAMPLE_CONFIG);

      // Phase directory with plan, summary, research
      const phaseDir = join(planning, 'phases', '29-auth-system');
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(join(phaseDir, '29-01-PLAN.md'), SAMPLE_PLAN_XML);
      writeFileSync(join(phaseDir, '29-01-SUMMARY.md'), SAMPLE_SUMMARY);
      writeFileSync(join(phaseDir, '29-RESEARCH.md'), SAMPLE_RESEARCH);

      // Second phase directory
      const phase2Dir = join(planning, 'phases', '30-dashboard');
      mkdirSync(phase2Dir, { recursive: true });
      writeFileSync(join(phase2Dir, '30-01-PLAN.md'), `---
phase: "30-dashboard"
plan: "01"
type: "implementation"
wave: 1
depends_on: [29-01]
files_modified: []
autonomous: false
---

# 30-01: Build Dashboard

<objective>
Create the main dashboard view.
</objective>

<tasks>
<task>Create dashboard component</task>
<task>Add data fetching</task>
</tasks>

<context>
Dashboard needs auth to be complete first.
</context>
`);

      // Quick tasks
      const quickDir = join(planning, 'quick', '001-fix-login');
      mkdirSync(quickDir, { recursive: true });
      writeFileSync(join(quickDir, '001-PLAN.md'), SAMPLE_QUICK_PLAN);
      writeFileSync(join(quickDir, '001-SUMMARY.md'), SAMPLE_QUICK_SUMMARY);

      // Milestones
      const msDir = join(planning, 'milestones');
      mkdirSync(msDir, { recursive: true });
      writeFileSync(join(msDir, 'v2.2-ROADMAP.md'), SAMPLE_MILESTONE_ROADMAP);
      writeFileSync(join(msDir, 'v2.2-REQUIREMENTS.md'), 'Milestone requirements here.');

      // Research at root
      const researchDir = join(planning, 'research');
      mkdirSync(researchDir, { recursive: true });
      writeFileSync(join(researchDir, 'architecture.md'), '# Architecture Research\n\nNotes.');

      const project = await parsePlanningDirectory(planning);

      // Top-level structure
      assert.deepStrictEqual(project.path, planning, 'project.path matches');
      assert.ok(project.project !== null, 'PROJECT.md parsed');
      assert.ok(project.roadmap !== null, 'ROADMAP.md parsed');
      assert.ok(project.requirements.length > 0, 'requirements parsed');
      assert.ok(project.state !== null, 'STATE.md parsed');
      assert.ok(project.config !== null, 'config.json parsed');

      // Phases
      assert.ok('29-auth-system' in project.phases, 'phase 29 present');
      assert.ok('30-dashboard' in project.phases, 'phase 30 present');

      const phase29 = project.phases['29-auth-system'];
      assert.deepStrictEqual(phase29?.number, 29, 'phase 29 number');
      assert.deepStrictEqual(phase29?.slug, 'auth-system', 'phase 29 slug');
      assert.ok('01' in (phase29?.plans ?? {}), 'phase 29 has plan 01');
      assert.ok('01' in (phase29?.summaries ?? {}), 'phase 29 has summary 01');
      assert.ok((phase29?.research?.length ?? 0) > 0, 'phase 29 has research');

      // Plan content (XML-in-markdown)
      const plan29 = phase29?.plans?.['01'];
      assert.ok(plan29 !== undefined, 'plan 29-01 exists');
      assert.ok(plan29?.objective?.includes('authentication') ?? false, 'plan objective extracted');
      assert.ok((plan29?.tasks?.length ?? 0) >= 3, 'plan tasks extracted');
      assert.ok(plan29?.context?.includes('JWT') ?? false, 'plan context extracted');
      assert.ok(plan29?.verification !== '', 'plan verification extracted');
      assert.ok(plan29?.successCriteria !== '', 'plan success criteria extracted');

      // Plan frontmatter
      assert.deepStrictEqual(plan29?.frontmatter?.phase, '29-auth-system', 'plan frontmatter phase');
      assert.deepStrictEqual(plan29?.frontmatter?.plan, '01', 'plan frontmatter plan');
      assert.deepStrictEqual(plan29?.frontmatter?.type, 'implementation', 'plan frontmatter type');
      assert.deepStrictEqual(plan29?.frontmatter?.wave, 1, 'plan frontmatter wave');
      assert.deepStrictEqual(plan29?.frontmatter?.autonomous, true, 'plan frontmatter autonomous');

      // Summary content
      const summary29 = phase29?.summaries?.['01'];
      assert.ok(summary29 !== undefined, 'summary 29-01 exists');
      assert.deepStrictEqual(summary29?.frontmatter?.phase, '29-auth-system', 'summary frontmatter phase');
      assert.deepStrictEqual(summary29?.frontmatter?.plan, '01', 'summary frontmatter plan');
      assert.deepStrictEqual(summary29?.frontmatter?.subsystem, 'auth', 'summary frontmatter subsystem');
      assert.ok((summary29?.frontmatter?.tags?.length ?? 0) >= 2, 'summary frontmatter tags');
      assert.ok((summary29?.frontmatter?.provides?.length ?? 0) >= 2, 'summary frontmatter provides');
      assert.ok((summary29?.frontmatter?.affects?.length ?? 0) >= 1, 'summary frontmatter affects');
      assert.ok((summary29?.frontmatter?.['tech-stack']?.length ?? 0) >= 2, 'summary frontmatter tech-stack');
      assert.ok((summary29?.frontmatter?.['key-files']?.length ?? 0) >= 2, 'summary frontmatter key-files');
      assert.ok((summary29?.frontmatter?.['key-decisions']?.length ?? 0) >= 2, 'summary frontmatter key-decisions');
      assert.ok((summary29?.frontmatter?.['patterns-established']?.length ?? 0) >= 1, 'summary frontmatter patterns-established');
      assert.deepStrictEqual(summary29?.frontmatter?.duration, '2h', 'summary frontmatter duration');
      assert.deepStrictEqual(summary29?.frontmatter?.completed, '2026-01-15', 'summary frontmatter completed');

      // Quick tasks
      assert.ok(project.quickTasks.length >= 1, 'quick tasks parsed');
      assert.deepStrictEqual(project.quickTasks[0]?.number, 1, 'quick task number');
      assert.ok(project.quickTasks[0]?.plan !== null, 'quick task has plan');
      assert.ok(project.quickTasks[0]?.summary !== null, 'quick task has summary');

      // Milestones
      assert.ok(project.milestones.length >= 1, 'milestones parsed');

      // Root research
      assert.ok(project.research.length >= 1, 'root research parsed');

      // Config
      assert.deepStrictEqual(project.config?.projectName, 'test-project', 'config projectName');

      // State
      assert.ok(project.state?.currentPhase?.includes('30') ?? false, 'state current phase');
      assert.deepStrictEqual(project.state?.status, 'in-progress', 'state status');

      // Validation
      assert.deepStrictEqual(project.validation.valid, true, 'validation passes for complete dir');
      assert.deepStrictEqual(project.validation.issues.length, 0, 'no validation issues');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 2: Minimal .planning directory (only ROADMAP.md) ─────────────

test('Minimal .planning directory (only ROADMAP.md)', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const project = await parsePlanningDirectory(planning);

      assert.deepStrictEqual(project.project, null, 'minimal: PROJECT.md is null');
      assert.ok(project.roadmap !== null, 'minimal: ROADMAP.md parsed');
      assert.deepStrictEqual(project.requirements.length, 0, 'minimal: no requirements');
      assert.deepStrictEqual(project.state, null, 'minimal: no state');
      assert.deepStrictEqual(project.config, null, 'minimal: no config');
      assert.deepStrictEqual(Object.keys(project.phases).length, 0, 'minimal: no phases');
      assert.deepStrictEqual(project.quickTasks.length, 0, 'minimal: no quick tasks');
      assert.deepStrictEqual(project.milestones.length, 0, 'minimal: no milestones');
      assert.deepStrictEqual(project.research.length, 0, 'minimal: no research');
      assert.deepStrictEqual(project.validation.valid, true, 'minimal: validation passes');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 3: Missing directory → validation fatal error ────────────────

test('Missing directory → validation returns fatal error', async () => {
    const base = createFixtureBase();
    try {
      const result = await validatePlanningDirectory(join(base, 'nonexistent'));

      assert.deepStrictEqual(result.valid, false, 'missing dir: validation fails');
      assert.ok(result.issues.length > 0, 'missing dir: has issues');
      assert.ok(
        result.issues.some(i => i.severity === 'fatal'),
        'missing dir: has fatal issue'
      );
    } finally {
      cleanup(base);
    }
});

  // ─── Test 4: Duplicate phase numbers ───────────────────────────────────

test('Phase directory with duplicate numbers', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const phasesDir = join(planning, 'phases');
      mkdirSync(join(phasesDir, '45-core-infrastructure'), { recursive: true });
      mkdirSync(join(phasesDir, '45-logging-config'), { recursive: true });

      writeFileSync(
        join(phasesDir, '45-core-infrastructure', '45-01-PLAN.md'),
        '# Core Plan\n\n<objective>Core infra</objective>'
      );
      writeFileSync(
        join(phasesDir, '45-logging-config', '45-01-PLAN.md'),
        '# Logging Plan\n\n<objective>Logging config</objective>'
      );

      const project = await parsePlanningDirectory(planning);

      assert.ok('45-core-infrastructure' in project.phases, 'dup nums: core-infrastructure phase present');
      assert.ok('45-logging-config' in project.phases, 'dup nums: logging-config phase present');
      assert.deepStrictEqual(project.phases['45-core-infrastructure']?.number, 45, 'dup nums: both have number 45 (a)');
      assert.deepStrictEqual(project.phases['45-logging-config']?.number, 45, 'dup nums: both have number 45 (b)');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 5: XML-in-markdown plan parsing ──────────────────────────────

test('Plan file with XML-in-markdown', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const phaseDir = join(planning, 'phases', '29-auth-system');
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(join(phaseDir, '29-01-PLAN.md'), SAMPLE_PLAN_XML);

      const project = await parsePlanningDirectory(planning);
      const plan = project.phases['29-auth-system']?.plans?.['01'];

      assert.ok(plan !== undefined, 'xml plan: plan exists');
      assert.ok(plan?.objective?.includes('authentication') ?? false, 'xml plan: objective extracted');
      assert.ok((plan?.tasks?.length ?? 0) === 3, 'xml plan: 3 tasks extracted');
      assert.ok(plan?.tasks?.[0]?.includes('auth middleware') ?? false, 'xml plan: first task content');
      assert.ok(plan?.context?.includes('JWT') ?? false, 'xml plan: context extracted');
      assert.ok(plan?.verification?.includes('Login returns') ?? false, 'xml plan: verification extracted');
      assert.ok(plan?.successCriteria?.includes('endpoints respond') ?? false, 'xml plan: success criteria extracted');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 6: Summary file with YAML frontmatter ───────────────────────

test('Summary file with YAML frontmatter', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const phaseDir = join(planning, 'phases', '29-auth-system');
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(join(phaseDir, '29-01-SUMMARY.md'), SAMPLE_SUMMARY);

      const project = await parsePlanningDirectory(planning);
      const summary = project.phases['29-auth-system']?.summaries?.['01'];

      assert.ok(summary !== undefined, 'summary fm: summary exists');
      assert.deepStrictEqual(summary?.frontmatter?.phase, '29-auth-system', 'summary fm: phase');
      assert.deepStrictEqual(summary?.frontmatter?.plan, '01', 'summary fm: plan');
      assert.deepStrictEqual(summary?.frontmatter?.subsystem, 'auth', 'summary fm: subsystem');
      assert.deepStrictEqual(summary?.frontmatter?.tags, ['authentication', 'security'], 'summary fm: tags');
      assert.deepStrictEqual(summary?.frontmatter?.provides, ['auth-middleware', 'jwt-validation'], 'summary fm: provides');
      assert.deepStrictEqual(summary?.frontmatter?.affects, ['api-routes'], 'summary fm: affects');
      assert.deepStrictEqual(summary?.frontmatter?.['tech-stack'], ['jsonwebtoken', 'express'], 'summary fm: tech-stack');
      assert.deepStrictEqual(summary?.frontmatter?.['key-files'], ['src/auth.ts', 'src/middleware/auth.ts'], 'summary fm: key-files');
      assert.deepStrictEqual(summary?.frontmatter?.['key-decisions'], ['Use RS256 for JWT signing', 'Store refresh tokens in DB'], 'summary fm: key-decisions');
      assert.deepStrictEqual(summary?.frontmatter?.['patterns-established'], ['Middleware-based auth'], 'summary fm: patterns-established');
      assert.deepStrictEqual(summary?.frontmatter?.duration, '2h', 'summary fm: duration');
      assert.deepStrictEqual(summary?.frontmatter?.completed, '2026-01-15', 'summary fm: completed');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 7: Orphan summaries (no matching plan) ──────────────────────

test('Orphan summaries (no matching plan)', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const phaseDir = join(planning, 'phases', '45-logging-config');
      mkdirSync(phaseDir, { recursive: true });

      // Summaries without corresponding plans
      writeFileSync(join(phaseDir, '45-04-SUMMARY.md'), `---
phase: "45-logging-config"
plan: "04"
subsystem: "logging"
---

# 45-04 Summary

Orphan summary content.
`);
      writeFileSync(join(phaseDir, '45-05-SUMMARY.md'), `---
phase: "45-logging-config"
plan: "05"
subsystem: "logging"
---

# 45-05 Summary

Another orphan.
`);

      const project = await parsePlanningDirectory(planning);
      const phase = project.phases['45-logging-config'];

      assert.ok(phase !== undefined, 'orphan: phase exists');
      assert.deepStrictEqual(Object.keys(phase?.plans ?? {}).length, 0, 'orphan: no plans');
      assert.ok(Object.keys(phase?.summaries ?? {}).length >= 2, 'orphan: summaries preserved');
      assert.ok('04' in (phase?.summaries ?? {}), 'orphan: summary 04 present');
      assert.ok('05' in (phase?.summaries ?? {}), 'orphan: summary 05 present');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 8: .archive/ directory skipped ──────────────────────────────

test('.archive/ directory → skipped by default', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      // Normal phase
      const phaseDir = join(planning, 'phases', '29-auth-system');
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(join(phaseDir, '29-01-PLAN.md'), SAMPLE_PLAN_XML);

      // Archived phase (should be skipped)
      const archiveDir = join(planning, '.archive', 'v2.5-deploy', '29-old-auth');
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, '29-01-PLAN.md'), '# Archived plan');

      const project = await parsePlanningDirectory(planning);

      assert.ok('29-auth-system' in project.phases, 'archive: normal phase present');
      // Archive phases should not appear in the phases map
      assert.ok(!Object.keys(project.phases).some(k => k.includes('old-auth')), 'archive: archived phase not present');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 9: Quick tasks ──────────────────────────────────────────────

test('Quick tasks parsed', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      // Quick task 1
      const qt1 = join(planning, 'quick', '001-fix-login');
      mkdirSync(qt1, { recursive: true });
      writeFileSync(join(qt1, '001-PLAN.md'), SAMPLE_QUICK_PLAN);
      writeFileSync(join(qt1, '001-SUMMARY.md'), SAMPLE_QUICK_SUMMARY);

      // Quick task 2 (plan only, no summary)
      const qt2 = join(planning, 'quick', '002-update-deps');
      mkdirSync(qt2, { recursive: true });
      writeFileSync(join(qt2, '002-PLAN.md'), '# 002: Update Dependencies\n\nUpdate all deps.');

      const project = await parsePlanningDirectory(planning);

      assert.deepStrictEqual(project.quickTasks.length, 2, 'quick: 2 quick tasks');
      assert.deepStrictEqual(project.quickTasks[0]?.number, 1, 'quick: first task number');
      assert.deepStrictEqual(project.quickTasks[0]?.slug, 'fix-login', 'quick: first task slug');
      assert.ok(project.quickTasks[0]?.plan !== null, 'quick: first task has plan');
      assert.ok(project.quickTasks[0]?.summary !== null, 'quick: first task has summary');
      assert.deepStrictEqual(project.quickTasks[1]?.number, 2, 'quick: second task number');
      assert.ok(project.quickTasks[1]?.plan !== null, 'quick: second task has plan');
      assert.deepStrictEqual(project.quickTasks[1]?.summary, null, 'quick: second task has no summary');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 10: Roadmap with milestone sections and <details> ────────────

test('Roadmap with milestone sections and <details> blocks', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_MILESTONE_SECTIONED_ROADMAP);

      const project = await parsePlanningDirectory(planning);

      assert.ok(project.roadmap !== null, 'ms roadmap: roadmap parsed');
      assert.ok((project.roadmap?.milestones?.length ?? 0) >= 2, 'ms roadmap: has milestone sections');

      // Check collapsed milestone
      const v20 = project.roadmap?.milestones?.find(m => m.id.includes('2.0'));
      assert.ok(v20 !== undefined, 'ms roadmap: v2.0 milestone found');
      assert.deepStrictEqual(v20?.collapsed, true, 'ms roadmap: v2.0 is collapsed');
      assert.ok((v20?.phases?.length ?? 0) >= 2, 'ms roadmap: v2.0 has phases');
      assert.ok(v20?.phases?.every(p => p.done) ?? false, 'ms roadmap: v2.0 phases all done');

      // Check active milestone
      const v25 = project.roadmap?.milestones?.find(m => m.id.includes('2.5'));
      assert.ok(v25 !== undefined, 'ms roadmap: v2.5 milestone found');
      assert.deepStrictEqual(v25?.collapsed, false, 'ms roadmap: v2.5 is not collapsed');
      assert.ok((v25?.phases?.length ?? 0) >= 3, 'ms roadmap: v2.5 has phases');

      // Check completion state
      const phase29 = v25?.phases?.find(p => p.number === 29);
      assert.ok(phase29?.done === true, 'ms roadmap: phase 29 is done');
      const phase30 = v25?.phases?.find(p => p.number === 30);
      assert.ok(phase30?.done === false, 'ms roadmap: phase 30 is not done');
    } finally {
      cleanup(base);
    }
});

  // ─── Test 11: Non-standard phase files → extra files ──────────────────

test('Non-standard phase files → collected as extra files', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);

      const phaseDir = join(planning, 'phases', '36-attachment-system');
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(join(phaseDir, '36-01-PLAN.md'), '<objective>Attachments</objective>');
      writeFileSync(join(phaseDir, 'BASELINE.md'), '# Baseline\n\nBaseline measurements.');
      writeFileSync(join(phaseDir, 'BUNDLE-ANALYSIS.md'), '# Bundle Analysis\n\nResults.');
      writeFileSync(join(phaseDir, 'depcheck-results.txt'), 'unused: pkg-a, pkg-b');

      const project = await parsePlanningDirectory(planning);
      const phase = project.phases['36-attachment-system'];

      assert.ok(phase !== undefined, 'extra: phase exists');
      assert.ok((phase?.extraFiles?.length ?? 0) >= 3, 'extra: non-standard files collected');
      assert.ok(
        phase?.extraFiles?.some(f => f.fileName === 'BASELINE.md') ?? false,
        'extra: BASELINE.md collected'
      );
      assert.ok(
        phase?.extraFiles?.some(f => f.fileName === 'BUNDLE-ANALYSIS.md') ?? false,
        'extra: BUNDLE-ANALYSIS.md collected'
      );
      assert.ok(
        phase?.extraFiles?.some(f => f.fileName === 'depcheck-results.txt') ?? false,
        'extra: depcheck-results.txt collected'
      );
    } finally {
      cleanup(base);
    }
});

  // ─── Test 12: Validation — missing ROADMAP.md → warning (not fatal) ───

test('Validation: missing ROADMAP.md → warning (not fatal)', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      // Only PROJECT.md, no ROADMAP.md
      writeFileSync(join(planning, 'PROJECT.md'), SAMPLE_PROJECT);

      const result = await validatePlanningDirectory(planning);

      assert.deepStrictEqual(result.valid, true, 'no roadmap: validation still passes');
      assert.ok(
        result.issues.some(i => i.severity === 'warning' && i.file.includes('ROADMAP')),
        'no roadmap: warning issue mentions ROADMAP'
      );
    } finally {
      cleanup(base);
    }
});

  // ─── Test 13: Validation — missing PROJECT.md → warning ───────────────

test('Validation: missing PROJECT.md → warning', async () => {
    const base = createFixtureBase();
    try {
      const planning = createPlanningDir(base);
      writeFileSync(join(planning, 'ROADMAP.md'), SAMPLE_ROADMAP);
      // No PROJECT.md

      const result = await validatePlanningDirectory(planning);

      assert.deepStrictEqual(result.valid, true, 'no project: validation passes (warning only)');
      assert.ok(
        result.issues.some(i => i.severity === 'warning' && i.file.includes('PROJECT')),
        'no project: warning issue mentions PROJECT'
      );
    } finally {
      cleanup(base);
    }
});

