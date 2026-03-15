---
estimated_steps: 8
estimated_files: 3
---

# T01: Implement mergeSliceToMilestone and wire into auto.ts

**Slice:** S02 — --no-ff slice merges + conflict elimination
**Milestone:** M003

## Description

Create the `mergeSliceToMilestone` function in `auto-worktree.ts` that does a `--no-ff` merge of a slice branch into the `milestone/<MID>` branch within the worktree. This function skips all `.gsd/` conflict resolution code — in worktree mode, `.gsd/` is local so conflicts are structurally impossible. Wire both auto.ts merge call sites to use the new function when `isInAutoWorktree()` is true.

## Steps

1. Export `autoWorktreeBranch` from auto-worktree.ts (remove `function` → `export function`)
2. Add `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` to auto-worktree.ts:
   - Assert `isInAutoWorktree(basePath)` or throw
   - Get milestone branch via `autoWorktreeBranch(milestoneId)`
   - Get current branch, verify we can checkout milestone branch
   - Checkout `milestone/<MID>` branch
   - Get slice branch name via `getSliceBranchName(milestoneId, sliceId, detectWorktreeName(basePath))`
   - Verify slice branch exists, check commit count via `nativeCommitCountBetween`
   - Build rich commit message (replicate format from `buildRichCommitMessage`)
   - Run `git merge --no-ff -m <message> <sliceBranch>`
   - On conflict: get conflicted files, throw `MergeConflictError` (no `.gsd/` resolution)
   - On success: delete slice branch, return `MergeSliceResult`
3. In auto.ts ~L553 (orphan merge): guard with `!isInAutoWorktree(base)`, add worktree-mode else branch
4. In auto.ts ~L1591 (post-dispatch merge): guard with `!isInAutoWorktree(basePath)`, add worktree-mode else branch
5. Verify `npx tsc --noEmit` passes

## Must-Haves

- [ ] `mergeSliceToMilestone` uses `--no-ff` (not squash)
- [ ] Zero `.gsd/` conflict resolution code in the new function
- [ ] `mergeSliceToMain` completely untouched
- [ ] Both auto.ts call sites route correctly based on `isInAutoWorktree()`
- [ ] MergeConflictError thrown for real code conflicts

## Verification

- `npx tsc --noEmit` — clean build with no type errors
- Manual code review: `mergeSliceToMilestone` has no `.gsd/` conflict resolution, no `git pull`, no runtime exclusion handling

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — S01 module with lifecycle functions
- `src/resources/extensions/gsd/auto.ts` — two merge call sites at ~L553 and ~L1591
- `src/resources/extensions/gsd/git-service.ts` — `MergeConflictError`, `MergeSliceResult`, `inferCommitType`, `nativeCommitCountBetween` exports

## Expected Output

- `src/resources/extensions/gsd/auto-worktree.ts` — `mergeSliceToMilestone` function added, `autoWorktreeBranch` exported
- `src/resources/extensions/gsd/auto.ts` — both merge call sites conditionally route to worktree-mode merge

## Observability Impact

- **New signal:** `mergeSliceToMilestone` returns `MergeSliceResult` on success (branch name, commit message, deletion status) — same shape as `mergeSliceToMain`.
- **Failure signal:** `MergeConflictError` thrown on real code conflicts, includes `conflictedFiles` list, `branch`, and `mainBranch` (milestone branch).
- **Inspection:** `git log --oneline --graph milestone/<MID>` in the worktree shows `--no-ff` merge topology with full slice commit history.
- **Future agent:** check for `MergeConflictError` in catch blocks at both auto.ts call sites to understand merge failure state.
