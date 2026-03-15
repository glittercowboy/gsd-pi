---
estimated_steps: 5
estimated_files: 1
---

# T02: Integration tests for milestone squash-merge

**Slice:** S03 — Milestone-to-main squash merge + worktree teardown
**Milestone:** M003

## Description

Build integration test suite that exercises `mergeMilestoneToMain` in real temp git repos, verifying squash-merge produces correct commit history on main, rich message format, worktree cleanup, and edge cases.

## Steps

1. Create test file following the pattern from `auto-worktree-merge.test.ts` — temp dir setup with real git init, helper to create milestone branch with --no-ff slice merges
2. Test: basic squash merge — create milestone branch with 2 slice merges (each with multiple commits), call `mergeMilestoneToMain`, assert: `git log --oneline main` has exactly 1 new commit, milestone branch deleted, worktree directory removed, `getAutoWorktreeOriginalBase()` returns null
3. Test: rich commit message — verify commit message has conventional commit subject `feat(MID): ...`, body lists slices as `- SXX: title`, includes branch metadata
4. Test: nothing to commit — milestone branch identical to main (no changes), verify function completes without error (logs warning or no-ops)
5. Test: auto-push — create bare remote, set `auto_push` pref, verify milestone commit appears on remote after merge

## Must-Haves

- [x] Real git repos (not mocks)
- [x] Squash produces exactly one commit on main
- [x] Rich message contains slice titles
- [x] Edge case: nothing to commit handled gracefully
- [x] Auto-push verified with bare remote

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — all pass, 0 failures

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — `mergeMilestoneToMain` from T01
- `src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — pattern reference for test setup helpers

## Expected Output

- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 4+ tests, 15+ assertions

## Observability Impact

- **Test output**: Test runner prints pass/fail per assertion with test group headers, final summary line `Results: N passed, M failed`
- **Future agent inspection**: Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — exit code 0 = all pass, exit code 1 = failures with FAIL lines indicating which assertions broke
- **Failure visibility**: Each failed assertion prints `FAIL: <description>` with expected vs actual values; nothing-to-commit and merge-conflict edge cases have specific error message checks
