---
id: S03
parent: M003
milestone: M003
provides:
  - mergeMilestoneToMain export from auto-worktree.ts
  - Milestone merge wiring in auto.ts complete phase
  - Integration test suite (4 tests, 23 assertions)
requires:
  - slice: S01
    provides: isInAutoWorktree, teardownAutoWorktree, getAutoWorktreeOriginalBase, removeWorktree
  - slice: S02
    provides: mergeSliceToMilestone (creates --no-ff slice history on milestone branch)
affects:
  - S05
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts
key_decisions:
  - JSON.stringify for commit message escaping in git commit -m
  - removeWorktree called with branch: null since branch already deleted before worktree removal
  - Worktree removed before branch deletion (reversed from initial implementation) to avoid silent failures
patterns_established:
  - autoCommitDirtyState helper for pre-merge cleanup
  - mergeMilestoneToMain returns { commitMessage, pushed } for caller diagnostics
  - addSliceToMilestone test helper for creating realistic milestone branch history
observability_surfaces:
  - UI notifications on merge success/failure with push status
  - git log --oneline main shows feat(MID) commit
  - MergeConflictError with file list on conflicts
drill_down_paths:
  - .gsd/milestones/M003/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T02-SUMMARY.md
duration: 40m
verification_result: passed
completed_at: 2026-03-14
---

# S03: Milestone-to-main squash merge + worktree teardown

**Squash-merge milestone branches to main with rich commit messages, auto-push, dirty worktree handling, and full teardown — verified by 4 integration tests with 23 assertions.**

## What Happened

T01 implemented `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapContent)` in auto-worktree.ts. The function auto-commits dirty worktree state, chdir to original base, checks out main, squash-merges the milestone branch, commits with a rich conventional-commit message listing all completed slices, auto-pushes if enabled, deletes the milestone branch, removes the worktree directory, and clears module state. Wired into auto.ts's `phase === "complete"` block before `stopAuto`, guarded by `isInAutoWorktree`. stopAuto is idempotent — after merge clears originalBase, the teardown guard is skipped.

T02 built 4 integration tests in real temp git repos: basic squash (one commit on main with correct message), rich commit message format (conventional commit with slice listing), nothing-to-commit (graceful handling when milestone branch is identical to main), and auto-push (push to bare remote). During testing, discovered and fixed two bugs: nothing-to-commit detection needed to check `err.stdout`/`err.stderr` instead of `err.message`, and worktree removal had to happen before branch deletion.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23 passed, 0 failed
- `npx tsc --noEmit` — zero errors
- Existing tests (`auto-worktree-merge.test.ts`) — 21 passed, 0 failed

## Requirements Advanced

- R030 — mergeMilestoneToMain squash-merges milestone branch to main, tears down worktree, chdir back to project root. One commit per milestone on main.
- R032 — Rich commit message in conventional commit format listing all completed slices with titles.

## Requirements Validated

- None yet — R030 and R032 require S04 preferences and S05 self-healing before full validation.

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- Auto-push test verifies push mechanics via manual push rather than prefs-driven auto-push, due to `loadEffectiveGSDPreferences` using a module-level const that captures cwd at import time, making temp repo prefs undiscoverable.
- Fixed 2 bugs in auto-worktree.ts during T02 (nothing-to-commit detection, worktree/branch deletion ordering).

## Known Limitations

- `loadEffectiveGSDPreferences` project path is a module-level const — cannot test prefs-driven auto-push in temp repos without refactoring to lazy resolution.
- Dirty worktree test not included (auto-commit helper tested implicitly through the flow but not as a dedicated test case).

## Follow-ups

- S05 should add self-healing around `mergeMilestoneToMain` failure paths (merge conflicts, checkout failures).
- S04 should gate `mergeMilestoneToMain` call on `git.merge_to_main: "milestone"` preference.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — Added `autoCommitDirtyState`, `mergeMilestoneToMain`; fixed nothing-to-commit detection and worktree/branch ordering
- `src/resources/extensions/gsd/auto.ts` — Wired `mergeMilestoneToMain` into complete phase before stopAuto
- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 4 integration tests, 23 assertions

## Forward Intelligence

### What the next slice should know
- `mergeMilestoneToMain` clears `originalBase` module state, which makes `isInAutoWorktree()` return false — downstream code must not assume worktree state persists after merge.
- The function signature takes `roadmapContent` as a string (the raw markdown), not a parsed object. It calls `parseRoadmap` internally.

### What's fragile
- `loadEffectiveGSDPreferences` captures `process.cwd()` at module load time into a const — any code that needs prefs in a different cwd (tests, worktrees) will get the wrong path. S04 should address this.
- Nothing-to-commit detection relies on parsing git error output strings (`"nothing to commit"`, `"nothing added to commit"`) — fragile against git version changes.

### Authoritative diagnostics
- `git log --oneline main` — shows the squash commit; one new commit per milestone merge
- `git worktree list` — confirms worktree removed after merge
- `git branch` — confirms milestone branch deleted after merge

### What assumptions changed
- Original plan assumed branch deletion before worktree removal — actually must be reversed (git won't delete a branch checked out in a worktree).
