---
id: T01
parent: S05
milestone: M003
provides:
  - git-self-heal module with abortAndReset, withMergeHeal, recoverCheckout, formatGitError
key_files:
  - src/resources/extensions/gsd/git-self-heal.ts
  - src/resources/extensions/gsd/tests/git-self-heal.test.ts
key_decisions:
  - withMergeHeal checks git diff --diff-filter=U to detect real conflicts and skips retry entirely
  - abortAndReset also checks for rebase-merge dir (not just rebase-apply) for completeness
patterns_established:
  - Synchronous git recovery functions returning structured results ({ cleaned: string[] })
  - Error pattern matching with user-friendly messages suggesting /gsd doctor
observability_surfaces:
  - abortAndReset returns { cleaned: string[] } describing actions taken
  - formatGitError output always includes /gsd doctor suggestion
duration: 8m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T01: Create git-self-heal.ts module with repair functions and tests

**Built git-self-heal.ts with 4 synchronous recovery functions and 14-assertion integration test suite against real temp git repos**

## What Happened

Created `git-self-heal.ts` exporting `abortAndReset`, `withMergeHeal`, `recoverCheckout`, and `formatGitError`. All functions are synchronous (execSync), never use `git clean`, and return structured results. `withMergeHeal` detects real conflicts via `git diff --diff-filter=U` and escalates immediately without retry — only transient failures get abort+reset+retry. Test suite creates real temp git repos with deliberate broken state (leftover MERGE_HEAD, SQUASH_MSG, merge conflicts, dirty indexes).

## Verification

- `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — 14/14 pass ✅
- `npx tsc --noEmit` — zero errors ✅
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21/21 pass ✅
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23/23 pass ✅

## Diagnostics

- `abortAndReset` result `.cleaned` array shows exactly what was cleaned (empty = no-op)
- `formatGitError` always suggests `/gsd doctor` in output
- `withMergeHeal` re-throws `MergeConflictError` with structured conflict data for real conflicts

## Deviations

- Added `rebase-merge` dir check alongside `rebase-apply` in `abortAndReset` — git uses either depending on rebase type.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/git-self-heal.ts` — module with 4 exported recovery functions
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — 14-assertion integration test suite
- `.gsd/milestones/M003/slices/S05/tasks/T01-PLAN.md` — added Observability Impact section
