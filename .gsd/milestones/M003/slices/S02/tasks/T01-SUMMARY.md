---
id: T01
parent: S02
milestone: M003
provides:
  - mergeSliceToMilestone function for --no-ff worktree-mode slice merges
  - auto.ts conditional routing at both merge call sites
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Commit message passed via shell quoting in execSync rather than stdin pipe — simpler, sufficient for merge commits
patterns_established:
  - Worktree-mode merge functions live in auto-worktree.ts, not git-service.ts
observability_surfaces:
  - MergeSliceResult returned on success with branch, message, deletedBranch fields
  - MergeConflictError thrown with conflictedFiles, branch, mainBranch on conflict
duration: 20m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Implement mergeSliceToMilestone and wire into auto.ts

**Added `mergeSliceToMilestone` to auto-worktree.ts with --no-ff merge, rich commit messages, and zero `.gsd/` conflict resolution; wired both auto.ts merge call sites to route via `isInAutoWorktree()` guard.**

## What Happened

1. Exported `autoWorktreeBranch` (was private).
2. Added imports for `detectWorktreeName`, `getSliceBranchName`, `MergeConflictError`, `inferCommitType`, `nativeBranchExists`, `nativeCommitCountBetween`.
3. Implemented `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)`:
   - Asserts `isInAutoWorktree` or throws
   - Checks slice branch exists and has commits ahead of milestone branch
   - Checks out milestone branch, builds rich commit message (replicates `buildRichCommitMessage` format)
   - Runs `git merge --no-ff -m <message> <sliceBranch>`
   - On conflict: detects conflicted files via `git diff --name-only --diff-filter=U`, throws `MergeConflictError`
   - On success: deletes slice branch, returns `MergeSliceResult`
4. Wired auto.ts orphan merge (~L554): `if (isInAutoWorktree(base))` → `mergeSliceToMilestone`, else existing `switchToMain` + `mergeSliceToMain`.
5. Wired auto.ts post-dispatch merge (~L1599): same pattern with `isInAutoWorktree(basePath)` guard.
6. Created scaffold test file `auto-worktree-merge.test.ts` for T02 to flesh out.

## Verification

- `npx tsc --noEmit` — clean, zero errors
- `node --test auto-worktree-merge.test.ts` — scaffold passes (placeholder test)
- Code review: `mergeSliceToMilestone` contains zero `.gsd/` conflict resolution (no `--theirs`, no runtime exclusion, no untracking, no snapshot)
- Code review: `mergeSliceToMain` untouched (zero diff in worktree.ts and git-service.ts)
- Both auto.ts call sites have `isInAutoWorktree()` guards routing correctly

### Slice-level verification status (partial — T01 is intermediate)
- `node --test auto-worktree-merge.test.ts` — ✅ passes (scaffold only, real tests in T02)
- `npx tsc --noEmit` — ✅ passes

## Diagnostics

- `MergeSliceResult` shape: `{ branch, mergedCommitMessage, deletedBranch }`
- `MergeConflictError` includes: `conflictedFiles`, `strategy: "merge"`, `branch`, `mainBranch`
- Inspect merge topology: `git log --oneline --graph milestone/<MID>` in worktree

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — exported `autoWorktreeBranch`, added `mergeSliceToMilestone` with all imports
- `src/resources/extensions/gsd/auto.ts` — added `mergeSliceToMilestone` import, guarded both merge call sites with `isInAutoWorktree()`
- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — created scaffold test file for T02
- `.gsd/milestones/M003/slices/S02/tasks/T01-PLAN.md` — added Observability Impact section
