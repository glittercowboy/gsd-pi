---
id: S02
parent: M003
milestone: M003
provides:
  - mergeSliceToMilestone function for --no-ff worktree-mode slice merges
  - auto.ts conditional routing at both merge call sites (orphan ~L554, post-dispatch ~L1599)
  - Zero .gsd/ conflict resolution in worktree merge path
requires:
  - slice: S01
    provides: isInAutoWorktree(), autoWorktreeBranch(), worktree infrastructure
affects:
  - S03
  - S06
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts
key_decisions:
  - D037: mergeSliceToMilestone lives in auto-worktree.ts, not git-service.ts
  - D038: No .gsd/ conflict resolution in worktree merge — structurally unnecessary
patterns_established:
  - Worktree-mode merge functions co-located with worktree lifecycle in auto-worktree.ts
  - isInAutoWorktree() guard pattern for conditional routing between worktree and branch modes
  - Caller must be on milestone branch when calling mergeSliceToMilestone
observability_surfaces:
  - MergeSliceResult returned on success with branch, mergedCommitMessage, deletedBranch
  - MergeConflictError thrown with conflictedFiles, branch, mainBranch on conflict
  - npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts — 21 assertions across 5 tests
drill_down_paths:
  - .gsd/milestones/M003/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S02/tasks/T02-SUMMARY.md
duration: 32m
verification_result: passed
completed_at: 2026-03-14
---

# S02: --no-ff slice merges + conflict elimination

**Added `mergeSliceToMilestone` with --no-ff merge and zero .gsd/ conflict resolution, wired both auto.ts merge call sites via `isInAutoWorktree()` guards, proved with 5 integration tests (21 assertions).**

## What Happened

T01 implemented `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` in auto-worktree.ts. The function asserts worktree context, validates the slice branch has commits, checks out the milestone branch, builds a rich conventional-commit message, runs `git merge --no-ff`, deletes the slice branch on success, and throws `MergeConflictError` with conflicted file names on failure. Zero `.gsd/` conflict resolution code — no `--theirs`, no runtime exclusion untracking, no snapshot creation. Both auto.ts merge call sites (orphan merge ~L554, post-dispatch ~L1599) were guarded with `isInAutoWorktree()` to route to the new function in worktree mode while leaving existing `mergeSliceToMain` completely untouched for branch-per-slice mode.

T02 built 5 integration tests with 21 assertions in a real temp repo: single slice --no-ff merge (verifies merge commit, rich message, branch deletion), two sequential slices (verifies distinct merge boundaries), zero commits (throws error), real code conflict (throws MergeConflictError with file names), and .gsd/ changes don't conflict with code-only slice changes.

## Verification

- `npx tsc --noEmit` — clean, zero errors
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21 passed, 0 failed
- Code review: `mergeSliceToMain` in git-service.ts untouched (zero diff)
- Code review: `mergeSliceToMilestone` contains zero `.gsd/` conflict resolution code

## Requirements Advanced

- R031 — `--no-ff` slice merges within worktree now implemented and tested with real git operations
- R036 — `.gsd/` conflict resolution code bypassed entirely in worktree merge path (elimination deferred to S06 for dead code removal)

## Requirements Validated

- None — R031 needs end-to-end auto-mode verification (S07), R036 needs dead code removal (S06)

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

None.

## Known Limitations

- `mergeSliceToMilestone` replicates `buildRichCommitMessage` format locally since the original is private on GitServiceImpl. If the format changes in git-service.ts, the worktree version must be updated manually.
- True bi-directional .gsd/ conflicts (both branches modify same .gsd/ file) would still cause a git conflict. In practice this doesn't happen because slice branches only contain code changes.

## Follow-ups

- S06 should remove the dead `.gsd/` conflict resolution code from worktree-mode paths
- S03 consumes the merged milestone branch for squash-merge to main

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — exported `autoWorktreeBranch`, added `mergeSliceToMilestone` with imports
- `src/resources/extensions/gsd/auto.ts` — added `mergeSliceToMilestone` import, guarded both merge call sites
- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 5 integration tests with 21 assertions

## Forward Intelligence

### What the next slice should know
- `mergeSliceToMilestone` returns `MergeSliceResult` with `{ branch, mergedCommitMessage, deletedBranch }` — S03's milestone squash can read the milestone branch's `git log` to build the milestone commit message from these merge commits.

### What's fragile
- The rich commit message format is duplicated between `mergeSliceToMilestone` (auto-worktree.ts) and `buildRichCommitMessage` (git-service.ts) — divergence is possible if one is updated without the other.

### Authoritative diagnostics
- `git log --oneline --graph milestone/<MID>` in the worktree shows merge topology — this is the ground truth for whether --no-ff merges are working correctly.

### What assumptions changed
- Caller must be on milestone branch when calling `mergeSliceToMilestone` (the `isInAutoWorktree` guard checks branch prefix) — this wasn't explicit in the plan but is enforced by the implementation.
