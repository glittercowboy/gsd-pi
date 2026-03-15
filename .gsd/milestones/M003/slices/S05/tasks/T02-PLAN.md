---
estimated_steps: 5
estimated_files: 2
---

# T02: Wire self-heal into auto-worktree.ts and auto.ts

**Slice:** S05 — Self-healing git repair
**Milestone:** M003

## Description

Integrate the self-heal utilities from `git-self-heal.ts` into the existing merge and checkout paths in `auto-worktree.ts` and `auto.ts`, replacing raw error handling with structured recovery.

## Steps

1. In `mergeSliceToMilestone` (auto-worktree.ts): replace the raw `execSync git checkout` with `recoverCheckout(cwd, milestoneBranch)`. Wrap the `execSync git merge --no-ff` block with `withMergeHeal` — pass a function that does the merge, let `withMergeHeal` handle abort+reset+retry for transient failures and immediate escalation for real conflicts.
2. In `mergeMilestoneToMain` (auto-worktree.ts): replace checkout main with `recoverCheckout(originalBasePath_, mainBranch)`. Wrap the squash-merge block with `withMergeHeal`.
3. In auto.ts ~L1670-1695 (non-conflict error handling): replace raw `error.message` in the notify call with `formatGitError(error)`.
4. Verify MergeConflictError still propagates correctly through `withMergeHeal` to auto.ts fix-merge dispatch.
5. Run all existing merge test suites to confirm zero regressions.

## Must-Haves

- [ ] `MergeConflictError` propagates unchanged to auto.ts fix-merge dispatch
- [ ] Existing test suites pass without modification
- [ ] `recoverCheckout` used at both checkout sites in auto-worktree.ts
- [ ] `formatGitError` used in auto.ts error notification

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21 pass
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23 pass
- `npx tsc --noEmit` — zero errors

## Observability Impact

- Signals added/changed: merge failures now show user-friendly messages instead of raw git output
- How a future agent inspects this: error messages include `/gsd doctor` suggestion
- Failure state exposed: self-heal retry action visible in error context

## Inputs

- `src/resources/extensions/gsd/git-self-heal.ts` — T01 output (4 exported functions)
- `src/resources/extensions/gsd/auto-worktree.ts` — existing merge functions to wrap
- `src/resources/extensions/gsd/auto.ts` — existing error handling block ~L1670

## Expected Output

- `src/resources/extensions/gsd/auto-worktree.ts` — modified with self-heal wrappers
- `src/resources/extensions/gsd/auto.ts` — modified with formatGitError
