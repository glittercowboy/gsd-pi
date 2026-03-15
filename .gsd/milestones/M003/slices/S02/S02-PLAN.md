# S02: --no-ff slice merges + conflict elimination

**Goal:** Completed slices merge into the milestone branch via `--no-ff` within the worktree, skipping all `.gsd/` conflict resolution code. `git log` on the milestone branch shows full commit history with merge commit boundaries per slice.
**Demo:** In a temp repo with an auto-worktree, complete a slice branch with multiple commits, merge it via `mergeSliceToMilestone`, and `git log --oneline --graph` shows a `--no-ff` merge commit with the slice's full history preserved.

## Must-Haves

- `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` function that does `--no-ff` merge into `milestone/<MID>` branch
- No `.gsd/` conflict resolution in worktree-mode merge path (runtime exclusion untracking, `--theirs` checkout, runtime file stripping all skipped)
- Both auto.ts merge call sites (orphan merge ~L553, post-dispatch ~L1591) route to new function when `isInAutoWorktree()` is true
- Existing `mergeSliceToMain` completely untouched — branch-per-slice mode works identically
- Rich commit message on merge commit (conventional commit format with slice metadata)
- Slice branch deleted after successful merge
- Real code conflicts (non-.gsd/) still throw `MergeConflictError`

## Proof Level

- This slice proves: contract
- Real runtime required: no (temp repo verification sufficient)
- Human/UAT required: no

## Verification

- `node --test auto-worktree-merge.test.ts` — tests covering:
  - `--no-ff` merge produces merge commit with full slice history
  - Rich commit message on merge commit
  - Slice branch deleted after merge
  - Zero-commit slice throws error
  - Real code conflict throws MergeConflictError
  - Multiple slices produce distinct merge boundaries
- `npx tsc --noEmit` — clean build

## Observability / Diagnostics

- Runtime signals: MergeConflictError thrown on real conflicts; MergeSliceResult returned on success
- Inspection surfaces: `git log --oneline --graph milestone/<MID>` shows merge topology
- Failure visibility: MergeConflictError includes conflictedFiles list, branch names

## Integration Closure

- Upstream surfaces consumed: `isInAutoWorktree()`, `getAutoWorktreeOriginalBase()`, `autoWorktreeBranch()` from auto-worktree.ts; `getSliceBranchName()`, `detectWorktreeName()` from worktree.ts; `inferCommitType()`, `nativeCommitCountBetween()`, `MergeConflictError`, `MergeSliceResult` from git-service.ts
- New wiring introduced: auto.ts merge call sites conditionally route to `mergeSliceToMilestone`
- What remains before milestone is truly usable end-to-end: S03 (milestone squash to main + teardown)

## Tasks

- [x] **T01: Implement mergeSliceToMilestone and wire into auto.ts** `est:45m`
  - Why: Core function for worktree-mode slice merges + integration into auto.ts's two merge call sites
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/git-service.ts`
  - Do:
    1. Export `autoWorktreeBranch` from auto-worktree.ts (currently private)
    2. Add `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` to auto-worktree.ts that: asserts `isInAutoWorktree`, checks out `milestone/<MID>`, gets slice branch via `getSliceBranchName`, checks commit count via `nativeCommitCountBetween`, builds rich commit message (replicate `buildRichCommitMessage` format — it's private on GitServiceImpl), runs `git merge --no-ff -m <message> <sliceBranch>`, deletes slice branch, returns `MergeSliceResult`. On conflict: check for conflicted files, throw `MergeConflictError` for any conflicts (no `.gsd/` auto-resolve). No `git pull`, no runtime exclusion untracking, no snapshot creation.
    3. In auto.ts orphan merge call site (~L553): wrap existing `switchToMain` + `mergeSliceToMain` in an `if (!isInAutoWorktree(base))` guard. Add else branch calling `mergeSliceToMilestone`. Keep same error handling pattern (abort + reset on MergeConflictError).
    4. In auto.ts post-dispatch merge call site (~L1591): same pattern — guard with `isInAutoWorktree(basePath)`, call `mergeSliceToMilestone` in worktree mode, keep existing `switchToMain` + `mergeSliceToMain` for branch mode. Keep same error handling (dispatch fix-merge on MergeConflictError).
  - Verify: `npx tsc --noEmit` passes
  - Done when: `mergeSliceToMilestone` exists, both auto.ts call sites route correctly, build clean

- [x] **T02: Integration test for --no-ff slice merges in worktree** `est:30m`
  - Why: Proves the merge function works correctly with real git operations in a temp repo
  - Files: `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts`
  - Do:
    1. Create test file following auto-worktree.test.ts patterns (temp repo, real git operations)
    2. Test: single slice with 3 commits → mergeSliceToMilestone → git log shows --no-ff merge commit with all 3 commits visible, merge commit has rich message, slice branch deleted
    3. Test: two sequential slices → each mergeSliceToMilestone → git log shows two merge boundaries
    4. Test: slice with zero commits → throws error
    5. Test: real code conflict (both milestone branch and slice branch modify same file) → throws MergeConflictError with conflicted file names
    6. Test: .gsd/ files in worktree don't cause conflicts (both branches have .gsd/ changes, merge succeeds because no conflict resolution needed — files are worktree-local)
  - Verify: `node --test auto-worktree-merge.test.ts` — all tests pass
  - Done when: All 5-6 test cases pass, covering happy path, multi-slice, error, conflict, and .gsd/ non-conflict scenarios

## Files Likely Touched

- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts`
