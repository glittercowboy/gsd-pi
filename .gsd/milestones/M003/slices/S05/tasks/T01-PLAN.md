---
estimated_steps: 6
estimated_files: 2
---

# T01: Create git-self-heal.ts module with repair functions and tests

**Slice:** S05 — Self-healing git repair
**Milestone:** M003

## Description

Create `git-self-heal.ts` with four focused synchronous functions for automated git state recovery, plus an integration test suite exercising each function against real temp git repos with deliberately broken state.

## Steps

1. Create `git-self-heal.ts` with `abortAndReset(cwd)`: check for `.git/MERGE_HEAD`, `.git/SQUASH_MSG`, `.git/rebase-apply`; abort merge/rebase if detected; `git reset --hard HEAD`. Return `{ cleaned: string[] }` describing what was cleared.
2. Add `withMergeHeal(cwd, mergeFn)`: call `mergeFn()`. On error, run `git diff --diff-filter=U` — if conflicted files exist, re-throw as `MergeConflictError` immediately (no retry). Otherwise `abortAndReset(cwd)`, retry `mergeFn()` once. On second failure, throw.
3. Add `recoverCheckout(cwd, targetBranch)`: `git reset --hard HEAD` then `git checkout <branch>`. If checkout still fails, throw with context.
4. Add `formatGitError(error)`: pattern-match common git error strings (merge conflict, checkout failure, detached HEAD, lock file) to user-friendly messages suggesting `/gsd doctor`.
5. Create test file with temp git repo fixtures: test `abortAndReset` with leftover MERGE_HEAD, with leftover SQUASH_MSG, with clean state (no-op). Test `withMergeHeal` with transient failure (succeeds on retry), with real conflict (escalates immediately). Test `recoverCheckout` with dirty index. Test `formatGitError` with known error patterns.
6. Run `npx tsc --noEmit` to verify types.

## Must-Haves

- [ ] All four functions exported and synchronous (execSync)
- [ ] Never uses `git clean` — only `git reset --hard HEAD`
- [ ] Real conflict detection skips retry and escalates immediately
- [ ] Test suite uses real temp git repos, not mocks

## Verification

- `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — all pass
- `npx tsc --noEmit` — zero errors

## Inputs

- S05-RESEARCH.md — existing patterns from auto.ts L1524-1580 (abort/reset), MergeConflictError from git-service.ts
- auto-worktree.ts — `execSync` patterns for git operations

## Observability Impact

- **Structured results:** `abortAndReset` returns `{ cleaned: string[] }` listing every action taken (e.g. "aborted merge", "removed SQUASH_MSG", "reset to HEAD"). Empty array = no-op.
- **Error translation:** `formatGitError` maps raw git errors to user-facing messages that always suggest `/gsd doctor`.
- **Conflict escalation:** `withMergeHeal` detects real conflicts via `git diff --diff-filter=U` and re-throws `MergeConflictError` without retry — callers see structured conflict data.
- **Failure inspection:** All functions throw with descriptive messages on unrecoverable failure; `recoverCheckout` includes branch name and underlying git error in the thrown Error.

## Expected Output

- `src/resources/extensions/gsd/git-self-heal.ts` — module with 4 exports
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — integration tests proving recovery
