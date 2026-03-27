import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { formatDoctorReport, runGSDDoctor, summarizeDoctorIssues, filterDoctorIssues, selectDoctorScope, validateTitle } from "../../doctor.js";
const tmpBase = mkdtempSync(join(tmpdir(), "gsd-doctor-test-"));
const gsd = join(tmpBase, ".gsd");
const mDir = join(gsd, "milestones", "M001");
const sDir = join(mDir, "slices", "S01");
const tDir = join(sDir, "tasks");
mkdirSync(tDir, { recursive: true });

writeFileSync(join(mDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`
  > After this: demo works
`);

writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Demo Slice

**Goal:** Demo
**Demo:** Demo

## Must-Haves
- done

## Tasks
- [x] **T01: Implement thing** \`est:10m\`
  Task is complete.
`);

writeFileSync(join(tDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 10m
verification_result: passed
completed_at: 2026-03-09T00:00:00Z
---

# T01: Implement thing

**Done**

## What Happened
Implemented.

## Diagnostics
- log
`);

describe('doctor', async () => {
  test('doctor diagnose', async () => {
    const report = await runGSDDoctor(tmpBase, { fix: false });
    // Reconciliation issue codes have been removed — doctor should NOT report them
    assert.ok(!report.issues.some(issue => issue.code === "all_tasks_done_missing_slice_summary" as any), "does not report removed code all_tasks_done_missing_slice_summary");
    assert.ok(!report.issues.some(issue => issue.code === "all_tasks_done_missing_slice_uat" as any), "does not report removed code all_tasks_done_missing_slice_uat");
    assert.ok(!report.issues.some(issue => issue.code === "all_tasks_done_roadmap_not_checked" as any), "does not report removed code all_tasks_done_roadmap_not_checked");
  });

  test('doctor formatting', async () => {
    const report = await runGSDDoctor(tmpBase, { fix: false });
    const summary = summarizeDoctorIssues(report.issues);
    const scoped = filterDoctorIssues(report.issues, { scope: "M001/S01", includeWarnings: true });
    const text = formatDoctorReport(report, { scope: "M001/S01", includeWarnings: true, maxIssues: 5 });
    assert.ok(text.includes("Scope: M001/S01"), "formatted report shows scope");
  });

  test('doctor default scope', async () => {
    const scope = await selectDoctorScope(tmpBase);
    assert.deepStrictEqual(scope, "M001/S01", "default doctor scope targets the active slice");
  });

  test('doctor fix', async () => {
    const report = await runGSDDoctor(tmpBase, { fix: true });
    // With reconciliation removed, doctor no longer creates placeholder summaries,
    // UAT files, or marks checkboxes. It only applies infrastructure fixes.
    // The task checkbox marking (task_summary_without_done_checkbox) is also removed.
    // Just verify it doesn't crash and produces a report.
    assert.ok(report.issues !== undefined, "doctor produces a report with issues array");
  });

  after(() => rmSync(tmpBase, { recursive: true, force: true }));

  // ─── Milestone summary detection: missing summary ──────────────────────
  test('doctor detects missing milestone summary', async () => {
    const msBase = mkdtempSync(join(tmpdir(), "gsd-doctor-ms-test-"));
    const msGsd = join(msBase, ".gsd");
    const msMDir = join(msGsd, "milestones", "M001");
    const msSDir = join(msMDir, "slices", "S01");
    const msTDir = join(msSDir, "tasks");
    mkdirSync(msTDir, { recursive: true });

    // Roadmap with ALL slices [x] — milestone is complete by slice status
    writeFileSync(join(msMDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: done
`);

    // Slice has plan with all tasks done
    writeFileSync(join(msSDir, "S01-PLAN.md"), `# S01: Done Slice

**Goal:** Done
**Demo:** Done

## Tasks
- [x] **T01: Done Task** \`est:10m\`
  Done.
`);

    // Task summary exists
    writeFileSync(join(msTDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
---
# T01: Done
**Done**
## What Happened
Done.
`);

    // Slice summary exists (so slice-level checks pass)
    writeFileSync(join(msSDir, "S01-SUMMARY.md"), `---
id: S01
parent: M001
---
# S01: Done
`);

    // Slice UAT exists (so slice-level checks pass)
    writeFileSync(join(msSDir, "S01-UAT.md"), `# S01 UAT\nDone.\n`);

    // NO milestone summary — this is the condition we're detecting

    const report = await runGSDDoctor(msBase, { fix: false });
    assert.ok(
      report.issues.some(issue => issue.code === "all_slices_done_missing_milestone_summary"),
      "detects missing milestone summary when all slices are done"
    );
    const msIssue = report.issues.find(issue => issue.code === "all_slices_done_missing_milestone_summary");
    assert.deepStrictEqual(msIssue?.scope, "milestone", "milestone summary issue has scope 'milestone'");
    assert.deepStrictEqual(msIssue?.severity, "warning", "milestone summary issue has severity 'warning'");
    assert.deepStrictEqual(msIssue?.unitId, "M001", "milestone summary issue unitId is 'M001'");
    assert.ok(msIssue?.message?.includes("SUMMARY") ?? false, "milestone summary issue message mentions SUMMARY");

    rmSync(msBase, { recursive: true, force: true });
  });

  // ─── Milestone summary detection: summary present (no false positive) ──
  test('doctor does NOT flag milestone with summary', async () => {
    const msBase = mkdtempSync(join(tmpdir(), "gsd-doctor-ms-ok-test-"));
    const msGsd = join(msBase, ".gsd");
    const msMDir = join(msGsd, "milestones", "M001");
    const msSDir = join(msMDir, "slices", "S01");
    const msTDir = join(msSDir, "tasks");
    mkdirSync(msTDir, { recursive: true });

    // Roadmap with ALL slices [x]
    writeFileSync(join(msMDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [x] **S01: Done Slice** \`risk:low\` \`depends:[]\`
  > After this: done
`);

    writeFileSync(join(msSDir, "S01-PLAN.md"), `# S01: Done Slice

**Goal:** Done
**Demo:** Done

## Tasks
- [x] **T01: Done Task** \`est:10m\`
  Done.
`);

    writeFileSync(join(msTDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
---
# T01: Done
**Done**
## What Happened
Done.
`);

    writeFileSync(join(msSDir, "S01-SUMMARY.md"), `---
id: S01
parent: M001
---
# S01: Done
`);

    writeFileSync(join(msSDir, "S01-UAT.md"), `# S01 UAT\nDone.\n`);

    // Milestone summary EXISTS
    writeFileSync(join(msMDir, "M001-SUMMARY.md"), `# M001 Summary\n\nMilestone complete.`);

    const report = await runGSDDoctor(msBase, { fix: false });
    assert.ok(
      !report.issues.some(issue => issue.code === "all_slices_done_missing_milestone_summary"),
      "does NOT report missing milestone summary when summary exists"
    );

    rmSync(msBase, { recursive: true, force: true });
  });

  // ─── blocker_discovered_no_replan detection ────────────────────────────
  test('doctor detects blocker_discovered_no_replan', async () => {
    const bBase = mkdtempSync(join(tmpdir(), "gsd-doctor-blocker-test-"));
    const bGsd = join(bBase, ".gsd");
    const bMDir = join(bGsd, "milestones", "M001");
    const bSDir = join(bMDir, "slices", "S01");
    const bTDir = join(bSDir, "tasks");
    mkdirSync(bTDir, { recursive: true });

    writeFileSync(join(bMDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: stuff works
`);

    writeFileSync(join(bSDir, "S01-PLAN.md"), `# S01: Test Slice

**Goal:** Test
**Demo:** Test

## Tasks
- [x] **T01: First task** \`est:10m\`
  First task.

- [ ] **T02: Second task** \`est:10m\`
  Second task.
`);

    // Task summary with blocker_discovered: true
    writeFileSync(join(bTDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
provides: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
duration: 10m
verification_result: passed
completed_at: 2026-03-10T00:00:00Z
blocker_discovered: true
---

# T01: First task

**Found a blocker.**

## What Happened

Discovered an issue.
`);

    // No REPLAN.md — should trigger the issue
    const report = await runGSDDoctor(bBase, { fix: false });
    const blockerIssues = report.issues.filter(i => i.code === "blocker_discovered_no_replan");
    assert.ok(blockerIssues.length > 0, "detects blocker_discovered_no_replan");
    assert.deepStrictEqual(blockerIssues[0]?.severity, "warning", "blocker issue has warning severity");
    assert.deepStrictEqual(blockerIssues[0]?.scope, "slice", "blocker issue has slice scope");
    assert.ok(blockerIssues[0]?.message?.includes("T01") ?? false, "blocker issue message mentions T01");
    assert.ok(blockerIssues[0]?.message?.includes("S01") ?? false, "blocker issue message mentions S01");

    rmSync(bBase, { recursive: true, force: true });
  });

  // ─── blocker_discovered with REPLAN.md (no false positive) ─────────────
  test('doctor does NOT flag blocker when REPLAN.md exists', async () => {
    const bBase = mkdtempSync(join(tmpdir(), "gsd-doctor-blocker-ok-test-"));
    const bGsd = join(bBase, ".gsd");
    const bMDir = join(bGsd, "milestones", "M001");
    const bSDir = join(bMDir, "slices", "S01");
    const bTDir = join(bSDir, "tasks");
    mkdirSync(bTDir, { recursive: true });

    writeFileSync(join(bMDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [ ] **S01: Test Slice** \`risk:low\` \`depends:[]\`
  > After this: stuff works
`);

    writeFileSync(join(bSDir, "S01-PLAN.md"), `# S01: Test Slice

**Goal:** Test
**Demo:** Test

## Tasks
- [x] **T01: First task** \`est:10m\`
  First task.

- [ ] **T02: Second task** \`est:10m\`
  Second task.
`);

    writeFileSync(join(bTDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
blocker_discovered: true
completed_at: 2026-03-10T00:00:00Z
---

# T01: First task

**Found a blocker.**

## What Happened

Discovered an issue.
`);

    // REPLAN.md exists — should NOT trigger
    writeFileSync(join(bSDir, "S01-REPLAN.md"), `# Replan\n\nAlready replanned.`);

    const report = await runGSDDoctor(bBase, { fix: false });
    const blockerIssues = report.issues.filter(i => i.code === "blocker_discovered_no_replan");
    assert.deepStrictEqual(blockerIssues.length, 0, "no blocker_discovered_no_replan when REPLAN.md exists");

    rmSync(bBase, { recursive: true, force: true });
  });

  // ─── Must-have verification: all addressed → no issue ─────────────────
  test('doctor: done task with must-haves all addressed → no issue', async () => {
    const mhBase = mkdtempSync(join(tmpdir(), "gsd-doctor-mh-ok-"));
    const mhGsd = join(mhBase, ".gsd");
    const mhMDir = join(mhGsd, "milestones", "M001");
    const mhSDir = join(mhMDir, "slices", "S01");
    const mhTDir = join(mhSDir, "tasks");
    mkdirSync(mhTDir, { recursive: true });

    writeFileSync(join(mhMDir, "M001-ROADMAP.md"), `# M001: Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeFileSync(join(mhSDir, "S01-PLAN.md"), `# S01: Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [x] **T01: Implement** \`est:10m\`\n  Done.\n`);

    // Task plan with must-haves
    writeFileSync(join(mhTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Must-Haves\n\n- [ ] \`parseWidgets\` function exported\n- [ ] Unit tests pass with zero failures\n`);

    // Summary mentioning both must-haves
    writeFileSync(join(mhTDir, "T01-SUMMARY.md"), `---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01: Implement\n\n## What Happened\nAdded parseWidgets function. Unit tests pass with zero failures.\n`);

    const report = await runGSDDoctor(mhBase, { fix: false });
    assert.ok(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when all must-haves are addressed"
    );

    rmSync(mhBase, { recursive: true, force: true });
  });

  // ─── Must-have verification: not addressed → warning fired ───────────
  test('doctor: done task with must-haves NOT addressed → warning', async () => {
    const mhBase = mkdtempSync(join(tmpdir(), "gsd-doctor-mh-fail-"));
    const mhGsd = join(mhBase, ".gsd");
    const mhMDir = join(mhGsd, "milestones", "M001");
    const mhSDir = join(mhMDir, "slices", "S01");
    const mhTDir = join(mhSDir, "tasks");
    mkdirSync(mhTDir, { recursive: true });

    writeFileSync(join(mhMDir, "M001-ROADMAP.md"), `# M001: Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeFileSync(join(mhSDir, "S01-PLAN.md"), `# S01: Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [x] **T01: Implement** \`est:10m\`\n  Done.\n`);

    // Task plan with 3 must-haves
    writeFileSync(join(mhTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Must-Haves\n\n- [ ] \`parseWidgets\` function exported\n- [ ] \`countWidgets\` utility added\n- [ ] Full regression suite passes\n`);

    // Summary mentions only parseWidgets — the other two are missing
    writeFileSync(join(mhTDir, "T01-SUMMARY.md"), `---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01: Implement\n\n## What Happened\nAdded parseWidgets function.\n`);

    const report = await runGSDDoctor(mhBase, { fix: false });
    const mhIssue = report.issues.find(i => i.code === "task_done_must_haves_not_verified");
    assert.ok(!!mhIssue, "must-have issue is fired when summary doesn't address all must-haves");
    assert.deepStrictEqual(mhIssue?.severity, "warning", "must-have issue is warning severity");
    assert.deepStrictEqual(mhIssue?.scope, "task", "must-have issue scope is task");
    assert.ok(mhIssue?.message?.includes("3 must-haves") ?? false, "message mentions total must-have count");
    assert.ok(mhIssue?.message?.includes("only 1") ?? false, "message mentions addressed count");
    assert.deepStrictEqual(mhIssue?.fixable, false, "must-have issue is not fixable");

    rmSync(mhBase, { recursive: true, force: true });
  });

  // ─── Must-have verification: no task plan → no issue ─────────────────
  test('doctor: done task with no task plan file → no issue', async () => {
    const mhBase = mkdtempSync(join(tmpdir(), "gsd-doctor-mh-noplan-"));
    const mhGsd = join(mhBase, ".gsd");
    const mhMDir = join(mhGsd, "milestones", "M001");
    const mhSDir = join(mhMDir, "slices", "S01");
    const mhTDir = join(mhSDir, "tasks");
    mkdirSync(mhTDir, { recursive: true });

    writeFileSync(join(mhMDir, "M001-ROADMAP.md"), `# M001: Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeFileSync(join(mhSDir, "S01-PLAN.md"), `# S01: Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [x] **T01: Implement** \`est:10m\`\n  Done.\n`);

    // NO task plan file — just a summary
    writeFileSync(join(mhTDir, "T01-SUMMARY.md"), `---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01: Implement\n\n## What Happened\nDone.\n`);

    const report = await runGSDDoctor(mhBase, { fix: false });
    assert.ok(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when task plan file doesn't exist"
    );

    rmSync(mhBase, { recursive: true, force: true });
  });

  // ─── Must-have verification: plan exists but no Must-Haves section → no issue
  test('doctor: done task with plan but no Must-Haves section → no issue', async () => {
    const mhBase = mkdtempSync(join(tmpdir(), "gsd-doctor-mh-nosect-"));
    const mhGsd = join(mhBase, ".gsd");
    const mhMDir = join(mhGsd, "milestones", "M001");
    const mhSDir = join(mhMDir, "slices", "S01");
    const mhTDir = join(mhSDir, "tasks");
    mkdirSync(mhTDir, { recursive: true });

    writeFileSync(join(mhMDir, "M001-ROADMAP.md"), `# M001: Test\n\n## Slices\n- [ ] **S01: Slice** \`risk:low\` \`depends:[]\`\n  > After this: done\n`);
    writeFileSync(join(mhSDir, "S01-PLAN.md"), `# S01: Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [x] **T01: Implement** \`est:10m\`\n  Done.\n`);

    // Task plan with NO Must-Haves section
    writeFileSync(join(mhTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Steps\n\n1. Do the thing.\n\n## Verification\n\n- Run tests.\n`);

    writeFileSync(join(mhTDir, "T01-SUMMARY.md"), `---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01: Implement\n\n## What Happened\nDone.\n`);

    const report = await runGSDDoctor(mhBase, { fix: false });
    assert.ok(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when task plan has no Must-Haves section"
    );

    rmSync(mhBase, { recursive: true, force: true });
  });

  // ─── validateTitle: em dash and slash detection ────────────────────────
  test('validateTitle: returns null for clean titles', () => {
    assert.deepStrictEqual(validateTitle("Foundation"), null, "clean title passes");
    assert.deepStrictEqual(validateTitle("Build Core Systems"), null, "clean title with spaces passes");
    assert.deepStrictEqual(validateTitle("API v2 Integration"), null, "clean title with version passes");
    assert.deepStrictEqual(validateTitle(""), null, "empty title passes");
  });

  test('validateTitle: detects em dash', () => {
    const result = validateTitle("Foundation — Build Core");
    assert.ok(result !== null, "detects em dash in title");
    assert.ok(result!.includes("em/en dash"), "message mentions em/en dash");
  });

  test('validateTitle: detects en dash', () => {
    const result = validateTitle("Phase 1 – Phase 2");
    assert.ok(result !== null, "detects en dash in title");
    assert.ok(result!.includes("em/en dash"), "message mentions em/en dash for en dash");
  });

  test('validateTitle: detects forward slash', () => {
    const result = validateTitle("Client/Server");
    assert.ok(result !== null, "detects forward slash in title");
    assert.ok(result!.includes("forward slash"), "message mentions forward slash");
  });

  test('validateTitle: detects both em dash and slash', () => {
    const result = validateTitle("Client — Server/API");
    assert.ok(result !== null, "detects both delimiters");
    assert.ok(result!.includes("em/en dash"), "message mentions em/en dash");
    assert.ok(result!.includes("forward slash"), "message mentions forward slash");
  });

  // ─── doctor detects delimiter_in_title for milestone ───────────────────
  test('doctor detects em dash in milestone title', async () => {
    const dtBase = mkdtempSync(join(tmpdir(), "gsd-doctor-dt-test-"));
    const dtGsd = join(dtBase, ".gsd");
    const dtMDir = join(dtGsd, "milestones", "M001");
    const dtSDir = join(dtMDir, "slices", "S01");
    const dtTDir = join(dtSDir, "tasks");
    mkdirSync(dtTDir, { recursive: true });

    // Roadmap with em dash in milestone title
    writeFileSync(join(dtMDir, "M001-ROADMAP.md"), `# M001: Foundation — Build Core\n\n## Slices\n- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`);
    writeFileSync(join(dtSDir, "S01-PLAN.md"), `# S01: Demo Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T01: Implement** \`est:10m\`\n  Task.\n`);
    writeFileSync(join(dtTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Steps\n\n1. Do the thing.\n`);

    const report = await runGSDDoctor(dtBase, { fix: false });
    const dtIssues = report.issues.filter(i => i.code === "delimiter_in_title");
    assert.ok(dtIssues.length >= 1, "detects delimiter_in_title for milestone with em dash");
    const milestoneIssue = dtIssues.find(i => i.scope === "milestone");
    assert.ok(milestoneIssue !== undefined, "delimiter issue has milestone scope");
    assert.deepStrictEqual(milestoneIssue?.severity, "warning", "delimiter issue has warning severity");
    assert.deepStrictEqual(milestoneIssue?.unitId, "M001", "delimiter issue unitId is M001");
    assert.ok(milestoneIssue?.message?.includes("em/en dash") ?? false, "issue message mentions em/en dash");
    assert.deepStrictEqual(milestoneIssue?.fixable, true, "delimiter issue is auto-fixable");

    rmSync(dtBase, { recursive: true, force: true });
  });

  // ─── doctor detects delimiter_in_title for slice ────────────────────────
  test('doctor detects em dash in slice title', async () => {
    const dtBase = mkdtempSync(join(tmpdir(), "gsd-doctor-dt-slice-"));
    const dtGsd = join(dtBase, ".gsd");
    const dtMDir = join(dtGsd, "milestones", "M001");
    const dtSDir = join(dtMDir, "slices", "S01");
    const dtTDir = join(dtSDir, "tasks");
    mkdirSync(dtTDir, { recursive: true });

    // Roadmap with em dash in slice title (milestone title is clean)
    writeFileSync(join(dtMDir, "M001-ROADMAP.md"), `# M001: Clean Milestone\n\n## Slices\n- [ ] **S01: Core — Foundation** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`);
    writeFileSync(join(dtSDir, "S01-PLAN.md"), `# S01: Core — Foundation\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T01: Implement** \`est:10m\`\n  Task.\n`);
    writeFileSync(join(dtTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Steps\n\n1. Do the thing.\n`);

    const report = await runGSDDoctor(dtBase, { fix: false });
    const dtIssues = report.issues.filter(i => i.code === "delimiter_in_title");
    assert.ok(dtIssues.length >= 1, "detects delimiter_in_title for slice with em dash");
    const sliceIssue = dtIssues.find(i => i.scope === "slice");
    assert.ok(sliceIssue !== undefined, "delimiter issue has slice scope");
    assert.deepStrictEqual(sliceIssue?.severity, "warning", "slice delimiter issue has warning severity");
    assert.deepStrictEqual(sliceIssue?.unitId, "M001/S01", "slice delimiter issue unitId is M001/S01");

    rmSync(dtBase, { recursive: true, force: true });
  });

  // ─── doctor does NOT flag clean titles ──────────────────────────────────
  test('doctor does NOT flag milestone with clean title', async () => {
    const dtBase = mkdtempSync(join(tmpdir(), "gsd-doctor-dt-clean-"));
    const dtGsd = join(dtBase, ".gsd");
    const dtMDir = join(dtGsd, "milestones", "M001");
    const dtSDir = join(dtMDir, "slices", "S01");
    const dtTDir = join(dtSDir, "tasks");
    mkdirSync(dtTDir, { recursive: true });

    // Roadmap with clean titles (no delimiters)
    writeFileSync(join(dtMDir, "M001-ROADMAP.md"), `# M001: Foundation Build Core\n\n## Slices\n- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`);
    writeFileSync(join(dtSDir, "S01-PLAN.md"), `# S01: Demo Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T01: Implement** \`est:10m\`\n  Task.\n`);
    writeFileSync(join(dtTDir, "T01-PLAN.md"), `# T01: Implement\n\n## Steps\n\n1. Do the thing.\n`);

    const report = await runGSDDoctor(dtBase, { fix: false });
    const dtIssues = report.issues.filter(i => i.code === "delimiter_in_title");
    assert.deepStrictEqual(dtIssues.length, 0, "no delimiter_in_title issues for clean titles");

    rmSync(dtBase, { recursive: true, force: true });
  });

  // ─── unresolvable_dependency: range syntax dep warns ─────────────────
  test('doctor: unresolvable_dependency warns for leftover range ID', async () => {
    // Simulate a roadmap where expandDependencies did NOT expand (pre-fix stored artifact)
    // by writing a dep that looks like a range but doesn't match any real slice.
    const base = mkdtempSync(join(tmpdir(), "gsd-doctor-udep-"));
    const mDir2 = join(base, ".gsd", "milestones", "M001");
    const sDir2 = join(mDir2, "slices", "S01");
    const tDir2 = join(sDir2, "tasks");
    mkdirSync(tDir2, { recursive: true });
    writeFileSync(join(mDir2, "M001-ROADMAP.md"), [
      "# M001: Test",
      "",
      "## Slices",
      "- [x] **S01: Done** `risk:low` `depends:[]`",
      "  > After this: done",
      "- [ ] **S02: Blocked** `risk:low` `depends:[S99]`",
      "  > After this: also done",
    ].join("\n") + "\n");
    writeFileSync(join(sDir2, "S01-PLAN.md"), "# S01\n\n**Goal:** g\n**Demo:** d\n\n## Tasks\n- [x] **T01: t** `est:5m`\n");
    writeFileSync(join(tDir2, "T01-SUMMARY.md"), "---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01\n## What Happened\nDone.\n");

    const r = await runGSDDoctor(base, { fix: false });
    const udepIssues = r.issues.filter(i => i.code === "unresolvable_dependency");
    assert.ok(udepIssues.length > 0, "unresolvable_dependency fires for unknown dep S99");
    assert.deepStrictEqual(udepIssues[0]?.severity, "warning", "severity is warning");
    assert.ok(udepIssues[0]?.message.includes("S99"), "message names the bad dep");

    rmSync(base, { recursive: true, force: true });
  });

  // ─── unresolvable_dependency: valid deps do not warn ─────────────────
  test('doctor: no unresolvable_dependency for valid deps', async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-doctor-udep-ok-"));
    const mDir2 = join(base, ".gsd", "milestones", "M001");
    const sDir2 = join(mDir2, "slices", "S01");
    const tDir2 = join(sDir2, "tasks");
    mkdirSync(tDir2, { recursive: true });
    writeFileSync(join(mDir2, "M001-ROADMAP.md"), [
      "# M001: Test",
      "",
      "## Slices",
      "- [x] **S01: Done** `risk:low` `depends:[]`",
      "  > After this: done",
      "- [ ] **S02: Next** `risk:low` `depends:[S01]`",
      "  > After this: next done",
    ].join("\n") + "\n");
    writeFileSync(join(sDir2, "S01-PLAN.md"), "# S01\n\n**Goal:** g\n**Demo:** d\n\n## Tasks\n- [x] **T01: t** `est:5m`\n");
    writeFileSync(join(tDir2, "T01-SUMMARY.md"), "---\nid: T01\nparent: S01\nmilestone: M001\n---\n# T01\n## What Happened\nDone.\n");

    const r = await runGSDDoctor(base, { fix: false });
    const udepIssues = r.issues.filter(i => i.code === "unresolvable_dependency");
    assert.deepStrictEqual(udepIssues.length, 0, "no unresolvable_dependency for valid S01 dep");

    rmSync(base, { recursive: true, force: true });
  });
});
