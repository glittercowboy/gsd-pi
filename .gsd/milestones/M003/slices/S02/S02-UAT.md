# S02: --no-ff slice merges + conflict elimination — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All verification is against git state in temp repos — no runtime UI or user interaction involved

## Preconditions

- Repository cloned and dependencies installed
- `npx tsc --noEmit` passes (clean build)

## Smoke Test

Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — all 21 assertions pass.

## Test Cases

### 1. --no-ff merge produces correct git topology

1. Create a temp repo with a `milestone/M001` branch
2. Create a slice branch with 3 commits modifying different files
3. Call `mergeSliceToMilestone(basePath, "M001", "S01", "Test slice")`
4. Run `git log --oneline --graph milestone/M001`
5. **Expected:** Graph shows a merge commit at the top with the 3 slice commits visible in the history. The merge commit message contains conventional commit format with slice metadata.

### 2. Sequential slices produce distinct merge boundaries

1. Complete and merge slice S01 (3 commits) via `mergeSliceToMilestone`
2. Create slice S02 branch with 2 commits
3. Call `mergeSliceToMilestone(basePath, "M001", "S02", "Second slice")`
4. Run `git log --oneline --graph milestone/M001`
5. **Expected:** Two distinct merge commits visible in the graph, each with their slice's commits as children.

### 3. Slice branch deleted after merge

1. Merge a slice via `mergeSliceToMilestone`
2. Run `git branch --list` in the worktree
3. **Expected:** The slice branch (e.g. `gsd/M001/S01`) no longer exists.

### 4. Zero-commit slice rejected

1. Create a slice branch identical to the milestone branch (no new commits)
2. Call `mergeSliceToMilestone`
3. **Expected:** Throws an error with message containing "no commits ahead".

### 5. Real code conflict throws MergeConflictError

1. On the milestone branch, modify `file.txt` line 1
2. On the slice branch, modify `file.txt` line 1 differently
3. Call `mergeSliceToMilestone`
4. **Expected:** Throws `MergeConflictError` with `conflictedFiles` containing `file.txt`.

## Edge Cases

### .gsd/ changes on milestone don't conflict with code-only slice

1. On the milestone branch, add/modify a file under `.gsd/`
2. On the slice branch, only modify code files (no `.gsd/` changes)
3. Call `mergeSliceToMilestone`
4. **Expected:** Merge succeeds — no conflict resolution needed, no `.gsd/` special handling invoked.

### Branch-per-slice mode untouched

1. Verify `mergeSliceToMain` in git-service.ts has zero modifications from this slice
2. **Expected:** Existing branch-per-slice merge path is identical to before S02.

## Failure Signals

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` reports any failures
- `npx tsc --noEmit` shows type errors
- `git log --graph` in a worktree shows fast-forward merges instead of merge commits
- `.gsd/` conflict resolution code (--theirs, runtime exclusion) present in `mergeSliceToMilestone`

## Requirements Proved By This UAT

- R031 — `--no-ff` slice merges within milestone worktree (contract-level proof via temp repo tests)
- R036 — `.gsd/` conflict resolution elimination in worktree merge path (code review + test showing no .gsd/ handling)

## Not Proven By This UAT

- R031 end-to-end in live auto-mode (deferred to S07)
- R036 dead code removal from git-service.ts (deferred to S06)
- R038 backwards compatibility regression test (deferred to S04)

## Notes for Tester

- All test cases are automated in `auto-worktree-merge.test.ts`. Manual verification only needed if you want to inspect git topology visually.
- The rich commit message format is replicated from `buildRichCommitMessage` — visual inspection of commit messages is a good gut check.
