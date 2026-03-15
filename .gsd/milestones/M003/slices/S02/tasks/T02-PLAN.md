---
estimated_steps: 6
estimated_files: 1
---

# T02: Integration test for --no-ff slice merges in worktree

**Slice:** S02 — --no-ff slice merges + conflict elimination
**Milestone:** M003

## Description

Prove `mergeSliceToMilestone` works correctly via integration tests in a real temp git repo with auto-worktrees. Covers happy path (single and multi-slice), error paths (zero commits, real code conflicts), and the key architectural claim that `.gsd/` files don't cause conflicts in worktree mode.

## Steps

1. Create `auto-worktree-merge.test.ts` following `auto-worktree.test.ts` patterns (temp repo, `createTestContext`, `assertEq`/`assertTrue`)
2. Helper: `createTempRepo` that inits a repo with an initial commit and `.gsd/` directory
3. Test "single slice --no-ff merge": create auto-worktree, create slice branch, add 3 commits, merge → verify `git log --oneline --graph` shows merge commit, all 3 slice commits visible, merge commit message has conventional format, slice branch deleted
4. Test "two sequential slices": merge slice S01, then create and merge slice S02 → verify git log shows two distinct merge boundaries
5. Test "zero commits throws": create slice branch with no commits ahead → mergeSliceToMilestone throws
6. Test "real code conflict throws MergeConflictError": modify same file on milestone branch and slice branch → merge throws MergeConflictError with file name
7. Test ".gsd/ changes don't conflict": both milestone branch and slice branch modify `.gsd/STATE.md` → merge succeeds (no conflict resolution needed because worktree `.gsd/` is local)

## Must-Haves

- [ ] All tests use real git operations in temp repos (no mocks)
- [ ] Merge topology verified via `git log --graph`
- [ ] MergeConflictError verified with correct conflicted file names
- [ ] Tests clean up temp dirs

## Verification

- `node --test src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — all tests pass

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — T01's `mergeSliceToMilestone` function
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — patterns for temp repo setup and assertions

## Expected Output

- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — integration test file with 5-6 test cases

## Observability Impact

- **Signals changed:** None (test-only task, no runtime changes)
- **Future agent inspection:** Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` to verify merge behavior
- **Failure state visible:** Test failures print assertion details with expected vs actual. Exit code 1 on any failure.
