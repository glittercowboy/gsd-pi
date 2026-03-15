---
id: T02
parent: S03
milestone: M003
provides:
  - Integration test suite for mergeMilestoneToMain (4 tests, 23 assertions)
  - Bug fixes in mergeMilestoneToMain (nothing-to-commit detection, worktree/branch deletion ordering)
key_files:
  - src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts
  - src/resources/extensions/gsd/auto-worktree.ts
key_decisions:
  - Auto-push test verifies push mechanics via manual push rather than prefs-driven auto-push, due to module-level const capturing cwd at import time
patterns_established:
  - addSliceToMilestone test helper creates slice branch, adds commits, merges --no-ff to milestone in one call
  - makeRoadmap helper generates correct YAML-frontmatter roadmap format for mergeMilestoneToMain
observability_surfaces:
  - Test exit code 0/1 with FAIL lines for broken assertions
duration: 25m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Integration tests for milestone squash-merge

**Built 4-test integration suite for mergeMilestoneToMain with 23 assertions, fixing 2 bugs discovered during testing**

## What Happened

Created `auto-worktree-milestone-merge.test.ts` following the pattern from `auto-worktree-merge.test.ts`. Tests exercise real git repos with temp directories, creating milestone branches with --no-ff slice merges, then calling `mergeMilestoneToMain` and verifying outcomes.

During test development, discovered and fixed two bugs in `mergeMilestoneToMain`:
1. **Nothing-to-commit detection**: The catch block checked `err.message` (Node's wrapper message) which doesn't contain git's stdout text like "nothing added to commit". Fixed to check `err.stdout` and `err.stderr` properties.
2. **Worktree/branch deletion ordering**: Branch deletion happened before worktree removal, causing `git branch -D` to fail silently (can't delete a branch checked out in a worktree). Swapped ordering: remove worktree first, then delete branch.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23 passed, 0 failed
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21 passed, 0 failed (existing tests still pass)
- Slice-level verification: test file runs and passes ✅

## Diagnostics

- Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — prints pass/fail per assertion
- FAIL lines show assertion name and expected vs actual values

## Deviations

- Auto-push test verifies push mechanics work (manual push after merge) rather than testing prefs-driven auto-push. `loadEffectiveGSDPreferences` uses a module-level const `PROJECT_PREFERENCES_PATH = join(process.cwd(), ".gsd", "preferences.md")` captured at import time, making temp repo prefs undiscoverable. Test still verifies the remote is correctly configured and the commit is pushable.
- Fixed 2 bugs in `auto-worktree.ts` (nothing-to-commit detection, worktree/branch ordering) — necessary for tests to verify correct behavior.

## Known Issues

- `loadEffectiveGSDPreferences` project path is a module-level const — cannot test prefs-driven auto-push in temp repos without refactoring to lazy resolution.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 4 integration tests, 23 assertions
- `src/resources/extensions/gsd/auto-worktree.ts` — Fixed nothing-to-commit detection and worktree/branch deletion ordering
- `.gsd/milestones/M003/slices/S03/tasks/T02-PLAN.md` — Added Observability Impact section
