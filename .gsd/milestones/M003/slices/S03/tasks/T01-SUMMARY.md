---
id: T01
parent: S03
milestone: M003
provides:
  - mergeMilestoneToMain export from auto-worktree.ts
  - Milestone merge wiring in auto.ts complete phase
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Used JSON.stringify for commit message escaping in git commit -m to handle special chars safely
  - removeWorktree called with branch: null since branch is already deleted before worktree removal
patterns_established:
  - autoCommitDirtyState helper for pre-merge cleanup
  - mergeMilestoneToMain returns { commitMessage, pushed } for caller diagnostics
observability_surfaces:
  - UI notifications on merge success/failure with push status
  - git log --oneline main shows feat(MID) commit
  - MergeConflictError with file list on conflicts
duration: 15m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Implement mergeMilestoneToMain and wire into auto.ts

**Added `mergeMilestoneToMain` squash-merge function and wired it into auto.ts's complete phase before stopAuto.**

## What Happened

Implemented `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapContent)` in auto-worktree.ts following the existing `mergeSliceToMilestone` pattern. The function: auto-commits dirty worktree state, chdir to original base, checks out main (from prefs), squash-merges the milestone branch, commits with a rich message listing completed slices in conventional commit format, auto-pushes if `auto_push` pref enabled, deletes the milestone branch, removes the worktree directory, and clears module state.

Wired the call into auto.ts's `phase === "complete"` block, guarded by `isInAutoWorktree && originalBasePath`. After merge, `basePath` and `gitService` are reset to original. Error handling wraps the call with a warning notification.

stopAuto idempotency verified by code review: after `mergeMilestoneToMain` clears `originalBase`, `isInAutoWorktree()` returns false, so stopAuto's teardown guard is skipped.

## Verification

- `npx tsc --noEmit` — zero errors, clean build
- Code review: `mergeMilestoneToMain` follows squash-merge pattern (merge --squash + commit + branch -D)
- Code review: auto.ts complete path calls merge before stopAuto, guarded correctly
- Code review: stopAuto idempotent — `isInAutoWorktree` returns false after merge clears originalBase

## Diagnostics

- UI notifications report merge success with push status, or failure with error message
- `git log --oneline main` shows `feat(MID): <title>` commit after merge
- `git worktree list` confirms worktree removed
- MergeConflictError includes conflicted file names

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — Added `autoCommitDirtyState` helper and `mergeMilestoneToMain` export; added imports for `parseRoadmap` and `loadEffectiveGSDPreferences`
- `src/resources/extensions/gsd/auto.ts` — Added `mergeMilestoneToMain` import; inserted milestone merge call in `phase === "complete"` block before `stopAuto`
- `.gsd/milestones/M003/slices/S03/tasks/T01-PLAN.md` — Added Observability Impact section
- `.gsd/milestones/M003/slices/S03/S03-PLAN.md` — Added diagnostic verification step; marked T01 done

## Slice Verification Status

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — **not yet run** (test file created in T02)
- Diagnostic check for MergeConflictError — **deferred to T02** (tested in integration tests)
