---
id: T02
parent: S02
milestone: M003
provides:
  - Integration tests proving mergeSliceToMilestone works with real git operations
key_files:
  - src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts
key_decisions:
  - Caller must be on milestone branch when calling mergeSliceToMilestone (isInAutoWorktree guard checks branch prefix)
patterns_established:
  - Merge tests use setupSliceBranch helper + checkout milestone before calling merge
observability_surfaces:
  - npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts — 21 assertions across 5 test cases
duration: 12m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Integration test for --no-ff slice merges in worktree

**Created 5 integration tests proving mergeSliceToMilestone handles --no-ff merges, conflicts, and edge cases with real git operations**

## What Happened

Built `auto-worktree-merge.test.ts` with 5 test cases and 21 assertions covering the full merge contract:
1. Single slice (3 commits) → --no-ff merge shows merge commit in graph, rich commit message, slice branch deleted
2. Two sequential slices → two distinct merge boundaries in git log
3. Zero commits → throws with "no commits ahead" message
4. Real code conflict → throws MergeConflictError with conflicted file name
5. .gsd/ changes on milestone don't conflict with code-only slice changes

Key finding during implementation: `isInAutoWorktree()` checks that the current branch starts with `milestone/`, so the caller must be on the milestone branch when calling `mergeSliceToMilestone`. The function internally does `git checkout` but the guard runs first.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` → 21 passed, 0 failed
- `npx tsc --noEmit` → clean build
- Slice-level: `auto-worktree-merge.test.ts` covers all 6 verification bullets from S02-PLAN.md

## Diagnostics

- Run test: `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts`
- On failure: assertion output shows expected vs actual with test label

## Deviations

- Test 5 (.gsd/ non-conflict) tests the realistic scenario: .gsd/ changes on milestone branch + code-only changes on slice branch. True bi-directional .gsd/ conflict would actually conflict in git since .gsd/ IS tracked in the worktree — but in practice slice branches only have code changes.

## Known Issues

None

## Files Created/Modified

- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 5 integration tests with 21 assertions for mergeSliceToMilestone
- `.gsd/milestones/M003/slices/S02/tasks/T02-PLAN.md` — added Observability Impact section
- `.gsd/milestones/M003/slices/S02/S02-PLAN.md` — marked T02 as done
