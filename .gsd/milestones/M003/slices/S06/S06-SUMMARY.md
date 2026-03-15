---
id: S06
parent: M003
milestone: M003
provides:
  - 4 git health check issue codes in doctor (orphaned_auto_worktree, stale_milestone_branch, corrupt_merge_state, tracked_runtime_files)
  - checkGitHealth function with detection and fix logic for all 4 codes
  - branch-mode-only annotation on .gsd/ conflict resolution code in git-service.ts
  - Integration test suite (6 tests, 17 assertions) for git health checks
requires:
  - slice: S01
    provides: listWorktrees, worktree infrastructure
  - slice: S05
    provides: abortAndReset error handling patterns
affects:
  - S07
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/git-service.ts
  - src/resources/extensions/gsd/tests/doctor-git.test.ts
key_decisions:
  - D038 — branch-mode-only annotation on .gsd/ conflict resolution code (annotate rather than delete, preserving branch-mode path)
  - checkGitHealth is a standalone async function called from runGSDDoctor, not inlined
  - autoWorktreeBranch import skipped — milestone branch pattern extracted inline via string replace
  - Worktrees must be under .gsd/worktrees/ to match listWorktrees filter
  - Roadmap must use ## Slices with checkbox format to match parseRoadmapSlices parser
patterns_established:
  - Git health check test pattern: createRepoWithCompletedMilestone helper, detect → fix → verify cycle
  - git health checks wrap all operations in try/catch for graceful degradation in non-git repos
  - fix actions record descriptive strings in fixesApplied for audit trail
observability_surfaces:
  - 4 new issue codes in /gsd doctor output with severity, scope, and fix status
  - fixesApplied strings for each remediation action
  - Non-git directories produce no git-related issues (silent skip)
drill_down_paths:
  - .gsd/milestones/M003/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S06/tasks/T02-SUMMARY.md
duration: 37m
verification_result: passed
completed_at: 2026-03-14
---

# S06: Doctor + cleanup + code simplification

**Added 4 git health checks to `/gsd doctor` with detection, fix, and integration tests covering orphaned worktrees, stale branches, corrupt merge state, and tracked runtime files.**

## What Happened

T01 extended the doctor system with `checkGitHealth`, a standalone async function that runs 4 checks: (1) orphaned auto-worktrees — cross-references `listWorktrees` against roadmap completion status, with safety guard against removing the current working directory; (2) stale milestone branches — flags `milestone/*` branches for completed milestones with no associated worktree; (3) corrupt merge state — detects MERGE_HEAD, SQUASH_MSG, and rebase directories, fixes via `abortAndReset`; (4) tracked runtime files — runs `git ls-files` against `RUNTIME_EXCLUSION_PATHS`, fixes via `git rm --cached`. All checks are wrapped in try/catch for non-git repo safety. The `.gsd/` conflict resolution block in git-service.ts was annotated as branch-mode-only per D038.

T02 built 6 integration tests (17 assertions) using real temp git repos with deliberately broken state. Tests cover the full detect → fix → verify cycle for all 4 issue codes plus safety guards (non-git directory doesn't crash, active worktree not flagged as orphaned).

## Verification

- `npx tsc --noEmit` — zero errors
- `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — 17 passed, 0 failed
- `npx tsx src/resources/extensions/gsd/tests/doctor.test.ts` — 59 passed, 0 failed
- `npx tsx src/resources/extensions/gsd/tests/doctor-fixlevel.test.ts` — 3 passed, 0 failed

## Requirements Advanced

- R040 — `/gsd doctor` now detects and fixes 4 git health issue types with full test coverage

## Requirements Validated

- R040 — 6 integration tests prove detection and fix for all 4 issue codes, plus safety guards for non-git repos and active worktrees

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Worktree path in tests changed from `.gsd-worktrees/` to `.gsd/worktrees/` to match `listWorktrees` filter
- Roadmap format in tests changed from table to checkbox format to match `parseRoadmapSlices` parser

## Known Limitations

- `.gsd/` conflict resolution code is annotated but not removed — preserved for `git.isolation: "branch"` users per R036/R038
- Doctor git checks require the `git` CLI to be available; no fallback to native module

## Follow-ups

- none

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts` — 4 new DoctorIssueCode values, checkGitHealth function
- `src/resources/extensions/gsd/git-service.ts` — branch-mode-only annotation on conflict resolution code
- `src/resources/extensions/gsd/tests/doctor-git.test.ts` — 6 integration tests for git health checks

## Forward Intelligence

### What the next slice should know
- All 4 doctor git checks work and have tests. S07 can build on these test patterns for broader coverage.

### What's fragile
- `parseRoadmapSlices` is strict about format — tests must use `## Slices` with `- [x] **S01: Title**` format, not tables.

### Authoritative diagnostics
- `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — canonical test for git health checks

### What assumptions changed
- Assumed `.gsd-worktrees/` path — actual path is `.gsd/worktrees/` per listWorktrees filter
