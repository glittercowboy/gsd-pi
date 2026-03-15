import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { formatDoctorReport, runGSDDoctor, summarizeDoctorIssues, filterDoctorIssues, selectDoctorScope, validateTitle } from "../doctor.js";
import { createTestContext } from './test-helpers.ts';

const { assertEq, assertTrue, report } = createTestContext();
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

async function main(): Promise<void> {
  console.log("\n=== doctor diagnose ===");
  {
    const report = await runGSDDoctor(tmpBase, { fix: false });
    assertTrue(!report.ok, "report is not ok when completion artifacts are missing");
    assertTrue(report.issues.some(issue => issue.code === "all_tasks_done_missing_slice_summary"), "detects missing slice summary");
    assertTrue(report.issues.some(issue => issue.code === "all_tasks_done_missing_slice_uat"), "detects missing slice UAT");
  }

  console.log("\n=== doctor formatting ===");
  {
    const report = await runGSDDoctor(tmpBase, { fix: false });
    const summary = summarizeDoctorIssues(report.issues);
    assertEq(summary.errors, 2, "two blocking errors in summary");
    const scoped = filterDoctorIssues(report.issues, { scope: "M001/S01", includeWarnings: true });
    assertTrue(scoped.length >= 2, "scope filter keeps slice issues");
    const text = formatDoctorReport(report, { scope: "M001/S01", includeWarnings: true, maxIssues: 5 });
    assertTrue(text.includes("Scope: M001/S01"), "formatted report shows scope");
    assertTrue(text.includes("Top issue types:"), "formatted report shows grouped issue types");
  }

  console.log("\n=== doctor default scope ===");
  {
    const scope = await selectDoctorScope(tmpBase);
    assertEq(scope, "M001/S01", "default doctor scope targets the active slice");
  }

  console.log("\n=== doctor fix ===");
  {
    const report = await runGSDDoctor(tmpBase, { fix: true });
    if (report.fixesApplied.length < 3) console.error(report);
    assertTrue(report.fixesApplied.length >= 3, "applies multiple fixes");
    assertTrue(existsSync(join(sDir, "S01-SUMMARY.md")), "creates placeholder slice summary");
    assertTrue(existsSync(join(sDir, "S01-UAT.md")), "creates placeholder UAT");

    const plan = readFileSync(join(sDir, "S01-PLAN.md"), "utf-8");
    assertTrue(plan.includes("- [x] **T01:"), "marks task checkbox done");

    const roadmap = readFileSync(join(mDir, "M001-ROADMAP.md"), "utf-8");
    assertTrue(roadmap.includes("- [x] **S01:"), "marks slice checkbox done");

    const state = readFileSync(join(gsd, "STATE.md"), "utf-8");
    assertTrue(state.includes("# GSD State"), "writes state file");
  }

  rmSync(tmpBase, { recursive: true, force: true });

  // ─── Milestone summary detection: missing summary ──────────────────────
  console.log("\n=== doctor detects missing milestone summary ===");
  {
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
    assertTrue(
      report.issues.some(issue => issue.code === "all_slices_done_missing_milestone_summary"),
      "detects missing milestone summary when all slices are done"
    );
    const msIssue = report.issues.find(issue => issue.code === "all_slices_done_missing_milestone_summary");
    assertEq(msIssue?.scope, "milestone", "milestone summary issue has scope 'milestone'");
    assertEq(msIssue?.severity, "warning", "milestone summary issue has severity 'warning'");
    assertEq(msIssue?.unitId, "M001", "milestone summary issue unitId is 'M001'");
    assertTrue(msIssue?.message?.includes("SUMMARY") ?? false, "milestone summary issue message mentions SUMMARY");

    rmSync(msBase, { recursive: true, force: true });
  }

  // ─── Milestone summary detection: summary present (no false positive) ──
  console.log("\n=== doctor does NOT flag milestone with summary ===");
  {
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
    assertTrue(
      !report.issues.some(issue => issue.code === "all_slices_done_missing_milestone_summary"),
      "does NOT report missing milestone summary when summary exists"
    );

    rmSync(msBase, { recursive: true, force: true });
  }

  // ─── blocker_discovered_no_replan detection ────────────────────────────
  console.log("\n=== doctor detects blocker_discovered_no_replan ===");
  {
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
    assertTrue(blockerIssues.length > 0, "detects blocker_discovered_no_replan");
    assertEq(blockerIssues[0]?.severity, "warning", "blocker issue has warning severity");
    assertEq(blockerIssues[0]?.scope, "slice", "blocker issue has slice scope");
    assertTrue(blockerIssues[0]?.message?.includes("T01") ?? false, "blocker issue message mentions T01");
    assertTrue(blockerIssues[0]?.message?.includes("S01") ?? false, "blocker issue message mentions S01");

    rmSync(bBase, { recursive: true, force: true });
  }

  // ─── blocker_discovered with REPLAN.md (no false positive) ─────────────
  console.log("\n=== doctor does NOT flag blocker when REPLAN.md exists ===");
  {
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
    assertEq(blockerIssues.length, 0, "no blocker_discovered_no_replan when REPLAN.md exists");

    rmSync(bBase, { recursive: true, force: true });
  }

  // ─── Must-have verification: all addressed → no issue ─────────────────
  console.log("\n=== doctor: done task with must-haves all addressed → no issue ===");
  {
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
    assertTrue(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when all must-haves are addressed"
    );

    rmSync(mhBase, { recursive: true, force: true });
  }

  // ─── Must-have verification: not addressed → warning fired ───────────
  console.log("\n=== doctor: done task with must-haves NOT addressed → warning ===");
  {
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
    assertTrue(!!mhIssue, "must-have issue is fired when summary doesn't address all must-haves");
    assertEq(mhIssue?.severity, "warning", "must-have issue is warning severity");
    assertEq(mhIssue?.scope, "task", "must-have issue scope is task");
    assertTrue(mhIssue?.message?.includes("3 must-haves") ?? false, "message mentions total must-have count");
    assertTrue(mhIssue?.message?.includes("only 1") ?? false, "message mentions addressed count");
    assertEq(mhIssue?.fixable, false, "must-have issue is not fixable");

    rmSync(mhBase, { recursive: true, force: true });
  }

  // ─── Must-have verification: no task plan → no issue ─────────────────
  console.log("\n=== doctor: done task with no task plan file → no issue ===");
  {
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
    assertTrue(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when task plan file doesn't exist"
    );

    rmSync(mhBase, { recursive: true, force: true });
  }

  // ─── Must-have verification: plan exists but no Must-Haves section → no issue
  console.log("\n=== doctor: done task with plan but no Must-Haves section → no issue ===");
  {
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
    assertTrue(
      !report.issues.some(i => i.code === "task_done_must_haves_not_verified"),
      "no must-have issue when task plan has no Must-Haves section"
    );

    rmSync(mhBase, { recursive: true, force: true });
  }

  // ─── validateTitle: em dash and slash detection ────────────────────────
  console.log("\n=== validateTitle: returns null for clean titles ===");
  {
    assertEq(validateTitle("Foundation"), null, "clean title passes");
    assertEq(validateTitle("Build Core Systems"), null, "clean title with spaces passes");
    assertEq(validateTitle("API v2 Integration"), null, "clean title with version passes");
    assertEq(validateTitle(""), null, "empty title passes");
  }

  console.log("\n=== validateTitle: detects em dash ===");
  {
    const result = validateTitle("Foundation — Build Core");
    assertTrue(result !== null, "detects em dash in title");
    assertTrue(result!.includes("em/en dash"), "message mentions em/en dash");
  }

  console.log("\n=== validateTitle: detects en dash ===");
  {
    const result = validateTitle("Phase 1 – Phase 2");
    assertTrue(result !== null, "detects en dash in title");
    assertTrue(result!.includes("em/en dash"), "message mentions em/en dash for en dash");
  }

  console.log("\n=== validateTitle: detects forward slash ===");
  {
    const result = validateTitle("Client/Server");
    assertTrue(result !== null, "detects forward slash in title");
    assertTrue(result!.includes("forward slash"), "message mentions forward slash");
  }

  console.log("\n=== validateTitle: detects both em dash and slash ===");
  {
    const result = validateTitle("Client — Server/API");
    assertTrue(result !== null, "detects both delimiters");
    assertTrue(result!.includes("em/en dash"), "message mentions em/en dash");
    assertTrue(result!.includes("forward slash"), "message mentions forward slash");
  }

  // ─── doctor detects delimiter_in_title for milestone ───────────────────
  console.log("\n=== doctor detects em dash in milestone title ===");
  {
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
    assertTrue(dtIssues.length >= 1, "detects delimiter_in_title for milestone with em dash");
    const milestoneIssue = dtIssues.find(i => i.scope === "milestone");
    assertTrue(milestoneIssue !== undefined, "delimiter issue has milestone scope");
    assertEq(milestoneIssue?.severity, "warning", "delimiter issue has warning severity");
    assertEq(milestoneIssue?.unitId, "M001", "delimiter issue unitId is M001");
    assertTrue(milestoneIssue?.message?.includes("em/en dash") ?? false, "issue message mentions em/en dash");
    assertEq(milestoneIssue?.fixable, false, "delimiter issue is not auto-fixable");

    rmSync(dtBase, { recursive: true, force: true });
  }

  // ─── doctor detects delimiter_in_title for slice ────────────────────────
  console.log("\n=== doctor detects em dash in slice title ===");
  {
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
    assertTrue(dtIssues.length >= 1, "detects delimiter_in_title for slice with em dash");
    const sliceIssue = dtIssues.find(i => i.scope === "slice");
    assertTrue(sliceIssue !== undefined, "delimiter issue has slice scope");
    assertEq(sliceIssue?.severity, "warning", "slice delimiter issue has warning severity");
    assertEq(sliceIssue?.unitId, "M001/S01", "slice delimiter issue unitId is M001/S01");

    rmSync(dtBase, { recursive: true, force: true });
  }

  // ─── doctor does NOT flag clean titles ──────────────────────────────────
  console.log("\n=== doctor does NOT flag milestone with clean title ===");
  {
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
    assertEq(dtIssues.length, 0, "no delimiter_in_title issues for clean titles");

    rmSync(dtBase, { recursive: true, force: true });
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
