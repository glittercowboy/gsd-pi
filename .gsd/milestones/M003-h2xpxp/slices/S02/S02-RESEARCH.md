# S02: --no-ff slice merges + conflict elimination — Research

**Date:** 2026-03-14

## Summary

The existing `mergeSliceToMain` in `git-service.ts` already supports `--no-ff` via `merge_strategy: "merge"` preference — the plumbing exists. The work for S02 is creating a new `mergeSliceToMilestone` function that operates *within* the worktree (merging a slice branch into the `milestone/<MID>` branch using `--no-ff`), and bypassing the ~60 lines of `.gsd/` conflict auto-resolution that are structurally unnecessary in worktree mode.

The critical insight: in worktree mode, each slice branch is created *from* the milestone branch within the worktree. The `.gsd/` directory is worktree-local — no other branch is writing to it concurrently. This eliminates the entire category of `.gsd/` merge conflicts. The conflict resolution code (runtime exclusion untracking, `.gsd/` `--theirs` checkout, runtime file stripping post-merge) can be skipped entirely.

## Recommendation

Create a `mergeSliceToMilestone(basePath, milestoneId, sliceId, sliceTitle)` function in `auto-worktree.ts` (or a new `auto-worktree-merge.ts`) that:
1. Asserts we're in the auto-worktree (`isInAutoWorktree`)
2. Checks out the `milestone/<MID>` branch within the worktree
3. Runs `git merge --no-ff -m <message> <sliceBranch>`
4. Deletes the slice branch
5. Skips all `.gsd/` conflict resolution — if a conflict occurs, it's a real code conflict

Modify `auto.ts` call sites to use `mergeSliceToMilestone` when `isInAutoWorktree()` is true, falling back to existing `mergeSliceToMain` for branch-per-slice mode.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Rich commit message | `buildRichCommitMessage()` in `git-service.ts` | Already formats conventional commit with slice metadata |
| Branch naming | `getSliceBranchName()` in `worktree.ts` | Handles both plain and worktree-namespaced patterns |
| Merge strategy plumbing | `merge_strategy` pref in `GitPreferences` | `--no-ff` flag already implemented in `mergeSliceToMain` |
| Commit count check | `nativeCommitCountBetween()` | Native libgit2 fast path for zero-commit guard |

## Existing Code and Patterns

- `git-service.ts:703-870` — `mergeSliceToMain()`: the current merge implementation with `--no-ff` support via `merge_strategy` pref. Lines 765-825 are the `.gsd/` conflict resolution code that becomes dead in worktree mode.
- `auto-worktree.ts` — S01 module with `isInAutoWorktree()`, `getAutoWorktreeOriginalBase()`, `autoWorktreeBranch()` (private). Need to either export `autoWorktreeBranch` or replicate the `milestone/<MID>` pattern.
- `auto.ts:553` — orphan merge call site. Uses `switchToMain` + `mergeSliceToMain`. In worktree mode, "main" is the milestone branch.
- `auto.ts:1591` — post-dispatch merge call site. Same pattern.
- `worktree.ts:178-181` — thin facade over `git-service.ts`. New worktree-mode merge should follow same pattern.

## Constraints

- Must not modify `mergeSliceToMain` behavior for branch-per-slice mode — backwards compat is critical (R038)
- The worktree's "main branch" is `milestone/<MID>`, not the repo's actual main. `switchToMain()` won't work — need `git checkout milestone/<MID>` explicitly.
- `buildRichCommitMessage` in git-service.ts is a private method on `GitServiceImpl`. Either: (a) make it accessible, (b) replicate the message format, or (c) add a new public method on `GitServiceImpl` for worktree-mode merge.
- Slice branches within the worktree use `gsd/<MID>/<SID>` naming (from `getSliceBranchName`). The worktree name detection via `detectWorktreeName` may return the milestone ID, affecting branch naming.

## Common Pitfalls

- **switchToMain() targets repo main, not milestone branch** — In worktree mode, the "integration branch" is `milestone/<MID>`. Calling `switchToMain()` would check out `main` (wrong). Must checkout the milestone branch explicitly before merging.
- **Snapshot creation assumes main branch context** — `createSnapshot()` in `mergeSliceToMain` saves branch refs. In worktree mode, snapshots should reference the milestone branch, not main.
- **Pull from origin before merge is wrong in worktree** — The `git pull --rebase origin main` in `mergeSliceToMain` makes no sense when merging into a local milestone branch. Skip it.
- **Branch deletion scope** — `git branch -D <sliceBranch>` after merge must run inside the worktree, not the main tree.

## Open Risks

- `detectWorktreeName(basePath)` when `basePath` is the worktree path may return the milestone worktree name, which would namespace slice branches differently than expected. Need to verify the branch naming convention works correctly within a worktree.
- The two `mergeSliceToMain` call sites in `auto.ts` have different error handling patterns (one aborts, one dispatches fix-merge). The worktree-mode path needs equivalent error handling for both.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| git worktree | — | No specific skill needed; git CLI knowledge sufficient |

## Sources

- Codebase exploration of `git-service.ts`, `auto-worktree.ts`, `auto.ts`, `worktree.ts`
- S01 summary forward intelligence (split-brain prevention pattern, originalBasePath usage)
