---
id: S05
parent: M003
milestone: M003
provides:
  - git-self-heal module (abortAndReset, withMergeHeal, recoverCheckout, formatGitError)
  - self-heal wrappers integrated into merge/checkout paths in auto-worktree.ts and auto.ts
requires:
  - slice: S01
    provides: worktree detection functions (isInAutoWorktree)
  - slice: S02
    provides: mergeSliceToMilestone merge operation
  - slice: S03
    provides: mergeMilestoneToMain squash merge operation
affects:
  - S06
key_files:
  - src/resources/extensions/gsd/git-self-heal.ts
  - src/resources/extensions/gsd/tests/git-self-heal.test.ts
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - D030 applied — withMergeHeal detects real conflicts via git diff --diff-filter=U and escalates immediately without retry; only transient failures get abort+reset+retry
  - MergeConflictError re-thrown with correct branch context after withMergeHeal (heal function uses "unknown" placeholders)
  - abortAndReset checks both rebase-apply and rebase-merge dirs for completeness
patterns_established:
  - Synchronous git recovery functions returning structured results ({ cleaned: string[] })
  - Error pattern matching with user-friendly messages suggesting /gsd doctor
  - withMergeHeal wraps merge calls; catch block re-throws MergeConflictError with correct branch names
  - recoverCheckout replaces raw git checkout at all checkout sites
observability_surfaces:
  - abortAndReset returns { cleaned: string[] } describing actions taken
  - formatGitError output always includes /gsd doctor suggestion
  - withMergeHeal re-throws MergeConflictError with structured conflict data for real conflicts
drill_down_paths:
  - .gsd/milestones/M003/slices/S05/tasks/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S05/tasks/T02-SUMMARY.md
duration: 16m
verification_result: passed
completed_at: 2026-03-14
---

# S05: Self-healing git repair

**Automatic git failure recovery — abort, reset, retry for transient failures; immediate escalation for real code conflicts**

## What Happened

Built `git-self-heal.ts` with four synchronous recovery functions: `abortAndReset` (clears MERGE_HEAD/SQUASH_MSG/rebase state), `withMergeHeal` (wraps merge ops with conflict detection and auto-retry), `recoverCheckout` (resets dirty index before checkout), and `formatGitError` (translates git errors to user-friendly messages with `/gsd doctor` suggestion). All tested against real temp git repos with deliberate broken state (14 assertions).

Wired self-heal into `auto-worktree.ts` — `recoverCheckout` replaces raw `git checkout` at both checkout sites (slice merge and milestone merge), `withMergeHeal` wraps both merge blocks. In `auto.ts`, `formatGitError` replaces raw error messages in the non-conflict error notification path. MergeConflictError propagation preserved with correct branch context.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — 14/14 pass ✅
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21/21 pass ✅
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23/23 pass ✅
- `npx tsc --noEmit` — zero errors ✅

## Requirements Advanced

- R035 — Self-healing git repair now implemented: abortAndReset, withMergeHeal, recoverCheckout handle transient failures automatically
- R037 — Zero git errors for vibe coders: formatGitError translates all git errors to non-technical messages with `/gsd doctor` suggestion

## Requirements Validated

- None moved to validated — full validation requires S06 (doctor) and S07 (test suite) to complete the coverage

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- Added `rebase-merge` dir check alongside `rebase-apply` in `abortAndReset` — git uses either depending on rebase type (interactive vs non-interactive). Minor addition, no plan change.

## Known Limitations

- Self-heal retry is limited to one attempt — repeated transient failures will still escalate
- `/gsd doctor` command referenced in error messages doesn't exist yet (S06)
- No self-heal for remote push failures (out of scope for this slice)

## Follow-ups

- S06: `/gsd doctor` command to detect and fix orphaned worktrees, stale branches, corrupt merge state
- S06: Remove dead `.gsd/` conflict resolution code from worktree-mode paths

## Files Created/Modified

- `src/resources/extensions/gsd/git-self-heal.ts` — module with 4 exported recovery functions
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — 14-assertion integration test suite
- `src/resources/extensions/gsd/auto-worktree.ts` — replaced checkout/merge with recoverCheckout/withMergeHeal wrappers
- `src/resources/extensions/gsd/auto.ts` — added formatGitError in non-conflict error notification path

## Forward Intelligence

### What the next slice should know
- `formatGitError` suggests `/gsd doctor` which doesn't exist yet — S06 must implement the doctor git health checks that users will be directed to
- The self-heal patterns (try/abort/reset/retry) established here should inform doctor's fix operations

### What's fragile
- `withMergeHeal` re-throw block manually reconstructs MergeConflictError with correct branch names — if MergeConflictError constructor changes, this breaks silently

### Authoritative diagnostics
- `git-self-heal.test.ts` — tests against real git repos with real broken state, not mocks. If these pass, the recovery logic works.

### What assumptions changed
- Original plan assumed `recoverCheckout` might need stash — confirmed worktree changes are expendable so `git reset --hard HEAD` suffices
