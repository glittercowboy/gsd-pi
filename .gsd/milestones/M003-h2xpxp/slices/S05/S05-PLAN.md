# S05: Self-healing git repair

**Goal:** When git operations fail during auto-mode, the system automatically attempts repair (abort, reset, retry) before escalating. Only truly unresolvable code conflicts trigger fix-merge or pause. Users see non-technical messages, not raw git errors.

**Demo:** Deliberately introduce a merge failure (corrupt index, stale MERGE_HEAD) during auto-mode and observe automatic recovery without user intervention. Real code conflicts still escalate to fix-merge.

## Must-Haves

- `abortAndReset(cwd)` detects and clears leftover MERGE_HEAD/SQUASH_MSG/rebase state
- `withMergeHeal(cwd, mergeFn)` wraps merge operations: on failure, detect real conflicts (escalate immediately) vs transient failures (abort+reset+retry once)
- `recoverCheckout(cwd, targetBranch)` handles dirty index by resetting before checkout
- `formatGitError(error)` translates git errors to non-technical user-facing messages
- Self-heal wired into `mergeSliceToMilestone` and `mergeMilestoneToMain` in auto-worktree.ts
- Self-heal wired into auto.ts non-conflict error handling path
- Never runs `git clean` without excluding `.gsd/`
- Real code conflicts (UU files detected) skip retry and escalate immediately

## Proof Level

- This slice proves: integration
- Real runtime required: yes (real git repos with deliberate failures)
- Human/UAT required: no

## Verification

- `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — all assertions pass
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — existing 21 assertions still pass
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — existing 23 assertions still pass
- `npx tsc --noEmit` — zero type errors

## Observability / Diagnostics

- Runtime signals: self-heal functions return structured results (action taken, retry count, success/failure)
- Inspection surfaces: `abortAndReset` reports what it cleaned (MERGE_HEAD, SQUASH_MSG, rebase)
- Failure visibility: `formatGitError` output includes suggested action (`/gsd doctor`)
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `mergeSliceToMilestone`, `mergeMilestoneToMain` (auto-worktree.ts), merge error handling block (auto.ts ~L1670-1695)
- New wiring introduced: self-heal wraps existing merge calls; formatGitError replaces raw error messages
- What remains: S06 (doctor), S07 (full test suite)

## Tasks

- [x] **T01: Create git-self-heal.ts module with repair functions and tests** `est:30m`
  - Why: The core self-heal utilities must exist and be independently tested before wiring into existing code.
  - Files: `src/resources/extensions/gsd/git-self-heal.ts`, `src/resources/extensions/gsd/tests/git-self-heal.test.ts`
  - Do: Create `git-self-heal.ts` with four exports: `abortAndReset(cwd)` (detects MERGE_HEAD/SQUASH_MSG/rebase-apply, aborts appropriately, resets to HEAD), `withMergeHeal(cwd, mergeFn)` (calls mergeFn, on failure checks `git diff --diff-filter=U` — if conflict files exist, throws MergeConflictError immediately without retry; otherwise aborts+resets+retries once), `recoverCheckout(cwd, targetBranch)` (resets dirty index then checkouts, stash not needed since worktree changes are expendable), `formatGitError(error)` (pattern-matches common git errors to user-friendly messages with `/gsd doctor` suggestion). All functions synchronous (execSync). Never use `git clean` — only `git reset --hard HEAD` and `git checkout -- .`. Test with real temp git repos: create merge conflicts, corrupt state, verify recovery.
  - Verify: `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — all pass
  - Done when: All four functions exported, tested with deliberate git failures, `npx tsc --noEmit` clean

- [x] **T02: Wire self-heal into auto-worktree.ts and auto.ts** `est:25m`
  - Why: The utilities must be integrated into the actual merge/checkout paths to provide self-healing in auto-mode.
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/auto.ts`
  - Do: In `mergeSliceToMilestone`: wrap the checkout + merge block with `withMergeHeal` (or use `recoverCheckout` for the checkout call and `withMergeHeal` for the merge). In `mergeMilestoneToMain`: same pattern — `recoverCheckout` for checkout main, `withMergeHeal` for squash merge. In auto.ts ~L1670-1695: replace the raw error message with `formatGitError`. Ensure `MergeConflictError` still propagates to auto.ts fix-merge dispatch (self-heal must re-throw it, not swallow it). Run existing merge tests to confirm no regressions.
  - Verify: `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` (21 pass), `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` (23 pass), `npx tsc --noEmit` clean
  - Done when: Self-heal wraps all merge/checkout paths in auto-worktree.ts, auto.ts uses formatGitError, all existing tests pass

## Files Likely Touched

- `src/resources/extensions/gsd/git-self-heal.ts` (new)
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` (new)
- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/auto.ts`
