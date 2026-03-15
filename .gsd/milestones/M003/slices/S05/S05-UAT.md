# S05: Self-healing git repair — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: live-runtime
- Why this mode is sufficient: Self-healing must be verified against real git repos with real failures — artifact inspection alone cannot prove recovery works

## Preconditions

- Project has a git repo initialized
- `npx tsc --noEmit` passes (no type errors)
- All three test suites pass (git-self-heal, auto-worktree-merge, auto-worktree-milestone-merge)

## Smoke Test

Run `npx tsx src/resources/extensions/gsd/tests/git-self-heal.test.ts` — all 14 assertions pass, confirming core self-heal functions work against real git repos.

## Test Cases

### 1. Transient merge failure auto-recovery

1. Create a temp git repo with a milestone branch
2. Leave a stale MERGE_HEAD file in `.git/`
3. Trigger `mergeSliceToMilestone` — the self-heal should detect the stale state, abort, reset, and retry successfully
4. **Expected:** Merge completes without error. No user intervention required.

### 2. Real code conflict escalation

1. Create a temp git repo with conflicting changes on two branches (same file, same line, different content)
2. Trigger `withMergeHeal` with a merge that produces UU (unmerged) files
3. **Expected:** MergeConflictError thrown immediately — no retry attempted. Error includes conflict file list.

### 3. Dirty index checkout recovery

1. Create a temp git repo with uncommitted changes in the index
2. Call `recoverCheckout(cwd, targetBranch)`
3. **Expected:** Index is reset, checkout succeeds to target branch.

### 4. User-friendly error messages

1. Trigger a git error (e.g., run git command in non-repo directory)
2. Pass the error through `formatGitError`
3. **Expected:** Output is a non-technical message suggesting `/gsd doctor`. No raw git stderr visible to user.

### 5. Existing merge tests still pass

1. Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts`
2. Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts`
3. **Expected:** 21/21 and 23/23 pass respectively. Self-heal wrappers cause zero regressions.

## Edge Cases

### SQUASH_MSG cleanup

1. Create `.git/SQUASH_MSG` file in a repo
2. Call `abortAndReset(cwd)`
3. **Expected:** SQUASH_MSG removed, `cleaned` array includes "SQUASH_MSG"

### Rebase state cleanup

1. Create `.git/rebase-merge/` or `.git/rebase-apply/` directory
2. Call `abortAndReset(cwd)`
3. **Expected:** Rebase aborted, `cleaned` array includes the rebase type

### No-op on clean state

1. Call `abortAndReset(cwd)` on a clean repo with no merge/rebase state
2. **Expected:** Returns `{ cleaned: [] }` — no actions taken

## Failure Signals

- Any test suite assertion failure
- `MergeConflictError` thrown for transient failures (should only throw for real conflicts)
- Raw git error messages appearing in auto.ts error notifications (should be formatted)
- `git clean` appearing anywhere in the codebase (explicitly forbidden — only `git reset --hard HEAD` used)

## Requirements Proved By This UAT

- R035 — Self-healing git repair: transient failures auto-recovered, real conflicts escalated
- R037 — Zero git errors for vibe coders: all error messages are user-friendly with `/gsd doctor` suggestion

## Not Proven By This UAT

- R040 — Doctor git health checks (S06)
- R036 — Dead conflict resolution code removal (S06)
- Remote push failure recovery (out of scope)
- Full end-to-end auto-mode self-heal during live milestone execution (S07 integration tests)

## Notes for Tester

- The `/gsd doctor` command referenced in error messages doesn't exist yet — that's expected (S06 will implement it)
- Self-heal retry is intentionally limited to one attempt — this is a design choice, not a bug
- All tests use real temp git repos with real git operations, not mocks
