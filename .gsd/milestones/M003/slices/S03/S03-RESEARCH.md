# S03: Milestone-to-main squash merge + worktree teardown — Research

**Date:** 2026-03-14

## Summary

S03 adds the final step of the auto-worktree lifecycle: when a milestone completes, the milestone branch is squash-merged to main, the worktree is torn down, and `process.chdir` returns to the project root. The current `stopAuto` already calls `teardownAutoWorktree`, but it does so **without squash-merging first** — it just removes the worktree and deletes the milestone branch. This is the critical gap.

The implementation requires: (1) a `mergeMilestoneToMain` function that checks out main in the original project root, squash-merges the milestone branch, commits with a rich message listing all slices, and optionally auto-pushes; (2) rewiring `stopAuto` (or the complete-milestone post-path) to call this merge before teardown; (3) modifying `teardownAutoWorktree` to optionally preserve the branch (since we need it alive for the squash-merge, then delete it after).

The existing `mergeSliceToMain` in git-service.ts is a useful pattern reference but has ~60 lines of `.gsd/` conflict resolution that are unnecessary for milestone squash. The new function should be clean and simple — the milestone branch already has all slices merged via `--no-ff`, so the squash just flattens the whole thing into one commit on main.

## Recommendation

Add `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapSlices)` to `auto-worktree.ts` (co-located with the rest of the worktree lifecycle, consistent with D037). The function operates from the **original project root** (not the worktree), because it needs to checkout main and merge there. Sequence:

1. `chdir` back to original project root
2. `git checkout main`
3. Build rich commit message from roadmap slices
4. `git merge --squash milestone/<MID>`
5. `git commit` with rich message
6. Auto-push if `auto_push` pref is true
7. Delete milestone branch
8. Remove worktree (via `removeWorktree`)
9. Clear `originalBase` module state

Wire this into the `state.phase === "complete"` path in `dispatchNextUnit` (around L1723), **before** `stopAuto` is called. `stopAuto` should detect that the worktree was already torn down and skip its own teardown.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Rich commit message format | `buildRichCommitMessage` pattern in git-service.ts / `mergeSliceToMilestone` | Consistent conventional-commit format across the project |
| Worktree removal | `removeWorktree` in worktree-manager.ts | Already handles chdir-out, force remove, prune, branch deletion |
| Auto-push | `auto_push` / `remote` prefs pattern in git-service.ts L867-870 | Consistent push behavior |
| Roadmap parsing | `parseRoadmap` in files.ts | Already used everywhere to get slice list |
| Main branch detection | `getMainBranch(basePath)` from git-service.ts | Handles custom main branch names |

## Existing Code and Patterns

- `src/resources/extensions/gsd/auto-worktree.ts` — `teardownAutoWorktree` currently does chdir + removeWorktree. Must be modified so `stopAuto` doesn't double-teardown after the milestone merge path runs.
- `src/resources/extensions/gsd/auto.ts:348-380` (`stopAuto`) — tears down worktree unconditionally if in one. After S03, the complete-milestone path will have already merged+torn down, so `stopAuto` must be idempotent (check `isInAutoWorktree` before attempting teardown).
- `src/resources/extensions/gsd/auto.ts:1710-1730` — the `state.phase === "complete"` block that calls `stopAuto`. This is where the squash-merge should be inserted, before `stopAuto`.
- `src/resources/extensions/gsd/git-service.ts:703-880` (`mergeSliceToMain`) — reference for squash-merge pattern. The `.gsd/` conflict resolution (L770-840) is NOT needed for milestone merge.
- `src/resources/extensions/gsd/worktree-manager.ts:262-305` (`removeWorktree`) — handles force-remove, prune, optional branch deletion. Pass `deleteBranch: false` when we want to delete the branch ourselves after the merge.
- `src/resources/extensions/gsd/auto-worktree.ts:mergeSliceToMilestone` — the `--no-ff` merge pattern. The milestone merge is the inverse: squash many commits into one.

## Constraints

- Must operate from `originalBasePath` (project root), not the worktree — `git merge --squash milestone/<MID>` must run on main in the original repo.
- `teardownAutoWorktree` currently deletes the milestone branch via `removeWorktree`. The squash-merge needs the branch alive. Either: (a) merge before teardown and pass `deleteBranch: false`, then delete after merge; or (b) restructure teardown to not delete the branch.
- `stopAuto` is called from ~20 places in auto.ts. The milestone squash should only happen on the `complete` phase path — not on error stops, pause, or other exit paths.
- Auto-push must use the same `auto_push` / `remote` preferences as existing push code.
- The milestone branch might have uncommitted changes from the complete-milestone unit's summary write. Must auto-commit before squash-merge.

## Common Pitfalls

- **Double teardown** — if `mergeMilestoneToMain` tears down the worktree and then `stopAuto` tries again, it'll error or no-op. Make `stopAuto`'s teardown conditional on `isInAutoWorktree()` (it already checks this, so it should be safe, but verify).
- **Dirty worktree at merge time** — the complete-milestone unit writes `M003-SUMMARY.md` and other files. These must be committed on the milestone branch before the squash-merge. Auto-commit in the worktree before chdir-ing out.
- **Branch doesn't exist after removeWorktree** — `removeWorktree` defaults to `deleteBranch: true`. Must pass `deleteBranch: false` or restructure the call order.
- **Squash-merge with no changes** — if milestone branch has no diff vs main (e.g., all changes were already cherry-picked), `git merge --squash` succeeds but `git commit` fails with "nothing to commit". Handle this gracefully.
- **originalBasePath is null** — if `getAutoWorktreeOriginalBase()` returns null during the complete path, the merge can't proceed. This shouldn't happen (we're in a worktree), but guard against it.

## Open Risks

- **Remote divergence** — if main has advanced on the remote since the worktree was created, `git pull --rebase` before merge could conflict. The existing `mergeSliceToMain` does a pull before merge; replicate that pattern.
- **Long-running milestone with main drift** — if someone pushes to main during a multi-day milestone, the squash-merge could have conflicts. Self-healing (S05) handles this, but S03 should at minimum throw `MergeConflictError` with actionable info.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| git | N/A — standard git CLI operations | none needed |

## Sources

- Existing codebase analysis (git-service.ts, auto-worktree.ts, auto.ts, worktree-manager.ts)
- S01 and S02 slice summaries for upstream contract
