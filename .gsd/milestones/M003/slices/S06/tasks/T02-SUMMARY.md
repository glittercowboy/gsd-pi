---
id: T02
parent: S06
milestone: M003
provides:
  - Integration tests for all 4 git health check issue codes in doctor
key_files:
  - src/resources/extensions/gsd/tests/doctor-git.test.ts
key_decisions:
  - Worktrees must be under .gsd/worktrees/ to match listWorktrees filter (not .gsd-worktrees/)
  - Roadmap must use `## Slices` with checkbox format to match parseRoadmapSlices parser
patterns_established:
  - Git health check test pattern: createRepoWithCompletedMilestone helper, detect → fix → verify cycle
observability_surfaces:
  - none
duration: 25m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Integration tests for doctor git health checks

**Built 6 integration tests (17 assertions) covering detection, fix, and false-positive prevention for all 4 git health check issue codes.**

## What Happened

Created `doctor-git.test.ts` with real temp git repos. Each test injects deliberate broken state, runs `runGSDDoctor` for detection, then `runGSDDoctor({fix:true})` for remediation, then verifies git state post-fix. Key discovery: worktrees must be under `.gsd/worktrees/` (not `.gsd-worktrees/`) and roadmaps must use the `## Slices` checkbox format (not table format) to match the actual parsers.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — 17 passed, 0 failed ✓
- `npx tsx src/resources/extensions/gsd/tests/doctor.test.ts` — 59 passed, 0 failed ✓
- `npx tsx src/resources/extensions/gsd/tests/doctor-fixlevel.test.ts` — all pass ✓
- `npx tsc --noEmit` — zero errors ✓

## Diagnostics

Run `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` to see all git health check test results.

## Deviations

- Roadmap format in tests changed from table (`## Slice Inventory` with `| |` rows) to checkbox format (`## Slices` with `- [x] **S01: ...**`) to match `parseRoadmapSlices` parser expectations.
- Worktree path changed from `.gsd-worktrees/` to `.gsd/worktrees/` to match `listWorktrees` filter.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/doctor-git.test.ts` — 6 integration tests for git health checks
- `.gsd/milestones/M003/slices/S06/S06-PLAN.md` — marked T02 done
- `.gsd/milestones/M003/slices/S06/tasks/T02-PLAN.md` — added Observability Impact section
